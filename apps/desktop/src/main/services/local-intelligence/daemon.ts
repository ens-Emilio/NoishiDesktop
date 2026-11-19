/**
 * Local Intelligence Daemon entry point.
 *
 * Runs as a child process forked from the Electron main process.
 * Communicates via IPC:
 *   Parent → Child: { type: "shutdown" }
 *   Child → Parent: { type: "ready", port: number }
 *
 * Implements idle timeout: shuts down after IDLE_TIMEOUT_MS without requests.
 */

import { startServer, type ServerHandle } from "./server.js";

export interface DaemonMessage {
	type: "ready" | "error" | "shutdown";
	port?: number;
	message?: string;
}

const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

let server: ServerHandle | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function resetIdleTimer(): void {
	clearTimeout(idleTimer!);
	idleTimer = setTimeout(async () => {
		console.log("[local-intelligence] Idle timeout reached, shutting down.");
		await shutdown();
	}, IDLE_TIMEOUT_MS);
}

async function shutdown(): Promise<void> {
	clearTimeout(idleTimer!);
	idleTimer = null;
	if (server) {
		await server.stop();
		server = null;
	}
	process.exit(0);
}

// Listen for parent messages
process.on("message", async (msg: DaemonMessage) => {
	if (msg?.type === "shutdown") {
		await shutdown();
	}
});

// Reset idle timer on any IPC message (acts as keepalive)
process.on("message", () => {
	resetIdleTimer();
});

// Graceful exit on signals
process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());

// Unhandled errors should not crash silently
process.on("uncaughtException", (err) => {
	console.error("[local-intelligence] Uncaught exception:", err);
	shutdown();
});

async function main(): Promise<void> {
	try {
		server = await startServer();

		// Notify parent that we're ready with the assigned port
		const readyMsg: DaemonMessage = { type: "ready", port: server.port };
		if (process.send) {
			process.send(readyMsg);
		} else {
			// Fallback for direct execution during development
			console.log(`[local-intelligence] Ready on port ${server.port}`);
		}

		console.log(`[local-intelligence] Server started on 127.0.0.1:${server.port}`);
		resetIdleTimer();
	} catch (err) {
		console.error("[local-intelligence] Failed to start:", err);
		const errMsg: DaemonMessage = {
			type: "error",
			message: err instanceof Error ? err.message : String(err),
		};
		if (process.send) {
			process.send(errMsg);
		}
		process.exit(1);
	}
}

main();