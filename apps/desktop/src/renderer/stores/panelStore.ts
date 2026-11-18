import { createStore, useStore } from "./createStore";

export type PanelTab = "chat" | "context" | "git" | "review" | "sandbox" | "settings";

export type PanelStoreState = {
	activePanel: PanelTab;
	isStreaming: boolean;
	streamingText: string;
	streamingThinking: string;
	reconnectState: "connected" | "reconnecting" | "disconnected";
	lastError: string | null;
};

export const panelStore = createStore<PanelStoreState>({
	activePanel: "chat",
	isStreaming: false,
	streamingText: "",
	streamingThinking: "",
	reconnectState: "connected",
	lastError: null,
});

export function usePanelState<S = PanelStoreState>(selector?: (state: PanelStoreState) => S): S {
	return useStore(panelStore, selector);
}
