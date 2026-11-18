/**
 * Session insights: cost, context breakdown, export and portability.
 *
 * Everything here reads the session JSONL the CLI already writes
 * (~/.noishi/agent/sessions/<slug>/<ts>_<id>.jsonl). No new state, no
 * re-derivation of numbers the agent already recorded: `usage` on each
 * assistant message is the source of truth for tokens and cost.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { slugForCwd } from "./session-files.js";

const SESSIONS_DIR = join(homedir(), ".noishi", "agent", "sessions");

type Usage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number; input?: number; output?: number };
};

type ContentPart = { type?: string; text?: string; [key: string]: unknown };

type Message = {
	role?: string;
	content?: string | ContentPart[];
	usage?: Usage;
	model?: string;
	provider?: string;
	timestamp?: number;
};

type Record_ = {
	type?: string;
	id?: string;
	timestamp?: string;
	message?: Message;
	name?: string;
	cwd?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
};

export function readSession(sessionPath: string): Record_[] {
	if (!existsSync(sessionPath)) return [];
	const out: Record_[] = [];
	for (const line of readFileSync(sessionPath, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as Record_);
		} catch {
			// A truncated last line (crash mid-write) is skipped, not fatal.
		}
	}
	return out;
}

/* ---------- cost (30) ---------- */

export type SessionCost = {
	sessionPath: string;
	messages: number;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: { input: number; output: number; total: number };
	byModel: { model: string; messages: number; tokens: number; cost: number }[];
	firstAt: number | null;
	lastAt: number | null;
};

export function sessionCost(sessionPath: string): SessionCost {
	const records = readSession(sessionPath);
	const cost: SessionCost = {
		sessionPath,
		messages: 0,
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: { input: 0, output: 0, total: 0 },
		byModel: [],
		firstAt: null,
		lastAt: null,
	};
	const models = new Map<string, { messages: number; tokens: number; cost: number }>();
	for (const record of records) {
		if (record.timestamp) {
			const at = Date.parse(record.timestamp);
			if (Number.isFinite(at)) {
				if (cost.firstAt === null || at < cost.firstAt) cost.firstAt = at;
				if (cost.lastAt === null || at > cost.lastAt) cost.lastAt = at;
			}
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		cost.messages++;
		if (message.role === "user") cost.userMessages++;
		if (Array.isArray(message.content)) {
			for (const part of message.content) if (part.type === "toolCall" || part.type === "tool_use") cost.toolCalls++;
		}
		if (message.role !== "assistant") continue;
		cost.assistantMessages++;
		const usage = message.usage;
		if (!usage) continue;
		const tokens = usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		cost.tokens.input += usage.input ?? 0;
		cost.tokens.output += usage.output ?? 0;
		cost.tokens.cacheRead += usage.cacheRead ?? 0;
		cost.tokens.cacheWrite += usage.cacheWrite ?? 0;
		cost.tokens.total += tokens;
		cost.cost.input += usage.cost?.input ?? 0;
		cost.cost.output += usage.cost?.output ?? 0;
		cost.cost.total += usage.cost?.total ?? 0;
		const key = message.model ?? "?";
		const entry = models.get(key) ?? { messages: 0, tokens: 0, cost: 0 };
		entry.messages++;
		entry.tokens += tokens;
		entry.cost += usage.cost?.total ?? 0;
		models.set(key, entry);
	}
	cost.byModel = [...models.entries()]
		.map(([model, value]) => ({ model, ...value }))
		.sort((a, b) => b.cost - a.cost);
	return cost;
}

/* ---------- context breakdown (28) ---------- */

export type ContextSlice = { label: string; chars: number; messages: number; share: number };

export type ContextBreakdown = {
	/** Tokens the provider reported for the most recent request. */
	usedTokens: number;
	contextWindow: number;
	/** Character counts per category — a shape, not a token estimate. */
	slices: ContextSlice[];
	largest: { role: string; chars: number; preview: string }[];
};

function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) => (typeof part.text === "string" ? part.text : part.type === "toolResult" ? JSON.stringify(part) : ""))
		.join("");
}

export function contextBreakdown(sessionPath: string, contextWindow: number): ContextBreakdown {
	const records = readSession(sessionPath);
	const buckets = new Map<string, { chars: number; messages: number }>();
	let usedTokens = 0;
	const largest: { role: string; chars: number; preview: string }[] = [];
	for (const record of records) {
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const text = textOf(message);
		const role = message.role ?? "?";
		const label =
			role === "system" ? "system prompt" : role === "user" ? "você" : role === "assistant" ? "agente" : role === "toolResult" ? "resultados de ferramenta" : role;
		const bucket = buckets.get(label) ?? { chars: 0, messages: 0 };
		bucket.chars += text.length;
		bucket.messages++;
		buckets.set(label, bucket);
		if (text.length > 400) largest.push({ role, chars: text.length, preview: text.slice(0, 160) });
		if (role === "assistant" && message.usage) {
			// The last request's input is the live context size.
			usedTokens = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0);
		}
	}
	const totalChars = [...buckets.values()].reduce((sum, bucket) => sum + bucket.chars, 0) || 1;
	return {
		usedTokens,
		contextWindow,
		slices: [...buckets.entries()]
			.map(([label, value]) => ({ label, chars: value.chars, messages: value.messages, share: value.chars / totalChars }))
			.sort((a, b) => b.chars - a.chars),
		largest: largest.sort((a, b) => b.chars - a.chars).slice(0, 8),
	};
}

