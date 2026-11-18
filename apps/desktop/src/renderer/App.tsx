import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, DesktopEnv, ExtensionUiRequest, NoishiBridge, SessionCommandResult, SessionListItem, SessionState } from "@noishi/rpc-bridge";
import { TerminalView } from "./Terminal.js";
import { SandboxTerminal } from "./SandboxTerminal.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { GitPanel } from "./GitPanel.js";
import { ContextPanel } from "./ContextPanel.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { renderMarkdown } from "./markdown.js";

/** Nome de ferramenta em linguagem de gente, para a linha de etapa do turno. */
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

type ChatBlock =
	| { kind: "text"; id: number; role: "user" | "assistant"; content: string; streaming: boolean; entryId?: string }
	| { kind: "thinking"; id: number; content: string; streaming: boolean }
	| { kind: "tool"; id: number; toolName: string; args: string; output: string; streaming?: boolean }
	| { kind: "error"; id: number; message: string; info?: boolean };

type StatusWidget = { key: string; lines: string[] };
type SandboxTask = {
	id: string;
	command: string;
	cwd: string;
	status: "queued" | "running" | "done" | "failed";
	output: string;
	exitCode: number | null;
	startedAt: number;
	finishedAt?: number;
};

type SandboxArtifact = {
	id: string;
	name: string;
	taskId?: string;
	createdAt: number;
	size: number;
	preview: string;
	path: string;
};

type SandboxStatus = {
	ready: boolean;
	dir: string;
	workspace: string;
	qemu: boolean;
	virtiofsd: boolean;
	booted: boolean;
	vcpu: number;
	memoryMb: number;
	allowlist: string[];
	tasks: SandboxTask[];
	artifacts: SandboxArtifact[];
	egress: { at: number; host: string; allowed: boolean; method: string }[];
	limits: { maxCpu: number; maxMemoryMb: number; maxSeconds: number };
	schedules: { id: string; command: string; everySeconds: number; lastRun?: number }[];
	snapshots: { name: string; createdAt: number; files: number }[];
	instances: SandboxInstance[];
	activeInstance: string;
};

type SandboxInstance = { id: string; root: string; workspace: string; booted: boolean; tasks: number; vcpu: number; memoryMb: number };

