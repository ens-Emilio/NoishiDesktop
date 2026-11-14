/**
 * Session host: one pi RPC subprocess per session.
 *
 * Owns a ThinRpcClient (JSONL on the CLI's stdio) and translates the desktop
 * IPC contract onto the pi RPC protocol. Extension UI responses are written
 * as raw JSONL on the subprocess stdin.
 */

import type {
	AgentEvent,
	ExtensionUiRequest,
	ExtensionUiResponse,
	SessionCommand,
	SessionCommandResult,
	SessionState,
	UsageSnapshot,
} from "@noishi/rpc-bridge";
import type { CliResolution } from "@noishi/noishi-sdk";
import { ThinRpcClient, type RpcEvent } from "./thin-rpc-client.js";
import { listSessions, newestSessionFile } from "./session-files.js";

type Subscriber = {
	windowId: number;
	onEvent: (event: AgentEvent) => void;
	onExtensionUi: (request: ExtensionUiRequest) => void;
};

const USAGE_ZERO: UsageSnapshot = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { total: 0, input: 0, output: 0 },
};

function isUsageRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageFrom(raw: Record<string, unknown>): UsageSnapshot {
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function translateEvent(raw: RpcEvent): AgentEvent | null {
	switch (raw.type) {
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end":
			return { type: "agent_end", aborted: Boolean(raw.willRetry) };
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

function translateExtensionUi(raw: RpcEvent): ExtensionUiRequest | null {
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

export class SessionHost {
	private client: ThinRpcClient | null = null;
	private readonly subscribers = new Map<number, Subscriber>();
	private cwd: string;
	private readonly cli: CliResolution;

	constructor(cli: CliResolution, cwd?: string) {
		this.cli = cli;
		this.cwd = cwd ?? process.env.HOME ?? "/";
	}

	subscribe(windowId: number, onEvent: (event: AgentEvent) => void, onExtensionUi: (request: ExtensionUiRequest) => void): void {
		this.subscribers.set(windowId, { windowId, onEvent, onExtensionUi });
	}

	hasSubscriber(windowId: number): boolean {
		return this.subscribers.has(windowId);
	}

	private async ensureClient(): Promise<ThinRpcClient> {
		if (this.client) return this.client;
		const entryArg = this.cli.args[0];
		if (entryArg === undefined) {
			throw new Error("noishi JS entry not found; set NOISHI_CLI_ROOT to the NoishiCLI checkout");
		}
		const client = new ThinRpcClient({
			entryPath: entryArg,
			cwd: this.cwd,
			provider: "ghostcli",
			model: "claude-opus-5-5",
		});
		client.onEvent((raw) => this.dispatchRawEvent(raw));
		await client.start();
		this.client = client;
		return client;
	}

	private dispatchRawEvent(raw: RpcEvent): void {
		if (raw.type === "extension_ui_request") {
			const request = translateExtensionUi(raw);
			if (request) for (const sub of this.subscribers.values()) sub.onExtensionUi(request);
			return;
		}
		const event = translateEvent(raw);
		if (event) for (const sub of this.subscribers.values()) sub.onEvent(event);
	}

	async runCommand(command: SessionCommand): Promise<SessionCommandResult> {
		try {
			const client = await this.ensureClient();
			const data = await this.dispatch(client, command);
			return { ok: true, data };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async dispatch(client: ThinRpcClient, command: SessionCommand): Promise<unknown> {
		switch (command.type) {
			case "prompt":
				return client.send({ type: "prompt", message: command.message });
			case "steer":
				return client.send({ type: "steer", message: command.message });
			case "followUp":
				return client.send({ type: "follow_up", message: command.message });
			case "abort":
				return client.send({ type: "abort" });
			case "newSession":
				return client.send({ type: "new_session" });
			case "getState":
				return client.send({ type: "get_state" });
			case "getModels":
				return client.send({ type: "get_available_models" });
			case "setModel":
				return client.send({ type: "set_model", provider: command.provider, modelId: command.modelId });
			case "setThinkingLevel":
				return client.send({ type: "set_thinking_level", level: command.level });
			case "getStats":
				return client.send({ type: "get_session_stats" });
			case "compact":
				return client.send({ type: "compact", customInstructions: command.customInstructions });
			case "fork":
				return client.send({ type: "fork", entryId: command.entryId });
			case "clone":
				return client.send({ type: "clone" });
			case "exportHtml":
				return client.send({ type: "export_html", outputPath: command.outputPath });
			case "switchSession":
				return client.send({ type: "switch_session", sessionPath: command.sessionPath });
			case "getEntries":
				return client.send({ type: "get_entries", since: command.since });
			case "setTitle":
				return client.send({ type: "set_session_name", name: command.title });
			case "listSessions":
				return this.listSessions();
			case "startIn":
				await this.restartIn(command.cwd);
				return { cwd: this.cwd };
		}
	}

	private listSessions(): Promise<Array<unknown>> {
		return listSessions(this.cwd);
	}

	/** Restart the RPC child in a new cwd (session-per-project model). */
	private async restartIn(cwd: string): Promise<void> {
		const client = this.client;
		this.client = null;
		await client?.stop();
		this.cwd = cwd;
		await this.ensureClient();
	}

	answerExtensionUi(response: ExtensionUiResponse): void {
		this.client?.answerExtensionUi(response);
	}

	disposeAll(): void {
		const client = this.client;
		this.client = null;
		this.subscribers.clear();
		void client?.stop();
	}
}