/* ---------- export (31) ---------- */

export function sessionToMarkdown(sessionPath: string): string {
	const records = readSession(sessionPath);
	const session = records.find((record) => record.type === "session");
	const lines: string[] = [`# ${session?.name ?? basename(sessionPath, ".jsonl")}`, ""];
	if (session?.cwd) lines.push(`cwd: \`${session.cwd}\``, "");
	for (const record of records) {
		if (record.type === "model_change") {
			lines.push(`> modelo: ${record.provider ?? "?"}/${record.modelId ?? "?"}`, "");
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const role = message.role ?? "?";
		if (role === "system") continue;
		const text = textOf(message).trim();
		if (!text) continue;
		lines.push(`## ${role === "user" ? "Você" : role === "assistant" ? "Noishi" : role}`, "", text, "");
	}
	return lines.join("\n");
}

export function exportMarkdown(sessionPath: string, outputPath?: string): { path: string; bytes: number } {
	const body = sessionToMarkdown(sessionPath);
	const target = outputPath ?? sessionPath.replace(/\.jsonl$/, ".md");
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, body);
	return { path: target, bytes: Buffer.byteLength(body) };
}

/** HTML used for the PDF render; self-contained, no external assets. */
export function sessionToHtml(sessionPath: string): string {
	const markdown = sessionToMarkdown(sessionPath);
	const escape = (value: string): string =>
		value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const body = markdown
		.split("\n")
		.map((line) => {
			if (line.startsWith("## ")) return `<h2>${escape(line.slice(3))}</h2>`;
			if (line.startsWith("# ")) return `<h1>${escape(line.slice(2))}</h1>`;
			if (line.startsWith("> ")) return `<blockquote>${escape(line.slice(2))}</blockquote>`;
			if (!line.trim()) return "";
			return `<p>${escape(line)}</p>`;
		})
		.join("\n");
	return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:14px/1.6 -apple-system,system-ui,sans-serif;color:#1b1722;margin:32px;max-width:46em}
h1{font-size:22px;margin:0 0 16px}h2{font-size:15px;margin:20px 0 6px;color:#5c5568}
p{margin:0 0 8px;white-space:pre-wrap}blockquote{margin:0 0 12px;color:#726a80;font-size:12px}
</style></head><body>${body}</body></html>`;
}

/* ---------- portability (33) ---------- */



/**
 * Copy a session into another project's session directory, rewriting the
 * session record's cwd so the CLI resumes it there.
 */
export function portSession(sessionPath: string, cwd: string): { path: string; cwd: string } {
	const records = readSession(sessionPath);
	if (records.length === 0) throw new Error("sessão vazia ou ilegível");
	const targetDir = join(SESSIONS_DIR, slugForCwd(cwd));
	mkdirSync(targetDir, { recursive: true });
	const target = join(targetDir, basename(sessionPath));
	const lines = records.map((record) => {
		if (record.type === "session") return JSON.stringify({ ...record, cwd });
		return JSON.stringify(record);
	});
	writeFileSync(target, `${lines.join("\n")}\n`);
	return { path: target, cwd };
}

/* ---------- transcript (32) ---------- */

export type TranscriptBlock =
	| { kind: "text"; role: "user" | "assistant"; content: string; entryId?: string }
	| { kind: "tool"; toolName: string; args: string; entryId?: string };

type ContentPartFull = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	input?: unknown;
};

/**
 * Rebuild the visible transcript from a session file. Only what the user and
 * the agent said is returned: system prompts and tool results stay out, which
 * is what resuming a session needs (the agent has its own context).
 */
export function sessionTranscript(sessionPath: string): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = [];
	for (const record of readSession(sessionPath)) {
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const role = message.role;
		if (role !== "user" && role !== "assistant") continue;
		const parts: ContentPartFull[] =
			typeof message.content === "string" ? [{ type: "text", text: message.content }] : ((message.content ?? []) as ContentPartFull[]);
		for (const part of parts) {
			if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
				blocks.push({ kind: "text", role, content: part.text, entryId: record.id });
			} else if (part.type === "toolCall" || part.type === "tool_use") {
				const args = part.arguments ?? part.input;
				blocks.push({
					kind: "tool",
					toolName: part.name ?? "tool",
					args: typeof args === "string" ? args : JSON.stringify(args ?? {}),
					entryId: record.id,
				});
			}
		}
	}
	return blocks;
}
