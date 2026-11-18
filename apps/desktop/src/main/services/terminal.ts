/**
 * Terminal service: one PTY per window, bound to the session's cwd.
 *
 * This is the *human's* terminal — independent from the agent's rpc `bash`,
 * so typing here never lands in the conversation context. Each PTY is tied to
 * a webContents id and dies with its window.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { WebContents } from "electron";
import { spawn, type IPty } from "node-pty";

type Entry = { pty: IPty; cwd: string; history: string };

const terminals = new Map<number, Entry>();

function shell(): string {
	return process.env.SHELL || "/bin/bash";
}

/** Accepts "~", "~/x" or a real path; falls back to HOME when missing. */
function resolveCwd(cwd: string): string {
	const expanded = cwd === "~" || cwd === "" ? homedir() : cwd.startsWith("~/") ? `${homedir()}/${cwd.slice(2)}` : cwd;
	return existsSync(expanded) ? expanded : homedir();
}

export function createTerminal(sender: WebContents, cwd: string, cols: number, rows: number): { id: number; cwd: string; reused?: boolean; history?: string } {
	const windowId = sender.id;
	const resolved = resolveCwd(cwd);
	const existing = terminals.get(windowId);
	if (existing && existing.cwd === resolved) {
		resizeTerminal(windowId, cols, rows);
		return { id: windowId, cwd: resolved, reused: true, history: existing.history };
	}
	disposeTerminal(windowId);
	const pty = spawn(shell(), ["-l"], {
		name: "xterm-256color",
		cwd: resolved,
		cols: Math.max(2, cols),
		rows: Math.max(2, rows),
		env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
	});
	const entry: Entry = { pty, cwd: resolved, history: "" };
	pty.onData((data) => {
		entry.history = (entry.history + data).slice(-32_000);
		if (!sender.isDestroyed()) sender.send("noishi:pty-data", { windowId, data });
	});
	pty.onExit(({ exitCode }) => {
		if (!sender.isDestroyed()) sender.send("noishi:pty-exit", { windowId, exitCode });
		terminals.delete(windowId);
	});
	terminals.set(windowId, entry);
	return { id: windowId, cwd: resolved };
}

export function writeTerminal(windowId: number, data: string): void {
	terminals.get(windowId)?.pty.write(data);
}

export function resizeTerminal(windowId: number, cols: number, rows: number): void {
	const entry = terminals.get(windowId);
	if (!entry) return;
	try {
		entry.pty.resize(Math.max(2, cols), Math.max(2, rows));
	} catch {
		// PTY already gone; the exit handler cleans the map.
	}
}

export function disposeTerminal(windowId: number): void {
	const entry = terminals.get(windowId);
	if (!entry) return;
	terminals.delete(windowId);
	try {
		entry.pty.kill();
	} catch {
		// already dead
	}
}

export function disposeAll(): void {
	for (const windowId of [...terminals.keys()]) disposeTerminal(windowId);
}
