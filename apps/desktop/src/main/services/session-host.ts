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
} from "@noishi/rpc-bridge";
import type { CliResolution } from "@noishi/noishi-sdk";
import { ThinRpcClient } from "./thin-rpc-client.js";
import { translateEvent, translateExtensionUi, type RpcEvent } from "./rpc-translate.js";
import { listSessions } from "./session-files.js";
import { snapshotFile } from "./checkpoints.js";

type Subscriber = {
	windowId: number;
	onEvent: (event: AgentEvent) => void;
	onExtensionUi: (request: ExtensionUiRequest) => void;
};


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
		// Checkpoints: the args of a write/edit tool call are complete at
		// toolcall_end and the tool has not run yet, so the file on disk is
		// still the pre-image. That is the moment to snapshot it (features 1-4).
		this.trackToolCall(raw);
		const event = translateEvent(raw);
		if (event) for (const sub of this.subscribers.values()) sub.onEvent(event);
	}

	/** Args accumulate across toolcall_delta; end marks the pre-execution point. */
	private pendingArgs = new Map<string, string>();
	private turnEntryId: string | null = null;

	private trackToolCall(raw: RpcEvent): void {
		if (raw.type === "turn_start") {
			this.turnEntryId = `turn-${Date.now().toString(36)}`;
			return;
		}
		if (raw.type !== "message_update") return;
		const stream = raw.assistantMessageEvent as Record<string, unknown> | undefined;
		if (!stream || typeof stream.type !== "string") return;
		const key = String(stream.contentIndex ?? "");
		if (stream.type === "toolcall_start") {
			this.pendingArgs.set(key, String(stream.toolName ?? ""));
			return;
		}
		if (stream.type === "toolcall_delta") {
			this.pendingArgs.set(key, `${this.pendingArgs.get(key) ?? ""}${String(stream.delta ?? "")}`);
			return;
		}
		if (stream.type !== "toolcall_end") return;
		const buffered = this.pendingArgs.get(key) ?? "";
		this.pendingArgs.delete(key);
		const split = buffered.indexOf("{");
		if (split < 0) return;
		const toolName = buffered.slice(0, split);
		if (toolName !== "write" && toolName !== "edit" && toolName !== "patch") return;
		let args: Record<string, unknown>;
		try {
			args = JSON.parse(buffered.slice(split)) as Record<string, unknown>;
		} catch {
			return;
		}
		const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
		if (!path || !this.sessionId || !this.turnEntryId) return;
		try {
			snapshotFile(this.sessionId, this.turnEntryId, path);
		} catch {
			// A checkpoint that cannot be taken must not break the turn.
		}
	}

	/** Session id reported by the agent, used as the checkpoint namespace. */
	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
	}

	private sessionId: string | null = null;

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
			case "getState": {
				const state = await client.send({ type: "get_state" });
				if (typeof state === "object" && state !== null) {
					const id = (state as Record<string, unknown>).sessionId;
					if (typeof id === "string") this.sessionId = id;
					return { ...state, cwd: this.cwd };
				}
				return state;
			}
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
