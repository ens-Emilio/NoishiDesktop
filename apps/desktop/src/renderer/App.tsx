import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, DesktopEnv, ExtensionUiRequest, NoishiBridge, SessionCommandResult, SessionListItem, SessionState } from "@noishi/rpc-bridge";

type ToolArgs = { raw: string };

type ChatBlock =
	| { kind: "text"; id: number; role: "user" | "assistant"; content: string; streaming: boolean; entryId?: string }
	| { kind: "thinking"; id: number; content: string; streaming: boolean }
	| { kind: "tool"; id: number; toolName: string; args: string; output: string; streaming?: boolean }
	| { kind: "error"; id: number; message: string; info?: boolean };

type StatusWidget = { key: string; lines: string[] };

type Mode = "main" | "buddy" | "quick" | "artifact";

let blockSeq = 0;
const nextId = (): number => ++blockSeq;

function modeFromQuery(): Mode {
	const q = new URLSearchParams(window.location.search).get("window");
	return q === "buddy" || q === "quick" || q === "artifact" ? q : "main";
}

/* ------------------------------------------------------------------ */
/* Ícones (subset do sprite do design system)                          */
/* ------------------------------------------------------------------ */
const Icon = ({ d, size = 14, className }: { d: string; size?: number; className?: string }) => (
	<svg className={`ic ${className ?? ""}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d={d} />
	</svg>
);

const ICONS = {
	send: "M8 13V3M3.5 7.5 8 3l4.5 4.5",
	stop: "M4 4h8v8H4z",
	clone: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
	compress: "M3 6h10M3 10h10",
	export: "M8 10V3M5 6l3-3 3 3M3 12h10",
	cpu: "M5 5h6v6H5zM6.5 2v3M9.5 2v3M6.5 11v3M9.5 11v3M2 6.5h3M2 9.5h3M11 6.5h3M11 9.5h3",
	fork: "M4 3v5a3 3 0 0 0 3 3h5M9.5 8.5 12 11l-2.5 2.5",
	copy: "M5.5 5.5h6v6h-6zM4.5 10.5h-1v-6h6v1",
	edit: "M11.5 2.5 13.5 4.5 6 12H4v-2z",
	plus: "M8 3v10M3 8h10",
	folder: "M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z",
	panel: "M2.5 3.5h11v9h-11zM6 3.5v9",
	spark: "M8 2.5 9.4 6.6 13.5 8 9.4 9.4 8 13.5 6.6 9.4 2.5 8 6.6 6.6z",
	terminal: "M3 4.5 6 8l-3 3.5M8 12h5",
	check: "M3.5 8.5 6.5 11.5 12.5 4.5",
	chevronDown: "M3.5 6 8 10.5 12.5 6",
	expand: "M6 3.5H3.5V6M10 12.5h2.5V10M3.5 3.5 7 7M12.5 12.5 9 9",
	pin: "M6 2.5h4M8 2.5v5l2 2v1H6v-1l2-2zM8 10.5v3",
	x: "M4 4l8 8M12 4l-8 8",
	alert: "M8 2.5 14 13H2zM8 6.5v3M8 11.3v.2",
	file: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
	share: "M6 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM14 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM6 7 10 5M6 9l4 2",
};

const Mark = ({ size = 22 }: { size?: number }) => (
	<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
		<rect x="1" y="1" width="22" height="22" rx="7" fill="none" stroke="currentColor" strokeOpacity=".28" />
		<path d="M7.6 17V7l8.8 10V7" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="square" />
		<circle cx="16.4" cy="17" r="1.5" fill="var(--accent)" />
	</svg>
);

/* ------------------------------------------------------------------ */
/* Diff derivado dos argumentos da tool                                */
/* ------------------------------------------------------------------ */
type DiffLine = { n: string; text: string; kind: "" | "add" | "del" };

function parseArgs(raw: string): Record<string, unknown> | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	try {
		const value = JSON.parse(trimmed) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** `edit` → −oldText/+newText per edit; `write` → all additions. */
function diffFromTool(toolName: string, raw: string): { file: string; lines: DiffLine[]; add: number; del: number } | null {
	const args = parseArgs(raw);
	if (!args) return null;
	const file = readString(args.path) ?? readString(args.file_path) ?? "";
	if (toolName === "edit") {
		const edits = Array.isArray(args.edits) ? args.edits : [];
		const rows: DiffLine[] = [];
		let add = 0;
		let del = 0;
		for (const edit of edits) {
			if (typeof edit !== "object" || edit === null) continue;
			const rec = edit as Record<string, unknown>;
			const oldText = readString(rec.oldText) ?? readString(rec.oldString) ?? "";
			const newText = readString(rec.newText) ?? readString(rec.newString) ?? "";
			for (const line of oldText.split("\n")) {
				if (!line) continue;
				rows.push({ n: "", text: `- ${line}`, kind: "del" });
				del++;
			}
			for (const line of newText.split("\n")) {
				if (!line) continue;
				rows.push({ n: "", text: `+ ${line}`, kind: "add" });
				add++;
			}
		}
		return rows.length ? { file, lines: rows, add, del } : null;
	}
	if (toolName === "write") {
		const content = readString(args.content);
		if (!content) return null;
		const rows = content.split("\n").map((line, index) => ({ n: String(index + 1), text: `+ ${line}`, kind: "add" as const }));
		return { file, lines: rows, add: rows.length, del: 0 };
	}
	return null;
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */
export function App() {
	const mode = modeFromQuery();
	const [theme, setTheme] = useState<"dark" | "light">(
		(document.documentElement.dataset.theme as "dark" | "light" | undefined) ?? "dark",
	);
	const [blocks, setBlocks] = useState<ChatBlock[]>([]);
	const [input, setInput] = useState("");
	const [env, setEnv] = useState<DesktopEnv | null>(null);
	const [state, setState] = useState<SessionState | null>(null);
	const [usage, setUsage] = useState<{ tokens: number; cost: number }>({ tokens: 0, cost: 0 });
	const [statusWidgets, setStatusWidgets] = useState<StatusWidget[]>([]);
	const [sessions, setSessions] = useState<SessionListItem[]>([]);
	const [sidebarOpen, setSidebarOpen] = useState(mode !== "buddy");
	const [models, setModels] = useState<{ provider: string; id: string }[]>([]);
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [cowork, setCowork] = useState<{ booted: boolean; assetsReady: boolean; dir?: string; busy: boolean; qemu: boolean }>({ booted: false, assetsReady: false, busy: false, qemu: true });
	const [coworkOutput, setCoworkOutput] = useState("");
	const [coworkCmd, setCoworkCmd] = useState("");
	const [coworkOpen, setCoworkOpen] = useState(false);
	const [extensions, setExtensions] = useState<{ skills: string[]; mcpServers: string[] }>({ skills: [], mcpServers: [] });
	const [pendingDialog, setPendingDialog] = useState<ExtensionUiRequest[]>([]);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [rpcError, setRpcError] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	const greeting = (): string => {
		const h = new Date().getHours();
		const part = h < 6 ? "Boa madrugada" : h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
		return `${part}. O que vamos construir?`;
	};

	/* ---------- RPC helpers ---------- */
	const run = useCallback(async (command: Parameters<typeof window.noishi.runSessionCommand>[0]): Promise<SessionCommandResult> => {
		const result = await window.noishi.runSessionCommand(command);
		if (!result.ok && /exited|not found|not ready/i.test(result.error)) setRpcError(result.error);
		return result;
	}, []);

	const loadSessions = useCallback(async (): Promise<void> => {
		const result = await run({ type: "listSessions" });
		if (result.ok) setSessions(result.data as SessionListItem[]);
	}, [run]);

	const refreshState = useCallback(async (): Promise<void> => {
		const result = await run({ type: "getState" });
		if (result.ok) {
			setState(result.data as SessionState);
			setRpcError(null);
		}
	}, [run]);

	const refreshUsage = useCallback(async (): Promise<void> => {
		const result = await run({ type: "getStats" });
		if (!result.ok || typeof result.data !== "object" || result.data === null) return;
		const tokens = "tokens" in result.data ? (result.data.tokens as { total?: number } | undefined) : undefined;
		const cost = "cost" in result.data ? result.data.cost : undefined;
		const total = tokens?.total ?? 0;
		if (total > 0 || typeof cost === "number") setUsage({ tokens: total, cost: typeof cost === "number" ? cost : 0 });
	}, [run]);

	const loadModels = useCallback(async (): Promise<void> => {
		const result = await run({ type: "getModels" });
		if (!result.ok || typeof result.data !== "object" || result.data === null) return;
		const raw = "models" in result.data ? result.data.models : result.data;
		if (!Array.isArray(raw)) return;
		const parsed = raw.filter(
			(m): m is { provider: string; id: string } =>
				typeof m === "object" && m !== null && "provider" in m && "id" in m && typeof m.provider === "string" && typeof m.id === "string",
		);
		setModels(parsed);
	}, [run]);

	const loadExtensions = useCallback(async (): Promise<void> => {
		const result = await run({ type: "listInstalled" });
		if (!result.ok || typeof result.data !== "object" || result.data === null) return;
		const data = result.data as Record<string, unknown>;
		const readList = (key: string): string[] => {
			const value = data[key];
			return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
		};
		setExtensions({ skills: readList("skills"), mcpServers: readList("mcpServers") });
	}, [run]);

	const refreshCowork = useCallback(async (): Promise<void> => {
		const result = await run({ type: "coworkStatus" });
		if (!result.ok || typeof result.data !== "object" || result.data === null) return;
		const data = result.data;
		setCowork((c) => ({
			...c,
			assetsReady: "ready" in data ? Boolean(data.ready) : false,
			dir: "dir" in data && typeof data.dir === "string" ? data.dir : undefined,
			booted: "booted" in data ? Boolean(data.booted) : false,
			qemu: "qemu" in data ? Boolean(data.qemu) : true,
		}));
	}, [run]);

	const installExtension = useCallback(async (): Promise<void> => {
		const path = window.prompt("Caminho do pacote (.mcpb ou .skill):", "");
		if (!path) return;
		const result = await run({ type: "installPackage", path });
		if (result.ok) {
			await loadExtensions();
			setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `Pacote instalado: ${path}`, info: true }]);
		} else {
			setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `instalar: ${result.error}` }]);
		}
	}, [loadExtensions, run]);

	const coworkBoot = useCallback(async (): Promise<void> => {
		setCowork((c) => ({ ...c, busy: true }));
		const result = await run({ type: "coworkBoot" });
		setCowork((c) => ({ ...c, busy: false, booted: result.ok }));
		setCoworkOutput(result.ok ? "VM pronta.\n" : `erro: ${result.error}\n`);
	}, [run]);

	const coworkExec = useCallback(async (): Promise<void> => {
		const command = coworkCmd.trim();
		if (!command) return;
		setCowork((c) => ({ ...c, busy: true }));
		const result = await run({ type: "coworkExec", command });
		setCowork((c) => ({ ...c, busy: false }));
		const output = result.ok && typeof result.data === "object" && result.data !== null && "output" in result.data ? readString(result.data.output) ?? "" : "";
		setCoworkOutput((prev) => `${prev}~ $ ${command}\n${result.ok ? output : `erro: ${result.error}`}\n`);
		setCoworkCmd("");
	}, [coworkCmd, run]);

	const changeModel = useCallback(async (provider: string, modelId: string): Promise<void> => {
		const result = await run({ type: "setModel", provider, modelId });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `modelo: ${result.error}` }]);
		setPopoverOpen(false);
		void refreshState();
	}, [refreshState, run]);

	const changeThinking = useCallback(async (level: string): Promise<void> => {
		const result = await run({ type: "setThinkingLevel", level });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `thinking: ${result.error}` }]);
		void refreshState();
	}, [refreshState, run]);

	const cloneSession = useCallback(async (): Promise<void> => {
		const result = await run({ type: "clone" });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `clone: ${result.error}` }]);
		void refreshState();
		void loadSessions();
	}, [loadSessions, refreshState, run]);

	/* ---------- stream events ---------- */
	function handleEvent(event: AgentEvent): void {
		switch (event.type) {
			case "message_update":
				applyStreamEvent(event.event, event.usage);
				break;
			case "entry_appended": {
				// Attach the entry id to the newest assistant block so "Fork daqui" works.
				const entry = event.entry;
				if (typeof entry === "object" && entry !== null && "type" in entry && entry.type === "message" && "id" in entry && typeof entry.id === "string") {
					const entryId: string = entry.id;
					setBlocks((prev) => {
						for (let i = prev.length - 1; i >= 0; i--) {
							const block = prev[i];
							if (block && block.kind === "text" && block.role === "assistant") {
								const next = [...prev];
								next[i] = { ...block, entryId };
								return next;
							}
						}
						return prev;
					});
				}
				break;
			}
			case "agent_settled":
				markStreamingDone();
				void refreshUsage();
				break;
			case "agent_end":
				markStreamingDone();
				void refreshState();
				void refreshUsage();
				break;
			case "bash_execution_update":
				appendToolOutput(event.delta);
				break;
			default:
				break;
		}
	}

	function applyStreamEvent(event: Record<string, unknown> & { type: string }, usageRecord: unknown): void {
		const u = usageRecord as { totalTokens?: number; cost?: { total?: number } } | undefined;
		if (u && typeof u.totalTokens === "number") setUsage({ tokens: u.totalTokens, cost: u.cost?.total ?? 0 });
		setBlocks((prev) => {
			const next = [...prev];
			const lastIndex = next.length - 1;
			const last = next[lastIndex];
			switch (event.type) {
				case "message_start":
					next.push({ kind: "text", id: nextId(), role: "assistant", content: "", streaming: true });
					return next;
				case "text_delta": {
					if (last?.kind === "text" && last.streaming) next[lastIndex] = { ...last, content: last.content + String(event.delta ?? "") };
					else next.push({ kind: "text", id: nextId(), role: "assistant", content: String(event.delta ?? ""), streaming: true });
					return next;
				}
				case "text_end":
					if (last?.kind === "text" && last.streaming) next[lastIndex] = { ...last, streaming: false };
					return next;
				case "thinking_delta": {
					if (last?.kind === "thinking" && last.streaming) next[lastIndex] = { ...last, content: last.content + String(event.delta ?? "") };
					else next.push({ kind: "thinking", id: nextId(), content: String(event.delta ?? ""), streaming: true });
					return next;
				}
				case "thinking_end":
					if (last?.kind === "thinking" && last.streaming) next[lastIndex] = { ...last, streaming: false };
					return next;
				case "toolcall_start":
					next.push({ kind: "tool", id: nextId(), toolName: String(event.toolName ?? "tool"), args: "", output: "", streaming: true });
					return next;
				case "toolcall_delta":
					if (last?.kind === "tool" && last.streaming) next[lastIndex] = { ...last, args: last.args + String(event.delta ?? "") };
					return next;
				case "toolcall_end":
					if (last?.kind === "tool" && last.streaming) next[lastIndex] = { ...last, streaming: false };
					return next;
				case "message_end":
					for (let i = next.length - 1; i >= 0; i--) {
						const block = next[i];
						if (block && (block.kind === "text" || block.kind === "thinking") && block.streaming) {
							next[i] = { ...block, streaming: false };
							break;
						}
					}
					return next;
				default:
					return next;
			}
		});
	}

	function appendToolOutput(delta: string): void {
		setBlocks((prev) => {
			const next = [...prev];
			const last = next[next.length - 1];
			if (last?.kind === "tool") next[next.length - 1] = { ...last, output: last.output + delta };
			return next;
		});
	}

	function markStreamingDone(): void {
		setBlocks((prev) =>
			prev.map((block) =>
				(block.kind === "text" || block.kind === "thinking" || block.kind === "tool") && block.streaming
					? { ...block, streaming: false }
					: block,
			),
		);
	}

	function handleExtensionUi(request: ExtensionUiRequest): void {
		switch (request.method) {
			case "notify":
				setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: request.message ?? "", info: request.notifyType !== "error" }]);
				window.noishi.answerExtensionUi({ id: request.id, cancelled: true });
				break;
			case "confirm":
			case "input":
			case "select":
			case "editor":
				setPendingDialog((prev) => [...prev, request]);
				break;
			case "setStatus":
				setStatusWidgets((prev) => {
					const rest = prev.filter((w) => w.key !== request.statusKey);
					return request.statusText ? [...rest, { key: request.statusKey, lines: [request.statusText] }] : rest;
				});
				break;
			case "setWidget":
				setStatusWidgets((prev) => {
					const rest = prev.filter((w) => w.key !== request.widgetKey);
					return request.widgetLines ? [...rest, { key: request.widgetKey, lines: request.widgetLines }] : rest;
				});
				break;
			default:
				window.noishi.answerExtensionUi({ id: request.id, cancelled: true });
		}
	}

	/* ---------- session actions ---------- */
	const sendPrompt = useCallback(async (): Promise<void> => {
		const message = input.trim();
		if (!message) return;
		setInput("");
		setBlocks((prev) => [...prev, { kind: "text", id: nextId(), role: "user", content: message, streaming: false }]);
		const result = await run({ type: "prompt", message });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: result.error }]);
		void refreshState();
	}, [input, refreshState, run]);

	const newSession = useCallback(async (): Promise<void> => {
		await run({ type: "newSession" });
		setBlocks([]);
		setUsage({ tokens: 0, cost: 0 });
		void refreshState();
	}, [refreshState, run]);

	const abort = useCallback((): void => {
		void run({ type: "abort" });
	}, [run]);

	const newSessionIn = useCallback(async (cwd: string): Promise<void> => {
		await run({ type: "startIn", cwd });
		setBlocks([]);
		setUsage({ tokens: 0, cost: 0 });
		void refreshState();
		void loadSessions();
	}, [loadSessions, refreshState, run]);

	const resumeSession = useCallback(async (sessionPath: string): Promise<void> => {
		setBlocks([]);
		const result = await run({ type: "switchSession", sessionPath });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: result.error }]);
		void refreshState();
	}, [refreshState, run]);

	const renameSession = useCallback(async (sessionPath: string, name: string): Promise<void> => {
		setRenaming(null);
		const trimmed = name.trim();
		if (!trimmed) return;
		await run({ type: "switchSession", sessionPath });
		await run({ type: "setTitle", title: trimmed });
		void loadSessions();
		void refreshState();
	}, [loadSessions, refreshState, run]);

	const compactSession = useCallback(async (): Promise<void> => {
		const result = await run({ type: "compact" });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: result.error }]);
		void refreshState();
	}, [refreshState, run]);

	const exportSession = useCallback(async (): Promise<void> => {
		const result = await run({ type: "exportHtml" });
		if (result.ok && typeof result.data === "object" && result.data !== null && "path" in result.data) {
			const path = readString(result.data.path) ?? "";
			setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `HTML exportado: ${path}`, info: true }]);
		}
	}, [run]);

	const forkFrom = useCallback(async (entryId: string): Promise<void> => {
		const result = await run({ type: "fork", entryId });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `fork: ${result.error}` }]);
		void refreshState();
		void loadSessions();
	}, [loadSessions, refreshState, run]);

	const copyText = useCallback((text: string): void => {
		void navigator.clipboard.writeText(text);
	}, []);

	/* ---------- boot ---------- */
	useEffect(() => {
		void window.noishi.getTheme().then((t) => {
			setTheme(t);
			document.documentElement.dataset.theme = t;
		});
		void window.noishi.getEnv().then(setEnv);
		void refreshState();
		void loadSessions();
		void loadModels();
		void loadExtensions();
		void refreshCowork();
		const offEvent = window.noishi.onSessionEvent(handleEvent);
		const offUi = window.noishi.onExtensionUiRequest(handleExtensionUi);
		const offRoute = window.noishi.onDeepLinkRoute((route) => {
			if (route.kind === "chat/new" || route.kind === "code/new") setBlocks([]);
		});
		const offTheme = window.noishi.onThemeChange((t) => {
			setTheme(t);
			document.documentElement.dataset.theme = t;
		});
		return () => {
			offEvent();
			offUi();
			offRoute();
			offTheme();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [blocks]);

	useEffect(() => {
		if (!popoverOpen) return;
		const close = (e: MouseEvent): void => {
			const target = e.target;
			if (target instanceof Element && !target.closest(".popover") && !target.closest(".model-pill")) setPopoverOpen(false);
		};
		window.addEventListener("mousedown", close);
		return () => window.removeEventListener("mousedown", close);
	}, [popoverOpen]);

	/* ---------- derivados ---------- */
	const status = useMemo(() => {
		if (!state) return { dot: "", text: "conectando…" };
		if (rpcError) return { dot: "dot--danger", text: "erro: o processo RPC encerrou" };
		if (state.isStreaming) return { dot: "dot--live", text: "streaming" };
		if (state.isCompacting) return { dot: "dot--warn", text: "compactando histórico · estimando resumo" };
		return { dot: "dot--ok", text: "pronto" };
	}, [state, rpcError]);

	const statusText = useMemo(() => {
		const model = state?.model?.id ?? state?.model?.name ?? "—";
		const thinking = state?.thinkingLevel ?? "off";
		return `${status.text} · ${model} · thinking ${thinking}`;
	}, [status.text, state]);

	const meter = useMemo(() => {
		const window = state?.model?.contextWindow ?? 0;
		if (!window || !usage.tokens) return null;
		const ratio = usage.tokens / window;
		const filled = Math.min(10, Math.round(ratio * 10));
		const cls = ratio >= 0.9 ? "high" : ratio >= 0.7 ? "mid" : "on";
		return { filled, cls };
	}, [state, usage]);

	const activeSession = state?.sessionFile;

	/* ---------- quick window ---------- */
	if (mode === "quick") {
		return (
			<div className="quick">
				<div className="quick-head">
					<Mark size={18} />
					<b>Noishi</b>
					<span className={`dot ${status.dot}`} />
					<span className="mono">{status.text}</span>
					<span className="spacer" />
					<button className="btn btn--ghost btn--icon btn--sm" onClick={() => void refreshState()} type="button" title="Atualizar estado">
						<Icon d={ICONS.pin} size={12} />
					</button>
				</div>
				<div className="quick-ctx">
					{env?.cliPath ?? "~/"} · {state?.model?.id ?? "modelo ?"}
				</div>
				<div className="quick-recent">
					{blocks.length === 0 ? (
						<div className="quick-line"><b>noishi</b><span>Nada ainda nesta sessão.</span></div>
					) : (
						blocks.slice(-6).map((block) => {
							if (block.kind === "text") return (
								<div key={block.id} className="quick-line">
									<b>{block.role === "user" ? "você" : "agente"}</b>
									<span>{block.content.slice(0, 160)}</span>
								</div>
							);
							if (block.kind === "tool") return (
								<div key={block.id} className="quick-line">
									<b>tool</b>
									<span className="mono">{block.toolName}</span>
								</div>
							);
							return null;
						})
					)}
				</div>
				<div className="quick-composer">
					<div className="quick-box">
						<textarea
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									void sendPrompt();
								}
							}}
							placeholder="Perguntar algo rápido…"
							rows={2}
							autoFocus
						/>
						<div className="quick-bar">
							<button className="chip chip--mono" onClick={() => void changeThinking("medium")} type="button">
								{state?.model?.id ?? "modelo"}
							</button>
							<span className="hint">Ctrl+Shift+Space</span>
							<button className={`btn btn--icon btn--sm${input.trim() ? " is-on" : ""}`} onClick={() => void sendPrompt()} disabled={!input.trim() || Boolean(state?.isStreaming)} type="button" title="Enviar">
								<Icon d={ICONS.send} size={12} />
							</button>
						</div>
					</div>
				</div>
			</div>
		);
	}

	/* ---------- artifact window ---------- */
	if (mode === "artifact") {
		const artifactId = new URLSearchParams(window.location.search).get("id") ?? "";
		return (
			<div className="artifact">
				<div className="artifact-head">
					<Icon d={ICONS.file} size={15} />
					<b>Relatório de sessão</b>
					<span className="badge">somente leitura</span>
					<span className="mono">{artifactId || "sem id"}</span>
					<span className="spacer" />
					<button className="btn btn--ghost btn--sm" onClick={() => copyText(window.location.href)} type="button">
						<Icon d={ICONS.copy} size={12} />
						Copiar link
					</button>
				</div>
				<div className="artifact-body">
					<div className="artifact-doc">
						<h1>{state?.sessionName ?? "Sessão sem nome"}</h1>
						<div className="sub">{activeSession ?? "sessão não carregada"}</div>
						{blocks.length === 0 ? (
							<p>Nenhuma mensagem carregada nesta janela.</p>
						) : (
							blocks.map((block) => {
								if (block.kind === "text") {
									return (
										<p key={block.id}>
											<strong>{block.role === "user" ? "Você: " : ""}</strong>
											{block.content}
										</p>
									);
								}
								if (block.kind === "tool") return <p key={block.id} className="mono">{block.toolName}</p>;
								return null;
							})
						)}
					</div>
				</div>
				<div className="artifact-foot">
					<Icon d={ICONS.share} size={12} />
					Aberto por <span className="mono">noishi://cowork/shared-artifact?id={artifactId}</span>
				</div>
			</div>
		);
	}

	/* ---------- main / buddy ---------- */
	return (
		<div className="app" data-mode={mode}>
			<aside className={`sidebar${sidebarOpen ? "" : " collapsed"}`}>
				<div className="sidebar-top">
					<div className="brand">
						<span className="brand-mark"><Mark /></span>
						<span className="brand-text">
							<span className="brand-name">Noishi</span>
							<span className="brand-version">v{env?.appVersion ?? "0.1.0"}</span>
						</span>
					</div>
					<button className="icon-btn" onClick={() => setSidebarOpen((s) => !s)} type="button" title="Colapsar sidebar">
						<Icon d={ICONS.panel} />
					</button>
				</div>
				<div className="sidebar-actions">
					<button className="btn btn--primary" onClick={() => void newSession()} type="button">
						<Icon d={ICONS.plus} size={13} />
						<span className="btn-label">Nova conversa</span>
					</button>
					<button className="btn" onClick={() => {
						const cwd = window.prompt("Diretório do projeto:", "~");
						if (cwd) void newSessionIn(cwd);
					}} type="button">
						<Icon d={ICONS.folder} size={13} />
						<span className="btn-label">Abrir projeto…</span>
					</button>
				</div>
				<div className="sidebar-section">
					<span>Sessões</span>
					<span className="count">{sessions.length}</span>
				</div>
				<div className="session-list">
					{sessions.map((session) => {
						const isRenaming = renaming === session.sessionFile;
						if (isRenaming) {
							return (
								<div key={session.sessionId} className="session-item active">
									<input
										className="session-rename"
										defaultValue={session.name ?? session.sessionId.slice(0, 8)}
										autoFocus
										onBlur={(e) => void renameSession(session.sessionFile, e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") void renameSession(session.sessionFile, (e.target as HTMLInputElement).value);
											if (e.key === "Escape") setRenaming(null);
										}}
									/>
								</div>
							);
						}
						return (
							<button
								key={session.sessionId}
								className={`session-item${activeSession === session.sessionFile ? " active" : ""}`}
								onClick={() => void resumeSession(session.sessionFile)}
								onDoubleClick={() => setRenaming(session.sessionFile)}
								type="button"
								title={`${session.sessionFile}\nDuplo clique para renomear`}
							>
								<span className="session-title">{session.name ?? session.sessionId.slice(0, 8)}</span>
								<span className="session-sub">
									{new Date(session.modifiedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })} · {session.messageCount ?? 0} msgs
								</span>
							</button>
						);
					})}
					{sessions.length === 0 ? <div className="session-empty">Nenhuma sessão ainda. Abra um projeto para começar.</div> : null}
				</div>
				<div className="sidebar-footer">
					<span className={`dot ${state ? "dot--ok" : ""}`} />
					CLI {env?.cliVersion ?? "?"} · v{env?.appVersion ?? "0.1.0"}
				</div>
			</aside>

			<div className="main">
				<header className="topbar">
					<span className="crumb">{state?.sessionName ?? (mode === "buddy" ? "Buddy" : "Nova conversa")}</span>
					<span className="status">
						<span className={`dot ${status.dot}`} />
						{statusText}
						{meter ? (
							<span className="meter">
								{Array.from({ length: 10 }, (_, i) => (
									<i key={i} className={i < meter.filled ? meter.cls : ""} />
								))}
							</span>
						) : null}
						{usage.tokens > 0 ? <span className="mono">{Math.round(usage.tokens / 100) / 10}k · ${usage.cost.toFixed(4)}</span> : null}
					</span>
					<div className="topbar-actions">
						{state?.isStreaming ? (
							<button className="btn btn--danger btn--sm" onClick={abort} type="button">
								<Icon d={ICONS.stop} size={12} />
								Parar
							</button>
						) : null}
						{state?.isCompacting ? <span className="chip">compactando…</span> : null}
						<button className="btn btn--ghost btn--sm" onClick={() => void cloneSession()} disabled={!state?.sessionId} type="button">
							<Icon d={ICONS.clone} size={12} />
							Clonar
						</button>
						<button className="btn btn--ghost btn--sm" onClick={() => void compactSession()} disabled={!state?.sessionId} type="button">
							<Icon d={ICONS.compress} size={12} />
							Compactar
						</button>
						<button className="btn btn--ghost btn--sm" onClick={() => void exportSession()} disabled={!state?.sessionId} type="button">
							<Icon d={ICONS.export} size={12} />
							Exportar
						</button>
						<button
							className={`btn btn--ghost btn--sm${coworkOpen ? " is-on" : ""}`}
							onClick={() => { setCoworkOpen((o) => !o); void refreshCowork(); }}
							type="button"
						>
							<Icon d={ICONS.cpu} size={12} />
							Cowork
						</button>
					</div>
				</header>

				{coworkOpen ? (
					<div className="cowork">
						<div className="cowork-row">
							<span className={`dot ${cowork.booted ? "dot--ok" : cowork.assetsReady && cowork.qemu ? "" : "dot--warn"}`} />
							<b>
								{cowork.booted
									? "VM ativa · alpine-virt · sem rede"
									: !cowork.qemu
										? "qemu ausente — sudo pacman -S qemu-desktop"
										: cowork.assetsReady
											? "pronta para boot"
											: "assets ausentes"}
							</b>
							{cowork.dir && !cowork.assetsReady && cowork.qemu ? <span className="mono">coloque alpine-virt.iso + iso-extract/boot/ em {cowork.dir}</span> : null}
							{!cowork.booted && cowork.qemu && cowork.assetsReady ? (
								<button className="btn btn--sm" onClick={() => void coworkBoot()} disabled={cowork.busy} type="button">
									{cowork.busy ? "bootando…" : "Boot VM"}
								</button>
							) : null}
						</div>
						{cowork.booted ? (
							<>
								<div className="cowork-body">
									<input
										className="field mono"
										value={coworkCmd}
										onChange={(e) => setCoworkCmd(e.target.value)}
										onKeyDown={(e) => { if (e.key === "Enter") void coworkExec(); }}
										placeholder="echo ok"
										aria-label="Comando na VM"
									/>
									<button className="btn btn--sm" onClick={() => void coworkExec()} disabled={cowork.busy || !coworkCmd.trim()} type="button">Exec</button>
								</div>
								<pre className="cowork-out">{coworkOutput || "—"}</pre>
							</>
						) : null}
					</div>
				) : null}

				{statusWidgets.length > 0 ? (
					<div className="widgets">
						{statusWidgets.map((widget) => (
							<pre key={widget.key} className="widget">{widget.lines.join("\n")}</pre>
						))}
					</div>
				) : null}

				<div className="chat" ref={scrollRef}>
					{blocks.length === 0 ? (
						<div className="greeting">
							<h1>{greeting()}</h1>
							<p>Noishi está pronto.</p>
							<p className="greeting-meta">CLI {env?.cliVersion ?? "?"} · {env?.cliPath ?? "não encontrado"}</p>
						</div>
					) : (
						<div className="chat-inner">
							{state?.isCompacting ? (
								<div className="banner banner--warn">
									<Icon d={ICONS.compress} className="ic" />
									<div><b>Compactando histórico.</b> O resumo substitui as mensagens antigas; as recentes ficam intactas.</div>
								</div>
							) : null}
							{rpcError ? (
								<div className="banner banner--danger">
									<Icon d={ICONS.alert} className="ic" />
									<div><b>O processo do agente encerrou.</b> {rpcError}. A sessão foi preservada em disco.</div>
								</div>
							) : null}
							{blocks.map((block) => {
								switch (block.kind) {
									case "text":
										if (block.role === "user") {
											return (
												<div key={block.id} className="row user">
													<div className="bubble">{block.content}</div>
												</div>
											);
										}
										return (
											<div key={block.id} className="row assistant msg-stack">
												<div>
													<div className="voice">
														{block.content}
														{block.streaming ? <span className="cursor" /> : null}
													</div>
													{!block.streaming ? (
														<div className="msg-tools">
															<button
																className="btn btn--ghost btn--sm"
																onClick={() => { if (block.entryId) void forkFrom(block.entryId); }}
																disabled={!block.entryId}
																title={block.entryId ? "Fork desta mensagem" : "Sem entry id"}
																type="button"
															>
																<Icon d={ICONS.fork} size={12} />
																Fork daqui
															</button>
															<button className="btn btn--ghost btn--icon btn--sm" onClick={() => copyText(block.content)} title="Copiar" type="button">
																<Icon d={ICONS.copy} size={12} />
															</button>
															<button
																className="btn btn--ghost btn--icon btn--sm"
																onClick={() => setPendingDialog((prev) => [...prev, { id: `local-${block.id}`, method: "editor", title: "Editar mensagem", prefill: block.content }])}
																title="Editar"
																type="button"
															>
																<Icon d={ICONS.edit} size={12} />
															</button>
														</div>
													) : null}
												</div>
											</div>
										);
									case "thinking":
										return (
											<details key={block.id} className="thinking">
												<summary>{block.streaming ? "pensando…" : "raciocínio"}</summary>
												<pre>{block.content}</pre>
											</details>
										);
									case "tool": {
										const diff = diffFromTool(block.toolName, block.args);
										return (
											<div key={block.id} className="toolcall">
												<div className="tool-head">
													<Icon d={ICONS.terminal} size={13} />
													<span className="toolname">{block.toolName}</span>
													<span className={`tool-state ${block.streaming ? "is-live" : "is-ok"}`}>
														{block.streaming ? "executando…" : "concluído"}
													</span>
												</div>
												{diff ? (
													<>
														<div className="tool-meta">
															<span>{diff.file || "arquivo"}</span>
															<span className="add">+{diff.add}</span>
															<span className="del">−{diff.del}</span>
														</div>
														<div className="diff">
															{diff.lines.map((line, index) => (
																<div key={index} className={`diff-line ${line.kind}`}>
																	<span className="diff-n">{line.n}</span>
																	<span className="diff-c">{line.text}</span>
																</div>
															))}
														</div>
													</>
												) : block.args || block.output ? (
													<pre>{block.args}{block.output}</pre>
												) : null}
											</div>
										);
									}
									case "error":
										return <div key={block.id} className={`error${block.info ? " is-info" : ""}`}>{block.message}</div>;
								}
							})}
						</div>
					)}
				</div>

				{pendingDialog[0] ? (
					(() => {
						const dialog = pendingDialog[0];
						if (!dialog) return null;
						const answer = (response: Parameters<typeof window.noishi.answerExtensionUi>[0]): void => {
							if (!dialog.id.startsWith("local-")) window.noishi.answerExtensionUi(response);
							setPendingDialog((prev) => prev.slice(1));
						};
						const options = "options" in dialog ? dialog.options : undefined;
						const placeholder = "placeholder" in dialog ? dialog.placeholder : undefined;
						const prefill = "prefill" in dialog ? dialog.prefill : undefined;
						return (
							<div className="dialog-layer">
								<div className="dialog">
									<h4 className="dialog-title">{"title" in dialog ? dialog.title ?? "Aprovação" : "Aprovação"}</h4>
									{"message" in dialog && dialog.message ? <p className="dialog-message">{dialog.message}</p> : null}
									{options?.length ? (
										<div className="dialog-chips">
											{options.map((option) => (
												<button key={option} className="chip chip--mono" type="button" onClick={() => answer({ id: dialog.id, value: option })}>
													{option}
												</button>
											))}
										</div>
									) : null}
									{dialog.method === "input" ? (
										<input
											className="field"
											autoFocus
											placeholder={placeholder ?? ""}
											onKeyDown={(e) => {
												if (e.key !== "Enter") return;
												const value = (e.target as HTMLInputElement).value.trim();
												if (value) answer({ id: dialog.id, value });
											}}
										/>
									) : null}
									{dialog.method === "editor" ? (
										<textarea
											autoFocus
											defaultValue={prefill ?? ""}
											aria-label="Editar mensagem"
											onKeyDown={(e) => {
												const value = (e.target as HTMLTextAreaElement).value.trim();
												if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && value) answer({ id: dialog.id, value });
											}}
										/>
									) : null}
									<div className="dialog-actions">
										{dialog.method === "confirm" ? (
											<>
												<button className="btn" type="button" onClick={() => answer({ id: dialog.id, confirmed: false })}>Recusar</button>
												<button className="btn btn--primary" type="button" onClick={() => answer({ id: dialog.id, confirmed: true })}>Aprovar</button>
											</>
										) : dialog.method === "editor" ? (
											<>
												<button className="btn" type="button" onClick={() => answer({ id: dialog.id, cancelled: true })}>Cancelar</button>
												<button
													className="btn btn--primary"
													type="button"
													onClick={() => {
														const el = document.querySelector<HTMLTextAreaElement>(".dialog textarea");
														const value = el?.value.trim();
														if (value) answer({ id: dialog.id, value });
													}}
												>
													Salvar e reenviar
												</button>
											</>
										) : dialog.method === "input" ? (
											<>
												<button className="btn" type="button" onClick={() => answer({ id: dialog.id, cancelled: true })}>Cancelar</button>
												<button
													className="btn btn--primary"
													type="button"
													onClick={() => {
														const el = document.querySelector<HTMLInputElement>(".dialog input.field");
														const value = el?.value.trim();
														if (value) answer({ id: dialog.id, value });
													}}
												>
													Salvar
												</button>
											</>
										) : (
											<button className="btn" type="button" onClick={() => answer({ id: dialog.id, cancelled: true })}>Cancelar</button>
										)}
									</div>
								</div>
							</div>
						);
					})()
				) : null}

				<div className="composer-wrap">
					<div className="composer">
						{popoverOpen ? (
							<div className="popover">
								<div className="popover-label">Modelo</div>
								<div className="popover-scroll">
									{models.length === 0 ? <div className="popover-item">nenhum modelo listado</div> : null}
									{models.map((model) => {
										const active = state?.model?.id === model.id && state?.model?.provider === model.provider;
										return (
											<button
												key={`${model.provider}/${model.id}`}
												className={`popover-item${active ? " is-on" : ""}`}
												onClick={() => void changeModel(model.provider, model.id)}
												type="button"
											>
												<span className="grow">{model.id}</span>
												<small>{model.provider}</small>
												{active ? <Icon d={ICONS.check} size={12} /> : null}
											</button>
										);
									})}
								</div>
								<div className="popover-sep" />
								<div className="popover-label">Raciocínio</div>
								<div className="popover-chips">
									{["off", "minimal", "low", "medium", "high"].map((level) => (
										<button
											key={level}
											type="button"
											className={`chip${state?.thinkingLevel === level ? " is-on" : ""}`}
											onClick={() => void changeThinking(level)}
										>
											{level}
										</button>
									))}
								</div>
								<div className="popover-sep" />
								<button className="popover-item" onClick={() => void loadExtensions()} type="button">
									<Icon d={ICONS.spark} size={13} />
									<span className="grow">Skills</span>
									<small>{extensions.skills.length}</small>
								</button>
								<button className="popover-item" onClick={() => void loadExtensions()} type="button">
									<Icon d={ICONS.terminal} size={13} />
									<span className="grow">MCP servers</span>
									<small>{extensions.mcpServers.length}</small>
								</button>
								<button className="popover-item accent" onClick={() => void installExtension()} type="button">
									<Icon d={ICONS.plus} size={13} />
									<span className="grow">Instalar .mcpb ou .skill</span>
								</button>
							</div>
						) : null}
						<textarea
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									void sendPrompt();
								}
							}}
							placeholder="Como posso ajudar hoje?"
							rows={2}
						/>
						<div className="composer-bar">
							<button className="pill model-pill" onClick={() => { setPopoverOpen((o) => !o); if (!models.length) void loadModels(); }} type="button" title="Modelo e raciocínio">
								<Icon d={ICONS.spark} size={12} />
								{state?.model?.id ?? "modelo"}
								<Icon d={ICONS.chevronDown} size={11} />
							</button>
							<span className="composer-hint">Enter envia · Shift+Enter quebra linha</span>
							<button
								className={`btn btn--icon btn--sm composer-send${input.trim() ? " ready" : ""}`}
								onClick={() => void sendPrompt()}
								type="button"
								disabled={!input.trim() || Boolean(state?.isStreaming)}
								title="Enviar"
							>
								<Icon d={ICONS.send} size={13} />
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

declare global {
	interface Window {
		noishi: NoishiBridge;
	}
}
