/**
 * Session files: list ~/.noishi/agent/sessions/<cwd-slug>/*.jsonl with light
 * metadata (id, name, mtime, message count). No pi imports — the JSONL shape
 * is stable ({"type":"session"|"message"|...}).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionListItem } from "@noishi/rpc-bridge";

const SESSIONS_DIR = join(homedir(), ".noishi", "agent", "sessions");

function slugForCwd(cwd: string): string {
	return `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
}

type JsonlRecord = { type?: string; message?: { role?: string; content?: unknown } };

function countUserMessages(records: JsonlRecord[]): number {
	return records.filter((r) => r.type === "message" && r.message?.role === "user").length;
}

export async function listSessions(cwd?: string, limit = 50): Promise<SessionListItem[]> {
	const dir = cwd ? join(SESSIONS_DIR, slugForCwd(cwd)) : SESSIONS_DIR;
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const files = entries.filter((f) => f.endsWith(".jsonl")).sort().reverse().slice(0, limit);
	const items: SessionListItem[] = [];
	for (const file of files) {
		const full = join(dir, file);
		const info = await stat(full);
		const sessionIdMatch = /_([0-9a-f-]{36})\.jsonl$/.exec(file);
		const content = await readFile(full, "utf-8");
		const records = content
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => {
				try {
					return JSON.parse(l) as JsonlRecord;
				} catch {
					return {};
				}
			});
		const sessionRecord = records.find((r) => r.type === "session") as
			| { name?: string }
			| undefined;
		items.push({
			sessionFile: full,
			sessionId: sessionIdMatch?.[1] ?? file,
			name: sessionRecord?.name,
			modifiedAt: info.mtime.toISOString(),
			messageCount: countUserMessages(records),
		});
	}
	return items;
}

/** Newest session file across all cwd slugs. */
export async function newestSessionFile(): Promise<string | null> {
	const slugs = await readdir(SESSIONS_DIR).catch(() => []);
	let newest: { path: string; mtime: number } | null = null;
	for (const slug of slugs) {
		const dir = join(SESSIONS_DIR, slug);
		const files = await readdir(dir).catch(() => []);
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const full = join(dir, file);
			const info = await stat(full).catch(() => null);
			if (!info) continue;
			if (!newest || info.mtimeMs > newest.mtime) newest = { path: full, mtime: info.mtimeMs };
		}
	}
	return newest?.path ?? null;
}
