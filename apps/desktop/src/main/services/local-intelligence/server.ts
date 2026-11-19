/**
 * Local Intelligence AG-UI compatible HTTP server.
 *
 * Uses Hono for minimal footprint. Exposes SSE endpoints with Last-Event-ID
 * support for idempotent replay on reconnect. Integrates tool call execution
 * against the agent-computer container with audit logging, reaper management,
 * hybrid memory search, and skill mining.
 */

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import {
	closeDb,
	getEventsAfter,
	insertThreadEvent,
	upsertThread,
	type ThreadEvent,
} from "./db.js";
import { executeToolCall, type ToolCallRequest } from "./computer-bridge.js";
import { recordAudit } from "./audit.js";
import { startReaper, stopReaper } from "./reaper.js";
import { startBackfill, stopBackfill } from "./embedding-backfill.js";
import { addMemory, searchMemories, getMemoriesForThread } from "./memory.js";
import { mineSkill, approveSkill, rejectSkill, listSkills, getSkillContent } from "./skill-miner.js";

export interface ServerHandle {
	app: Hono;
	port: number;
	stop: () => Promise<void>;
}

/** Active SSE subscribers per thread_id. */
const subscribers = new Map<string, Set<(evt: ThreadEvent) => void>>();

/** Notify all SSE subscribers of a new event for a thread. */
export function broadcastEvent(threadId: string, evt: ThreadEvent): void {
	const subs = subscribers.get(threadId);
	if (!subs) return;
	for (const fn of subs) {
		try {
			fn(evt);
		} catch {
			// subscriber disconnected; will be cleaned up on next write
		}
	}
}

