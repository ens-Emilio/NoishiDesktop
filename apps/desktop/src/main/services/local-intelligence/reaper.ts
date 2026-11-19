/**
 * Agent Computer Reaper.
 *
 * Monitors tool call activity and pauses the agent-computer container
 * after IDLE_TIMEOUT_MS of inactivity to free CPU. Unpauses transparently
 * on the next tool call.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CONTAINER_NAME = "openbot-desktop-agent-computer-1";
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const CHECK_INTERVAL_MS = 60 * 1000; // check every 1 minute

export interface ReaperState {
	containerState: "running" | "paused" | "stopped" | "unknown";
	lastToolCallAt: number;
}

let lastToolCallAt = Date.now();
let checkTimer: NodeJS.Timeout | null = null;
let currentState: ReaperState["containerState"] = "unknown";

async function getContainerState(): Promise<ReaperState["containerState"]> {
	try {
		const { stdout } = await execFileAsync("docker", [
			"inspect",
			"--format",
			"{{.State.Status}}",
			CONTAINER_NAME,
		]);
		const state = stdout.trim();
		if (state === "running") return "running";
		if (state === "paused") return "paused";
		return "stopped";
	} catch {
		return "unknown";
	}
}

async function pauseContainer(): Promise<void> {
	try {
		await execFileAsync("docker", ["pause", CONTAINER_NAME]);
		currentState = "paused";
		console.log("[reaper] agent-computer paused (idle)");
	} catch (err) {
		console.error("[reaper] Failed to pause:", err);
	}
}

async function unpauseContainer(): Promise<void> {
	try {
		await execFileAsync("docker", ["unpause", CONTAINER_NAME]);
		currentState = "running";
		console.log("[reaper] agent-computer unpaused");
	} catch (err) {
		console.error("[reaper] Failed to unpause:", err);
	}
}

/** Record a tool call timestamp (called by bridge on every TOOL_CALL_START). */
export function recordToolCall(): void {
	lastToolCallAt = Date.now();
}

/** Ensure the container is running before forwarding a tool call. */
export async function ensureRunning(): Promise<void> {
	if (currentState === "paused") {
		await unpauseContainer();
	} else if (currentState !== "running") {
		// Re-check actual state in case we lost track
		const actual = await getContainerState();
		if (actual === "paused") {
			await unpauseContainer();
		} else {
			currentState = actual;
		}
	}
}

/** Start the periodic idle checker. */
export function startReaper(): void {
	clearInterval(checkTimer!);
	checkTimer = setInterval(async () => {
		const idle = Date.now() - lastToolCallAt;
		if (idle > IDLE_TIMEOUT_MS) {
			const state = await getContainerState();
			currentState = state;
			if (state === "running") {
				await pauseContainer();
			}
		}
	}, CHECK_INTERVAL_MS);
}

/** Stop the reaper. */
export function stopReaper(): void {
	clearInterval(checkTimer!);
	checkTimer = null;
}

/** Get current reaper state for diagnostics. */
export async function getReaperState(): Promise<ReaperState> {
	const state = await getContainerState();
	currentState = state;
	return {
		containerState: state,
		lastToolCallAt,
	};
}