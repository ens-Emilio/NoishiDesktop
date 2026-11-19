/**
 * Local Intelligence Daemon Manager (Electron Main Process).
 *
 * Forks the daemon child process on demand (lazy-start), tracks its port,
 * and forwards shutdown signals. Exposes a simple async API for IPC handlers.
 */

import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonMessage } from "./daemon.js";

export interface DaemonHandle {
	port: number;
	baseUrl: string;
}

let child: ChildProcess | null = null;
let handle: DaemonHandle | null = null;
let pendingStart: ((h: DaemonHandle) => void) | null = null;
let pendingReject: ((err: Error) => void) | null = null;

const DAEMON_SCRIPT = join(
	fileURLToPath(import.meta.url),
	"..",
	"daemon.js",
);

/** Start the daemon if not already running. Returns the port handle. */
export async function startDaemon(): Promise<DaemonHandle> {
	if (handle) return handle;

	// Prevent concurrent starts
	if (pendingStart) {
		return new Promise<DaemonHandle>((resolve, reject) => {
			// Chain onto existing pending start
			const originalResolve = pendingStart!;
			const originalReject = pendingReject!;
			pendingStart = (h) => {
				originalResolve(h);
				resolve(h);
			};
			pendingReject = (err) => {
				originalReject(err);
				reject(err);
			};
		});
	}

	return new Promise<DaemonHandle>((resolve, reject) => {
		pendingStart = resolve;
		pendingReject = reject;

		child = fork(DAEMON_SCRIPT, [], {
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		});

		child.stdout?.on("data", (d: Buffer) => {
			process.stdout.write(`[local-intelligence] ${d.toString()}`);
		});

		child.stderr?.on("data", (d: Buffer) => {
			process.stderr.write(`[local-intelligence] ${d.toString()}`);
		});

		child.on("message", (msg: DaemonMessage) => {
			if (msg.type === "ready" && msg.port != null) {
				handle = {
					port: msg.port,
					baseUrl: `http://127.0.0.1:${msg.port}`,
				};
				const resolveFn = pendingStart;
				pendingStart = null;
				pendingReject = null;
				resolveFn?.(handle);
			} else if (msg.type === "error") {
				const rejectFn = pendingReject;
				pendingStart = null;
				pendingReject = null;
				rejectFn?.(new Error(msg.message ?? "Daemon failed to start"));
			}
		});

		child.on("exit", (code) => {
			handle = null;
			child = null;
			if (pendingReject) {
				const rejectFn = pendingReject;
				pendingStart = null;
				pendingReject = null;
				rejectFn(new Error(`Daemon exited with code ${code}`));
			}
		});

		child.on("error", (err) => {
			handle = null;
			child = null;
			if (pendingReject) {
				const rejectFn = pendingReject;
				pendingStart = null;
				pendingReject = null;
				rejectFn(err);
			}
		});
	});
}

/** Stop the daemon gracefully. */
export async function stopDaemon(): Promise<void> {
	if (!child) return;

	try {
		child.send({ type: "shutdown" } satisfies DaemonMessage);
	} catch {
		// Already dead
	}

	// Wait up to 5s for graceful exit
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			child?.kill("SIGKILL");
			resolve();
		}, 5000);

		child!.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
	});

	handle = null;
	child = null;
}

/** Get the current daemon handle, or null if not running. */
export function getDaemonHandle(): DaemonHandle | null {
	return handle;
}

/** Check if the daemon is currently running. */
export function isDaemonRunning(): boolean {
	return handle !== null && child !== null;
}