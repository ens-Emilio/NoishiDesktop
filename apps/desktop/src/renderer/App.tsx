import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, DesktopEnv, ExtensionUiRequest, NoishiBridge, SessionCommandResult, SessionListItem, SessionState } from "@noishi/rpc-bridge";

type ChatBlock =
	| { kind: "text"; id: number; role: "user" | "assistant"; content: string; streaming: boolean }
	| { kind: "thinking"; id: number; content: string; streaming: boolean }
	| { kind: "tool"; id: number; toolName: string; summary: string }
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

	useEffect(() => {
		window.noishi.getEnv().then(setEnv);
		void refreshState();
		void loadSessions();
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
					next.push({ kind: "tool", id: nextId(), toolName: String(event.toolName ?? "tool"), summary: "executando…" });
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
			case "confirm": {
				const confirmed = window.confirm(`${request.title ?? "Confirmação"}\n\n${request.message ?? ""}`);
				window.noishi.answerExtensionUi({ id: request.id, confirmed });
				break;
			}
			case "input": {
				const value = window.prompt(request.title ?? "Entrada", request.placeholder ?? "");
				if (value === null) window.noishi.answerExtensionUi({ id: request.id, cancelled: true });
				else window.noishi.answerExtensionUi({ id: request.id, value });
				break;
			}
			case "select": {
				const options = request.options ?? [];
				const picked = window.prompt(`${request.title ?? "Escolha"}\nOpções: ${options.join(", ")}`);
				if (picked === null) window.noishi.answerExtensionUi({ id: request.id, cancelled: true });
				else window.noishi.answerExtensionUi({ id: request.id, value: picked });
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
					<span className="footer-model">{state?.model?.name ?? state?.model?.id ?? "—"}</span>
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
						<button className="btn ghost" onClick={compactSession} type="button" disabled={!state?.sessionId}>Compactar</button>
						<button className="btn ghost" onClick={exportSession} type="button">Exportar</button>
					</div>
				</header>

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
											<span className="toolname">{block.toolName}</span>
											<pre>{block.summary}</pre>
										</div>
									);
								case "error":
									return <div key={block.id} className="error">{block.message}</div>;
							}
						})
					)}
				</div>

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
						<div className="composer-bar">
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

/* scrollbars */
.chat::-webkit-scrollbar, .session-list::-webkit-scrollbar { width: 8px; }
.chat::-webkit-scrollbar-thumb, .session-list::-webkit-scrollbar-thumb { background: var(--border-line); border-radius: 4px; }
`;
