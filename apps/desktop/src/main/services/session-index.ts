/**
 * Session index: folders, tags and full-text search across session files.
 *
 * The agent writes `~/.noishi/agent/sessions/<slug>/<id>.jsonl`; this module
 * reads them to serve three desktop features that must not shell out:
 *   - global search over message content (feature 12)
 *   - folders/tags per session, persisted alongside the index (feature 13)
 *
 * The index is a small JSON map keyed by session file path, so a session keeps
 * its folder even after the app restarts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const SESSIONS_DIR = join(homedir(), ".noishi", "agent", "sessions");
const INDEX_PATH = join(homedir(), ".noishi", "agent", "session-index.json");

export type SessionMeta = { folder: string | null; tags: string[]; updatedAt: number };
export type SessionIndex = Record<string, SessionMeta>;

function readIndex(): SessionIndex {
	if (!existsSync(INDEX_PATH)) return {};
	try {
		return JSON.parse(readFileSync(INDEX_PATH, "utf-8")) as SessionIndex;
	} catch {
		return {};
	}
}

function writeIndex(index: SessionIndex): void {
	mkdirSync(dirname(INDEX_PATH), { recursive: true });
	writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

export async function setSessionFolder(sessionPath: string, folder: string | null, tags: string[] = []): Promise<void> {
	const index = readIndex();
	index[sessionPath] = { folder, tags, updatedAt: Date.now() };
	writeIndex(index);
}

export async function listFolderIndex(): Promise<{
	folders: string[];
	tags: string[];
	entries: Record<string, { folder: string | null; tags: string[] }>;
}> {
	const index = readIndex();
	const folders = new Set<string>();
	const tags = new Set<string>();
	const entries: Record<string, { folder: string | null; tags: string[] }> = {};
	for (const [path, meta] of Object.entries(index)) {
		if (meta.folder) folders.add(meta.folder);
		for (const tag of meta.tags) tags.add(tag);
		entries[path] = { folder: meta.folder, tags: meta.tags };
	}
	return { folders: [...folders].sort(), tags: [...tags].sort(), entries };
}

export type SearchHit = {
	sessionPath: string;
	sessionId: string;
	slug: string;
	line: number;
	role: string | null;
	snippet: string;
	score: number;
};

type JsonlRecord = { type?: string; message?: { role?: string; content?: unknown } };

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (typeof part === "object" && part !== null && "text" in part) return String(part.text);
				return "";
			})
			.join(" ");
	}
	return "";
}

/** Full-text search over message bodies of every session (bounded per file). */
export async function searchSessions(query: string, limit = 50): Promise<SearchHit[]> {
	const needle = query.trim().toLowerCase();
	if (needle.length < 2) return [];
	const hits: SearchHit[] = [];

	let slugs: string[];
	try {
		slugs = readdirSync(SESSIONS_DIR);
	} catch {
		return [];
	}

	for (const slug of slugs) {
		const dir = join(SESSIONS_DIR, slug);
		let files: string[];
		try {
			if (!statSync(dir).isDirectory()) continue;
			files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const file of files) {
			const full = join(dir, file);
			let content: string;
			try {
				content = readFileSync(full, "utf-8");
			} catch {
				continue;
			}
			if (!content.toLowerCase().includes(needle)) continue;
			const sessionId = /_([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1] ?? basename(file, ".jsonl");
			let lineNo = 0;
			for (const raw of content.split("\n")) {
				lineNo++;
				if (!raw.toLowerCase().includes(needle)) continue;
				let record: JsonlRecord;
				try {
					record = JSON.parse(raw) as JsonlRecord;
				} catch {
					continue;
				}
				if (record.type !== "message") continue;
				const text = textFromContent(record.message?.content);
				const index = text.toLowerCase().indexOf(needle);
				if (index === -1) continue;
				const start = Math.max(0, index - 60);
				const snippet = text.slice(start, index + needle.length + 80).replace(/\s+/g, " ");
				hits.push({
					sessionPath: full,
					sessionId,
					slug,
					line: lineNo,
					role: record.message?.role ?? null,
					snippet: `${start > 0 ? "…" : ""}${snippet}${index + needle.length + 80 < text.length ? "…" : ""}`,
					score: 1,
				});
				if (hits.length >= limit) return hits;
			}
		}
	}
	return hits;
}
