/**
 * Typed IPC contract for Noishi Desktop.
 *
 * The renderer talks to the main process over contextBridge channels defined
 * here. The main process owns RpcClient instances (one per session) from the
 * NoishiCLI checkout and translates this contract onto the pi RPC protocol.
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
/** Tool-approval policy shared by prefs and the review UI (feature 5). */
export type ApprovalRule = {
	/** Tool name the rule applies to ("bash", "write", "edit", …). */
	tool: string;
	/** Optional glob over the tool's path/command argument. */
	pattern?: string;
	decision: "allow" | "deny" | "ask";
};

/** Rebindable accelerator (feature 45). */
export type Shortcut = { action: string; accelerator: string };


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
	| { type: "sandboxBoot" }
	| { type: "sandboxExec"; command: string; cwd?: string }
	| { type: "sandboxStatus" }
	| { type: "sandboxTask"; command: string; cwd?: string; name?: string }
	| { type: "sandboxArtifact"; artifactId: string }
	| { type: "sandboxAllowlist"; domains: string[] }
	| { type: "sandboxShutdown" }
	| { type: "installPackage"; path: string }
	| { type: "listInstalled" }
	| { type: "setServerEnabled"; name: string; enabled: boolean }
	| { type: "removePackage"; kind: "skill" | "mcp"; name: string }
	| { type: "startIn"; cwd: string }
	| { type: "getEntries"; since?: string }
	| { type: "setTitle"; title: string }
	// --- preferences ---
	| { type: "getPrefs" }
	| { type: "setPrefs"; patch: Record<string, unknown> }
	// --- workspace / files ---
	| { type: "readTree"; root: string; maxDepth?: number }
	| { type: "searchFiles"; root: string; query: string }
	| { type: "openFile"; path: string }
	| { type: "searchSessions"; query: string }
	| { type: "setSessionFolder"; sessionPath: string; folder: string | null; tags?: string[] }
	| { type: "listFolders" }
	// --- git ---
	| { type: "gitStatus"; cwd: string }
	| { type: "gitDiff"; cwd: string; path: string; staged: boolean }
	| { type: "gitStage"; cwd: string; paths: string[] }
	| { type: "gitUnstage"; cwd: string; paths: string[] }
	| { type: "gitDiscard"; cwd: string; path: string }
	| { type: "gitCommit"; cwd: string; message: string; paths?: string[] }
	| { type: "gitWorktrees"; cwd: string }
	| { type: "gitAddWorktree"; cwd: string; path: string; branch: string; createBranch: boolean }
	| { type: "gitBlame"; cwd: string; path: string }
	| { type: "gitConflicts"; cwd: string; path: string }
	| { type: "gitResolveConflict"; cwd: string; path: string; choice: "ours" | "theirs" }
	| { type: "gitCommitSession"; cwd: string; message: string; sessionId: string }
	| { type: "gitWorktreeForSession"; cwd: string; sessionId: string }
	// --- review / diff ---
	| { type: "applyDiff"; cwd: string; path: string; patch: string }
	| { type: "sessionDiff"; sessionId: string }
	| { type: "getApprovalRules" }
	| { type: "setApprovalRules"; rules: ApprovalRule[] }
	// --- checkpoints ---
	| { type: "snapshotFile"; sessionId: string; entryId: string; path: string }
	| { type: "revertFile"; sessionId: string; entryId: string; path: string }
	| { type: "rewindTo"; sessionId: string; entryId: string }
	| { type: "sessionChanges"; sessionId: string }
	| { type: "listCheckpoints"; sessionId: string }
	// --- prompts ---
	| { type: "rememberPrompt"; text: string }
	| { type: "savePrompt"; title: string; body: string }
	| { type: "deletePrompt"; id: string }
	// --- sandbox extras ---
	| { type: "sandboxSetLimits"; maxCpu: number; maxMemoryMb: number; maxSeconds: number }
	| { type: "sandboxWorkspaceDiff" }
	| { type: "sandboxSnapshot"; name: string }
	| { type: "sandboxRestoreSnapshot"; name: string }
	| { type: "sandboxListSnapshots" }
	| { type: "sandboxSchedule"; command: string; everySeconds: number }
	| { type: "sandboxUnschedule"; id: string }
	// --- system ---
	| { type: "checkForUpdates" }
	| { type: "cliVersionCheck" }
	| { type: "diagnostics" }
	| { type: "saveTheme"; theme: Record<string, string> }
	| { type: "listThemes" }
	| { type: "reportCrash"; message: string; stack?: string }
	| { type: "recentCrashes" }
	| { type: "setTelemetry"; enabled: boolean; endpoint: string | null }
	| { type: "setZoom"; level: number }
	| { type: "getZoom" }
	| { type: "windowControl"; action: "minimize" | "maximize" | "close" }
	| { type: "windowState" }
	| { type: "setShortcuts"; shortcuts: Shortcut[] }
	| { type: "importTheme"; path: string }
	| { type: "applyTheme"; name: string }
	| { type: "trayBadge"; count: number }
	| { type: "openExternal"; url: string }
	// --- context / cost / session portability ---
	| { type: "sessionCost"; sessionPath: string }
	| { type: "contextBreakdown"; sessionPath: string; contextWindow?: number }
	| { type: "exportMarkdown"; sessionPath: string; outputPath?: string }
	| { type: "exportPdf"; sessionPath: string }
	| { type: "portSession"; sessionPath: string; cwd: string }
	| { type: "sessionTranscript"; sessionPath: string }
	// --- sandbox extras ---
	| { type: "sandboxInstances" }
	| { type: "sandboxCreateInstance"; name: string }
	| { type: "sandboxDestroyInstance"; id: string }
	| { type: "sandboxProvision"; toolchain: string[] }
	// --- voice ---
	| { type: "transcribe"; audioBase64: string; mime: string };

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
	/** Working directory the session runs in (also the terminal's cwd). */
	cwd?: string;
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
	/** "dark" | "light" — from nativeTheme.shouldUseDarkColors */
	theme: "dark" | "light";
	/** Resolved noishi CLI path used for session spawning. */
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
	sessionCommand: "noishi:session-command",
	sessionEvent: "noishi:session-event",
	extensionUiRequest: "noishi:extension-ui-request",
	extensionUiResponse: "noishi:extension-ui-response",
	getEnv: "noishi:get-env",
	getTheme: "noishi:get-theme",
	ptyCreate: "noishi:pty-create",
	ptyWrite: "noishi:pty-write",
	ptyResize: "noishi:pty-resize",
	ptyData: "noishi:pty-data",
	ptyExit: "noishi:pty-exit",
	themeChanged: "noishi:theme-changed",
	sandboxEvent: "noishi:sandbox-event",
	openMain: "noishi:open-main",
	findQuery: "noishi:find-query",
	findOpen: "noishi:find-open",
	findResult: "noishi:find-result",
	onEnv: "noishi:on-env",
	themeTokens: "noishi:theme-tokens",
	sandboxTtyOpen: "noishi:sandbox-tty-open",
	sandboxTtyWrite: "noishi:sandbox-tty-write",
	sandboxTtyClose: "noishi:sandbox-tty-close",
	sandboxTtyData: "noishi:sandbox-tty-data",
} as const;

