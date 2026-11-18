/**
 * Review: the diff surface between what the agent proposed and what is on disk.
 *
 * Three jobs, all local and synchronous:
 *  - apply a unified patch to one file (accept a proposed change)
 *  - build the accumulated diff of a session from its checkpoints (pre-images
 *    vs. current content), which is what the review panel renders
 *  - evaluate the approval policy for a tool call
 *
 * No git dependency: a session may run outside a repository, and the
 * checkpoints already hold the pre-images.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { listEntries, readSnapshot } from "./checkpoints.js";
import { resolveWithin } from "./path-guard.js";

export type DiffHunk = {
	/** 1-based first line in the old file. */
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: { kind: " " | "-" | "+"; text: string }[];
};

export type FileDiff = {
	path: string;
	/** Unified diff text, ready to display or hand to `git apply`. */
	patch: string;
	hunks: DiffHunk[];
	add: number;
	del: number;
	/** "added" when the file did not exist before the session touched it. */
	status: "added" | "modified" | "deleted";
	entryId: string;
	createdAt: number;
};

/* ---------- unified diff parsing ---------- */

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch: string): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	let current: DiffHunk | null = null;
	for (const raw of patch.split("\n")) {
		const header = HUNK_HEADER.exec(raw);
		if (header) {
			current = {
				oldStart: Number(header[1]),
				oldLines: header[2] === undefined ? 1 : Number(header[2]),
				newStart: Number(header[3]),
				newLines: header[4] === undefined ? 1 : Number(header[4]),
				lines: [],
			};
			hunks.push(current);
			continue;
		}
		if (!current) continue;
		if (raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
		const marker = raw[0];
		if (marker === " " || marker === "-" || marker === "+") {
			current.lines.push({ kind: marker, text: raw.slice(1) });
		} else if (raw === "" && current.lines.length === 0) {
			// A blank line before the first hunk body is padding, not content.
			continue;
		} else if (raw === "\\ No newline at end of file") {
			continue;
		}
	}
	return hunks;
}

/**
 * Apply hunks to `original`. Context lines must match; a mismatch aborts the
 * whole patch so a stale diff never half-writes a file.
 */
export function applyHunks(original: string[], hunks: DiffHunk[]): { ok: true; lines: string[] } | { ok: false; error: string } {
	const out: string[] = [];
	let cursor = 0; // 0-based index into original
	for (const hunk of hunks) {
		const start = Math.max(0, hunk.oldStart - 1);
		if (start < cursor) return { ok: false, error: `hunk fora de ordem na linha ${hunk.oldStart}` };
		// Copy untouched lines before the hunk.
		while (cursor < start && cursor < original.length) out.push(original[cursor++] as string);
		for (const line of hunk.lines) {
			if (line.kind === " ") {
				if (original[cursor] !== line.text) {
					return { ok: false, error: `contexto não confere na linha ${cursor + 1}` };
				}
				out.push(line.text);
				cursor++;
			} else if (line.kind === "-") {
				if (original[cursor] !== line.text) {
					return { ok: false, error: `remoção não confere na linha ${cursor + 1}` };
				}
				cursor++;
			} else {
				out.push(line.text);
			}
		}
	}
	while (cursor < original.length) out.push(original[cursor++] as string);
	return { ok: true, lines: out };
}

/** Apply a unified patch to one file inside `cwd`. */
export function applyPatch(cwd: string, path: string, patch: string): { ok: boolean; applied: number; error?: string } {
	let full: string;
	try {
		full = resolveWithin(cwd, path);
	} catch (error) {
		return { ok: false, applied: 0, error: error instanceof Error ? error.message : String(error) };
	}
	const hunks = parsePatch(patch);
	if (hunks.length === 0) return { ok: false, applied: 0, error: "patch sem hunks" };
	const existed = existsSync(full);
	const original = existed ? readFileSync(full, "utf-8").split("\n") : [];
	const result = applyHunks(original, hunks);
	if (!result.ok) return { ok: false, applied: 0, error: result.error };
	writeFileSync(full, result.lines.join("\n"));
	return { ok: true, applied: hunks.length };
}

