import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExtensionUiResponse, NoishiBridge, SessionCommandResult, SessionListItem, SessionState } from "@noishi/rpc-bridge";
import { ChatBlockRow } from "./components/ChatMessageList.js";
import { DialogLayer } from "./components/DialogLayer.js";
import { SandboxView, type SandboxStatus } from "./components/SandboxView.js";
import { panelStore, usePanelState, type PanelTab } from "./stores/panelStore.js";
import {
	handleExtensionUiRequest,
	handleSessionEvent,
	nextBlockId,
	pushBlock,
	sessionStore,
	setBlocks,
	useSessionState,
} from "./stores/sessionStore.js";
import { useWorkspaceState, workspaceStore, type FileNode, type FolderIndex, type SessionSearchHit } from "./stores/workspaceStore.js";

const TerminalView = lazy(() => import("./Terminal.js").then((m) => ({ default: m.TerminalView })));
const ReviewPanel = lazy(() => import("./ReviewPanel.js").then((m) => ({ default: m.ReviewPanel })));
const GitPanel = lazy(() => import("./GitPanel.js").then((m) => ({ default: m.GitPanel })));
const ContextPanel = lazy(() => import("./ContextPanel.js").then((m) => ({ default: m.ContextPanel })));
const SettingsPanel = lazy(() => import("./SettingsPanel.js").then((m) => ({ default: m.SettingsPanel })));
const ArtifactSandbox = lazy(() => import("./ArtifactSandbox.js").then((m) => ({ default: m.ArtifactSandbox })));

const TOOL_LABELS: Record<string, string> = {
	read: "lendo arquivo",
	write: "escrevendo arquivo",
	edit: "editando arquivo",
	bash: "rodando comando",
	glob: "procurando arquivos",
	grep: "buscando no código",
	ls: "listando diretório",
	web_search: "pesquisando na web",
	web_fetch: "abrindo página",
	task: "delegando tarefa",
	todo: "atualizando tarefas",
};

type Mode = "main" | "buddy" | "quick" | "artifact";

