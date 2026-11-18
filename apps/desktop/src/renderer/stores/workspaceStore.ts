import type { SessionListItem } from "@noishi/rpc-bridge";
import { createStore, useStore } from "./createStore.js";

export type FileNode = { name: string; path: string; dir: boolean; size?: number; children?: FileNode[] };
export type SessionSearchHit = { sessionPath: string; snippet: string; role: string | null; line: number };
export type FolderIndex = {
	folders: string[];
	tags: string[];
	entries: Record<string, { folder: string | null; tags: string[] }>;
};

export type WorkspaceStoreState = {
	roots: string[];
	treeByRoot: Record<string, FileNode[]>;
	treeOpen: Record<string, boolean>;
	sessions: SessionListItem[];
	sessionQuery: string;
	sessionHits: SessionSearchHit[];
	folders: FolderIndex;
};

export const workspaceStore = createStore<WorkspaceStoreState>({
	roots: [],
	treeByRoot: {},
	treeOpen: {},
	sessions: [],
	sessionQuery: "",
	sessionHits: [],
	folders: { folders: [], tags: [], entries: {} },
});

export function useWorkspaceState<S = WorkspaceStoreState>(selector?: (state: WorkspaceStoreState) => S): S {
	return useStore(workspaceStore, selector);
}