type FileNode = { name: string; path: string; dir: boolean; size?: number; children?: FileNode[] };
type SessionSearchHit = { sessionPath: string; snippet: string; role: string | null; line: number };

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
	// Theme lives on <html data-theme>; the renderer only pushes it there.
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
	const [pendingDialog, setPendingDialog] = useState<ExtensionUiRequest[]>([]);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [rpcError, setRpcError] = useState<string | null>(null);
	const [needsInput, setNeedsInput] = useState(false);
	const [view, setView] = useState<"chat" | "terminal" | "sandbox" | "review" | "git" | "context" | "settings">("chat");
	const VIEW_LABELS: Record<typeof view, string> = {
		chat: "Nova conversa",
		terminal: "Terminal",
		sandbox: "Sandbox",
		review: "Revisão",
		git: "Git",
		context: "Contexto",
		settings: "Ajustes",
	};
	const [findOpen, setFindOpen] = useState(false);
	const [findText, setFindText] = useState("");
	const [findResult, setFindResult] = useState<{ matches: number; active: number }>({ matches: 0, active: 0 });
	// Composer: slash menu, prompt history, saved prompts, attachments, resize.
	const [slashOpen, setSlashOpen] = useState(false);
	const [historyIndex, setHistoryIndex] = useState(-1);
	const [promptHistory, setPromptHistory] = useState<string[]>([]);
	const [savedPrompts, setSavedPrompts] = useState<{ id: string; title: string; body: string }[]>([]);
	const [attachments, setAttachments] = useState<{ name: string; dataUrl: string }[]>([]);
	const [composerHeight, setComposerHeight] = useState(40);
	const [savedOpen, setSavedOpen] = useState(false);
	// Workspace navigation (features 8, 9, 12, 13, 14).
	const [roots, setRoots] = useState<string[]>([]);
	const [tree, setTree] = useState<FileNode[]>([]);
	const [treeOpen, setTreeOpen] = useState<Record<string, boolean>>({});
	const [mentionOpen, setMentionOpen] = useState(false);
	const [mentionHits, setMentionHits] = useState<{ path: string; rel: string }[]>([]);
	const [sessionQuery, setSessionQuery] = useState("");
	const [sessionHits, setSessionHits] = useState<SessionSearchHit[]>([]);
	const [folders, setFolders] = useState<{ folders: string[]; tags: string[]; entries: Record<string, { folder: string | null; tags: string[] }> }>({ folders: [], tags: [], entries: {} });
	const [queued, setQueued] = useState<string[]>([]);
	const [prefs, setPrefs] = useState<Record<string, unknown> | null>(null);
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
		setExtensions({ skills: readList("skills"), mcpServers: readList("mcpServers"), enabledServers: readList("enabledServers") });
	}, [run]);

	const toggleServer = useCallback(
		async (name: string, enabled: boolean): Promise<void> => {
			const result = await run({ type: "setServerEnabled", name, enabled });
			if (result.ok) await loadExtensions();
			else setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `mcp: ${result.error}` }]);
		},
		[loadExtensions, run],
	);

	const removeInstalled = useCallback(
		async (kind: "skill" | "mcp", name: string): Promise<void> => {
			const result = await run({ type: "removePackage", kind, name });
			if (result.ok) await loadExtensions();
			else setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `remover: ${result.error}` }]);
		},
		[loadExtensions, run],
	);

	const refreshSandbox = useCallback(async (): Promise<void> => {
		const result = await run({ type: "sandboxStatus" });
		if (!result.ok || typeof result.data !== "object" || result.data === null) return;
		setSandbox(result.data as SandboxStatus);
	}, [run]);

	/* ---------- voz -> prompt (24) ---------- */
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
							setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `voz: ${result.error}` }]);
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
			setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `microfone: ${error instanceof Error ? error.message : String(error)}` }]);
		}
	}, [recording, run]);

	/* ---------- sandbox extras: instâncias, provisionamento, diff, snapshots ---------- */
	const sandboxSetActive = useCallback(
		async (id: string): Promise<void> => {
			await run({ type: "sandboxSetLimits", maxCpu: sandbox.limits.maxCpu, maxMemoryMb: sandbox.limits.maxMemoryMb, maxSeconds: sandbox.limits.maxSeconds });
			await run({ type: "sandboxInstances" });
			setSandbox((prev) => {
				const instances = prev.instances.map((instance) => ({ ...instance, booted: instance.id === id ? prev.booted : instance.booted }));
				return { ...prev, activeInstance: id, instances };
			});
			void refreshSandbox();
		},
		[refreshSandbox, run, sandbox.limits],
	);

	const sandboxCreateInstance = useCallback(async (): Promise<void> => {
		const name = window.prompt("Nome da nova instância");
		if (!name) return;
		const result = await run({ type: "sandboxCreateInstance", name });
		if (!result.ok) {
			setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `instância: ${result.error}` }]);
			return;
		}
		await sandboxSetActive(name.trim().replace(/[^\w.-]/g, "_").slice(0, 40));
	}, [run, sandboxSetActive]);

	const sandboxDestroyInstance = useCallback(
		async (id: string): Promise<void> => {
			const result = await run({ type: "sandboxDestroyInstance", id });
			if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `remover VM: ${result.error}` }]);
			void refreshSandbox();
		},
		[refreshSandbox, run],
	);

	const sandboxProvision = useCallback(async (): Promise<void> => {
		const list = window.prompt("Pacotes apk (ex: nodejs npm python3 py3-pip go rust cargo)", "nodejs npm python3 py3-pip");
		if (!list) return;
		setSandboxBusy(true);
		const result = await run({ type: "sandboxProvision", toolchain: list.split(/[\s,]+/).filter(Boolean) });
		setSandboxBusy(false);
		setSandboxOutput(result.ok ? `toolchain: ${list}\n${(result.data as { output: string }).output}` : `erro: ${result.error}`);
		void refreshSandbox();
	}, [refreshSandbox, run]);

	const sandboxDiff = useCallback(async (): Promise<void> => {
		const result = await run({ type: "sandboxWorkspaceDiff" });
		if (!result.ok || !Array.isArray(result.data)) {
			setSandboxOutput(result.ok ? "—" : `erro: ${result.error}`);
			return;
		}
		const changes = result.data as { path: string; status: string }[];
		setSandboxOutput(changes.length ? changes.map((change) => `${change.status}\t${change.path}`).join("\n") : "workspace sem diferenças desde o baseline");
	}, [run]);

	const sandboxSnapshot = useCallback(async (): Promise<void> => {
		const name = window.prompt("Nome do snapshot", `snap-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`);
		if (!name) return;
		const result = await run({ type: "sandboxSnapshot", name });
		setSandboxOutput(result.ok ? `snapshot ${name}: ${JSON.stringify(result.data)}` : `erro: ${result.error}`);
		void refreshSandbox();
	}, [refreshSandbox, run]);

	const sandboxRestore = useCallback(
		async (name: string): Promise<void> => {
			const result = await run({ type: "sandboxRestoreSnapshot", name });
			setSandboxOutput(result.ok ? `restaurado ${name}: ${JSON.stringify(result.data)}` : `erro: ${result.error}`);
			void refreshSandbox();
		},
		[refreshSandbox, run],
	);

	const sandboxSchedule = useCallback(async (): Promise<void> => {
		const command = sandboxCmd.trim();
		if (!command) return;
		const every = Number(window.prompt("Repetir a cada quantos segundos?", "3600"));
		if (!Number.isFinite(every) || every <= 0) return;
		const result = await run({ type: "sandboxSchedule", command, everySeconds: every });
		setSandboxOutput(result.ok ? `agendada a cada ${every}s: ${command}` : `erro: ${result.error}`);
		void refreshSandbox();
	}, [refreshSandbox, run, sandboxCmd]);

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
		setPendingDialog((prev) => [
			...prev,
			{ id: `local-install-${Date.now()}`, method: "input", title: "Instalar pacote", placeholder: "/caminho/pacote.mcpb" },
		]);
	}, []);

	const installExtensionAt = useCallback(
		async (path: string): Promise<void> => {
			const result = await run({ type: "installPackage", path });
			if (result.ok) {
				await loadExtensions();
				setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `Pacote instalado: ${path}`, info: true }]);
			} else {
				setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `instalar: ${result.error}` }]);
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
				// Drain the follow-up queue (feature 26): the turn is over, so the
				// next queued message becomes the new turn.
				setQueued((prev) => {
					const [next, ...rest] = prev;
					if (next) {
						setBlocks((blocks) => [...blocks, { kind: "text", id: nextId(), role: "user", content: next, streaming: false }]);
						void window.noishi.runSessionCommand({ type: "followUp", message: next });
					}
					return rest;
				});
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
		// Slash commands are handled locally, never sent to the agent.
		if (message.startsWith("/")) {
			setInput("");
			runSlashCommand(message);
			return;
		}
		setInput("");
		setHistoryIndex(-1);
		setBlocks((prev) => [...prev, { kind: "text", id: nextId(), role: "user", content: message, streaming: false }]);
		const result = await run({ type: "prompt", message });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: result.error }]);
		void run({ type: "rememberPrompt", text: message }).then((r) => {
			if (r.ok && Array.isArray(r.data)) setPromptHistory(r.data.filter((v): v is string => typeof v === "string"));
		});
		void refreshState();
	}, [input, refreshState, run]);

	/** Steer the running turn without aborting it (feature 25). */
	const steer = useCallback(async (): Promise<void> => {
		const message = input.trim();
		if (!message) return;
		setInput("");
		setBlocks((prev) => [...prev, { kind: "text", id: nextId(), role: "user", content: `↪ ${message}`, streaming: false }]);
		const result = await run({ type: "steer", message });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: result.error }]);
	}, [input, run]);

	/** Queue a follow-up for after the current turn (feature 26). */
	const queueFollowUp = useCallback((): void => {
		const message = input.trim();
		if (!message) return;
		setInput("");
		setQueued((prev) => [...prev, message]);
	}, [input]);

	/** Slash commands (feature 20). */
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
						setUsage({ tokens: 0, cost: 0 });
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
						setPopoverOpen(true);
					}
					break;
				case "thinking":
					if (arg) void run({ type: "setThinkingLevel", level: arg });
					break;
				case "help":
					setBlocks((prev) => [
						...prev,
						{
							kind: "error",
							id: nextId(),
							info: true,
							message: "/compact [instruções] · /clear · /new · /export · /model [provider/id] · /thinking [nível] · /help",
						},
					]);
					break;
				default:
					setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `comando desconhecido: /${name}` }]);
			}
		},
		[refreshState, run],
	);

	/** Prompt history navigation (feature 21). */
	const navigateHistory = useCallback(
		(direction: -1 | 1): void => {
			if (promptHistory.length === 0) return;
			const next = Math.max(-1, Math.min(promptHistory.length - 1, historyIndex + direction));
			setHistoryIndex(next);
			setInput(next === -1 ? "" : (promptHistory[next] ?? ""));
		},
		[historyIndex, promptHistory],
	);

	/** Attach an image as a data URL (feature 23). */
	const attachImage = useCallback((file: File): void => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = typeof reader.result === "string" ? reader.result : "";
			if (dataUrl) setAttachments((prev) => [...prev, { name: file.name, dataUrl }]);
		};
		reader.readAsDataURL(file);
	}, []);

	/* ---------- workspace (8, 9, 11, 12, 13, 14) ---------- */
	const loadTree = useCallback(async (root: string): Promise<void> => {
		const result = await run({ type: "readTree", root, maxDepth: 3 });
		if (result.ok && Array.isArray(result.data)) setTree(result.data as FileNode[]);
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
			if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: result.error }]);
		},
		[run],
	);

	const searchAllSessions = useCallback(
		async (query: string): Promise<void> => {
			setSessionQuery(query);
			if (query.trim().length < 2) {
				setSessionHits([]);
				return;
			}
			const result = await run({ type: "searchSessions", query });
			if (result.ok && Array.isArray(result.data)) setSessionHits((result.data as SessionSearchHit[]).slice(0, 30));
		},
		[run],
	);

	const loadFolders = useCallback(async (): Promise<void> => {
		const result = await run({ type: "listFolders" });
		if (result.ok && typeof result.data === "object" && result.data !== null) {
			setFolders(result.data as { folders: string[]; tags: string[]; entries: Record<string, { folder: string | null; tags: string[] }> });
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
		setRoots((prev) => (prev.includes(cwd) ? prev : [...prev, cwd].slice(-3)));
		void refreshState();
		void loadSessions();
		void loadTree(cwd);
	}, [loadSessions, loadTree, refreshState, run]);

	const resumeSession = useCallback(async (sessionPath: string): Promise<void> => {
		setBlocks([]);
		const result = await run({ type: "switchSession", sessionPath });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: result.error }]);
		// Incremental history (feature 32): the session file is the source, so a
		// resumed conversation shows what was said instead of an empty pane.
		const transcript = await run({ type: "sessionTranscript", sessionPath });
		if (transcript.ok && Array.isArray(transcript.data)) {
			const rebuilt: ChatBlock[] = [];
			for (const block of transcript.data as { kind: string; role?: "user" | "assistant"; content?: string; toolName?: string; args?: string; entryId?: string }[]) {
				if (block.kind === "text" && block.content) {
					rebuilt.push({
						kind: "text",
						id: nextId(),
						role: block.role ?? "assistant",
						content: block.content,
						streaming: false,
						entryId: block.entryId,
					});
				} else if (block.kind === "tool" && block.toolName) {
					rebuilt.push({ kind: "tool", id: nextId(), toolName: block.toolName, args: block.args ?? "", output: "", streaming: false });
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
			document.documentElement.dataset.theme = t;
		});
		void window.noishi.getEnv().then(setEnv);
		void refreshState();
		void loadSessions();
		void loadModels();
		void loadExtensions();
		void refreshSandbox();
		void run({ type: "getPrefs" }).then((result) => {
			if (!result.ok || typeof result.data !== "object" || result.data === null) return;
			const data = result.data as Record<string, unknown>;
			setPrefs(data);
			if (Array.isArray(data.promptHistory)) setPromptHistory(data.promptHistory.filter((v): v is string => typeof v === "string"));
			if (Array.isArray(data.savedPrompts)) setSavedPrompts(data.savedPrompts as { id: string; title: string; body: string }[]);
			if (typeof data.composerHeight === "number") setComposerHeight(data.composerHeight);
		});
		void loadFolders();
		const offSandbox = window.noishi.onSandboxEvent(() => {
			void refreshSandbox();
		});
		const offEvent = window.noishi.onSessionEvent(handleEvent);
		const offUi = window.noishi.onExtensionUiRequest(handleExtensionUi);
		const offRoute = window.noishi.onDeepLinkRoute((route) => {
			if (route.kind === "chat/new" || route.kind === "code/new") setBlocks([]);
			if (route.kind === "code/needs-input") setNeedsInput(true);
			if (route.kind === "chat/share") {
				setView("chat");
				setInput((prev) => (prev.trim() ? `${prev}\n\n${route.prompt}` : route.prompt));
			}
		});
		const offTheme = window.noishi.onThemeChange((t) => {
			document.documentElement.dataset.theme = t;
		});
		// Custom theme tokens (feature 46): paint them onto :root and clear the
		// previous set, so switching themes never leaves stale overrides.
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
	// Artifact windows fetch the real artifact body instead of rendering blocks.
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

	// Find bar: Ctrl+F opens it (main process), results stream back here.
	useEffect(() => {
		const offOpen = window.noishi.find.onOpen(() => setFindOpen(true));
		const offResult = window.noishi.find.onResult((result) => {
			setFindResult({ matches: result.matches, active: result.active });
		});
		return () => {
			offOpen();
			offResult();
		};
	}, []);

	// Ctrl+F / Cmd+F also works when the native menu is unavailable (dev, other
	// window kinds); the main process handles the actual search.
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
				e.preventDefault();
				setFindOpen(true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	/* ---------- derivados ---------- */
	/*
	 * Etapa corrente do turno. O Claude mostra o que está acontecendo ("lendo
	 * arquivo"), não um "streaming" genérico — é o que faz o app parecer que
	 * está trabalhando em vez de travado.
	 */
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
		if (!state) return { dot: "", text: "conectando…" };
		if (rpcError) return { dot: "dot--danger", text: "erro: o processo RPC encerrou" };
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
		const window = state?.model?.contextWindow ?? 0;
		if (!window || !usage.tokens) return null;
		const ratio = usage.tokens / window;
		const filled = Math.min(10, Math.round(ratio * 10));
		const cls = ratio >= 0.9 ? "high" : ratio >= 0.7 ? "mid" : "on";
		return { filled, cls };
	}, [state, usage]);

	const activeSession = state?.sessionFile;

	// Budget guard (feature 29): warn once per threshold crossing, and stop the
	// turn when the hard limit is passed. Thresholds live in prefs.
	const budgetState = useRef<{ warned: boolean; stopped: boolean }>({ warned: false, stopped: false });
	useEffect(() => {
		const budget = (prefs as { budget?: { warnUsd: number | null; stopUsd: number | null } } | null)?.budget;
		if (!budget || usage.cost <= 0) return;
		const warnAt = budget.warnUsd;
		const stopAt = budget.stopUsd;
		if (warnAt !== null && usage.cost >= warnAt && !budgetState.current.warned) {
			budgetState.current.warned = true;
			setBlocks((prev) => [
				...prev,
				{ kind: "error", id: nextId(), info: true, message: `orçamento: $${usage.cost.toFixed(4)} passou do aviso de $${warnAt.toFixed(2)}` },
			]);
		}
		if (stopAt !== null && usage.cost >= stopAt && !budgetState.current.stopped) {
			budgetState.current.stopped = true;
			void run({ type: "abort" });
			setBlocks((prev) => [
				...prev,
				{ kind: "error", id: nextId(), message: `orçamento: $${usage.cost.toFixed(4)} atingiu o limite de $${stopAt.toFixed(2)} — turno interrompido` },
			]);
		}
	}, [prefs, run, usage.cost]);

	// Tray badge (feature 44): sessions waiting for an answer.
	useEffect(() => {
		void run({ type: "trayBadge", count: needsInput ? 1 : 0 });
	}, [needsInput, run]);

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
					<button className="btn btn--ghost btn--icon btn--sm" onClick={() => void window.noishi.openMainWindow()} type="button" title="Abrir janela principal">
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
						onClick={() => setSidebarOpen((s) => !s)}
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
					<button className="btn" onClick={() => setPendingDialog((prev) => [...prev, { id: `local-open-${Date.now()}`, method: "input", title: "Abrir projeto", placeholder: "~/projetos/noishi-desktop" }])} type="button">
						<Icon d={ICONS.folder} size={13} />
						<span className="btn-label">Abrir projeto…</span>
					</button>
				</div>
				<div className="sidebar-section">
					<span>Arquivos</span>
					<span className="count">{roots.length}</span>
					<button
						className="icon-btn icon-btn--tiny"
						onClick={() =>
							setPendingDialog((prev) => [
								...prev,
								{ id: `local-root-${Date.now()}`, method: "input", title: "Adicionar pasta ao workspace", placeholder: "/caminho/do/projeto" },
							])
						}
						title="Adicionar raiz"
						aria-label="Adicionar pasta ao workspace"
						type="button"
					>
						<Icon d={ICONS.plus} size={11} />
					</button>
				</div>
				<div className="file-tree">
					{roots.length === 0 ? <div className="session-empty">Abra um projeto para ver os arquivos.</div> : null}
					{roots.map((root) => (
						<div key={root} className="tree-root">
							<button
								className="tree-row tree-root-row"
								onClick={() => {
									setTreeOpen((prev) => ({ ...prev, [root]: !prev[root] }));
									if (!treeOpen[root]) void loadTree(root);
								}}
								type="button"
								title={root}
							>
								<Icon d={treeOpen[root] ? ICONS.chevronDown : ICONS.chevronRight} size={10} />
								<Icon d={ICONS.folder} size={11} />
								<span className="tree-name">{root.split("/").pop() ?? root}</span>
							</button>
							{treeOpen[root] ? <TreeNodes nodes={tree} depth={0} onOpen={(path) => void openFile(path)} /> : null}
						</div>
					))}
				</div>
				<div className="sidebar-section">
					<span>Sessões</span>
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
								onContextMenu={(e) => {
									e.preventDefault();
									const current = folders.entries[session.sessionFile]?.folder ?? null;
									setPendingDialog((prev) => [
										...prev,
										{
											id: `local-folder-${session.sessionFile}`,
											method: "input",
											title: `Pasta de "${session.name ?? session.sessionId.slice(0, 8)}"`,
											placeholder: current ?? "ex.: clientes/acme",
										},
									]);
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
					<span className={`dot ${state ? "dot--ok" : ""}`} />
					CLI {env?.cliVersion ?? "?"} · v{env?.appVersion ?? "0.1.0"}
				</div>
			</aside>

			<div className="main">
				<header className="topbar">
					<span className="crumb">{state?.sessionName ?? (mode === "buddy" ? "Buddy" : VIEW_LABELS[view])}</span>
					<span className="status" role="status" aria-live="polite">
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
					<div className="view-tabs" role="tablist" aria-label="Áreas do app">
						<button role="tab" aria-selected={view === "chat"} className={`view-tab${view === "chat" ? " is-on" : ""}`} onClick={() => setView("chat")} type="button">Chat</button>
						<button role="tab" aria-selected={view === "terminal"} className={`view-tab${view === "terminal" ? " is-on" : ""}`} onClick={() => setView("terminal")} type="button">Terminal</button>
						<button role="tab" aria-selected={view === "sandbox"} className={`view-tab${view === "sandbox" ? " is-on" : ""}`} onClick={() => { setView("sandbox"); void refreshSandbox(); }} type="button">Sandbox</button>
						<button role="tab" aria-selected={view === "review"} className={`view-tab${view === "review" ? " is-on" : ""}`} onClick={() => setView("review")} type="button">Revisão</button>
						<button role="tab" aria-selected={view === "git"} className={`view-tab${view === "git" ? " is-on" : ""}`} onClick={() => setView("git")} type="button">Git</button>
						<button role="tab" aria-selected={view === "context"} className={`view-tab${view === "context" ? " is-on" : ""}`} onClick={() => setView("context")} type="button">Contexto</button>
						<button role="tab" aria-selected={view === "settings"} className={`view-tab${view === "settings" ? " is-on" : ""}`} onClick={() => setView("settings")} type="button">Ajustes</button>
					</div>
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
					</div>
				{findOpen ? (
					<div className="findbar">
						<Icon d={ICONS.search} size={12} />
						<input
							className="field findbar-input"
							autoFocus
							value={findText}
							onChange={(e) => {
								setFindText(e.target.value);
								window.noishi.find.query(e.target.value, true);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									window.noishi.find.query(findText, !e.shiftKey);
								}
								if (e.key === "Escape") {
									window.noishi.find.clear();
									setFindOpen(false);
									setFindText("");
									setFindResult({ matches: 0, active: 0 });
								}
							}}
							placeholder="Localizar no chat"
							aria-label="Localizar no chat"
						/>
						<span className="mono findbar-count">
							{findText ? `${findResult.active}/${findResult.matches}` : ""}
						</span>
						<button className="btn btn--ghost btn--icon btn--sm" onClick={() => window.noishi.find.query(findText, false)} disabled={!findText} title="Anterior" type="button">
							<Icon d={ICONS.chevronUp} size={12} />
						</button>
						<button className="btn btn--ghost btn--icon btn--sm" onClick={() => window.noishi.find.query(findText, true)} disabled={!findText} title="Próximo" type="button">
							<Icon d={ICONS.chevronDown} size={12} />
						</button>
						<button
							className="btn btn--ghost btn--icon btn--sm"
							onClick={() => {
								window.noishi.find.clear();
								setFindOpen(false);
								setFindText("");
								setFindResult({ matches: 0, active: 0 });
							}}
							title="Fechar"
							type="button"
						>
							<Icon d={ICONS.x} size={12} />
						</button>
					</div>
				) : null}
					{/*
					 * A janela não tem moldura do SO, então os controles são nossos. Ficam no
					 * fim da faixa arrastável, com no-drag; o de fechar só ganha vermelho no
					 * hover, como em qualquer app nativo.
					 */}
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

				{statusWidgets.length > 0 ? (
					<div className="widgets">
						{statusWidgets.map((widget) => (
							<pre key={widget.key} className="widget">{widget.lines.join("\n")}</pre>
						))}
					</div>
				) : null}

				{view === "sandbox" ? (
					<div className="sandbox">
						<div className="sandbox-head">
							<span className={`dot ${sandbox.booted ? "dot--ok" : sandbox.ready && sandbox.qemu && sandbox.virtiofsd ? "" : "dot--warn"}`} />
							<b>
								{sandbox.booted
									? `VM ativa · alpine-virt · ${sandbox.vcpu} vCPU · ${Math.round(sandbox.memoryMb / 1024)} GB · ${sandbox.allowlist.length} domínios`
									: !sandbox.qemu
										? "qemu ausente — sudo pacman -S qemu-desktop"
										: !sandbox.virtiofsd
											? "virtiofsd ausente — sudo pacman -S virtiofsd"
											: sandbox.ready
												? "pronta para boot"
												: "assets ausentes"}
							</b>
							{sandbox.dir && !sandbox.ready && sandbox.qemu ? <span className="mono">coloque alpine-virt.iso + iso-extract/boot/ em {sandbox.dir}</span> : null}
							<select
								className="field sandbox-instance"
								value={sandbox.activeInstance}
								onChange={(e) => void sandboxSetActive(e.target.value)}
								aria-label="Instância do sandbox"
							>
								{sandbox.instances.length === 0 ? <option value="default">default</option> : null}
								{sandbox.instances.map((instance) => (
									<option key={instance.id} value={instance.id}>
										{instance.id}{instance.booted ? " · ativa" : ""} · {instance.tasks} tarefas
									</option>
								))}
							</select>
							<button className="btn btn--ghost btn--sm" onClick={() => void sandboxCreateInstance()} type="button">+ VM</button>
							{sandbox.activeInstance !== "default" ? (
								<button className="btn btn--ghost btn--sm" onClick={() => void sandboxDestroyInstance(sandbox.activeInstance)} type="button">Remover VM</button>
							) : null}
							{!sandbox.booted ? (
								<button className="btn btn--sm" onClick={() => void sandboxBoot()} disabled={sandboxBusy || !sandbox.ready || !sandbox.qemu || !sandbox.virtiofsd} type="button">
									{sandboxBusy ? "bootando…" : "Boot VM"}
								</button>
							) : (
								<button className="btn btn--sm" onClick={() => void run({ type: "sandboxShutdown" }).then(() => void refreshSandbox())} type="button">
									Desligar
								</button>
							)}
						</div>

						{sandbox.booted ? (
							<>
								<div className="sandbox-bar">
									<span className="mono">/workspace ← {sandbox.workspace}</span>
									<span className="mono">{sandbox.egress.length ? `${sandbox.egress.filter((e) => e.allowed).length}/${sandbox.egress.length} egress liberados` : "sem tráfego"}</span>
								</div>
								<div className="sandbox-body">
									<input
										className="field mono"
										value={sandboxCmd}
										onChange={(e) => setSandboxCmd(e.target.value)}
										onKeyDown={(e) => { if (e.key === "Enter") void sandboxTask(); }}
										placeholder="npm test"
										aria-label="Comando na VM"
									/>
									<button className="btn btn--sm" onClick={() => void sandboxTask()} disabled={sandboxBusy || !sandboxCmd.trim()} type="button">Tarefa</button>
									<button className="btn btn--ghost btn--sm" onClick={() => void sandboxExec()} disabled={sandboxBusy || !sandboxCmd.trim()} type="button">Exec</button>
									<button className="btn btn--ghost btn--sm" onClick={() => void sandboxSchedule()} disabled={sandboxBusy || !sandboxCmd.trim()} type="button">Agendar</button>
								</div>
								<div className="sandbox-tools">
									<button className="btn btn--ghost btn--sm" onClick={() => void sandboxProvision()} disabled={sandboxBusy} type="button">Instalar toolchain…</button>
									<button className="btn btn--ghost btn--sm" onClick={() => void sandboxDiff()} type="button">Diff do workspace</button>
									<button className="btn btn--ghost btn--sm" onClick={() => void sandboxSnapshot()} type="button">Snapshot</button>
									<span className="spacer" />
									<label className="sandbox-limit">
										vCPU
										<input
											className="field"
											type="number"
											min={1}
											max={16}
											value={sandbox.limits.maxCpu}
											onChange={(e) => void sandboxSaveLimits({ maxCpu: Number(e.target.value) })}
											aria-label="vCPU do sandbox"
										/>
									</label>
									<label className="sandbox-limit">
										RAM MB
										<input
											className="field"
											type="number"
											min={512}
											max={8192}
											step={256}
											value={sandbox.limits.maxMemoryMb}
											onChange={(e) => void sandboxSaveLimits({ maxMemoryMb: Number(e.target.value) })}
											aria-label="Memória do sandbox"
										/>
									</label>
									<label className="sandbox-limit">
										timeout s
										<input
											className="field"
											type="number"
											min={10}
											max={3600}
											value={sandbox.limits.maxSeconds}
											onChange={(e) => void sandboxSaveLimits({ maxSeconds: Number(e.target.value) })}
											aria-label="Timeout do sandbox"
										/>
									</label>
								</div>
								<pre className="sandbox-out">{sandboxOutput || "—"}</pre>

								<div className="sandbox-grid">
									<div className="sandbox-col">
										<div className="sandbox-col-title">Tarefas</div>
										{sandbox.tasks.length === 0 ? <div className="sandbox-empty">Nenhuma tarefa ainda.</div> : null}
										{sandbox.tasks.map((task) => (
											<div key={task.id} className="task">
												<div className="task-head">
													<span className={`dot ${task.status === "done" ? "dot--ok" : task.status === "failed" ? "dot--danger" : ""}`} />
													<span className="mono task-cmd">{task.command}</span>
													<span className="task-state">{task.status === "running" ? "executando…" : task.status}</span>
												</div>
												{task.output ? <pre className="task-out">{task.output.slice(-1500)}</pre> : null}
											</div>
										))}
									</div>
									<div className="sandbox-col">
										<div className="sandbox-col-title">Artefatos</div>
										{sandbox.artifacts.length === 0 ? <div className="sandbox-empty">Tarefas concluídas geram artefatos.</div> : null}
										{sandbox.artifacts.map((artifact) => (
											<button
												key={artifact.id}
												className="artifact-row"
												onClick={() => void sandboxReadArtifact(artifact.id)}
												type="button"
											>
												<Icon d={ICONS.file} size={12} />
												<span className="artifact-name">{artifact.name}</span>
												<span className="mono artifact-meta">{Math.round(artifact.size / 102.4) / 10} kB</span>
											</button>
										))}
									</div>
									<div className="sandbox-col">
										<div className="sandbox-col-title">Agendadas</div>
										{sandbox.schedules.length === 0 ? <div className="sandbox-empty">Nenhuma tarefa recorrente.</div> : null}
										{sandbox.schedules.map((entry) => (
											<div key={entry.id} className="task">
												<div className="task-head">
													<span className="mono task-cmd">{entry.command}</span>
													<span className="task-state">a cada {entry.everySeconds}s</span>
													<button className="btn btn--ghost btn--icon btn--sm" onClick={() => void sandboxUnschedule(entry.id)} title="Cancelar" type="button">
														<Icon d={ICONS.x} size={10} />
													</button>
												</div>
											</div>
										))}
										<div className="sandbox-col-title">Snapshots</div>
										{sandbox.snapshots.length === 0 ? <div className="sandbox-empty">Nenhum snapshot.</div> : null}
										{sandbox.snapshots.map((snapshot) => (
											<div key={snapshot.name} className="task">
												<div className="task-head">
													<span className="mono task-cmd">{snapshot.name}</span>
													<span className="task-state">{snapshot.files} arq.</span>
													<button className="btn btn--ghost btn--sm" onClick={() => void sandboxRestore(snapshot.name)} type="button">Restaurar</button>
												</div>
											</div>
										))}
									</div>
								</div>
								<div className="sandbox-tty">
									<div className="sandbox-col-title">Terminal da VM</div>
									<SandboxTerminal booted={sandbox.booted} />
								</div>
							</>
						) : null}

						{openArtifact ? (
							<div className="artifact-sheet">
								<div className="artifact-sheet-head">
									<span className="mono">{openArtifact.id}</span>
									<span className="spacer" />
									<button
										className="btn btn--ghost btn--sm"
										onClick={() => {
											setBlocks((prev) => [
												...prev,
												{ kind: "error", id: nextId(), message: `Artefato do sandbox: ${openArtifact.id}`, info: true },
											]);
											setView("chat");
										}}
										type="button"
									>
										<Icon d={ICONS.share} size={12} />
										Enviar ao chat
									</button>
									<button className="btn btn--ghost btn--sm" onClick={() => setOpenArtifact(null)} type="button">Fechar</button>
								</div>
								<pre className="artifact-sheet-body">{openArtifact.body}</pre>
							</div>
						) : null}
					</div>
				) : view === "review" ? (
					<div className="panel-pane">
						<ReviewPanel run={run} cwd={state?.cwd ?? ""} sessionId={state?.sessionId ?? ""} />
					</div>
				) : view === "git" ? (
					<div className="panel-pane">
						<GitPanel run={run} cwd={state?.cwd ?? ""} sessionId={state?.sessionId ?? ""} />
					</div>
				) : view === "context" ? (
					<div className="panel-pane">
						<ContextPanel
							run={run}
							sessionPath={state?.sessionFile ?? ""}
							contextWindow={state?.model?.contextWindow ?? 0}
							usedTokens={usage.tokens}
							onBudgetWarn={(message) => setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message, info: true }])}
						/>
					</div>
				) : view === "settings" ? (
					<div className="panel-pane">
						<SettingsPanel run={run} onPrefs={(next) => setPrefs(next as unknown as Record<string, unknown>)} />
					</div>
				) : view === "terminal" ? (
					<div className="terminal-pane">
						<TerminalView cwd={state?.cwd ?? "~"} />
					</div>
				) : (
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
							{needsInput ? (
								<div className="banner banner--accent">
									<Icon d={ICONS.alert} className="ic" />
									<div><b>Esta sessão está aguardando sua resposta.</b> Aberta pela rota <span className="mono">noishi://code/needs-input</span>.</div>
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
													<div className="voice md" dangerouslySetInnerHTML={{ __html: renderMarkdown(block.content) }} />
													{block.streaming ? <span className="cursor" /> : null}
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
				)}

				{pendingDialog[0] ? (
					(() => {
						const dialog = pendingDialog[0];
						if (!dialog) return null;
						const answer = (response: Parameters<typeof window.noishi.answerExtensionUi>[0]): void => {
							if (dialog.id.startsWith("local-open-") && "value" in response) {
								void newSessionIn(response.value);
							} else if (dialog.id.startsWith("local-folder-") && "value" in response) {
								void assignFolder(dialog.id.slice("local-folder-".length), response.value.trim() || null);
							} else if (dialog.id.startsWith("local-root-") && "value" in response) {
								const cwd = response.value;
								setRoots((prev) => (prev.includes(cwd) ? prev : [...prev, cwd].slice(-4)));
								void loadTree(cwd);
							} else if (dialog.id.startsWith("local-install-") && "value" in response) {
								void installExtensionAt(response.value);
							} else if (!dialog.id.startsWith("local-")) {
								window.noishi.answerExtensionUi(response);
							}
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
														type="button"
														aria-pressed={on}
													>
														<span className="settings-toggle-knob" />
													</button>
													<span className="settings-ext-name">{name}</span>
													<button className="btn btn--ghost btn--icon btn--sm" onClick={() => void removeInstalled("mcp", name)} title="Remover" type="button">
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
												<button className="btn btn--ghost btn--icon btn--sm" onClick={() => void removeInstalled("skill", name)} title="Remover" type="button">
													<Icon d={ICONS.x} size={11} />
												</button>
											</div>
										))}
										<button className="popover-item accent" onClick={() => void installExtension()} type="button">
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
											onClick={() => setQueued((prev) => prev.filter((_, i) => i !== index))}
											title="Remover da fila"
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
								// @-mention: the token after the last @ with no space.
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
								if (e.key === "Escape") setSlashOpen(false);
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
								const move = (ev: PointerEvent): void => setComposerHeight(Math.max(48, Math.min(400, startH - (ev.clientY - startY))));
								const up = (): void => {
									window.removeEventListener("pointermove", move);
									window.removeEventListener("pointerup", up);
								};
								window.addEventListener("pointermove", move);
								window.addEventListener("pointerup", up);
							}}
							title="Arraste para redimensionar"
						/>
						<div className="composer-bar">
							<button className="pill model-pill" onClick={() => { setPopoverOpen((o) => !o); if (!models.length) void loadModels(); }} type="button" title="Modelo e raciocínio">
								<Icon d={ICONS.spark} size={12} />
								{state?.model?.id ?? "modelo"}
								<Icon d={ICONS.chevronDown} size={11} />
							</button>
							<button
								className="pill"
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
								className={`btn btn--icon btn--sm composer-send${input.trim() ? " ready" : ""}`}
								onClick={() => {
									if (state?.isStreaming) queueFollowUp();
									else void sendPrompt();
								}}
								type="button"
								disabled={!input.trim()}
								title={state?.isStreaming ? "Enfileirar" : "Enviar"}
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