function modeFromQuery(): Mode {
	const q = new URLSearchParams(window.location.search).get("window");
	return q === "buddy" || q === "quick" || q === "artifact" ? q : "main";
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

const Icon = ({ d, size = 14, className }: { d: string; size?: number; className?: string }) => (
	<svg className={`ic ${className ?? ""}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d={d} />
	</svg>
);

const SLASH_COMMANDS = [
	{ name: "compact", description: "resumir o histórico" },
	{ name: "clear", description: "limpar o chat desta janela" },
	{ name: "new", description: "nova sessão" },
	{ name: "export", description: "exportar a sessão em HTML" },
	{ name: "model", description: "trocar de modelo" },
	{ name: "thinking", description: "nível de raciocínio" },
	{ name: "help", description: "listar comandos" },
];

const ICONS = {
	send: "M8 13V3M3.5 7.5 8 3l4.5 4.5",
	stop: "M4 4h8v8H4z",
	clone: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
	compress: "M3 6h10M3 10h10",
	export: "M8 10V3M5 6l3-3 3 3M3 12h10",
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
	chevronUp: "M3.5 10 8 5.5 12.5 10",
	chevronRight: "M6 3.5 10.5 8 6 12.5",
	search: "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5 14 14",
	expand: "M6 3.5H3.5V6M10 12.5h2.5V10M3.5 3.5 7 7M12.5 12.5 9 9",
	pin: "M6 2.5h4M8 2.5v5l2 2v1H6v-1l2-2zM8 10.5v3",
	x: "M4 4l8 8M12 4l-8 8",
	mic: "M8 2.5a2 2 0 0 1 2 2v3.5a2 2 0 0 1-4 0V4.5a2 2 0 0 1 2-2zM4.5 7.5v.5a3.5 3.5 0 0 0 7 0v-.5M8 11.5V14",
	alert: "M8 2.5 14 13H2zM8 6.5v3M8 11.3v.2",
	file: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
	share: "M6 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM14 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM6 7 10 5M6 9l4 2",
};

const VIEW_LABELS: Record<PanelTab, string> = {
	chat: "Nova conversa",
	terminal: "Terminal",
	sandbox: "Sandbox",
	review: "Revisão",
	git: "Git",
	context: "Contexto",
	settings: "Ajustes",
};

const TreeNodes = ({
	nodes,
	depth,
	onOpen,
}: {
	nodes: FileNode[];
	depth: number;
	onOpen: (path: string) => void;
}) => (
	<>
		{nodes.map((node) => (
			<div key={node.path}>
				<button
					className="tree-row"
					style={{ paddingLeft: 8 + depth * 12 }}
					onClick={() => (node.dir ? undefined : onOpen(node.path))}
					type="button"
					title={node.path}
					aria-label={`${node.dir ? "pasta" : "arquivo"} ${node.name}`}
				>
					<Icon d={node.dir ? ICONS.folder : ICONS.file} size={10} />
					<span className="tree-name">{node.name}</span>
				</button>
				{node.dir && node.children?.length ? <TreeNodes nodes={node.children} depth={depth + 1} onOpen={onOpen} /> : null}
			</div>
		))}
	</>
);

const Mark = ({ size = 22 }: { size?: number }) => (
	<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
		<rect x="1" y="1" width="22" height="22" rx="7" fill="none" stroke="currentColor" strokeOpacity=".28" />
		<path d="M7.6 17V7l8.8 10V7" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="square" />
		<circle cx="16.4" cy="17" r="1.5" fill="var(--accent)" />
	</svg>
);

export function App() {
	const mode = modeFromQuery();

	// Segmented external store slices so streaming chunks don't re-render panels or sidebar unnecessarily.
	const blocks = useSessionState((s) => s.blocks);
	const env = useSessionState((s) => s.env);
	const state = useSessionState((s) => s.state);
	const usage = useSessionState((s) => s.usage);
	const statusWidgets = useSessionState((s) => s.statusWidgets);
	const queued = useSessionState((s) => s.queued);
	const rpcError = useSessionState((s) => s.rpcError);
	const needsInput = useSessionState((s) => s.needsInput);
	const reconnecting = useSessionState((s) => s.reconnecting);

	const view = usePanelState((s) => s.activePanel);
	const sidebarOpen = usePanelState((s) => s.sidebarOpen);
	const popoverOpen = usePanelState((s) => s.popoverOpen);
	const findOpen = usePanelState((s) => s.findOpen);
	const findText = usePanelState((s) => s.findText);
	const findResult = usePanelState((s) => s.findResult);
	const pendingDialog = usePanelState((s) => s.pendingDialog);
	const prefs = usePanelState((s) => s.prefs);

	const roots = useWorkspaceState((s) => s.roots);
	const treeByRoot = useWorkspaceState((s) => s.treeByRoot);
	const treeOpen = useWorkspaceState((s) => s.treeOpen);
	const sessions = useWorkspaceState((s) => s.sessions);
	const sessionQuery = useWorkspaceState((s) => s.sessionQuery);
	const sessionHits = useWorkspaceState((s) => s.sessionHits);
	const folders = useWorkspaceState((s) => s.folders);

	const [input, setInput] = useState("");
	const [models, setModels] = useState<{ provider: string; id: string }[]>([]);
	const [sandbox, setSandbox] = useState<SandboxStatus>({
		ready: false,
		dir: "",
		workspace: "",
		qemu: true,
		virtiofsd: true,
		booted: false,
		vcpu: 4,
		memoryMb: 2048,
		allowlist: [],
		tasks: [],
		artifacts: [],
		egress: [],
		limits: { maxCpu: 4, maxMemoryMb: 2048, maxSeconds: 300 },
		schedules: [],
		snapshots: [],
		instances: [],
		activeInstance: "default",
	});
	const [recording, setRecording] = useState(false);
	const [sandboxBusy, setSandboxBusy] = useState(false);
	const [sandboxCmd, setSandboxCmd] = useState("");
	const [sandboxOutput, setSandboxOutput] = useState("");
	const [openArtifact, setOpenArtifact] = useState<{ id: string; body: string } | null>(null);
	const [artifactBody, setArtifactBody] = useState<string | null>(null);
	const [extensions, setExtensions] = useState<{ skills: string[]; mcpServers: string[]; enabledServers: string[] }>({
		skills: [],
		mcpServers: [],
		enabledServers: [],
	});
	const [extensionsOpen, setExtensionsOpen] = useState(false);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [slashOpen, setSlashOpen] = useState(false);
	const [historyIndex, setHistoryIndex] = useState(-1);
	const [promptHistory, setPromptHistory] = useState<string[]>([]);
	const [savedPrompts, setSavedPrompts] = useState<{ id: string; title: string; body: string }[]>([]);
	const [attachments, setAttachments] = useState<{ name: string; dataUrl: string }[]>([]);
	const [composerHeight, setComposerHeight] = useState(40);
	const [savedOpen, setSavedOpen] = useState(false);
	const [mentionOpen, setMentionOpen] = useState(false);
	const [mentionHits, setMentionHits] = useState<{ path: string; rel: string }[]>([]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const pinnedBottomRef = useRef(true);

	useEffect(() => {
		panelStore.setState({ sidebarOpen: mode !== "buddy" });
	}, [mode]);

	const greeting = (): string => {
		const h = new Date().getHours();
		const part = h < 6 ? "Boa madrugada" : h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
		return `${part}. O que vamos construir?`;
	};

	/* ---------- RPC helpers ---------- */
	const run = useCallback(async (command: Parameters<typeof window.noishi.runSessionCommand>[0]): Promise<SessionCommandResult> => {
		const result = await window.noishi.runSessionCommand(command);
		if (!result.ok && /exited|not found|not ready/i.test(result.error)) {
			sessionStore.setState({ rpcError: result.error });
		}
		return result;
	}, []);

	const loadSessions = useCallback(async (): Promise<void> => {
		const result = await run({ type: "listSessions" });
		if (result.ok) workspaceStore.setState({ sessions: result.data as SessionListItem[] });
	}, [run]);

	const refreshState = useCallback(async (): Promise<void> => {
		const result = await run({ type: "getState" });
		if (result.ok) {
			sessionStore.setState({ state: result.data as SessionState, rpcError: null });
		}
	}, [run]);

	const refreshUsage = useCallback(async (): Promise<void> => {
		const result = await run({ type: "getStats" });
		if (!result.ok || typeof result.data !== "object" || result.data === null) return;
		const tokens = "tokens" in result.data ? (result.data.tokens as { total?: number } | undefined) : undefined;
		const cost = "cost" in result.data ? result.data.cost : undefined;
		const total = tokens?.total ?? 0;
		if (total > 0 || typeof cost === "number") {
			sessionStore.setState({ usage: { tokens: total, cost: typeof cost === "number" ? cost : 0 } });
		}
	}, [run]);

	const reconnectRpc = useCallback(async (): Promise<void> => {
		sessionStore.setState({ reconnecting: true });
		const result = await run({ type: "reconnectRpc" });
		sessionStore.setState({ reconnecting: false });
		if (result.ok) {
			sessionStore.setState({ rpcError: null });
			await refreshState();
			await loadSessions();
		}
	}, [loadSessions, refreshState, run]);

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
		setExtensions({ skills: readList("skills"), mcpServers: readList("mcpServers"), enabledServers: readList("enabledServers") });
	}, [run]);

	const toggleServer = useCallback(
		async (name: string, enabled: boolean): Promise<void> => {
			const result = await run({ type: "setServerEnabled", name, enabled });
			if (result.ok) await loadExtensions();
			else pushBlock({ kind: "error", id: nextBlockId(), message: `mcp: ${result.error}` });
		},
		[loadExtensions, run],
	);

	const removeInstalled = useCallback(
		async (kind: "skill" | "mcp", name: string): Promise<void> => {
			const result = await run({ type: "removePackage", kind, name });
			if (result.ok) await loadExtensions();
			else pushBlock({ kind: "error", id: nextBlockId(), message: `remover: ${result.error}` });
		},
		[loadExtensions, run],
	);

	const refreshSandbox = useCallback(async (): Promise<void> => {
		const result = await run({ type: "sandboxStatus" });
		if (!result.ok || typeof result.data !== "object" || result.data === null) return;
		setSandbox(result.data as SandboxStatus);
	}, [run]);

	/* ---------- voz -> prompt ---------- */
	const recorderRef = useRef<MediaRecorder | null>(null);

	const toggleRecording = useCallback(async (): Promise<void> => {
		if (recording) {
			recorderRef.current?.stop();
			setRecording(false);
			return;
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const chunks: Blob[] = [];
			const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "" });
			recorderRef.current = recorder;
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunks.push(event.data);
			};
			recorder.onstop = () => {
				for (const track of stream.getTracks()) track.stop();
				const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
				const reader = new FileReader();
				reader.onload = () => {
					const dataUrl = typeof reader.result === "string" ? reader.result : "";
					const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
					if (!base64) return;
					void run({ type: "transcribe", audioBase64: base64, mime: blob.type || "audio/webm" }).then((result) => {
						if (!result.ok) {
							pushBlock({ kind: "error", id: nextBlockId(), message: `voz: ${result.error}` });
							return;
						}
						const text = String((result.data as { text?: string }).text ?? "").trim();
						if (text) setInput((prev) => (prev.trim() ? `${prev} ${text}` : text));
					});
				};
				reader.readAsDataURL(blob);
			};
			recorder.start();
			setRecording(true);
		} catch (error) {
			pushBlock({ kind: "error", id: nextBlockId(), message: `microfone: ${error instanceof Error ? error.message : String(error)}` });
		}
	}, [recording, run]);

	/* ---------- sandbox actions (usando modal em vez de window.prompt) ---------- */
	const enqueueDialog = useCallback((dialog: Parameters<typeof panelStore.setState>[0] extends never ? never : typeof pendingDialog[number]): void => {
		panelStore.setState((prev) => ({ ...prev, pendingDialog: [...prev.pendingDialog, dialog] }));
	}, []);

	const sandboxSetActive = useCallback(
		async (id: string): Promise<void> => {
			const result = await run({ type: "sandboxSetActive", id });
			if (result.ok && result.data) setSandbox(result.data as SandboxStatus);
			else void refreshSandbox();
		},
		[refreshSandbox, run],
	);

	const sandboxCreateInstance = useCallback((): void => {
		enqueueDialog({ id: `local-vm-${Date.now()}`, method: "input", title: "Nova instância de sandbox", placeholder: "ex.: staging" });
	}, [enqueueDialog]);

	const sandboxDestroyInstance = useCallback(
		async (id: string): Promise<void> => {
			const result = await run({ type: "sandboxDestroyInstance", id });
			if (!result.ok) pushBlock({ kind: "error", id: nextBlockId(), message: `remover VM: ${result.error}` });
			void refreshSandbox();
		},
		[refreshSandbox, run],
	);

	const sandboxProvision = useCallback((): void => {
		enqueueDialog({ id: `local-provision-${Date.now()}`, method: "input", title: "Instalar pacotes apk na VM", placeholder: "nodejs npm python3 py3-pip" });
	}, [enqueueDialog]);

	const sandboxDiff = useCallback(async (): Promise<void> => {
		const result = await run({ type: "sandboxWorkspaceDiff" });
		if (!result.ok || !Array.isArray(result.data)) {
			setSandboxOutput(result.ok ? "—" : `erro: ${result.error}`);
			return;
		}
		const changes = result.data as { path: string; status: string }[];
		setSandboxOutput(changes.length ? changes.map((change) => `${change.status}\t${change.path}`).join("\n") : "workspace sem diferenças desde o baseline");
	}, [run]);

	const sandboxSnapshot = useCallback((): void => {
		enqueueDialog({
			id: `local-snapshot-${Date.now()}`,
			method: "input",
			title: "Nome do snapshot",
			placeholder: `snap-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`,
		});
	}, [enqueueDialog]);

	const sandboxRestore = useCallback(
		async (name: string): Promise<void> => {
			const result = await run({ type: "sandboxRestoreSnapshot", name });
			setSandboxOutput(result.ok ? `restaurado ${name}: ${JSON.stringify(result.data)}` : `erro: ${result.error}`);
			void refreshSandbox();
		},
		[refreshSandbox, run],
	);

	const sandboxSchedule = useCallback((): void => {
		if (!sandboxCmd.trim()) return;
		enqueueDialog({ id: `local-schedule-${Date.now()}`, method: "input", title: "Repetir tarefa a cada quantos segundos?", placeholder: "3600" });
	}, [enqueueDialog, sandboxCmd]);

	const sandboxUnschedule = useCallback(
		async (id: string): Promise<void> => {
			await run({ type: "sandboxUnschedule", id });
			void refreshSandbox();
		},
		[refreshSandbox, run],
	);

	const sandboxSaveLimits = useCallback(
		async (patch: { maxCpu?: number; maxMemoryMb?: number; maxSeconds?: number }): Promise<void> => {
			const next = { ...sandbox.limits, ...patch };
			await run({ type: "sandboxSetLimits", ...next });
			void refreshSandbox();
		},
		[refreshSandbox, run, sandbox.limits],
	);

	const installExtension = useCallback((): void => {
		enqueueDialog({ id: `local-install-${Date.now()}`, method: "input", title: "Instalar pacote", placeholder: "/caminho/pacote.mcpb" });
	}, [enqueueDialog]);

	const installExtensionAt = useCallback(
		async (path: string): Promise<void> => {
			const result = await run({ type: "installPackage", path });
			if (result.ok) {
				await loadExtensions();
				pushBlock({ kind: "error", id: nextBlockId(), message: `Pacote instalado: ${path}`, info: true });
			} else {
				pushBlock({ kind: "error", id: nextBlockId(), message: `instalar: ${result.error}` });
			}
		},
		[loadExtensions, run],
	);

	const sandboxBoot = useCallback(async (): Promise<void> => {
		setSandboxBusy(true);
		setSandboxOutput("bootando VM…\n");
		const result = await run({ type: "sandboxBoot" });
		setSandboxBusy(false);
		if (result.ok) {
			setSandbox(result.data as SandboxStatus);
			setSandboxOutput("VM pronta · workspace montado · egress via proxy\n");
		} else {
			setSandboxOutput(`erro: ${result.error}\n`);
			void refreshSandbox();
		}
	}, [refreshSandbox, run]);

	const sandboxExec = useCallback(async (): Promise<void> => {
		const command = sandboxCmd.trim();
		if (!command) return;
		setSandboxBusy(true);
		const result = await run({ type: "sandboxExec", command, cwd: "/workspace" });
		setSandboxBusy(false);
		const output = result.ok
			? readString(typeof result.data === "object" && result.data !== null && "output" in result.data ? result.data.output : "") ?? ""
			: `erro: ${result.error}`;
		setSandboxOutput((prev) => `${prev}~ $ ${command}\n${output}\n`);
		setSandboxCmd("");
	}, [sandboxCmd, run]);

	const sandboxTask = useCallback(async (): Promise<void> => {
		const command = sandboxCmd.trim();
		if (!command) return;
		setSandboxBusy(true);
		const result = await run({ type: "sandboxTask", command, cwd: "/workspace" });
		setSandboxBusy(false);
		if (result.ok) {
			setSandboxCmd("");
			void refreshSandbox();
		} else {
			setSandboxOutput((prev) => `${prev}erro ao criar tarefa: ${result.error}\n`);
		}
	}, [refreshSandbox, sandboxCmd, run]);

	const sandboxReadArtifact = useCallback(async (artifactId: string): Promise<void> => {
		const result = await run({ type: "sandboxArtifact", artifactId });
		if (result.ok && typeof result.data === "object" && result.data !== null && "body" in result.data) {
			setOpenArtifact({ id: artifactId, body: readString(result.data.body) ?? "" });
		}
	}, [run]);

	const changeModel = useCallback(async (provider: string, modelId: string): Promise<void> => {
		const result = await run({ type: "setModel", provider, modelId });
		if (!result.ok) pushBlock({ kind: "error", id: nextBlockId(), message: `modelo: ${result.error}` });
		panelStore.setState({ popoverOpen: false });
		void refreshState();
	}, [refreshState, run]);

	const changeThinking = useCallback(async (level: string): Promise<void> => {
		const result = await run({ type: "setThinkingLevel", level });
		if (!result.ok) pushBlock({ kind: "error", id: nextBlockId(), message: `thinking: ${result.error}` });
		void refreshState();
	}, [refreshState, run]);

	const cloneSession = useCallback(async (): Promise<void> => {
		const result = await run({ type: "clone" });
		if (!result.ok) pushBlock({ kind: "error", id: nextBlockId(), message: `clone: ${result.error}` });
		void refreshState();
		void loadSessions();
	}, [loadSessions, refreshState, run]);

	/* ---------- session actions ---------- */
	const runSlashCommand = useCallback(
		(raw: string): void => {
			const [name, ...rest] = raw.slice(1).split(/\s+/);
			const arg = rest.join(" ").trim();
			switch (name) {
				case "compact":
					void run({ type: "compact", customInstructions: arg || undefined });
					break;
				case "clear":
					setBlocks([]);
					break;
				case "new":
					void run({ type: "newSession" }).then(() => {
						setBlocks([]);
						sessionStore.setState({ usage: { tokens: 0, cost: 0 } });
						void refreshState();
					});
					break;
				case "export":
					void run({ type: "exportHtml" });
					break;
				case "model":
					if (arg) {
						const [provider, id] = arg.includes("/") ? arg.split("/") : ["", arg];
						void run({ type: "setModel", provider: provider ?? "", modelId: id ?? arg });
					} else {
						panelStore.setState({ popoverOpen: true });
					}
					break;
				case "thinking":
					if (arg) void run({ type: "setThinkingLevel", level: arg });
					break;
				case "help":
					pushBlock({
						kind: "error",
						id: nextBlockId(),
						info: true,
						message: "/compact [instruções] · /clear · /new · /export · /model [provider/id] · /thinking [nível] · /help",
					});
					break;
				default:
					pushBlock({ kind: "error", id: nextBlockId(), message: `comando desconhecido: /${name}` });
			}
		},
		[refreshState, run],
	);

	const submitMessage = useCallback(
		async (message: string, attached: { name: string; dataUrl: string }[] = []): Promise<void> => {
			const trimmed = message.trim();
			if (!trimmed) return;
			if (trimmed.startsWith("/")) {
				runSlashCommand(trimmed);
				return;
			}
			pinnedBottomRef.current = true;
			const display = attached.length ? `${trimmed}\n\n[${attached.length} anexo(s): ${attached.map((a) => a.name).join(", ")}]` : trimmed;
			pushBlock({ kind: "text", id: nextBlockId(), role: "user", content: display, streaming: false });
			const result = await run({ type: "prompt", message: trimmed, attachments: attached.length ? attached : undefined });
			if (!result.ok) pushBlock({ kind: "error", id: nextBlockId(), message: result.error });
			void run({ type: "rememberPrompt", text: trimmed }).then((r) => {
				if (r.ok && Array.isArray(r.data)) setPromptHistory(r.data.filter((v): v is string => typeof v === "string"));
			});
			void refreshState();
		},
		[refreshState, run, runSlashCommand],
	);

	const sendPrompt = useCallback(async (): Promise<void> => {
		const message = input.trim();
		if (!message && attachments.length === 0) return;
		const currentAttachments = attachments;
		setInput("");
		setAttachments([]);
		setHistoryIndex(-1);
		await submitMessage(message || "Analise os anexos.", currentAttachments);
	}, [attachments, input, submitMessage]);

	const steer = useCallback(async (): Promise<void> => {
		const message = input.trim();
		if (!message) return;
		setInput("");
		pushBlock({ kind: "text", id: nextBlockId(), role: "user", content: `↪ ${message}`, streaming: false });
		const result = await run({ type: "steer", message });
		if (!result.ok) pushBlock({ kind: "error", id: nextBlockId(), message: result.error });
	}, [input, run]);

	const queueFollowUp = useCallback((): void => {
		const message = input.trim();
		if (!message) return;
		setInput("");
		sessionStore.setState((prev) => ({ ...prev, queued: [...prev.queued, message] }));
	}, [input]);

	const navigateHistory = useCallback(
		(direction: -1 | 1): void => {
			if (promptHistory.length === 0) return;
			const next = Math.max(-1, Math.min(promptHistory.length - 1, historyIndex + direction));
			setHistoryIndex(next);
			setInput(next === -1 ? "" : (promptHistory[next] ?? ""));
		},
		[historyIndex, promptHistory],
	);

	const attachImage = useCallback((file: File): void => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = typeof reader.result === "string" ? reader.result : "";
			if (dataUrl) setAttachments((prev) => [...prev, { name: file.name, dataUrl }]);
		};
		reader.readAsDataURL(file);
	}, []);

	/* ---------- workspace ---------- */
	const loadTree = useCallback(async (root: string): Promise<void> => {
		const result = await run({ type: "readTree", root, maxDepth: 3 });
		if (result.ok && Array.isArray(result.data)) {
			workspaceStore.setState((prev) => ({
				...prev,
				treeByRoot: { ...prev.treeByRoot, [root]: result.data as FileNode[] },
			}));
		}
	}, [run]);

	const searchMentions = useCallback(
		async (query: string): Promise<void> => {
			const root = roots[0] ?? state?.cwd;
			if (!root || !query.trim()) {
				setMentionHits([]);
				return;
			}
			const result = await run({ type: "searchFiles", root, query });
			if (result.ok && Array.isArray(result.data)) {
				setMentionHits((result.data as { path: string; rel: string }[]).slice(0, 12));
			}
		},
		[roots, run, state?.cwd],
	);

	const openFile = useCallback(
		async (path: string): Promise<void> => {
			const result = await run({ type: "openFile", path });
			if (!result.ok) pushBlock({ kind: "error", id: nextBlockId(), message: result.error });
		},
		[run],
	);

	const searchAllSessions = useCallback(
		async (query: string): Promise<void> => {
			workspaceStore.setState({ sessionQuery: query });
			if (query.trim().length < 2) {
				workspaceStore.setState({ sessionHits: [] });
				return;
			}
			const result = await run({ type: "searchSessions", query });
			if (result.ok && Array.isArray(result.data)) {
				workspaceStore.setState({ sessionHits: (result.data as SessionSearchHit[]).slice(0, 30) });
			}
		},
		[run],
	);

	const loadFolders = useCallback(async (): Promise<void> => {
		const result = await run({ type: "listFolders" });
		if (result.ok && typeof result.data === "object" && result.data !== null) {
			workspaceStore.setState({ folders: result.data as FolderIndex });
		}
	}, [run]);

	const assignFolder = useCallback(
		async (sessionPath: string, folder: string | null): Promise<void> => {
			await run({ type: "setSessionFolder", sessionPath, folder });
			await loadFolders();
		},
		[loadFolders, run],
	);

	const savePrompt = useCallback(async (title: string, body: string): Promise<void> => {
		const result = await run({ type: "savePrompt", title, body });
		if (result.ok && Array.isArray(result.data)) {
			setSavedPrompts(result.data as { id: string; title: string; body: string }[]);
		}
	}, [run]);

	const deleteSavedPrompt = useCallback(async (id: string): Promise<void> => {
		const result = await run({ type: "deletePrompt", id });
		if (result.ok && Array.isArray(result.data)) {
			setSavedPrompts(result.data as { id: string; title: string; body: string }[]);
		}
	}, [run]);

	const newSession = useCallback(async (): Promise<void> => {
		await run({ type: "newSession" });
		setBlocks([]);
		sessionStore.setState({ usage: { tokens: 0, cost: 0 } });
		void refreshState();
	}, [refreshState, run]);

	const abort = useCallback((): void => {
		void run({ type: "abort" });
	}, [run]);

	const newSessionIn = useCallback(async (cwd: string): Promise<void> => {
		await run({ type: "startIn", cwd });
		setBlocks([]);
		sessionStore.setState({ usage: { tokens: 0, cost: 0 } });
		workspaceStore.setState((prev) => ({
			...prev,
			roots: prev.roots.includes(cwd) ? prev.roots : [...prev.roots, cwd].slice(-4),
			treeOpen: { ...prev.treeOpen, [cwd]: true },
		}));
		void refreshState();
		void loadSessions();
		void loadTree(cwd);
	}, [loadSessions, loadTree, refreshState, run]);

	const resumeSession = useCallback(async (sessionPath: string): Promise<void> => {
		setBlocks([]);
		const result = await run({ type: "switchSession", sessionPath });
		if (!result.ok) pushBlock({ kind: "error", id: nextBlockId(), message: result.error });
		const transcript = await run({ type: "sessionTranscript", sessionPath });
		if (transcript.ok && Array.isArray(transcript.data)) {
			const rebuilt = [];
			for (const block of transcript.data as { kind: string; role?: "user" | "assistant"; content?: string; toolName?: string; args?: string; entryId?: string }[]) {
				if (block.kind === "text" && block.content) {
					rebuilt.push({
						kind: "text" as const,
						id: nextBlockId(),
						role: block.role ?? ("assistant" as const),
						content: block.content,
						streaming: false,
						entryId: block.entryId,
					});
				} else if (block.kind === "tool" && block.toolName) {
					rebuilt.push({ kind: "tool" as const, id: nextBlockId(), toolName: block.toolName, args: block.args ?? "", output: "", streaming: false });
				}
			}
			setBlocks(rebuilt);
		}
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
		if (!result.ok) pushBlock({ kind: "error", id: nextBlockId(), message: result.error });
		void refreshState();
	}, [refreshState, run]);

	const exportSession = useCallback(async (): Promise<void> => {
		const result = await run({ type: "exportHtml" });
		if (result.ok && typeof result.data === "object" && result.data !== null && "path" in result.data) {
			const path = readString(result.data.path) ?? "";
			pushBlock({ kind: "error", id: nextBlockId(), message: `HTML exportado: ${path}`, info: true });
		}
	}, [run]);

	const forkFrom = useCallback(async (entryId: string): Promise<void> => {
		const result = await run({ type: "fork", entryId });
		if (!result.ok) pushBlock({ kind: "error", id: nextBlockId(), message: `fork: ${result.error}` });
		void refreshState();
		void loadSessions();
	}, [loadSessions, refreshState, run]);

	const copyText = useCallback((text: string): void => {
		void navigator.clipboard.writeText(text);
	}, []);

	/* ---------- boot ---------- */
	useEffect(() => {
		void window.noishi.getTheme().then((t) => {
			document.documentElement.dataset.theme = t;
		});
		void window.noishi.getEnv().then((e) => sessionStore.setState({ env: e }));
		void refreshState();
		void loadSessions();
		void loadModels();
		void loadExtensions();
		void refreshSandbox();
		void run({ type: "getPrefs" }).then((result) => {
			if (!result.ok || typeof result.data !== "object" || result.data === null) return;
			const data = result.data as Record<string, unknown>;
			panelStore.setState({ prefs: data });
			if (Array.isArray(data.promptHistory)) setPromptHistory(data.promptHistory.filter((v): v is string => typeof v === "string"));
			if (Array.isArray(data.savedPrompts)) setSavedPrompts(data.savedPrompts as { id: string; title: string; body: string }[]);
			if (typeof data.composerHeight === "number") setComposerHeight(data.composerHeight);
		});
		void loadFolders();
		const offSandbox = window.noishi.onSandboxEvent(() => {
			void refreshSandbox();
		});
		const offEvent = window.noishi.onSessionEvent((event) => {
			handleSessionEvent(event, { refreshState, refreshUsage });
		});
		const offUi = window.noishi.onExtensionUiRequest(handleExtensionUiRequest);
		const offRoute = window.noishi.onDeepLinkRoute((route) => {
			if (route.kind === "chat/new" || route.kind === "code/new") setBlocks([]);
			if (route.kind === "code/needs-input") sessionStore.setState({ needsInput: true });
			if (route.kind === "chat/share") {
				panelStore.setState({ activePanel: "chat" });
				setInput((prev) => (prev.trim() ? `${prev}\n\n${route.prompt}` : route.prompt));
			}
		});
		const offTheme = window.noishi.onThemeChange((t) => {
			document.documentElement.dataset.theme = t;
		});
		let appliedTokenNames: string[] = [];
		const offTokens = window.noishi.onThemeTokens((tokens) => {
			for (const name of appliedTokenNames) document.documentElement.style.removeProperty(name);
			appliedTokenNames = Object.keys(tokens);
			for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
		});
		return () => {
			offEvent();
			offSandbox();
			offUi();
			offRoute();
			offTheme();
			offTokens();
		};
	}, [loadExtensions, loadFolders, loadModels, loadSessions, refreshSandbox, refreshState, refreshUsage, run]);

	// Smart auto-scroll: only scroll to bottom if the user hasn't scrolled up to read history.
	useEffect(() => {
		const el = scrollRef.current;
		if (el && pinnedBottomRef.current) el.scrollTop = el.scrollHeight;
	}, [blocks]);

	// Outside click closes popovers (model popover, saved prompts, @-mention).
	useEffect(() => {
		if (!popoverOpen && !savedOpen && !mentionOpen) return;
		const close = (e: MouseEvent): void => {
			const target = e.target;
			if (!(target instanceof Element)) return;
			if (popoverOpen && !target.closest(".popover") && !target.closest(".model-pill")) {
				panelStore.setState({ popoverOpen: false });
			}
			if (savedOpen && !target.closest(".saved-menu") && !target.closest(".saved-pill")) {
				setSavedOpen(false);
			}
			if (mentionOpen && !target.closest(".slash-menu")) {
				setMentionOpen(false);
			}
		};
		window.addEventListener("mousedown", close);
		return () => window.removeEventListener("mousedown", close);
	}, [mentionOpen, popoverOpen, savedOpen]);

	useEffect(() => {
		if (mode !== "artifact") return;
		const artifactId = new URLSearchParams(window.location.search).get("id");
		if (!artifactId) return;
		void window.noishi
			.runSessionCommand({ type: "sandboxArtifact", artifactId })
			.then((result) => {
				if (result.ok && typeof result.data === "object" && result.data !== null && "body" in result.data) {
					setArtifactBody(readString(result.data.body) ?? "");
				}
			});
	}, [mode]);

	useEffect(() => {
		const offOpen = window.noishi.find.onOpen(() => panelStore.setState({ findOpen: true }));
		const offResult = window.noishi.find.onResult((result) => {
			panelStore.setState({ findResult: { matches: result.matches, active: result.active } });
		});
		return () => {
			offOpen();
			offResult();
		};
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
				e.preventDefault();
				panelStore.setState({ findOpen: true });
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const turnStep = useMemo(() => {
		if (!state?.isStreaming) return null;
		const last = blocks[blocks.length - 1];
		if (!last) return "pensando…";
		if (last.kind === "tool") {
			const label = TOOL_LABELS[last.toolName] ?? last.toolName;
			return last.streaming ? `${label}…` : `${label} · concluído`;
		}
		if (last.kind === "thinking") return last.streaming ? "pensando…" : "pensou";
		if (last.kind === "text") return last.streaming ? "escrevendo…" : "escreveu";
		return "trabalhando…";
	}, [blocks, state?.isStreaming]);

	const status = useMemo(() => {
		if (rpcError) return { dot: "dot--danger", text: "erro: RPC indisponível" };
		if (!state) return { dot: "", text: "conectando…" };
		if (state.isStreaming) return { dot: "dot--live", text: turnStep ?? "trabalhando…" };
		if (state.isCompacting) return { dot: "dot--warn", text: "compactando histórico · estimando resumo" };
		return { dot: "dot--ok", text: "pronto" };
	}, [state, rpcError, turnStep]);

	const statusText = useMemo(() => {
		const model = state?.model?.id ?? state?.model?.name ?? "—";
		const thinking = state?.thinkingLevel ?? "off";
		return `${status.text} · ${model} · thinking ${thinking}`;
	}, [status.text, state]);

	const meter = useMemo(() => {
		const win = state?.model?.contextWindow ?? 0;
		if (!win || !usage.tokens) return null;
		const ratio = usage.tokens / win;
		const filled = Math.min(10, Math.round(ratio * 10));
		const cls = ratio >= 0.9 ? "high" : ratio >= 0.7 ? "mid" : "on";
		return { filled, cls };
	}, [state, usage]);

	const activeSession = state?.sessionFile;

	const budgetState = useRef<{ warned: boolean; stopped: boolean }>({ warned: false, stopped: false });
	useEffect(() => {
		const budget = (prefs as { budget?: { warnUsd: number | null; stopUsd: number | null } } | null)?.budget;
		if (!budget || usage.cost <= 0) return;
		const warnAt = budget.warnUsd;
		const stopAt = budget.stopUsd;
		if (warnAt !== null && usage.cost >= warnAt && !budgetState.current.warned) {
			budgetState.current.warned = true;
			pushBlock({ kind: "error", id: nextBlockId(), info: true, message: `orçamento: $${usage.cost.toFixed(4)} passou do aviso de $${warnAt.toFixed(2)}` });
		}
		if (stopAt !== null && usage.cost >= stopAt && !budgetState.current.stopped) {
			budgetState.current.stopped = true;
			void run({ type: "abort" });
			pushBlock({ kind: "error", id: nextBlockId(), message: `orçamento: $${usage.cost.toFixed(4)} atingiu o limite de $${stopAt.toFixed(2)} — turno interrompido` });
		}
	}, [prefs, run, usage.cost]);

	useEffect(() => {
		void run({ type: "trayBadge", count: needsInput ? 1 : 0 });
	}, [needsInput, run]);

	const handleDialogAnswer = useCallback(
		(response: ExtensionUiResponse): void => {
			const dialog = pendingDialog[0];
			if (!dialog) return;
			if (dialog.id.startsWith("local-open-") && "value" in response) {
				void newSessionIn(response.value);
			} else if (dialog.id.startsWith("local-folder-") && "value" in response) {
				void assignFolder(dialog.id.slice("local-folder-".length), response.value.trim() || null);
			} else if (dialog.id.startsWith("local-root-") && "value" in response) {
				const cwd = response.value;
				workspaceStore.setState((prev) => ({
					...prev,
					roots: prev.roots.includes(cwd) ? prev.roots : [...prev.roots, cwd].slice(-4),
					treeOpen: { ...prev.treeOpen, [cwd]: true },
				}));
				void loadTree(cwd);
			} else if (dialog.id.startsWith("local-install-") && "value" in response) {
				void installExtensionAt(response.value);
			} else if (dialog.id.startsWith("local-edit-") && "value" in response) {
				void submitMessage(response.value);
			} else if (dialog.id.startsWith("local-vm-") && "value" in response) {
				const name = response.value;
				void run({ type: "sandboxCreateInstance", name }).then((res) => {
					if (!res.ok) pushBlock({ kind: "error", id: nextBlockId(), message: `instância: ${res.error}` });
					else void sandboxSetActive(name.trim().replace(/[^\w.-]/g, "_").slice(0, 40));
				});
			} else if (dialog.id.startsWith("local-provision-") && "value" in response) {
				const list = response.value;
				setSandboxBusy(true);
				void run({ type: "sandboxProvision", toolchain: list.split(/[\s,]+/).filter(Boolean) }).then((res) => {
					setSandboxBusy(false);
					setSandboxOutput(res.ok ? `toolchain: ${list}\n${(res.data as { output: string }).output}` : `erro: ${res.error}`);
					void refreshSandbox();
				});
			} else if (dialog.id.startsWith("local-snapshot-") && "value" in response) {
				const name = response.value;
				void run({ type: "sandboxSnapshot", name }).then((res) => {
					setSandboxOutput(res.ok ? `snapshot ${name}: ${JSON.stringify(res.data)}` : `erro: ${res.error}`);
					void refreshSandbox();
				});
			} else if (dialog.id.startsWith("local-schedule-") && "value" in response) {
				const every = Number(response.value);
				const command = sandboxCmd.trim();
				if (Number.isFinite(every) && every > 0 && command) {
					void run({ type: "sandboxSchedule", command, everySeconds: every }).then((res) => {
						setSandboxOutput(res.ok ? `agendada a cada ${every}s: ${command}` : `erro: ${res.error}`);
						void refreshSandbox();
					});
				}
			} else if (!dialog.id.startsWith("local-")) {
				window.noishi.answerExtensionUi(response);
			}
			panelStore.setState((prev) => ({ ...prev, pendingDialog: prev.pendingDialog.slice(1) }));
		},
		[assignFolder, installExtensionAt, loadTree, newSessionIn, pendingDialog, refreshSandbox, run, sandboxCmd, sandboxSetActive, submitMessage],
	);

	const handleEditBlock = useCallback((blockId: number, content: string): void => {
		enqueueDialog({ id: `local-edit-${blockId}`, method: "editor", title: "Editar e reenviar mensagem", prefill: content });
	}, [enqueueDialog]);

	const blockIcons = useMemo(
		() => ({
			fork: <Icon d={ICONS.fork} size={12} />,
			copy: <Icon d={ICONS.copy} size={12} />,
			edit: <Icon d={ICONS.edit} size={12} />,
			terminal: <Icon d={ICONS.terminal} size={13} />,
		}),
		[],
	);

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
					<button className="btn btn--ghost btn--icon btn--sm" onClick={() => void refreshState()} type="button" title="Atualizar estado" aria-label="Atualizar estado">
						<Icon d={ICONS.pin} size={12} />
					</button>
					<button className="btn btn--ghost btn--icon btn--sm" onClick={() => void window.noishi.openMainWindow()} type="button" title="Abrir janela principal" aria-label="Abrir janela principal">
						<Icon d={ICONS.expand} size={12} />
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
							aria-label="Pergunta rápida"
							rows={2}
							autoFocus
						/>
						<div className="quick-bar">
							<button className="chip chip--mono" onClick={() => void changeThinking("medium")} type="button">
								{state?.model?.id ?? "modelo"}
							</button>
							<span className="hint">Ctrl+Shift+Space</span>
							<button className={`btn btn--icon btn--sm${input.trim() ? " is-on" : ""}`} onClick={() => void sendPrompt()} disabled={!input.trim() || Boolean(state?.isStreaming)} type="button" title="Enviar" aria-label="Enviar">
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
		const isHtml = artifactBody ? /<!doctype|<html|<svg|<script/i.test(artifactBody) : false;
		const kind = artifactBody?.trim().startsWith("<svg") ? "svg" : "html";
		return (
			<div className="artifact">
				<div className="artifact-head">
					<Icon d={ICONS.file} size={15} />
					<b>Relatório de sessão</b>
					<span className="badge">{isHtml ? "interativo" : "somente leitura"}</span>
					<span className="mono">{artifactId || "sem id"}</span>
					<span className="spacer" />
					<button className="btn btn--ghost btn--sm" onClick={() => copyText(window.location.href)} type="button">
						<Icon d={ICONS.copy} size={12} />
						Copiar link
					</button>
					<button
						className="btn btn--ghost btn--sm"
						onClick={() => {
							if (artifactBody === null) return;
							const blob = new Blob([artifactBody], { type: "text/markdown" });
							const url = URL.createObjectURL(blob);
							const a = document.createElement("a");
							a.href = url;
							a.download = `noishi-artifact-${artifactId || "sem-id"}.md`;
							a.click();
							URL.revokeObjectURL(url);
						}}
						disabled={artifactBody === null}
						type="button"
					>
						<Icon d={ICONS.export} size={12} />
						Exportar
					</button>
				</div>
				<div className="artifact-body">
					<div className="artifact-doc">
						{artifactBody === null ? (
							<p>Carregando artefato…</p>
						) : isHtml ? (
							<Suspense fallback={<p>Carregando preview…</p>}>
								<ArtifactSandbox
									title={artifactId || "Artifact"}
									kind={kind}
									revisions={[{ version: "v1", content: artifactBody, timestamp: Date.now() }]}
									onFixError={(err) => {
										void run({ type: "prompt", message: `Corrija o erro de runtime no artefato ${artifactId}:\n\n\`\`\`\n${err}\n\`\`\`` });
										window.noishi.openMainWindow();
									}}
								/>
							</Suspense>
						) : (
							<pre className="artifact-pre">{artifactBody}</pre>
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
					<button
						className="icon-btn"
						onClick={() => panelStore.setState((prev) => ({ ...prev, sidebarOpen: !prev.sidebarOpen }))}
						type="button"
						title="Colapsar sidebar"
						aria-label={sidebarOpen ? "Colapsar barra lateral" : "Expandir barra lateral"}
						aria-expanded={sidebarOpen}
					>
						<Icon d={ICONS.panel} />
					</button>
				</div>
				<div className="sidebar-actions">
					<button className="btn btn--new-chat" onClick={() => void newSession()} type="button" aria-label="Nova conversa">
						<Icon d={ICONS.plus} size={13} />
						<span className="btn-label">Nova conversa</span>
					</button>
					<button
						className="btn"
						onClick={() => enqueueDialog({ id: `local-open-${Date.now()}`, method: "input", title: "Abrir projeto", placeholder: "~/projetos/noishi-desktop" })}
						type="button"
					>
						<Icon d={ICONS.folder} size={13} />
						<span className="btn-label">Abrir projeto…</span>
					</button>
				</div>
				<div className="sidebar-section">
					<span className="sidebar-section-title">Arquivos</span>
					<span className="sidebar-section-right">
						<span className="count">{roots.length}</span>
						<button
							className="icon-btn icon-btn--tiny"
							onClick={() => enqueueDialog({ id: `local-root-${Date.now()}`, method: "input", title: "Adicionar pasta ao workspace", placeholder: "/caminho/do/projeto" })}
							title="Adicionar raiz"
							aria-label="Adicionar pasta ao workspace"
							type="button"
						>
							<Icon d={ICONS.plus} size={11} />
						</button>
					</span>
				</div>
				<div className="file-tree">
					{roots.length === 0 ? <div className="session-empty">Abra um projeto para ver os arquivos.</div> : null}
					{roots.map((root) => (
						<div key={root} className="tree-root">
							<button
								className="tree-row tree-root-row"
								onClick={() => {
									const opening = !treeOpen[root];
									workspaceStore.setState((prev) => ({ ...prev, treeOpen: { ...prev.treeOpen, [root]: opening } }));
									if (opening) void loadTree(root);
								}}
								type="button"
								title={root}
							>
								<Icon d={treeOpen[root] ? ICONS.chevronDown : ICONS.chevronRight} size={10} />
								<Icon d={ICONS.folder} size={11} />
								<span className="tree-name">{root.split("/").pop() ?? root}</span>
							</button>
							{treeOpen[root] ? <TreeNodes nodes={treeByRoot[root] ?? []} depth={0} onOpen={(path) => void openFile(path)} /> : null}
						</div>
					))}
				</div>
				<div className="sidebar-section">
					<span className="sidebar-section-title">Sessões</span>
					<span className="count">{sessions.length}</span>
				</div>
				<div className="session-search">
					<Icon d={ICONS.search} size={11} />
					<input
						className="field session-search-input"
						value={sessionQuery}
						onChange={(e) => void searchAllSessions(e.target.value)}
						placeholder="Buscar em todas as sessões"
						aria-label="Buscar em todas as sessões"
					/>
				</div>
				{sessionHits.length > 0 ? (
					<div className="session-hits">
						{sessionHits.map((hit, index) => (
							<button
								key={`${hit.sessionPath}-${hit.line}-${index}`}
								className="session-hit"
								onClick={() => void resumeSession(hit.sessionPath)}
								type="button"
								title={hit.sessionPath}
							>
								<span className="mono session-hit-role">{hit.role ?? "?"}</span>
								<span className="session-hit-text">{hit.snippet}</span>
							</button>
						))}
					</div>
				) : null}
				<div className="session-list" role="list" aria-label="Sessões">
					{sessions.map((session) => {
						const isRenaming = renaming === session.sessionFile;
						if (isRenaming) {
							return (
								<div key={session.sessionId} className="session-item active">
									<input
										className="session-rename"
										defaultValue={session.name ?? session.sessionId.slice(0, 8)}
										aria-label="Renomear sessão"
										autoFocus
										onBlur={(e) => void renameSession(session.sessionFile, e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") void renameSession(session.sessionFile, e.currentTarget.value);
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
								onContextMenu={(e) => {
									e.preventDefault();
									const current = folders.entries[session.sessionFile]?.folder ?? null;
									enqueueDialog({
										id: `local-folder-${session.sessionFile}`,
										method: "input",
										title: `Pasta de "${session.name ?? session.sessionId.slice(0, 8)}"`,
										placeholder: current ?? "ex.: clientes/acme",
									});
								}}
								type="button"
								title={`${session.sessionFile}\nDuplo clique para renomear`}
							>
								<span className="session-title">{session.name ?? session.sessionId.slice(0, 8)}</span>
								<span className="session-sub">
									{new Date(session.modifiedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })} · {session.messageCount ?? 0} msgs
									{folders.entries[session.sessionFile]?.folder ? (
										<span className="session-folder">{folders.entries[session.sessionFile]?.folder}</span>
									) : null}
									{folders.entries[session.sessionFile]?.tags?.map((tag) => (
										<span key={tag} className="session-tag">#{tag}</span>
									))}
								</span>
							</button>
						);
					})}
					{sessions.length === 0 ? <div className="session-empty">Nenhuma sessão ainda. Abra um projeto para começar.</div> : null}
				</div>
				<div className="sidebar-footer">
					<span className={`dot ${state ? "dot--ok" : rpcError ? "dot--danger" : ""}`} />
					CLI {env?.cliVersion ?? "?"} · v{env?.appVersion ?? "0.1.0"}
				</div>
			</aside>

			<div className="main">
				<header className="topbar">
					<span className="crumb">{view === "chat" ? state?.sessionName ?? (mode === "buddy" ? "Buddy" : "Nova conversa") : VIEW_LABELS[view]}</span>
					<span className="status" role="status" aria-live="polite" title={statusText}>
						<span className={`dot ${status.dot}`} />
						<span className="status-text">{statusText}</span>
						{meter ? (
							<span className="meter">
								{Array.from({ length: 10 }, (_, i) => (
									<i key={i} className={i < meter.filled ? meter.cls : ""} />
								))}
							</span>
						) : null}
						{usage.tokens > 0 ? <span className="mono">{Math.round(usage.tokens / 100) / 10}k · ${usage.cost.toFixed(4)}</span> : null}
					</span>
					<div className="view-tabs" role="tablist" aria-label="Áreas do app">
						{(["chat", "terminal", "sandbox", "review", "git", "context", "settings"] as const).map((tab) => (
							<button
								key={tab}
								role="tab"
								aria-selected={view === tab}
								className={`view-tab${view === tab ? " is-on" : ""}`}
								onClick={() => {
									panelStore.setState({ activePanel: tab });
									if (tab === "sandbox") void refreshSandbox();
								}}
								type="button"
							>
								{tab === "chat" ? "Chat" : VIEW_LABELS[tab]}
							</button>
						))}
					</div>
					<div className="topbar-actions">
						{state?.isStreaming ? (
							<button className="btn btn--danger btn--sm" onClick={abort} type="button">
								<Icon d={ICONS.stop} size={12} />
								<span className="topbar-act-label">Parar</span>
							</button>
						) : null}
						{state?.isCompacting ? <span className="chip">compactando…</span> : null}
						<button className="btn btn--ghost btn--sm" onClick={() => void cloneSession()} disabled={!state?.sessionId} title="Clonar sessão" aria-label="Clonar sessão" type="button">
							<Icon d={ICONS.clone} size={12} />
							<span className="topbar-act-label">Clonar</span>
						</button>
						<button className="btn btn--ghost btn--sm" onClick={() => void compactSession()} disabled={!state?.sessionId} title="Compactar histórico" aria-label="Compactar histórico" type="button">
							<Icon d={ICONS.compress} size={12} />
							<span className="topbar-act-label">Compactar</span>
						</button>
						<button className="btn btn--ghost btn--sm" onClick={() => void exportSession()} disabled={!state?.sessionId} title="Exportar HTML" aria-label="Exportar HTML" type="button">
							<Icon d={ICONS.export} size={12} />
							<span className="topbar-act-label">Exportar</span>
						</button>
					</div>
					<div className="window-controls">
						<button className="btn btn--icon btn--sm window-btn" onClick={() => void run({ type: "windowControl", action: "minimize" })} type="button" aria-label="Minimizar" title="Minimizar">
							<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
						</button>
						<button className="btn btn--icon btn--sm window-btn" onClick={() => void run({ type: "windowControl", action: "maximize" })} type="button" aria-label="Maximizar" title="Maximizar">
							<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="2.2" y="2.2" width="5.6" height="5.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
						</button>
						<button className="btn btn--icon btn--sm window-btn window-btn--close" onClick={() => void run({ type: "windowControl", action: "close" })} type="button" aria-label="Fechar" title="Fechar">
							<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.6 2.6l4.8 4.8M7.4 2.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
						</button>
					</div>
				</header>

				{findOpen ? (
					<div className="findbar">
						<Icon d={ICONS.search} size={12} />
						<input
							className="field findbar-input"
							autoFocus
							value={findText}
							onChange={(e) => {
								panelStore.setState({ findText: e.target.value });
								window.noishi.find.query(e.target.value, true);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									window.noishi.find.query(findText, !e.shiftKey);
								}
								if (e.key === "Escape") {
									window.noishi.find.clear();
									panelStore.setState({ findOpen: false, findText: "", findResult: { matches: 0, active: 0 } });
								}
							}}
							placeholder="Localizar no chat"
							aria-label="Localizar no chat"
						/>
						<span className="mono findbar-count">{findText ? `${findResult.active}/${findResult.matches}` : ""}</span>
						<button className="btn btn--ghost btn--icon btn--sm" onClick={() => window.noishi.find.query(findText, false)} disabled={!findText} title="Anterior" aria-label="Ocorrência anterior" type="button">
							<Icon d={ICONS.chevronUp} size={12} />
						</button>
						<button className="btn btn--ghost btn--icon btn--sm" onClick={() => window.noishi.find.query(findText, true)} disabled={!findText} title="Próximo" aria-label="Próxima ocorrência" type="button">
							<Icon d={ICONS.chevronDown} size={12} />
						</button>
						<button
							className="btn btn--ghost btn--icon btn--sm"
							onClick={() => {
								window.noishi.find.clear();
								panelStore.setState({ findOpen: false, findText: "", findResult: { matches: 0, active: 0 } });
							}}
							title="Fechar busca"
							aria-label="Fechar busca"
							type="button"
						>
							<Icon d={ICONS.x} size={12} />
						</button>
					</div>
				) : null}

				{statusWidgets.length > 0 ? (
					<div className="widgets">
						{statusWidgets.map((widget) => (
							<pre key={widget.key} className="widget">{widget.lines.join("\n")}</pre>
						))}
					</div>
				) : null}

				{view === "sandbox" ? (
					<SandboxView
						sandbox={sandbox}
						sandboxBusy={sandboxBusy}
						sandboxCmd={sandboxCmd}
						setSandboxCmd={setSandboxCmd}
						sandboxOutput={sandboxOutput}
						openArtifact={openArtifact}
						setOpenArtifact={setOpenArtifact}
						onSetActive={(id) => void sandboxSetActive(id)}
						onCreateInstance={sandboxCreateInstance}
						onDestroyInstance={(id) => void sandboxDestroyInstance(id)}
						onBoot={() => void sandboxBoot()}
						onShutdown={() => void run({ type: "sandboxShutdown" }).then(() => void refreshSandbox())}
						onTask={() => void sandboxTask()}
						onExec={() => void sandboxExec()}
						onSchedule={sandboxSchedule}
						onUnschedule={(id) => void sandboxUnschedule(id)}
						onProvision={sandboxProvision}
						onDiff={() => void sandboxDiff()}
						onSnapshot={sandboxSnapshot}
						onRestore={(name) => void sandboxRestore(name)}
						onSaveLimits={(patch) => void sandboxSaveLimits(patch)}
						onReadArtifact={(id) => void sandboxReadArtifact(id)}
						onSendArtifactToChat={(id) => {
							pushBlock({ kind: "error", id: nextBlockId(), message: `Artefato do sandbox: ${id}`, info: true });
							panelStore.setState({ activePanel: "chat" });
						}}
						icons={{ file: <Icon d={ICONS.file} size={12} />, x: <Icon d={ICONS.x} size={10} />, share: <Icon d={ICONS.share} size={12} /> }}
					/>
				) : view === "review" ? (
					<div className="panel-pane">
						<Suspense fallback={<div className="panel-empty">Carregando revisão…</div>}>
							<ReviewPanel run={run} cwd={state?.cwd ?? ""} sessionId={state?.sessionId ?? ""} />
						</Suspense>
					</div>
				) : view === "git" ? (
					<div className="panel-pane">
						<Suspense fallback={<div className="panel-empty">Carregando Git…</div>}>
							<GitPanel run={run} cwd={state?.cwd ?? ""} sessionId={state?.sessionId ?? ""} />
						</Suspense>
					</div>
				) : view === "context" ? (
					<div className="panel-pane">
						<Suspense fallback={<div className="panel-empty">Carregando contexto…</div>}>
							<ContextPanel
								run={run}
								sessionPath={state?.sessionFile ?? ""}
								contextWindow={state?.model?.contextWindow ?? 0}
								usedTokens={usage.tokens}
								onBudgetWarn={(message) => pushBlock({ kind: "error", id: nextBlockId(), message, info: true })}
							/>
						</Suspense>
					</div>
				) : view === "settings" ? (
					<div className="panel-pane">
						<Suspense fallback={<div className="panel-empty">Carregando ajustes…</div>}>
							<SettingsPanel run={run} onPrefs={(next) => panelStore.setState({ prefs: next as unknown as Record<string, unknown> })} />
						</Suspense>
					</div>
				) : view === "terminal" ? (
					<div className="terminal-pane">
						<Suspense fallback={<div className="panel-empty">Carregando terminal…</div>}>
							<TerminalView cwd={state?.cwd ?? "~"} />
						</Suspense>
					</div>
				) : (
					<div
						className="chat"
						ref={scrollRef}
						onScroll={(e) => {
							const el = e.currentTarget;
							pinnedBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
						}}
					>
						{rpcError ? (
							<div className="banner banner--danger" role="alert">
								<Icon d={ICONS.alert} className="ic" />
								<div className="grow"><b>Agente RPC indisponível.</b> {rpcError}.</div>
								<button className="btn btn--sm" onClick={() => void reconnectRpc()} disabled={reconnecting} type="button">
									{reconnecting ? "Reconectando…" : "Reconectar"}
								</button>
							</div>
						) : null}
						{blocks.length === 0 ? (
							<div className="greeting">
								<h1>{greeting()}</h1>
								<p>{rpcError ? "Configure NOISHI_CLI_ROOT ou instale o CLI para iniciar uma sessão." : "Noishi está pronto."}</p>
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
								{needsInput ? (
									<div className="banner banner--accent">
										<Icon d={ICONS.alert} className="ic" />
										<div><b>Esta sessão está aguardando sua resposta.</b> Aberta pela rota <span className="mono">noishi://code/needs-input</span>.</div>
									</div>
								) : null}
								{blocks.map((block) => (
									<ChatBlockRow
										key={block.id}
										block={block}
										onFork={(entryId) => void forkFrom(entryId)}
										onCopy={copyText}
										onEdit={handleEditBlock}
										icons={blockIcons}
									/>
								))}
							</div>
						)}
					</div>
				)}

				{pendingDialog[0] ? <DialogLayer dialog={pendingDialog[0]} onAnswer={handleDialogAnswer} /> : null}

				{view === "chat" || mode === "buddy" ? (
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
									<button className={`popover-item${extensionsOpen ? " is-on" : ""}`} onClick={() => { setExtensionsOpen((o) => !o); void loadExtensions(); }} type="button">
										<Icon d={ICONS.spark} size={13} />
										<span className="grow">Extensões</span>
										<small>
											{extensions.enabledServers.length}/{extensions.mcpServers.length} MCP · {extensions.skills.length} skills
										</small>
									</button>
									{extensionsOpen ? (
										<div className="settings-ext">
											<div className="settings-ext-label">MCP servers</div>
											{extensions.mcpServers.length === 0 ? <div className="settings-ext-empty">Nenhum instalado.</div> : null}
											{extensions.mcpServers.map((name) => {
												const on = extensions.enabledServers.includes(name);
												return (
													<div key={name} className="settings-ext-row">
														<button
															className={`settings-toggle${on ? " is-on" : ""}`}
															onClick={() => void toggleServer(name, !on)}
															title={on ? "Desativar" : "Ativar"}
															aria-label={`${on ? "Desativar" : "Ativar"} ${name}`}
															type="button"
															aria-pressed={on}
														>
															<span className="settings-toggle-knob" />
														</button>
														<span className="settings-ext-name">{name}</span>
														<button className="btn btn--ghost btn--icon btn--sm" onClick={() => void removeInstalled("mcp", name)} title="Remover" aria-label={`Remover ${name}`} type="button">
															<Icon d={ICONS.x} size={11} />
														</button>
													</div>
												);
											})}
											<div className="settings-ext-label">Skills</div>
											{extensions.skills.length === 0 ? <div className="settings-ext-empty">Nenhuma instalada.</div> : null}
											{extensions.skills.map((name) => (
												<div key={name} className="settings-ext-row">
													<span className="settings-ext-name">{name}</span>
													<button className="btn btn--ghost btn--icon btn--sm" onClick={() => void removeInstalled("skill", name)} title="Remover" aria-label={`Remover ${name}`} type="button">
														<Icon d={ICONS.x} size={11} />
													</button>
												</div>
											))}
											<button className="popover-item accent" onClick={installExtension} type="button">
												<Icon d={ICONS.plus} size={13} />
												<span className="grow">Instalar .mcpb ou .skill</span>
											</button>
										</div>
									) : null}
								</div>
							) : null}
							{mentionOpen && mentionHits.length > 0 ? (
								<div className="slash-menu">
									{mentionHits.map((hit) => (
										<button
											key={hit.path}
											className="slash-item"
											type="button"
											onClick={() => {
												setInput((prev) => {
													const at = prev.lastIndexOf("@");
													return `${prev.slice(0, at)}@${hit.rel} `;
												});
												setMentionOpen(false);
											}}
										>
											<span className="mono">@{hit.rel}</span>
										</button>
									))}
								</div>
							) : null}
							{slashOpen ? (
								<div className="slash-menu">
									{SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(input.slice(1).split(/\s/)[0] ?? "")).map((cmd) => (
										<button
											key={cmd.name}
											className="slash-item"
											type="button"
											onClick={() => {
												setInput(`/${cmd.name} `);
												setSlashOpen(false);
											}}
										>
											<span className="mono">/{cmd.name}</span>
											<span className="slash-desc">{cmd.description}</span>
										</button>
									))}
								</div>
							) : null}
							{attachments.length > 0 ? (
								<div className="attach-row">
									{attachments.map((file, index) => (
										<span key={`${file.name}-${index}`} className="attach-chip">
											<img src={file.dataUrl} alt={file.name} />
											<span className="attach-name">{file.name}</span>
											<button
												className="btn btn--ghost btn--icon btn--sm"
												onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
												title="Remover anexo"
												aria-label={`Remover anexo ${file.name}`}
												type="button"
											>
												<Icon d={ICONS.x} size={10} />
											</button>
										</span>
									))}
								</div>
							) : null}
							{queued.length > 0 ? (
								<div className="queued-row">
									{queued.map((message, index) => (
										<span key={`${message}-${index}`} className="queued-chip">
											<span className="mono">fila</span>
											{message.slice(0, 60)}
											<button
												className="btn btn--ghost btn--icon btn--sm"
												onClick={() => sessionStore.setState((prev) => ({ ...prev, queued: prev.queued.filter((_, i) => i !== index) }))}
												title="Remover da fila"
												aria-label="Remover mensagem da fila"
												type="button"
											>
												<Icon d={ICONS.x} size={10} />
											</button>
										</span>
									))}
								</div>
							) : null}
							<textarea
								value={input}
								style={{ height: composerHeight }}
								onChange={(e) => {
									const value = e.target.value;
									setInput(value);
									setSlashOpen(value.startsWith("/") && !value.includes(" "));
									const at = value.lastIndexOf("@");
									const mention = at >= 0 && !/\s/.test(value.slice(at));
									setMentionOpen(mention);
									if (mention) void searchMentions(value.slice(at + 1));
								}}
								onPaste={(e) => {
									const file = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
									if (file) {
										e.preventDefault();
										attachImage(file);
									}
								}}
								onDragOver={(e) => e.preventDefault()}
								onDrop={(e) => {
									e.preventDefault();
									for (const file of e.dataTransfer.files) {
										if (file.type.startsWith("image/")) attachImage(file);
										else void file.text().then((text) => setInput((prev) => `${prev}${prev ? "\n" : ""}${text}`));
									}
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										if (state?.isStreaming && e.altKey) void steer();
										else if (state?.isStreaming) queueFollowUp();
										else void sendPrompt();
										return;
									}
									if (e.key === "ArrowUp" && !input.trim()) {
										e.preventDefault();
										navigateHistory(-1);
									}
									if (e.key === "ArrowDown" && historyIndex >= 0) {
										e.preventDefault();
										navigateHistory(1);
									}
									if (e.key === "Escape") {
										setSlashOpen(false);
										setMentionOpen(false);
										setSavedOpen(false);
									}
								}}
								placeholder="Como posso ajudar hoje?  (/ para comandos)"
								aria-label="Mensagem para o agente"
								rows={1}
							/>
							<div
								className="composer-resize"
								onPointerDown={(e) => {
									const startY = e.clientY;
									const startH = composerHeight;
									let finalH = startH;
									const move = (ev: PointerEvent): void => {
										finalH = Math.max(48, Math.min(400, startH - (ev.clientY - startY)));
										setComposerHeight(finalH);
									};
									const up = (): void => {
										window.removeEventListener("pointermove", move);
										window.removeEventListener("pointerup", up);
										void run({ type: "setPrefs", patch: { composerHeight: finalH } });
									};
									window.addEventListener("pointermove", move);
									window.addEventListener("pointerup", up);
								}}
								title="Arraste para redimensionar"
							/>
							<div className="composer-bar">
								<button className="pill model-pill" onClick={() => { panelStore.setState((prev) => ({ ...prev, popoverOpen: !prev.popoverOpen })); if (!models.length) void loadModels(); }} type="button" title="Modelo e raciocínio">
									<Icon d={ICONS.spark} size={12} />
									{state?.model?.id ?? "modelo"}
									<Icon d={ICONS.chevronDown} size={11} />
								</button>
								<button
									className="pill saved-pill"
									onClick={() => setSavedOpen((o) => !o)}
									type="button"
									title="Prompts salvos"
								>
									<Icon d={ICONS.file} size={12} />
									prompts
								</button>
								{savedOpen ? (
									<div className="saved-menu">
										{savedPrompts.length === 0 ? <div className="saved-empty">Nenhum prompt salvo.</div> : null}
										{savedPrompts.map((prompt) => (
											<div key={prompt.id} className="saved-row">
												<button
													className="saved-use"
													onClick={() => {
														setInput(prompt.body);
														setSavedOpen(false);
													}}
													type="button"
												>
													{prompt.title}
												</button>
												<button
													className="btn btn--ghost btn--icon btn--sm"
													onClick={() => void deleteSavedPrompt(prompt.id)}
													title="Remover"
													aria-label={`Remover prompt ${prompt.title}`}
													type="button"
												>
													<Icon d={ICONS.x} size={10} />
												</button>
											</div>
										))}
										<button
											className="popover-item accent"
											onClick={() => {
												const body = input.trim();
												if (!body) return;
												void savePrompt(body.slice(0, 40), body);
												setSavedOpen(false);
											}}
											type="button"
										>
											<Icon d={ICONS.plus} size={12} />
											<span className="grow">Salvar o texto atual</span>
										</button>
									</div>
								) : null}
								<button
									className={`pill mic-pill${recording ? " is-live" : ""}`}
									onClick={() => void toggleRecording()}
									type="button"
									title={recording ? "Parar gravação" : "Ditar prompt"}
									aria-pressed={recording}
								>
									<Icon d={ICONS.mic} size={12} />
									{recording ? "gravando…" : "voz"}
								</button>
								<span className="composer-hint">
									{state?.isStreaming ? "Enter enfileira · Alt+Enter direciona" : "Enter envia · Shift+Enter quebra linha"}
								</span>
								<button
									className={`btn btn--icon btn--sm composer-send${input.trim() || attachments.length ? " ready" : ""}`}
									onClick={() => {
										if (state?.isStreaming) queueFollowUp();
										else void sendPrompt();
									}}
									type="button"
									disabled={!input.trim() && attachments.length === 0}
									title={state?.isStreaming ? "Enfileirar" : "Enviar"}
									aria-label={state?.isStreaming ? "Enfileirar mensagem" : "Enviar mensagem"}
								>
									<Icon d={ICONS.send} size={13} />
								</button>
							</div>
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}

declare global {
	interface Window {
		noishi: NoishiBridge;
	}
}
