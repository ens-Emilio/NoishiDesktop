import type { ExtensionUiRequest } from "@noishi/rpc-bridge";
import { createStore, useStore } from "./createStore.js";

export type PanelTab = "chat" | "terminal" | "sandbox" | "review" | "git" | "context" | "settings";

export type PanelStoreState = {
	activePanel: PanelTab;
	sidebarOpen: boolean;
	popoverOpen: boolean;
	findOpen: boolean;
	findText: string;
	findResult: { matches: number; active: number };
	pendingDialog: ExtensionUiRequest[];
	prefs: Record<string, unknown> | null;
};

export const panelStore = createStore<PanelStoreState>({
	activePanel: "chat",
	sidebarOpen: true,
	popoverOpen: false,
	findOpen: false,
	findText: "",
	findResult: { matches: 0, active: 0 },
	pendingDialog: [],
	prefs: null,
});

export function usePanelState<S = PanelStoreState>(selector?: (state: PanelStoreState) => S): S {
	return useStore(panelStore, selector);
}
