import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, DesktopEnv, ExtensionUiRequest, NoushiBridge, SessionCommandResult, SessionListItem, SessionState } from "@noushi/rpc-bridge";

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
	const [showSessions, setShowSessions] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);

	const loadSessions = useCallback(async (): Promise<void> => {
		const result: SessionCommandResult = await window.noushi.runSessionCommand({ type: "listSessions" });
		if (result.ok) setSessions(result.data as SessionListItem[]);
	}, []);

	useEffect(() => {
		window.noushi.getEnv().then(setEnv);
		void refreshState();
		void loadSessions();
		// deep-link routes: chat/new resets the view (session commands already ran in main)
		const offRoute = window.noushi.onDeepLinkRoute((route) => {
			if (route.kind === "chat/new" || route.kind === "code/new") setBlocks([]);
		});
		return () => {
			offRoute();
		};
		const offEvent = window.noushi.onSessionEvent(handleEvent);
		const offUi = window.noushi.onExtensionUiRequest(handleExtensionUi);
		return () => {
			offEvent();
			offUi();
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
				window.noushi.answerExtensionUi({ id: request.id, cancelled: true });
				break;
			}
			case "confirm": {
				const confirmed = window.confirm(`${request.title ?? "Confirmação"}\n\n${request.message ?? ""}`);
				window.noushi.answerExtensionUi({ id: request.id, confirmed });
				break;
			}
			case "input": {
				const value = window.prompt(request.title ?? "Entrada", request.placeholder ?? "");
				if (value === null) window.noushi.answerExtensionUi({ id: request.id, cancelled: true });
				else window.noushi.answerExtensionUi({ id: request.id, value });
				break;
			}
			case "select": {
				const options = request.options ?? [];
				const picked = window.prompt(`${request.title ?? "Escolha"}\nOpções: ${options.join(", ")}`);
				if (picked === null) window.noushi.answerExtensionUi({ id: request.id, cancelled: true });
				else window.noushi.answerExtensionUi({ id: request.id, value: picked });
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
				window.noushi.answerExtensionUi({ id: request.id, cancelled: true });
		}
	}

	const refreshState = useCallback(async (): Promise<void> => {
		const result: SessionCommandResult = await window.noushi.runSessionCommand({ type: "getState" });
		if (result.ok) setState(result.data as SessionState);
	}, []);

	const refreshUsage = useCallback(async (): Promise<void> => {
		const result: SessionCommandResult = await window.noushi.runSessionCommand({ type: "getStats" });
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
		const result = await window.noushi.runSessionCommand({ type: "prompt", message });
		if (!result.ok) {
			setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: result.ok ? "" : result.error }]);
			return;
		}
		void refreshState();
	}, [input, refreshState]);

	const newSession = useCallback(async (): Promise<void> => {
		await window.noushi.runSessionCommand({ type: "newSession" });
		setBlocks([]);
		setUsage({ tokens: 0, cost: 0 });
		void refreshState();
	}, [refreshState]);

	const abort = useCallback((): void => {
		void window.noushi.runSessionCommand({ type: "abort" });
	}, []);

	const newSessionIn = useCallback(async (cwd: string): Promise<void> => {
		await window.noushi.runSessionCommand({ type: "startIn", cwd });
		setBlocks([]);
		setUsage({ tokens: 0, cost: 0 });
		void refreshState();
	}, [refreshState]);

	const resumeSession = useCallback(async (sessionPath: string): Promise<void> => {
		setBlocks([]);
		const result = await window.noushi.runSessionCommand({ type: "switchSession", sessionPath });
		if (!result.ok) {
			setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: result.ok ? "" : result.error }]);
		}
		await window.noushi.runSessionCommand({ type: "getEntries" });
		void refreshState();
	}, [refreshState]);

	const compactSession = useCallback(async (): Promise<void> => {
		const result = await window.noushi.runSessionCommand({ type: "compact" });
		if (!result.ok) setBlocks((prev) => [...prev, { kind: "error", id: nextId(), message: result.ok ? "" : result.error }]);
		void refreshState();
	}, [refreshState]);

	const exportSession = useCallback(async (): Promise<void> => {
		const result = await window.noushi.runSessionCommand({ type: "exportHtml" });
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
			<header className="topbar">
				<span className="brand">Noushi</span>
				<span className="status">{statusLine}</span>
				<div className="actions">
					<button onClick={() => { setShowSessions((s) => !s); void loadSessions(); }} type="button">Sessões</button>
					<button onClick={compactSession} type="button" disabled={!state?.sessionId}>Compactar</button>
					<button onClick={exportSession} type="button">Exportar</button>
					<button onClick={newSession} type="button">Nova sessão</button>
					{state?.isStreaming ? (
						<button onClick={abort} type="button">Parar</button>
					) : null}
				</div>
			</header>

			{showSessions ? (
				<aside className="sessions">
					<div className="sessions-head">
						<span>Sessões ({sessions.length})</span>
						<button
							onClick={() => {
								const cwd = window.prompt("Diretório do projeto:", "/home/zens");
								if (cwd) void newSessionIn(cwd).then(() => setShowSessions(false));
							}}
							type="button"
						>
							Nova em…
						</button>
					</div>
					{sessions.map((session) => (
						<button
							key={session.sessionId}
							className="session-row"
							onClick={() => void resumeSession(session.sessionFile)}
							type="button"
						>
							<span className="session-name">{session.name ?? session.sessionId.slice(0, 8)}</span>
							<span className="session-meta">
								{new Date(session.modifiedAt).toLocaleString("pt-BR")} · {session.messageCount ?? 0} msgs
							</span>
						</button>
					))}
					{sessions.length === 0 ? <p className="session-meta">Nenhuma sessão para este diretório.</p> : null}
				</aside>
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
					<div className="empty">
						<h1>Noushi</h1>
						<p>Conversa com o agente. Ferramentas (read, edit, bash…) aparecem aqui.</p>
						{env ? <p className="meta">CLI: {env.cliPath ?? "não encontrado"} ({env.cliVersion ?? "?"})</p> : null}
					</div>
				) : (
					blocks.map((block) => {
						switch (block.kind) {
							case "text":
								return block.role === "user" ? (
									<div key={block.id} className="bubble user">{block.content}</div>
								) : (
									<div key={block.id} className={`bubble assistant${block.streaming ? " streaming" : ""}`}>
										{block.content}
										{block.streaming ? <span className="cursor">▌</span> : null}
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

			<footer className="composer">
				<textarea
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void sendPrompt();
						}
					}}
					placeholder="Pergunte algo… (Enter envia, Shift+Enter quebra linha)"
					rows={3}
				/>
			</footer>

			<style>{css}</style>
		</div>
	);
}

declare global {
	interface Window {
		noushi: NoushiBridge;
	}
}

const css = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #111318; color: #e4e7ec; font: 14px/1.5 system-ui, sans-serif; }
.app { display: flex; flex-direction: column; height: 100vh; }
.topbar { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid #23262e; }
.brand { font-weight: 700; letter-spacing: 0.04em; }
.status { color: #8b93a1; flex: 1; font-size: 12px; }
.actions button { margin-left: 8px; }
button { background: #1d2027; color: #e4e7ec; border: 1px solid #2e323c; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
button:hover { background: #262a33; }
.widgets { padding: 4px 16px; }
.widget { background: #171a20; border: 1px solid #23262e; border-radius: 6px; padding: 6px 10px; font-size: 12px; color: #a7b0bd; }
.chat { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.empty { margin: auto; text-align: center; color: #8b93a1; }
.empty h1 { color: #e4e7ec; letter-spacing: 0.06em; }
.meta { font-size: 12px; color: #5c6470; }
.bubble { max-width: 76%; padding: 10px 14px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
.bubble.user { align-self: flex-end; background: #23407a; }
.bubble.assistant { align-self: flex-start; background: #1b1e25; }
.bubble.streaming .cursor { animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.thinking { align-self: flex-start; color: #8b93a1; font-size: 12px; max-width: 76%; }
.thinking pre { white-space: pre-wrap; background: #171a20; border-radius: 8px; padding: 8px 12px; }
.toolcall { align-self: flex-start; background: #14171c; border: 1px solid #23262e; border-radius: 8px; padding: 8px 12px; max-width: 80%; }
.toolname { color: #7aa2f7; font-weight: 600; font-size: 12px; }
.toolcall pre { white-space: pre-wrap; margin: 6px 0 0; font-size: 12px; color: #a7b0bd; max-height: 200px; overflow-y: auto; }
.error { align-self: stretch; background: #2a1618; color: #f2a3ad; border: 1px solid #45262a; border-radius: 8px; padding: 8px 12px; }
.sessions { border-bottom: 1px solid #23262e; max-height: 260px; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; }
.sessions-head { display: flex; justify-content: space-between; align-items: center; color: #8b93a1; font-size: 12px; }
.session-row { display: flex; justify-content: space-between; gap: 12px; background: #171a20; border: 1px solid #23262e; border-radius: 6px; padding: 6px 10px; cursor: pointer; text-align: left; }
.session-name { color: #e4e7ec; font-size: 13px; }
.session-meta { color: #5c6470; font-size: 11px; }
.composer { border-top: 1px solid #23262e; padding: 12px 16px; }
.composer textarea { width: 100%; background: #171a20; color: #e4e7ec; border: 1px solid #2e323c; border-radius: 8px; padding: 10px 12px; font: inherit; resize: vertical; }
`;
