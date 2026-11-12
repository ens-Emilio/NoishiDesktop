import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, DesktopEnv, ExtensionUiRequest, NoishiBridge, SessionCommandResult, SessionListItem, SessionState } from "@noishi/rpc-bridge";

type ChatBlock =
	| { kind: "text"; id: number; role: "user" | "assistant"; content: string; streaming: boolean }
	| { kind: "thinking"; id: number; content: string; streaming: boolean }
	| { kind: "tool"; id: number; toolName: string; summary: string; streaming?: boolean }
	| { kind: "error"; id: number; message: string };

type StatusWidget = { key: string; lines: string[] };

let blockSeq = 0;
const nextId = (): number => ++blockSeq;

export function App() {
	const [blocks, setBlocks] = useState<ChatBlock[]>([]);
	const [input, setInput] = useState("");
	const [env, setEnv] = useState<DesktopEnv | null>(null);
	const [state, setState] = useState<SessionState | null>(null);
	const [usage, setUsage] = useState<{ tokens: number; cost: number }>({ tokens: 0, cost: 0 });
	const [statusWidgets, setStatusWidgets] = useState<StatusWidget[]>([]);
	const [sessions, setSessions] = useState<SessionListItem[]>([]);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [models, setModels] = useState<{ provider: string; id: string; contextWindow?: number; reasoning?: boolean }[]>([]);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [cowork, setCowork] = useState<{ booted: boolean; assetsReady: boolean; dir?: string; busy: boolean; qemu: boolean }>({ booted: false, assetsReady: false, busy: false, qemu: true });
	const [coworkOutput, setCoworkOutput] = useState("");
	const [coworkCmd, setCoworkCmd] = useState("");
	const [coworkOpen, setCoworkOpen] = useState(false);
	const [extensions, setExtensions] = useState<{ skills: string[]; mcpServers: string[] }>({ skills: [], mcpServers: [] });
	const [pendingDialog, setPendingDialog] = useState<ExtensionUiRequest[]>([]);
	const scrollRef = useRef<HTMLDivElement>(null);

	const greeting = (): string => {
		const h = new Date().getHours();
		if (h < 6) return "Boa madrugada";
		if (h < 12) return "Bom dia";
		if (h < 18) return "Boa tarde";
		return "Boa noite";
	};

	const loadSessions = useCallback(async (): Promise<void> => {
		const result: SessionCommandResult = await window.noishi.runSessionCommand({ type: "listSessions" });
		if (result.ok) setSessions(result.data as SessionListItem[]);
	}, []);

	const refreshState = useCallback(async (): Promise<void> => {
		const result: SessionCommandResult = await window.noishi.runSessionCommand({ type: "getState" });
		if (result.ok) setState(result.data as SessionState);
	}, []);

	const refreshUsage = useCallback(async (): Promise<void> => {
		const result: SessionCommandResult = await window.noishi.runSessionCommand({ type: "getStats" });
		if (!result.ok) return;
		const stats = result.data as { tokens?: { total?: number }; cost?: number };
		const total = stats.tokens?.total ?? 0;
		const cost = typeof stats.cost === "number" ? stats.cost : 0;
		if (total > 0 || cost > 0) setUsage({ tokens: total, cost });
	}, []);

	const loadModels = useCallback(async (): Promise<void> => {
		const result: SessionCommandResult = await window.noishi.runSessionCommand({ type: "getModels" });
		if (!result.ok || typeof result.data !== "object" || result.data === null) return;
		const raw = "models" in result.data ? (result.data as { models: unknown }).models : result.data;
		if (!Array.isArray(raw)) return;
		const parsed = raw.filter(
			(m): m is { provider: string; id: string; contextWindow?: number; reasoning?: boolean } =>
				typeof m === "object" && m !== null && "provider" in m && "id" in m &&
				typeof (m as { provider: unknown }).provider === "string" && typeof (m as { id: unknown }).id === "string",
		);
		setModels(parsed);
	}, []);

	const loadExtensions = useCallback(async (): Promise<void> => {
		const result: SessionCommandResult = await window.noishi.runSessionCommand({ type: "listInstalled" });
		if (!result.ok || typeof result.data !== "object" || result.data === null) return;
		const data = result.data;
		const readList = (key: string): string[] => {
			if (!(key in data)) return [];
			const value = (data as Record<string, unknown>)[key];
			return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
		};
		setExtensions({ skills: readList("skills"), mcpServers: readList("mcpServers") });
	}, []);

	const installExtension = useCallback(async (): Promise<void> => {
		const path = window.prompt("Caminho do pacote (.mcpb ou .skill):", "");
		if (!path) return;
		const result: SessionCommandResult = await window.noishi.runSessionCommand({ type: "installPackage", path });
		if (result.ok) {
			await loadExtensions();
			setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `Pacote instalado: ${path}` }]);
		} else {
			setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `instalar: ${result.error}` }]);
		}
	}, [loadExtensions]);

	const refreshCowork = useCallback(async (): Promise<void> => {
		const result: SessionCommandResult = await window.noishi.runSessionCommand({ type: "coworkStatus" });
		if (!result.ok || typeof result.data !== "object" || result.data === null) return;
		const data = result.data;
		setCowork((c) => ({
			...c,
			assetsReady: "ready" in data ? Boolean(data.ready) : false,
			dir: "dir" in data && typeof data.dir === "string" ? data.dir : undefined,
			booted: "booted" in data ? Boolean(data.booted) : false,
			qemu: "qemu" in data ? Boolean(data.qemu) : true,
		}));
	}, []);

	const coworkBoot = useCallback(async (): Promise<void> => {
		setCowork((c) => ({ ...c, busy: true }));
		const result: SessionCommandResult = await window.noishi.runSessionCommand({ type: "coworkBoot" });
		setCowork((c) => ({ ...c, busy: false, booted: result.ok }));
		setCoworkOutput(result.ok ? "VM pronta.\n" : `erro: ${result.error}\n`);
	}, []);

	const coworkExec = useCallback(async (): Promise<void> => {
		const command = coworkCmd.trim();
		if (!command) return;
		setCowork((c) => ({ ...c, busy: true }));
		const result: SessionCommandResult = await window.noishi.runSessionCommand({ type: "coworkExec", command });
		setCowork((c) => ({ ...c, busy: false }));
		setCoworkOutput((prev) => `${prev}$ ${command}\n${result.ok ? (result.data as { output?: string })?.output ?? "" : `erro: ${result.error}`}\n`);
		setCoworkCmd("");
	}, [coworkCmd]);

	const changeModel = useCallback(async (provider: string, modelId: string): Promise<void> => {
		const result: SessionCommandResult = await window.noishi.runSessionCommand({ type: "setModel", provider, modelId });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `modelo: ${result.error}` }]);
		void refreshState();
	}, [refreshState]);

	const changeThinking = useCallback(async (level: string): Promise<void> => {
		const result: SessionCommandResult = await window.noishi.runSessionCommand({ type: "setThinkingLevel", level });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `thinking: ${result.error}` }]);
		void refreshState();
	}, [refreshState]);

	const forkSession = useCallback(async (): Promise<void> => {
		const result: SessionCommandResult = await window.noishi.runSessionCommand({ type: "clone" });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `clone: ${result.error}` }]);
		void refreshState();
		void loadSessions();
	}, [refreshState, loadSessions]);

	useEffect(() => {
		window.noishi.getEnv().then(setEnv);
		void refreshState();
		void loadSessions();
		void loadModels();
		void loadExtensions();
		void refreshCowork();
		const offEvent = window.noishi.onSessionEvent(handleEvent);
		const offUi = window.noishi.onExtensionUiRequest(handleExtensionUi);
		// deep-link routes: chat/new resets the view (session commands already ran in main)
		const offRoute = window.noishi.onDeepLinkRoute((route) => {
			if (route.kind === "chat/new" || route.kind === "code/new") setBlocks([]);
		});
		return () => {
			offEvent();
			offUi();
			offRoute();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	function handleEvent(event: AgentEvent): void {
		switch (event.type) {
			case "message_update":
				applyStreamEvent(event.event, event.usage);
				break;
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

	function applyStreamEvent(event: Record<string, unknown> & { type: string }, usage: unknown): void {
		const u = usage as { totalTokens?: number; cost?: { total?: number } } | undefined;
		if (u && typeof u.totalTokens === "number") {
			setUsage({ tokens: u.totalTokens, cost: u.cost?.total ?? 0 });
		}
		setBlocks((prev) => {
			const next = [...prev];
			const lastIndex = next.length - 1;
			const last = next[lastIndex];
			switch (event.type) {
				case "message_start": {
					next.push({ kind: "text", id: nextId(), role: "assistant", content: "", streaming: true });
					return next;
				}
				case "text_delta": {
					const target = last?.kind === "text" && last.streaming ? last : null;
					if (target) {
						next[lastIndex] = { ...target, content: target.content + String(event.delta ?? "") };
					} else {
						next.push({ kind: "text", id: nextId(), role: "assistant", content: String(event.delta ?? ""), streaming: true });
					}
					return next;
				}
				case "text_end": {
					if (last?.kind === "text" && last.streaming) next[lastIndex] = { ...last, streaming: false };
					return next;
				}
				case "thinking_delta": {
					const target = last?.kind === "thinking" && last.streaming ? last : null;
					if (target) {
						next[lastIndex] = { ...target, content: target.content + String(event.delta ?? "") };
					} else {
						next.push({ kind: "thinking", id: nextId(), content: String(event.delta ?? ""), streaming: true });
					}
					return next;
				}
				case "thinking_end": {
					if (last?.kind === "thinking" && last.streaming) next[lastIndex] = { ...last, streaming: false };
					return next;
				}
			case "toolcall_start": {
				next.push({ kind: "tool", id: nextId(), toolName: String(event.toolName ?? "tool"), summary: "", streaming: true });
				return next;
			}
			case "toolcall_delta": {
				if (last?.kind === "tool" && last.streaming) {
					next[lastIndex] = { ...last, summary: last.summary + String(event.delta ?? "") };
				}
				return next;
			}
			case "toolcall_end": {
				if (last?.kind === "tool" && last.streaming) next[lastIndex] = { ...last, streaming: false };
				return next;
			}
				case "message_end": {
					for (let i = next.length - 1; i >= 0; i--) {
						const block = next[i];
						if (!block) continue;
						if (block.kind === "text" || block.kind === "thinking") {
							next[i] = block.streaming ? { ...block, streaming: false } : block;
							break;
						}
					}
					return next;
				}
				default:
					return next;
			}
		});
	}

	function appendToolOutput(delta: string): void {
		setBlocks((prev) => {
			const next = [...prev];
			const last = next[next.length - 1];
			if (last?.kind === "tool") {
				next[next.length - 1] = { ...last, summary: last.summary + delta };
			}
			return next;
		});
	}

	function markStreamingDone(): void {
		setBlocks((prev) =>
			prev.map((block) => {
			if (block.kind === "text" || block.kind === "thinking") {
				return block.streaming ? { ...block, streaming: false } : block;
			}
			return block;
		}),
		);
	}

	function handleExtensionUi(request: ExtensionUiRequest): void {
		switch (request.method) {
			case "notify": {
				setBlocks((prev) => [
					...prev,
					{ kind: "error", id: nextId(), message: `${request.notifyType === "error" ? "⚠" : "ℹ"} ${request.message ?? ""}` },
				]);
				window.noishi.answerExtensionUi({ id: request.id, cancelled: true });
				break;
			}
			case "confirm":
			case "input":
			case "select": {
				// In-chat dialog instead of window.confirm/prompt: queue the
				// request; the dialog component answers it.
				setPendingDialog((prev) => [...prev, request]);
				break;
			}
			case "setStatus": {
				setStatusWidgets((prev) => {
					const rest = prev.filter((w) => w.key !== request.statusKey);
					return request.statusText ? [...rest, { key: request.statusKey ?? "", lines: [request.statusText] }] : rest;
				});
				break;
			}
			case "setWidget": {
				setStatusWidgets((prev) => {
					const rest = prev.filter((w) => w.key !== request.widgetKey);
					return request.widgetLines ? [...rest, { key: request.widgetKey ?? "", lines: request.widgetLines ?? [] }] : rest;
				});
				break;
			}
			default:
				window.noishi.answerExtensionUi({ id: request.id, cancelled: true });
		}
	}


	const sendPrompt = useCallback(async (): Promise<void> => {
		const message = input.trim();
		if (!message) return;
		setInput("");
		setBlocks((prev) => [...prev, { kind: "text", id: nextId(), role: "user", content: message, streaming: false }]);
		const result = await window.noishi.runSessionCommand({ type: "prompt", message });
		if (!result.ok) {
			setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: result.ok ? "" : result.error }]);
			return;
		}
		void refreshState();
	}, [input, refreshState]);

	const newSession = useCallback(async (): Promise<void> => {
		await window.noishi.runSessionCommand({ type: "newSession" });
		setBlocks([]);
		setUsage({ tokens: 0, cost: 0 });
		void refreshState();
	}, [refreshState]);

	const abort = useCallback((): void => {
		void window.noishi.runSessionCommand({ type: "abort" });
	}, []);

	const newSessionIn = useCallback(async (cwd: string): Promise<void> => {
		await window.noishi.runSessionCommand({ type: "startIn", cwd });
		setBlocks([]);
		setUsage({ tokens: 0, cost: 0 });
		void refreshState();
	}, [refreshState]);

	const resumeSession = useCallback(async (sessionPath: string): Promise<void> => {
		setBlocks([]);
		const result = await window.noishi.runSessionCommand({ type: "switchSession", sessionPath });
		if (!result.ok) {
			setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: result.ok ? "" : result.error }]);
		}
		await window.noishi.runSessionCommand({ type: "getEntries" });
		void refreshState();
	}, [refreshState]);

	const compactSession = useCallback(async (): Promise<void> => {
		const result = await window.noishi.runSessionCommand({ type: "compact" });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: result.ok ? "" : result.error }]);
		void refreshState();
	}, [refreshState]);

	const exportSession = useCallback(async (): Promise<void> => {
		const result = await window.noishi.runSessionCommand({ type: "exportHtml" });
		if (result.ok) {
			const path = (result.data as { path?: string })?.path ?? "exportado";
			setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: `HTML exportado: ${path}` }]);
		}
	}, []);

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [blocks]);
	const statusLine = useMemo(() => {
		if (!state) return "conectando…";
		const model = state.model?.name ?? state.model?.id ?? "—";
		const busy = state.isStreaming ? "● streaming" : state.isCompacting ? "◌ compactando" : "○ pronto";
		return `${busy} · ${model} · ${state.thinkingLevel ?? "off"} · ${usage.tokens} tok · $${usage.cost.toFixed(4)}`;
	}, [state, usage]);

	return (
		<div className="app">
			{/* ---------- SIDEBAR ---------- */}
			<aside className={`sidebar${sidebarOpen ? "" : " collapsed"}`}>
				<div className="sidebar-top">
					<div className="brand">
						<span className="brand-mark">N</span>
						<span className="brand-name">Noishi</span>
					</div>
					<button className="icon-btn" onClick={() => setSidebarOpen((s) => !s)} type="button" title="Alternar sidebar">
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
							<rect x="1.5" y="2.5" width="13" height="11" rx="2" />
							<line x1="6" y1="2.5" x2="6" y2="13.5" />
						</svg>
					</button>
				</div>
				<button className="new-chat" onClick={newSession} type="button">
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
						<line x1="7" y1="2" x2="7" y2="12" /><line x1="2" y1="7" x2="12" y2="7" />
					</svg>
					Nova conversa
				</button>
				<button className="new-project" onClick={() => {
					const cwd = window.prompt("Diretório do projeto:", "/home/zens");
					if (cwd) void newSessionIn(cwd);
				}} type="button">
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
						<path d="M2 3.5h4l1.2 1.5H12v5.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5z" />
					</svg>
					Abrir projeto…
				</button>
				<div className="sidebar-section">Sessões</div>
				<div className="session-list">
					{sessions.map((session) => (
						<button
							key={session.sessionId}
							className={`session-item${state?.sessionFile === session.sessionFile ? " active" : ""}`}
							onClick={() => void resumeSession(session.sessionFile)}
							type="button"
							title={session.sessionFile}
						>
							<span className="session-title">{session.name ?? session.sessionId.slice(0, 8)}</span>
							<span className="session-sub">
								{new Date(session.modifiedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}
								{" · "}
								{session.messageCount ?? 0} msgs
							</span>
						</button>
					))}
					{sessions.length === 0 ? <div className="session-empty">Nenhuma sessão ainda</div> : null}
				</div>
				<div className="sidebar-footer">
					<span className="footer-meta">
						{env?.cliVersion ? `CLI ${env.cliVersion}` : "CLI ?"} · v{env?.appVersion ?? "0.1.0"}
					</span>
				</div>
			</aside>

			{/* ---------- MAIN ---------- */}
			<div className="main">
				<header className="topbar">
					<span className="crumb">{state?.sessionName ?? "Nova conversa"}</span>
					<span className="status">{statusLine}</span>
					<div className="actions">
						{state?.isStreaming ? (
							<button className="btn stop" onClick={abort} type="button">Parar</button>
						) : null}
						<button className="btn ghost" onClick={forkSession} type="button" disabled={!state?.sessionId}>Clonar</button>
						<button className="btn ghost" onClick={compactSession} type="button" disabled={!state?.sessionId}>Compactar</button>
						<button className="btn ghost" onClick={exportSession} type="button">Exportar</button>
						<button className={`btn ghost${coworkOpen ? " on" : ""}`} onClick={() => { setCoworkOpen((o) => !o); void refreshCowork(); }} type="button">Cowork</button>
					</div>
				</header>

				{coworkOpen ? (
					<div className="cowork">
					<div className="cowork-head">
						<span className={`vm-dot${cowork.booted ? " up" : cowork.assetsReady && cowork.qemu ? "" : " missing"}`} />
						<span className="cowork-label">
							{cowork.booted
								? "VM ativa"
								: !cowork.qemu
									? "qemu ausente — instale: sudo pacman -S qemu-desktop"
									: cowork.assetsReady
										? "pronta para boot"
										: "assets ausentes"}
							{cowork.dir && !cowork.assetsReady && cowork.qemu ? ` — coloque alpine-virt.iso + iso-extract/boot/ em ${cowork.dir}` : ""}
						</span>
						{!cowork.booted && cowork.qemu && cowork.assetsReady ? (
							<button className="btn" onClick={() => void coworkBoot()} disabled={cowork.busy} type="button">
								{cowork.busy ? "bootando…" : "Boot VM"}
							</button>
						) : null}
					</div>
						{cowork.booted ? (
							<>
								<div className="cowork-input-row">
									<input
										className="cowork-input"
										value={coworkCmd}
										onChange={(e) => setCoworkCmd(e.target.value)}
										onKeyDown={(e) => { if (e.key === "Enter") void coworkExec(); }}
										placeholder="comando na VM (rede deny-all)…"
									/>
									<button className="btn" onClick={() => void coworkExec()} disabled={cowork.busy || !coworkCmd.trim()} type="button">Exec</button>
								</div>
								<pre className="cowork-output">{coworkOutput || "—"}</pre>
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
							<p className="greeting-sub">Noishi está pronto. O que vamos construir?</p>
							{env ? <p className="greeting-meta">CLI {env.cliVersion ?? "?"} · {env.cliPath ?? "não encontrado"}</p> : null}
						</div>
					) : (
						blocks.map((block) => {
							switch (block.kind) {
								case "text":
									return block.role === "user" ? (
										<div key={block.id} className="row user">
											<div className="bubble user">{block.content}</div>
										</div>
									) : (
										<div key={block.id} className="row assistant">
											<div className={`bubble assistant${block.streaming ? " streaming" : ""}`}>
												{block.content}
												{block.streaming ? <span className="cursor">▌</span> : null}
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
								case "tool":
									return (
										<div key={block.id} className="toolcall">
											<span className="toolname">{block.toolName}{block.streaming ? " · executando…" : ""}</span>
											{block.summary ? <pre>{block.summary}</pre> : null}
										</div>
									);
								case "error":
									return <div key={block.id} className="error">{block.message}</div>;
							}
						})
					)}
				</div>

				{(() => {
					const dialog = pendingDialog[0];
					if (!dialog) return null;
					const answer = (response: Parameters<typeof window.noishi.answerExtensionUi>[0]): void => {
						window.noishi.answerExtensionUi(response);
						setPendingDialog((prev) => prev.slice(1));
					};
					const options = "options" in dialog ? dialog.options : undefined;
					const placeholder = "placeholder" in dialog ? dialog.placeholder : undefined;
					return (
						<div className="approval">
							<div className="approval-title">{"title" in dialog ? dialog.title ?? "Aprovação" : "Aprovação"}</div>
							{"message" in dialog && dialog.message ? (
								<div className="approval-message">{dialog.message}</div>
							) : null}
							{options?.length ? (
								<div className="approval-options">
									{options.map((option) => (
										<button key={option} className="chip" type="button" onClick={() => answer({ id: dialog.id, value: option })}>
											{option}
										</button>
									))}
								</div>
							) : null}
							{dialog.method === "input" ? (
								<input
									className="approval-input"
									autoFocus
									placeholder={placeholder ?? ""}
									onKeyDown={(e) => {
										if (e.key !== "Enter") return;
										const value = (e.target as HTMLInputElement).value.trim();
										if (!value) return;
										answer({ id: dialog.id, value });
									}}
								/>
							) : null}
							<div className="approval-actions">
								{dialog.method === "confirm" ? (
									<>
										<button className="btn approve" type="button" onClick={() => answer({ id: dialog.id, confirmed: true })}>
											Aprovar
										</button>
										<button className="btn ghost" type="button" onClick={() => answer({ id: dialog.id, confirmed: false })}>
											Recusar
										</button>
									</>
								) : dialog.method === "select" ? (
									<button className="btn ghost" type="button" onClick={() => answer({ id: dialog.id, cancelled: true })}>
										Cancelar
									</button>
								) : null}
							</div>
						</div>
					);
				})()}

				<div className="composer-wrap">
					<div className="composer">
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
					{settingsOpen ? (
						<div className="settings composer-popover">
							<select
								className="settings-select"
								value={state?.model ? `${state.model.provider}/${state.model.id}` : ""}
								onChange={(e) => {
									const [provider, ...rest] = e.target.value.split("/");
									const modelId = rest.join("/");
									if (provider && modelId) void changeModel(provider, modelId);
								}}
							>
								{!state?.model ? <option value="">modelo atual</option> : null}
								{models.map((m) => (
									<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
										{m.id} ({m.provider})
									</option>
								))}
							</select>
							<div className="thinking-row">
								{["off", "minimal", "low", "medium", "high"].map((level) => (
									<button
										key={level}
										type="button"
										className={`chip${state?.thinkingLevel === level ? " on" : ""}`}
										onClick={() => void changeThinking(level)}
									>
										{level}
									</button>
								))}
							</div>
							<div className="extensions-list">
								{extensions.skills.map((skill) => (
									<div key={`s-${skill}`} className="extension-item">
										<span className="extension-name">{skill}</span>
										<span>skill</span>
									</div>
								))}
								{extensions.mcpServers.map((server) => (
									<div key={`m-${server}`} className="extension-item">
										<span className="extension-name">{server}</span>
										<span>mcp</span>
									</div>
								))}
								{extensions.skills.length === 0 && extensions.mcpServers.length === 0 ? (
									<div className="extension-item">nenhum pacote instalado</div>
								) : null}
							</div>
							<button className="chip" type="button" onClick={() => void installExtension()}>
								+ instalar .mcpb/.skill
							</button>
						</div>
					) : null}
					<div className="composer-bar">
						<button className="model-btn" onClick={() => { setSettingsOpen((s) => !s); if (!models.length) void loadModels(); }} type="button" title="Modelo e thinking">
							{state?.model?.name ?? state?.model?.id ?? "—"}
							<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
						</button>
						<span className="composer-hint">Enter envia · Shift+Enter quebra linha</span>
							<button
								className={`send${input.trim() ? " ready" : ""}`}
								onClick={() => void sendPrompt()}
								type="button"
								disabled={!input.trim() || Boolean(state?.isStreaming)}
								title="Enviar"
							>
								<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8">
									<path d="M7 12V2M3 6l4-4 4 4" />
								</svg>
							</button>
						</div>
					</div>
				</div>
			</div>

			<style>{css}</style>
		</div>
	);
}

declare global {
	interface Window {
		noishi: NoishiBridge;
	}
}

const css = `
:root {
	--bg: #191919;
	--surface: #1f1f1f;
	--border: #ffffff0a;
	--border-line: #ffffff1f;
	--border-strong: #ffffff2e;
	--text: #ffffffed;
	--text-secondary: #ffffff91;
	--text-muted: #ffffff73;
	--accent: #d97757;
	--on-accent: #191919;
	--hover: #ffffff13;
	--active: #ffffff1f;
	--shadow-popover: 0 8px 24px #00000052, 0 2px 6px #0003;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }

.app { display: flex; height: 100vh; overflow: hidden; }

/* ---------- SIDEBAR ---------- */
.sidebar { width: 260px; min-width: 260px; background: var(--surface); border-right: 1px solid var(--border-line); display: flex; flex-direction: column; padding: 12px 10px; gap: 8px; transition: width .15s ease, min-width .15s ease; }
.sidebar.collapsed { width: 52px; min-width: 52px; padding: 12px 6px; }
.sidebar.collapsed .brand-name, .sidebar.collapsed .sidebar-section,
.sidebar.collapsed .session-list, .sidebar.collapsed .sidebar-footer { display: none; }
.sidebar.collapsed .new-chat, .sidebar.collapsed .new-project { padding: 8px; justify-content: center; }
.sidebar.collapsed .new-chat span, .sidebar.collapsed .new-project span { display: none; }

.sidebar-top { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 8px; }
.brand { display: flex; align-items: center; gap: 8px; }
.brand-mark { width: 24px; height: 24px; border-radius: 6px; background: var(--accent); color: var(--on-accent); font-weight: 800; font-size: 13px; display: grid; place-items: center; }
.brand-name { font-weight: 650; font-size: 15px; letter-spacing: .01em; }
.icon-btn { background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 4px; border-radius: 8px; display: grid; place-items: center; }
.icon-btn:hover { background: var(--hover); color: var(--text); }

.new-chat, .new-project { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border-radius: 10px; border: none; cursor: pointer; font: inherit; font-size: 13.5px; }
.new-chat { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.new-chat:hover { background: #e08a6e; }
.new-project { background: none; color: var(--text-secondary); border: 1px solid var(--border-line); }
.new-project:hover { background: var(--hover); color: var(--text); }
.new-project span { flex: 1; text-align: left; }
.new-chat span { flex: 1; text-align: left; }

.sidebar-section { color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; padding: 10px 8px 2px; }
.session-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.session-item { display: flex; flex-direction: column; gap: 1px; width: 100%; padding: 7px 10px; border-radius: 10px; border: none; background: none; cursor: pointer; text-align: left; font: inherit; }
.session-item:hover { background: var(--hover); }
.session-item.active { background: var(--active); }
.session-title { color: var(--text); font-size: 13px; }
.session-sub { color: var(--text-muted); font-size: 11px; }
.session-empty { color: var(--text-muted); font-size: 12px; padding: 8px; }

.sidebar-footer { border-top: 1px solid var(--border-line); padding: 10px 8px 2px; display: flex; flex-direction: column; gap: 2px; }
.footer-model { color: var(--text-secondary); font-size: 12px; }
.footer-meta { color: var(--text-muted); font-size: 11px; }

/* ---------- MAIN ---------- */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg); }
.topbar { display: flex; align-items: center; gap: 14px; padding: 10px 18px; border-bottom: 1px solid var(--border); min-height: 46px; }
.crumb { font-weight: 600; font-size: 13.5px; color: var(--text); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status { color: var(--text-muted); flex: 1; font-size: 12px; }
.actions { display: flex; gap: 6px; }
.btn { border: 1px solid var(--border-line); background: var(--surface); color: var(--text); border-radius: 10px; padding: 5px 12px; cursor: pointer; font: inherit; font-size: 12.5px; }
.btn:hover:not(:disabled) { background: var(--hover); }
.btn:disabled { opacity: .45; cursor: default; }
.btn.stop { background: #dc3c3d1f; border-color: #dc3c3d39; color: #f17778; }
.btn.ghost { background: none; }

.widgets { padding: 4px 18px; }
.widget { background: var(--surface); border: 1px solid var(--border-line); border-radius: 10px; padding: 6px 10px; font-size: 12px; color: var(--text-secondary); margin: 0; }

/* ---------- CHAT ---------- */
.chat { flex: 1; overflow-y: auto; padding: 24px 0 12px; display: flex; flex-direction: column; gap: 14px; align-items: center; }
.greeting { margin: auto; text-align: center; }
.greeting h1 { font-size: 34px; font-weight: 500; color: var(--text); margin: 0 0 6px; letter-spacing: -.01em; }
.greeting-sub { color: var(--text-secondary); margin: 0 0 14px; font-size: 15px; }
.greeting-meta { color: var(--text-muted); font-size: 11.5px; max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.row { width: 100%; max-width: 760px; padding: 0 24px; display: flex; }
.row.user { justify-content: flex-end; }
.row.assistant { justify-content: flex-start; }
.bubble { max-width: 85%; padding: 10px 16px; border-radius: 14px; white-space: pre-wrap; word-break: break-word; }
.bubble.user { background: #ffffff17; color: var(--text); border-bottom-right-radius: 4px; }
.bubble.assistant { background: none; color: var(--text); border-bottom-left-radius: 4px; }
.bubble.streaming .cursor { animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }

.thinking { width: 100%; max-width: 760px; padding: 0 24px; color: var(--text-muted); font-size: 12px; }
.thinking summary { cursor: pointer; }
.thinking pre { white-space: pre-wrap; background: var(--surface); border-radius: 10px; padding: 10px 14px; color: var(--text-secondary); }

.toolcall { width: 100%; max-width: 760px; margin: 0 24px; background: var(--surface); border: 1px solid var(--border-line); border-radius: 10px; padding: 10px 14px; }
.toolname { color: var(--accent); font-weight: 600; font-size: 12px; }
.toolcall pre { white-space: pre-wrap; margin: 6px 0 0; font-size: 12px; color: var(--text-secondary); max-height: 220px; overflow-y: auto; }
.error { width: 100%; max-width: 760px; margin: 0 24px; background: #dc3c3d1f; color: #f17778; border: 1px solid #dc3c3d39; border-radius: 10px; padding: 8px 14px; }

/* ---------- COMPOSER ---------- */
.composer-wrap { padding: 0 24px 20px; display: flex; justify-content: center; }
.composer { width: 100%; max-width: 760px; background: var(--surface); border: 1px solid var(--border-line); border-radius: 16px; padding: 10px 12px 8px; transition: border-color .15s; box-shadow: var(--shadow-popover); }
.composer:focus-within { border-color: var(--border-strong); }
.composer textarea { width: 100%; background: none; border: none; outline: none; resize: none; color: var(--text); font: inherit; font-size: 14.5px; min-height: 44px; }
.composer textarea::placeholder { color: var(--text-muted); }
.composer-bar { display: flex; align-items: center; justify-content: space-between; padding-top: 4px; }
.composer-hint { color: var(--text-muted); font-size: 11px; }
.send { width: 32px; height: 32px; border-radius: 9px; border: none; background: var(--hover); color: var(--text-muted); cursor: pointer; display: grid; place-items: center; }
.send.ready { background: var(--accent); color: var(--on-accent); }
.send.ready:hover { background: #e08a6e; }
.send:disabled { cursor: default; }

/* ---------- SETTINGS (composer popover) ---------- */
.model-btn { display: inline-flex; align-items: center; gap: 5px; background: none; border: 1px solid var(--border-line); color: var(--text-secondary); font: inherit; font-size: 11.5px; cursor: pointer; padding: 3px 10px; border-radius: 999px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-btn:hover { background: var(--hover); color: var(--text); border-color: var(--border-strong); }
.settings.composer-popover { position: absolute; bottom: calc(100% - 6px); left: 12px; right: 12px; margin: 0; z-index: 10; }
.composer-wrap { position: relative; }
.settings { display: flex; flex-direction: column; gap: 8px; background: var(--surface-popover); border: 1px solid var(--border-line); border-radius: 10px; padding: 8px; margin-top: 4px; box-shadow: var(--shadow-popover); }
.settings-select { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border-line); border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 12px; }
.thinking-row { display: flex; gap: 4px; flex-wrap: wrap; }
.chip { background: none; border: 1px solid var(--border-line); color: var(--text-secondary); border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 11px; cursor: pointer; }
.chip:hover { background: var(--hover); color: var(--text); }
.chip.on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }

/* ---------- COWORK ---------- */
.cowork { margin: 0 18px; background: var(--surface); border: 1px solid var(--border-line); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.cowork-head { display: flex; align-items: center; gap: 10px; }
.cowork-label { color: var(--text-secondary); font-size: 12px; flex: 1; }
.vm-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); flex: none; }
.vm-dot.up { background: #53c556; }
.vm-dot.missing { background: #f17778; }
.cowork-input-row { display: flex; gap: 6px; }
.cowork-input { flex: 1; background: var(--bg); border: 1px solid var(--border-line); border-radius: 8px; color: var(--text); font: inherit; font-size: 12.5px; padding: 6px 10px; outline: none; }
.cowork-input:focus { border-color: var(--border-strong); }
.cowork-input::placeholder { color: var(--text-muted); }
.cowork-output { margin: 0; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12px; color: var(--text-secondary); max-height: 220px; overflow-y: auto; white-space: pre-wrap; }
.btn.on { border-color: var(--accent); color: var(--accent); }

/* ---------- APPROVAL (in-chat dialog) ---------- */
.approval { margin: 0 24px 12px; background: var(--surface-popover); border: 1px solid var(--border-line); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; box-shadow: var(--shadow-popover); max-width: 712px; align-self: center; width: calc(100% - 48px); }
.approval-title { font-weight: 600; font-size: 13px; color: var(--text); }
.approval-message { font-size: 12px; color: var(--text-secondary); white-space: pre-wrap; }
.approval-options { display: flex; gap: 6px; flex-wrap: wrap; }
.approval-input { background: var(--bg); border: 1px solid var(--border-line); border-radius: 8px; color: var(--text); font: inherit; font-size: 12.5px; padding: 6px 10px; outline: none; }
.approval-input:focus { border-color: var(--border-strong); }
.approval-actions { display: flex; gap: 6px; }
.btn.approve { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.btn.approve:hover { background: #e08a6e; }

/* ---------- EXTENSIONS (mcpb/skills) ---------- */
.extensions-list { display: flex; flex-direction: column; gap: 4px; }
.extension-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 8px; background: var(--bg); border: 1px solid var(--border); font-size: 12px; color: var(--text-secondary); }
.extension-name { color: var(--text); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* scrollbars */
.chat::-webkit-scrollbar, .session-list::-webkit-scrollbar { width: 8px; }
.chat::-webkit-scrollbar-thumb, .session-list::-webkit-scrollbar-thumb { background: var(--border-line); border-radius: 4px; }
`;
