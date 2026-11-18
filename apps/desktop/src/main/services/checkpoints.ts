/**
 * Checkpoints: per-turn snapshots of the files the agent touched.
 *
 * Every tool call that writes a path records the file's pre-image here before
 * the write happens (the renderer is told about it, but the main process owns
 * the copy). That makes three things possible without shelling out to git:
 *   - revert a single file to its state before a turn (feature 2)
 *   - rewind the whole workspace to a message boundary (feature 3)
 *   - show what the session changed so far (feature 4)
 *
 * Snapshots live under ~/.noishi/agent/checkpoints/<session>/<entry>/ and are
 * pruned to the last 40 entries.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resolveWithin } from "./path-guard.js";

const ROOT = join(homedir(), ".noishi", "agent", "checkpoints");
const MAX_ENTRIES = 40;

export type SnapshotFile = { path: string; existed: boolean; snapshot?: string };

export type CheckpointEntry = {
	/** Entry id from the agent (stable per message). */
	entryId: string;
	createdAt: number;
	files: SnapshotFile[];
};

function sessionDir(sessionId: string): string {
	return join(ROOT, sessionId.replace(/[^\w.-]/g, "_"));
}

function entryDir(sessionId: string, entryId: string): string {
	return join(sessionDir(sessionId), entryId.replace(/[^\w.-]/g, "_"));
}

function indexFile(sessionId: string): string {
	return join(sessionDir(sessionId), "index.json");
}

function readIndex(sessionId: string): CheckpointEntry[] {
	const path = indexFile(sessionId);
	if (!existsSync(path)) return [];
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as CheckpointEntry[];
	} catch {
		return [];
	}
}

function writeIndex(sessionId: string, entries: CheckpointEntry[]): void {
	mkdirSync(sessionDir(sessionId), { recursive: true });
	const kept = entries.slice(-MAX_ENTRIES);
	for (const entry of entries.slice(0, Math.max(0, entries.length - MAX_ENTRIES))) {
		rmSync(entryDir(sessionId, entry.entryId), { recursive: true, force: true });
	}
	writeFileSync(indexFile(sessionId), JSON.stringify(kept, null, 2));
}

/**
 * Record the pre-image of a file before the agent writes it. Idempotent per
 * (session, entry, path): the first snapshot wins, so a file touched twice in
 * one turn still reverts to the start of the turn.
 */
export function snapshotFile(sessionId: string, entryId: string, path: string): void {
	const entries = readIndex(sessionId);
	const existing = entries.find((entry) => entry.entryId === entryId);
	const dir = entryDir(sessionId, entryId);
	mkdirSync(dir, { recursive: true });

	if (existing?.files.some((file) => file.path === path)) return;

	const snapshot: SnapshotFile = { path, existed: existsSync(path) };
	if (snapshot.existed) {
		const target = join(dir, `${basename(path)}.${entries.length}-${existing?.files.length ?? 0}.bak`);
		try {
			copyFileSync(path, target);
			snapshot.snapshot = target;
		} catch {
			snapshot.existed = false;
		}
	}

	if (existing) {
		existing.files.push(snapshot);
	} else {
		entries.push({ entryId, createdAt: Date.now(), files: [snapshot] });
	}
	writeIndex(sessionId, entries);
}

/** Revert one file to its pre-turn content (or delete it if it did not exist). */
export function revertFile(sessionId: string, entryId: string, path: string): { ok: boolean; error?: string } {
	const entries = readIndex(sessionId);
	const entry = entries.find((item) => item.entryId === entryId);
	const file = entry?.files.find((item) => item.path === path);
	if (!file) return { ok: false, error: "sem snapshot para este arquivo" };
	try {
		if (!file.existed) {
			rmSync(path, { force: true });
			return { ok: true };
		}
		if (!file.snapshot || !existsSync(file.snapshot)) return { ok: false, error: "snapshot ausente em disco" };
		const safeSnapshot = resolveWithin(ROOT, file.snapshot);
		copyFileSync(safeSnapshot, path);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Rewind every file touched at or after `entryId` (inclusive). */
export function rewindTo(sessionId: string, entryId: string): { ok: boolean; reverted: string[]; error?: string } {
	const entries = readIndex(sessionId);
	const index = entries.findIndex((entry) => entry.entryId === entryId);
	if (index === -1) return { ok: false, reverted: [], error: "entry não encontrada" };
	const reverted: string[] = [];
	for (let i = entries.length - 1; i >= index; i--) {
		const entry = entries[i];
		if (!entry) continue;
		// Within an entry, revert in reverse order so the earliest snapshot wins.
		for (let f = entry.files.length - 1; f >= 0; f--) {
			const file = entry.files[f];
			if (!file) continue;
			const result = revertFile(sessionId, entry.entryId, file.path);
			if (result.ok) reverted.push(file.path);
		}
	}
	writeIndex(sessionId, entries.slice(0, index));
	return { ok: true, reverted };
}

/** All files the session has snapshotted, newest entry first. */
export function sessionChanges(sessionId: string): { path: string; entryId: string; createdAt: number; existed: boolean }[] {
	const entries = readIndex(sessionId);
	const seen = new Map<string, { path: string; entryId: string; createdAt: number; existed: boolean }>();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry) continue;
		for (const file of entry.files) {
			if (!seen.has(file.path)) {
				seen.set(file.path, { path: file.path, entryId: entry.entryId, createdAt: entry.createdAt, existed: file.existed });
			}
		}
	}
	return [...seen.values()];
}

/** Entries with at least one file, newest first (for the rewind picker). */
export function listCheckpoints(sessionId: string): { entryId: string; createdAt: number; files: number }[] {
	return readIndex(sessionId)
		.slice()
		.reverse()
		.map((entry) => ({ entryId: entry.entryId, createdAt: entry.createdAt, files: entry.files.length }));
}

/** Full entries (with their file pre-images), oldest first — used by review. */
export function listEntries(sessionId: string): CheckpointEntry[] {
	return readIndex(sessionId);
}

/** Read a snapshot file's content, or null when it is gone. */
export function readSnapshot(path: string): string | null {
	return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/** Current size on disk, for diagnostics. */
export function checkpointSize(sessionId: string): number {
	const dir = sessionDir(sessionId);
	if (!existsSync(dir)) return 0;
	let total = 0;
	for (const file of readdirSync(dir)) {
		const full = join(dir, file);
		try {
			const info = statSync(full);
			if (info.isFile()) total += info.size;
		} catch {
			// A file removed between readdir and stat is not part of the size.
		}
	}
	return total;
}