/** Create and start the intelligence server on a dynamic port. */
export async function startServer(): Promise<ServerHandle> {
	const app = new Hono();

	// Health check
	app.get("/health", (c) => c.json({ status: "ok" }));

	// --- Threads & Runs (AG-UI) ---

	app.post("/threads", async (c) => {
		const body = await c.req.json<{ title?: string; agent_id?: string }>();
		const id = randomUUID();
		const thread = upsertThread(id, { title: body.title, agentId: body.agent_id });
		return c.json({ id: thread.id, url: `/threads/${thread.id}/events` }, 201);
	});

	app.get("/threads/:id/events", (c) => {
		const threadId = c.req.param("id");
		const afterSeq = parseInt(c.req.query("after") ?? "0", 10);
		const events = getEventsAfter(threadId, afterSeq);
		return c.json(events);
	});

	app.post("/threads/:id/runs", async (c) => {
		const threadId = c.req.param("id");
		const runId = randomUUID();

		upsertThread(threadId, { status: "running" });

		const seq = insertThreadEvent(threadId, "RUN_STARTED", { runId });
		broadcastEvent(threadId, {
			id: seq,
			thread_id: threadId,
			sequence_num: seq,
			event_type: "RUN_STARTED",
			payload_json: JSON.stringify({ runId }),
			timestamp: Date.now(),
		});

		return c.json({ runId, streamUrl: `/threads/${threadId}/runs/${runId}/stream` }, 201);
	});

	app.get("/threads/:id/runs/:runId/stream", (c) => {
		const threadId = c.req.param("id");
		const lastEventId = c.req.header("Last-Event-ID");
		const lastSeq = parseInt(lastEventId ?? "0", 10);

		return streamSSE(c, async (stream) => {
			const missed = getEventsAfter(threadId, lastSeq);
			for (const evt of missed) {
				await stream.writeSSE({
					event: evt.event_type,
					data: evt.payload_json ?? "{}",
					id: String(evt.sequence_num),
				});
			}

			const onEvent = async (evt: ThreadEvent) => {
				try {
					await stream.writeSSE({
						event: evt.event_type,
						data: evt.payload_json ?? "{}",
						id: String(evt.sequence_num),
					});
				} catch {
					// stream closed
				}
			};

			let subs = subscribers.get(threadId);
			if (!subs) {
				subs = new Set();
				subscribers.set(threadId, subs);
			}
			subs.add(onEvent);

			stream.onAbort(() => {
				subs!.delete(onEvent);
				if (subs!.size === 0) subscribers.delete(threadId);
			});

			await new Promise<void>((resolve) => {
				stream.onAbort(() => resolve());
			});
		});
	});

	app.post("/threads/:id/events", async (c) => {
		const threadId = c.req.param("id");
		const body = await c.req.json<{ event_type: string; payload?: unknown }>();
		const seq = insertThreadEvent(threadId, body.event_type, body.payload ?? {});
		broadcastEvent(threadId, {
			id: seq,
			thread_id: threadId,
			sequence_num: seq,
			event_type: body.event_type,
			payload_json: JSON.stringify(body.payload ?? {}),
			timestamp: Date.now(),
		});
		return c.json({ sequence_num: seq }, 201);
	});

	// Mark thread finished and trigger skill mining
	app.post("/threads/:id/finish", async (c) => {
		const threadId = c.req.param("id");
		upsertThread(threadId, { status: "finished" });

		const seq = insertThreadEvent(threadId, "RUN_FINISHED", {});
		broadcastEvent(threadId, {
			id: seq,
			thread_id: threadId,
			sequence_num: seq,
			event_type: "RUN_FINISHED",
			payload_json: "{}",
			timestamp: Date.now(),
		});

		// Attempt skill mining (non-blocking)
		const draft = mineSkill(threadId);

		return c.json({ status: "finished", skillDraft: draft ? { id: draft.id, name: draft.name } : null });
	});

	// --- Tool Calls ---

	app.post("/threads/:id/runs/:runId/tools", async (c) => {
		const threadId = c.req.param("id");
		const runId = c.req.param("runId");
		const body = await c.req.json<{ tool: string; args: Record<string, unknown> }>();

		const startSeq = insertThreadEvent(threadId, "TOOL_CALL_START", { tool: body.tool, runId });
		broadcastEvent(threadId, {
			id: startSeq,
			thread_id: threadId,
			sequence_num: startSeq,
			event_type: "TOOL_CALL_START",
			payload_json: JSON.stringify({ tool: body.tool, runId }),
			timestamp: Date.now(),
		});

		const req: ToolCallRequest = { tool: body.tool, args: body.args, threadId, runId };
		const result = await executeToolCall(req);

		recordAudit({
			threadId,
			toolName: body.tool,
			args: body.args,
			resultSummary: result.success ? JSON.stringify(result.output).slice(0, 500) : result.error ?? null,
			approvedBy: null,
		});

		const endPayload = {
			tool: body.tool,
			success: result.success,
			output: result.output,
			error: result.error,
			durationMs: result.durationMs,
		};
		const endSeq = insertThreadEvent(threadId, "TOOL_CALL_END", endPayload);
		broadcastEvent(threadId, {
			id: endSeq,
			thread_id: threadId,
			sequence_num: endSeq,
			event_type: "TOOL_CALL_END",
			payload_json: JSON.stringify(endPayload),
			timestamp: Date.now(),
		});

		return c.json(result);
	});

	// --- Memory ---

	app.post("/memories", async (c) => {
		const body = await c.req.json<{
			content: string;
			category?: string;
			confidence?: number;
			thread_id?: string;
		}>();
		const id = await addMemory(body.content, {
			category: body.category,
			confidence: body.confidence,
			threadId: body.thread_id,
		});
		return c.json({ id }, 201);
	});

	app.get("/memories/search", async (c) => {
		const query = c.req.query("q") ?? "";
		const limit = parseInt(c.req.query("limit") ?? "5", 10);
		const category = c.req.query("category") ?? undefined;
		const results = await searchMemories(query, { limit, category });
		return c.json(results);
	});

	app.get("/threads/:id/memories", (c) => {
		const threadId = c.req.param("id");
		const limit = parseInt(c.req.query("limit") ?? "10", 10);
		const memories = getMemoriesForThread(threadId, limit);
		return c.json(memories);
	});

	// --- Skills ---

	app.get("/skills", (c) => {
		const status = c.req.query("status") as "pending" | "active" | "rejected" | undefined;
		const skills = listSkills(status);
		return c.json(skills);
	});

	app.get("/skills/:id", (c) => {
		const skillId = c.req.param("id");
		const content = getSkillContent(skillId);
		if (!content) return c.json({ error: "not found" }, 404);
		return c.text(content, 200, { "Content-Type": "text/markdown" });
	});

	app.post("/skills/:id/approve", (c) => {
		const skillId = c.req.param("id");
		const ok = approveSkill(skillId);
		if (!ok) return c.json({ error: "not found or not pending" }, 404);
		return c.json({ status: "approved" });
	});

	app.delete("/skills/:id", (c) => {
		const skillId = c.req.param("id");
		const ok = rejectSkill(skillId);
		if (!ok) return c.json({ error: "not found or not pending" }, 404);
		return c.json({ status: "rejected" });
	});

	// --- Lifecycle ---

	const nodeServer: ServerType = serve({
		fetch: app.fetch,
		port: 0,
		hostname: "127.0.0.1",
	});

	// Wait for server to actually bind before reading port
	await new Promise<void>((resolve) => {
		nodeServer.once("listening", () => resolve());
	});

	const addr = nodeServer.address();
	const port = typeof addr === "object" && addr !== null ? addr.port : 0;

	startReaper();
	startBackfill();

	const handle: ServerHandle = {
		app,
		port,
		stop: async () => {
			stopReaper();
			stopBackfill();
			nodeServer.close();
			closeDb();
			subscribers.clear();
		},
	};

	return handle;
}