/** Full window API surface exposed through contextBridge (window.noishi). */
/** Routes the main process pushes to the renderer (deep links, page shares). */
export type DeepLinkPayload =
	| { kind: "chat/new" }
	| { kind: "chat/share"; prompt: string }
	| { kind: "code/new"; cwd?: string }
	| { kind: "code/continue" }
	| { kind: "code/needs-input" }
	| { kind: "buddy"; cwd?: string }
	| { kind: "cowork/shared-artifact"; artifactId?: string };

export type NoishiBridge = {
	getEnv(): Promise<DesktopEnv>;
	getTheme(): Promise<"dark" | "light">;
	onThemeChange(listener: (theme: "dark" | "light") => void): () => void;
	/** Custom theme tokens pushed by the main process (feature 46). */
	onThemeTokens(listener: (tokens: Record<string, string>) => void): () => void;
	/** Interactive shell inside the sandbox VM (feature 41). */
	sandboxTty: {
		open(cols: number, rows: number): Promise<{ ok: boolean; error?: string }>;
		write(data: string): void;
		close(): void;
		onData(listener: (data: string) => void): () => void;
	};
	pty: {
		create(cwd: string, cols: number, rows: number): Promise<{ id: number; cwd: string }>;
		write(data: string): void;
		resize(cols: number, rows: number): void;
		onData(listener: (data: string) => void): () => void;
		onExit(listener: (exitCode: number) => void): () => void;
	};
	runSessionCommand(command: SessionCommand): Promise<SessionCommandResult>;
	onSessionEvent(listener: (event: AgentEvent) => void): () => void;
	onSandboxEvent(listener: (event: { type: string; detail?: string }) => void): () => void;
	onExtensionUiRequest(listener: (request: ExtensionUiRequest) => void): () => void;
	answerExtensionUi(response: ExtensionUiResponse): void;
	onDeepLinkRoute(listener: (route: DeepLinkPayload) => void): () => void;
	/** Bring the main window to front (used by the quick window's expand button). */
	openMainWindow(): void;
	find: {
		/** Run a search; forward=false goes to the previous match. */
		query(text: string, forward?: boolean): void;
		/** Clear the search and its highlight. */
		clear(): void;
		onOpen(listener: () => void): () => void;
		onResult(listener: (result: { query: string; matches: number; active: number }) => void): () => void;
	};
};
