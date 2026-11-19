/**
 * Agent Computer Bridge.
 *
 * Forwards tool calls to the OpenBot agent-computer container via HTTP,
 * using the shared COMPUTER_TOKEN for authentication. Handles pause/unpause
 * transparently through the reaper.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureRunning, recordToolCall } from "./reaper.js";

const COMPUTER_PORT = 4100;
const COMPUTER_BASE = `http://127.0.0.1:${COMPUTER_PORT}`;
const TOKEN_PATH = join(homedir(), ".noishi", "openbot", "secrets", "computer_token");

let cachedToken: string | null = null;

function getComputerToken(): string {
	if (cachedToken) return cachedToken;
	try {
		cachedToken = readFileSync(TOKEN_PATH, "utf-8").trim();
	} catch {
		throw new Error(`Cannot read computer token at ${TOKEN_PATH}. Is the OpenBot stack deployed?`);
	}
	return cachedToken;
}

export interface ToolCallRequest {
	tool: string;
	args: Record<string, unknown>;
	threadId: string;
	runId: string;
}

export interface ToolCallResult {
	success: boolean;
	output: unknown;
	error?: string;
	durationMs: number;
}

/** Forward a tool call to the agent-computer and return the result. */
export async function executeToolCall(req: ToolCallRequest): Promise<ToolCallResult> {
	const start = Date.now();

	// Ensure container is running (unpause if needed)
	await ensureRunning();

	// Record activity for reaper
	recordToolCall();

	const token = getComputerToken();

	try {
		const res = await fetch(`${COMPUTER_BASE}/api/tools/${req.tool}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"X-Thread-Id": req.threadId,
				"X-Run-Id": req.runId,
			},
			body: JSON.stringify(req.args),
			signal: AbortSignal.timeout(120_000), // 2 min timeout per tool call
		});

		const durationMs = Date.now() - start;

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			return {
				success: false,
				output: null,
				error: `agent-computer returned ${res.status}: ${text}`,
				durationMs,
			};
		}

		const output = await res.json().catch(() => null);
		return { success: true, output, durationMs };
	} catch (err) {
		const durationMs = Date.now() - start;
		return {
			success: false,
			output: null,
			error: err instanceof Error ? err.message : String(err),
			durationMs,
		};
	}
}

/** Health check for the agent-computer container. */
export async function isComputerHealthy(): Promise<boolean> {
	try {
		const res = await fetch(`${COMPUTER_BASE}/health`, {
			signal: AbortSignal.timeout(3000),
		});
		return res.ok;
	} catch {
		return false;
	}
}