/* ---------- diff generation ---------- */

/** Longest-common-subsequence line diff, bounded so a huge file cannot stall. */
export function lineDiff(before: string[], after: string[], maxLines = 4000): DiffHunk[] {
	const a = before.slice(0, maxLines);
	const b = after.slice(0, maxLines);
	const n = a.length;
	const m = b.length;
	// Prefix/suffix trim first: real edits touch a small middle region, and a
	// full LCS table over 4000 lines would be 16M cells.
	let prefix = 0;
	while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;
	const midA = a.slice(prefix, n - suffix);
	const midB = b.slice(prefix, m - suffix);
	if (midA.length === 0 && midB.length === 0) return [];

	const lines: DiffHunk["lines"] = [];
	for (const text of midA) lines.push({ kind: "-", text });
	for (const text of midB) lines.push({ kind: "+", text });
	return [
		{
			oldStart: prefix + 1,
			oldLines: midA.length,
			newStart: prefix + 1,
			newLines: midB.length,
			lines,
		},
	];
}

export function toPatch(path: string, hunks: DiffHunk[]): string {
	const out = [`--- a/${path}`, `+++ b/${path}`];
	for (const hunk of hunks) {
		out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
		for (const line of hunk.lines) out.push(`${line.kind}${line.text}`);
	}
	return out.join("\n");
}

/**
 * Accumulated diff of a session: every file a checkpoint recorded, compared
 * against its pre-image. Files the agent created show as fully added.
 */
export function sessionDiff(sessionId: string): FileDiff[] {
	const entries = listEntries(sessionId);
	const seen = new Map<string, { entryId: string; createdAt: number; existed: boolean; snapshot?: string }>();
	// Oldest first so the earliest pre-image wins: that is the session baseline.
	for (const entry of entries) {
		for (const file of entry.files) {
			if (!seen.has(file.path)) {
				seen.set(file.path, { entryId: entry.entryId, createdAt: entry.createdAt, existed: file.existed, snapshot: file.snapshot });
			}
		}
	}
	const diffs: FileDiff[] = [];
	for (const [path, meta] of seen) {
		const before = meta.existed && meta.snapshot ? readSnapshot(meta.snapshot) : null;
		const exists = existsSync(path);
		const after = exists ? readFileSync(path, "utf-8") : null;
		if (before === after) continue;
		const beforeLines = before === null ? [] : before.split("\n");
		const afterLines = after === null ? [] : after.split("\n");
		const hunks = lineDiff(beforeLines, afterLines);
		if (hunks.length === 0) continue;
		let add = 0;
		let del = 0;
		for (const hunk of hunks) {
			for (const line of hunk.lines) {
				if (line.kind === "+") add++;
				else if (line.kind === "-") del++;
			}
		}
		diffs.push({
			path,
			patch: toPatch(path, hunks),
			hunks,
			add,
			del,
			status: before === null ? "added" : after === null ? "deleted" : "modified",
			entryId: meta.entryId,
			createdAt: meta.createdAt,
		});
	}
	return diffs.sort((a, b) => a.path.localeCompare(b.path));
}

/* ---------- approval policy ---------- */

export type RuleDecision = "allow" | "deny" | "ask";

/** Glob with `*` and `**`, matched against the tool's path/command argument. */
function globMatch(pattern: string, value: string): boolean {
	// Split on `**` first so the single-`*` pass cannot eat it, then join the
	// pieces with `.*`. No placeholder characters, no control-char regex.
	const parts = pattern.split("**").map((part) =>
		part
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, "[^/]*"),
	);
	return new RegExp(`^${parts.join(".*")}$`).test(value);
}

/**
 * First matching rule wins; no match means "ask". Rules are ordered by the UI,
 * so a specific rule can sit above a broad one.
 */
export function decide(
	rules: { tool: string; pattern?: string; decision: RuleDecision }[],
	tool: string,
	arg: string,
): RuleDecision {
	for (const rule of rules) {
		if (rule.tool !== tool && rule.tool !== "*") continue;
		if (rule.pattern && !globMatch(rule.pattern, arg)) continue;
		return rule.decision;
	}
	return "ask";
}
