/**
 * Process group supervisor for Noishi Desktop.
 *
 * Tracks spawned child process groups (PGIDs) for `noushi rpc`, `node-pty`,
 * QEMU/KVM, `virtiofsd`, and `sandbox-proxy`, ensuring clean transactional
 * teardown on `before-quit` or unexpected window crashes so no orphans remain.
 */

import type { ChildProcess } from "node:child_process";

export type TrackedProcess = {
	id: string;
	label: string;
	pid: number;
	pgid: number;
};

const tracked = new Map<string, TrackedProcess>();

export function trackProcess(id: string, label: string, child: ChildProcess): void {
	if (!child.pid) return;
	const pid = child.pid;
	tracked.set(id, { id, label, pid, pgid: pid });
	child.once("exit", () => {
		tracked.delete(id);
	});
}

export function untrackProcess(id: string): void {
	tracked.delete(id);
}

export function listTrackedProcesses(): TrackedProcess[] {
	return [...tracked.values()];
}

export function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
	try {
		// Negative PID targets the entire process group on POSIX
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Process already exited
		}
	}
}

export async function shutdownAllProcesses(graceMs = 1500): Promise<void> {
	const entries = listTrackedProcesses();
	if (entries.length === 0) return;

	for (const entry of entries) {
		killProcessGroup(entry.pgid, "SIGTERM");
	}

	await new Promise<void>((resolve) => setTimeout(resolve, graceMs));

	for (const entry of listTrackedProcesses()) {
		killProcessGroup(entry.pgid, "SIGKILL");
		tracked.delete(entry.id);
	}
}
