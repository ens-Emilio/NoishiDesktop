import type { AgentEvent, DesktopEnv, ExtensionUiRequest, SessionState } from "@noishi/rpc-bridge";
import { createStore, useStore } from "./createStore.js";
import { panelStore } from "./panelStore.js";

export type ChatBlock =
	| { kind: "text"; id: number; role: "user" | "assistant"; content: string; streaming: boolean; entryId?: string }
	| { kind: "thinking"; id: number; content: string; streaming: boolean }
	| { kind: "tool"; id: number; toolName: string; args: string; output: string; streaming?: boolean }
	| { kind: "error"; id: number; message: string; info?: boolean };

export type StatusWidget = { key: string; lines: string[] };

let blockSeq = 0;
export const nextBlockId = (): number => ++blockSeq;

export type SessionStoreState = {
	blocks: ChatBlock[];
	env: DesktopEnv | null;
	state: SessionState | null;
	usage: { tokens: number; cost: number };
	statusWidgets: StatusWidget[];
	queued: string[];
	rpcError: string | null;
	needsInput: boolean;
	reconnecting: boolean;
};

export const sessionStore = createStore<SessionStoreState>({
	blocks: [],
	env: null,
	state: null,
	usage: { tokens: 0, cost: 0 },
	statusWidgets: [],
	queued: [],
	rpcError: null,
	needsInput: false,
	reconnecting: false,
});

export function useSessionState<S = SessionStoreState>(selector?: (state: SessionStoreState) => S): S {
	return useStore(sessionStore, selector);
}

export function pushBlock(block: ChatBlock): void {
	sessionStore.setState((prev) => ({ ...prev, blocks: [...prev.blocks, block] }));
}

export function setBlocks(updater: ChatBlock[] | ((prev: ChatBlock[]) => ChatBlock[])): void {
	sessionStore.setState((prev) => ({
		...prev,
		blocks: typeof updater === "function" ? updater(prev.blocks) : updater,
	}));
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

function appendToolOutput(delta: string): void {
	setBlocks((prev) => {
		const next = [...prev];
		const last = next[next.length - 1];
		if (last?.kind === "tool") next[next.length - 1] = { ...last, output: last.output + delta };
		return next;
	});
}

function applyStreamEvent(event: Record<string, unknown> & { type: string }, usageRecord: unknown): void {
	const u = usageRecord as { totalTokens?: number; cost?: { total?: number } } | undefined;
	if (u && typeof u.totalTokens === "number") {
		sessionStore.setState({ usage: { tokens: u.totalTokens, cost: u.cost?.total ?? 0 } });
	}
	setBlocks((prev) => {
		const next = [...prev];
		const lastIndex = next.length - 1;
		const last = next[lastIndex];
		switch (event.type) {
			case "message_start":
				next.push({ kind: "text", id: nextBlockId(), role: "assistant", content: "", streaming: true });
				return next;
			case "text_delta":
				if (last?.kind === "text" && last.streaming) next[lastIndex] = { ...last, content: last.content + String(event.delta ?? "") };
				else next.push({ kind: "text", id: nextBlockId(), role: "assistant", content: String(event.delta ?? ""), streaming: true });
				return next;
			case "text_end":
				if (last?.kind === "text" && last.streaming) next[lastIndex] = { ...last, streaming: false };
				return next;
			case "thinking_delta":
				if (last?.kind === "thinking" && last.streaming) next[lastIndex] = { ...last, content: last.content + String(event.delta ?? "") };
				else next.push({ kind: "thinking", id: nextBlockId(), content: String(event.delta ?? ""), streaming: true });
				return next;
			case "thinking_end":
				if (last?.kind === "thinking" && last.streaming) next[lastIndex] = { ...last, streaming: false };
				return next;
			case "toolcall_start":
				next.push({ kind: "tool", id: nextBlockId(), toolName: String(event.toolName ?? "tool"), args: "", output: "", streaming: true });
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

export function handleSessionEvent(
	event: AgentEvent,
	callbacks: { refreshState: () => Promise<void>; refreshUsage: () => Promise<void> },
): void {
	switch (event.type) {
		case "message_update":
			applyStreamEvent(event.event, event.usage);
			break;
		case "entry_appended": {
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
			void callbacks.refreshUsage();
			break;
		case "agent_end":
			markStreamingDone();
			void callbacks.refreshState();
			void callbacks.refreshUsage();
			sessionStore.setState((prev) => {
				const [next, ...rest] = prev.queued;
				if (!next) return { ...prev, queued: rest };
				void window.noishi.runSessionCommand({ type: "followUp", message: next });
				return {
					...prev,
					queued: rest,
					blocks: [...prev.blocks, { kind: "text", id: nextBlockId(), role: "user", content: next, streaming: false }],
				};
			});
			break;
		case "bash_execution_update":
			appendToolOutput(event.delta);
			break;
		case "rpc_exit":
			markStreamingDone();
			sessionStore.setState({ rpcError: event.message });
			break;
		default:
			break;
	}
}

export function handleExtensionUiRequest(request: ExtensionUiRequest): void {
	switch (request.method) {
		case "notify":
			pushBlock({ kind: "error", id: nextBlockId(), message: request.message ?? "", info: request.notifyType !== "error" });
			window.noishi.answerExtensionUi({ id: request.id, cancelled: true });
			break;
		case "confirm":
		case "input":
		case "select":
		case "editor":
			panelStore.setState((prev) => ({ ...prev, pendingDialog: [...prev.pendingDialog, request] }));
			break;
		case "setStatus":
			sessionStore.setState((prev) => {
				const rest = prev.statusWidgets.filter((w) => w.key !== request.statusKey);
				return {
					...prev,
					statusWidgets: request.statusText ? [...rest, { key: request.statusKey, lines: [request.statusText] }] : rest,
				};
			});
			break;
		case "setWidget":
			sessionStore.setState((prev) => {
				const rest = prev.statusWidgets.filter((w) => w.key !== request.widgetKey);
				return {
					...prev,
					statusWidgets: request.widgetLines ? [...rest, { key: request.widgetKey, lines: request.widgetLines }] : rest,
				};
			});
			break;
		default:
			window.noishi.answerExtensionUi({ id: request.id, cancelled: true });
	}
}
