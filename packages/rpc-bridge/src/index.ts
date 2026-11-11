/**
 * Typed IPC contract for Noushi Desktop.
 *
 * The renderer talks to the main process over contextBridge channels defined
 * here. The main process owns RpcClient instances (one per session) from the
 * NoushiCLI checkout and translates this contract onto the pi RPC protocol.
 *
 * Keep payloads minimal and serializable: no classes, no functions.
 */

// ---------------------------------------------------------------------------
// Agent events (pi RPC stdout -> renderer)
// ---------------------------------------------------------------------------

/** Subset of the pi JsonAgentSessionEvent union the renderer consumes. */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; aborted: boolean }
	| { type: "agent_settled"; aborted: boolean }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "auto_compaction_start"; reason: string }
	| { type: "compaction_start"; reason: string }
	| { type: "compaction_end"; aborted: boolean; willRetry: boolean }
	| { type: "bash_execution_update"; id?: string; delta: string }
	| { type: "message_update"; event: AssistantStreamEvent; usage: UsageSnapshot }
	| { type: "entry_appended"; entry: unknown }
	| { type: "session_info_changed"; name?: string };

export type UsageSnapshot = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number; input: number; output: number };
};

export type AssistantStreamEvent =
	| { type: "message_start"; message: unknown }
	| { type: "message_end"; message: unknown }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number };

// ---------------------------------------------------------------------------
// Session commands (renderer -> main -> pi RPC stdin)
// ---------------------------------------------------------------------------

export type SessionCommand =
	| { type: "prompt"; message: string }
	| { type: "steer"; message: string }
	| { type: "followUp"; message: string }
	| { type: "abort" }
	| { type: "newSession" }
	| { type: "getState" }
	| { type: "getModels" }
	| { type: "setModel"; provider: string; modelId: string }
	| { type: "setThinkingLevel"; level: string }
	| { type: "getStats" }
	| { type: "compact"; customInstructions?: string }
	| { type: "fork"; entryId: string }
	| { type: "clone" }
	| { type: "exportHtml"; outputPath?: string }
	| { type: "switchSession"; sessionPath: string }
	| { type: "listSessions" }
	| { type: "startIn"; cwd: string }
	| { type: "getEntries"; since?: string };

export type SessionCommandResult =
	| { ok: true; data: unknown }
	| { ok: false; error: string };

/** Snapshot mirrored from the pi RpcSessionState. */
export type SessionState = {
	sessionId: string;
	sessionName?: string;
	model?: { id: string; name?: string; provider: string; contextWindow?: number };
	thinkingLevel?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	messageCount: number;
	sessionFile?: string;
};

// ---------------------------------------------------------------------------
// Extension UI requests (pi -> renderer dialogs)
// ---------------------------------------------------------------------------

export type ExtensionUiRequest =
	| { id: string; method: "select"; title: string; options: string[] }
	| { id: string; method: "confirm"; title: string; message: string }
	| { id: string; method: "input"; title: string; placeholder?: string }
	| { id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
	| { id: string; method: "editor"; title: string; prefill?: string }
	| { id: string; method: "setStatus"; statusKey: string; statusText?: string }
	| { id: string; method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: string }
	| { id: string; method: "setTitle"; title: string };

export type ExtensionUiResponse =
	| { id: string; value: string }
	| { id: string; confirmed: boolean }
	| { id: string; cancelled: true };

// ---------------------------------------------------------------------------
// App-level
// ---------------------------------------------------------------------------

export type DesktopEnv = {
	appVersion: string;
	platform: NodeJS.Platform;
	/** Resolved noushi CLI path used for session spawning. */
	cliPath: string | null;
	cliVersion: string | null;
};

export type SessionListItem = {
	sessionFile: string;
	sessionId: string;
	name?: string;
	modifiedAt: string;
	messageCount?: number;
};

/** Channel names, prefixed to keep the surface obvious in devtools. */
export const CHANNELS = {
	sessionCommand: "noushi:session-command",
	sessionEvent: "noushi:session-event",
	extensionUiRequest: "noushi:extension-ui-request",
	extensionUiResponse: "noushi:extension-ui-response",
	getEnv: "noushi:get-env",
	onEnv: "noushi:on-env",
} as const;

/** Full window API surface exposed through contextBridge (window.noushi). */
export type NoushiBridge = {
	getEnv(): Promise<DesktopEnv>;
	runSessionCommand(command: SessionCommand): Promise<SessionCommandResult>;
	onSessionEvent(listener: (event: AgentEvent) => void): () => void;
	onExtensionUiRequest(listener: (request: ExtensionUiRequest) => void): () => void;
	answerExtensionUi(response: ExtensionUiResponse): void;
	onDeepLinkRoute(listener: (route: { kind: string }) => void): () => void;
};
