/**
 * pi RPC -> desktop bridge translation.
 *
 * Kept free of Electron imports so the contract fixtures (probe/rpc-contract.mjs)
 * can exercise it under plain Node. This is the one place where an upstream
 * protocol change silently breaks the UI: a renamed field yields `undefined`
 * and the renderer shows blanks.
 */

import type { AgentEvent, ExtensionUiRequest, UsageSnapshot } from "@noishi/rpc-bridge";

export type RpcEvent = Record<string, unknown>;

function isUsageRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function usageFrom(raw: Record<string, unknown>): UsageSnapshot {
	const cost = isUsageRecord(raw.cost) ? raw.cost : {};
	return {
		input: Number(raw.input ?? 0),
		output: Number(raw.output ?? 0),
		cacheRead: Number(raw.cacheRead ?? 0),
		cacheWrite: Number(raw.cacheWrite ?? 0),
		totalTokens: Number(raw.totalTokens ?? 0),
		cost: {
			total: Number(cost.total ?? 0),
			input: Number(cost.input ?? 0),
			output: Number(cost.output ?? 0),
		},
	};
}

export function translateEvent(raw: RpcEvent): AgentEvent | null {
	switch (raw.type) {
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end":
			return { type: "agent_end", aborted: Boolean(raw.aborted) };
		case "agent_settled":
			return { type: "agent_settled", aborted: Boolean(raw.aborted) };
		case "turn_start":
			return { type: "turn_start" };
		case "turn_end":
			return { type: "turn_end" };
		case "bash_execution_update":
			return { type: "bash_execution_update", delta: String(raw.delta ?? "") };
		case "compaction_start":
			return { type: "compaction_start", reason: String(raw.reason ?? "manual") };
		case "compaction_end":
			return { type: "compaction_end", aborted: Boolean(raw.aborted), willRetry: Boolean(raw.willRetry) };
		case "message_update":
			if (!isRecord(raw.usage) || !isRecord(raw.assistantMessageEvent)) return null;
			return {
				type: "message_update",
				event: raw.assistantMessageEvent as never,
				usage: usageFrom(raw.usage),
			};
		case "entry_appended":
			return { type: "entry_appended", entry: raw.entry };
		case "session_info_changed":
			return { type: "session_info_changed", name: typeof raw.name === "string" ? raw.name : undefined };
		default:
			return null;
	}
}

export function translateExtensionUi(raw: RpcEvent): ExtensionUiRequest | null {
	const method = raw.method;
	const id = raw.id;
	if (typeof id !== "string" || typeof method !== "string") return null;
	switch (method) {
		case "select":
			return { id, method, title: String(raw.title ?? ""), options: Array.isArray(raw.options) ? raw.options.map(String) : [] };
		case "confirm":
			return { id, method, title: String(raw.title ?? ""), message: String(raw.message ?? "") };
		case "input":
			return {
				id,
				method,
				title: String(raw.title ?? ""),
				placeholder: typeof raw.placeholder === "string" ? raw.placeholder : undefined,
			};
		case "notify":
			return {
				id,
				method,
				message: String(raw.message ?? ""),
				notifyType: raw.notifyType === "warning" || raw.notifyType === "error" ? raw.notifyType : "info",
			};
		case "editor":
			return { id, method, title: String(raw.title ?? ""), prefill: typeof raw.prefill === "string" ? raw.prefill : undefined };
		case "setStatus":
			return {
				id,
				method,
				statusKey: String(raw.statusKey ?? ""),
				statusText: typeof raw.statusText === "string" ? raw.statusText : undefined,
			};
		case "setWidget":
			return {
				id,
				method,
				widgetKey: String(raw.widgetKey ?? ""),
				widgetLines: Array.isArray(raw.widgetLines) ? raw.widgetLines.map(String) : undefined,
				widgetPlacement: typeof raw.widgetPlacement === "string" ? raw.widgetPlacement : undefined,
			};
		case "setTitle":
			return { id, method, title: String(raw.title ?? "") };
		default:
			return null;
	}
}
