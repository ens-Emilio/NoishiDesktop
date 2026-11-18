/**
 * Find in page: a small overlay over the chat with next/prev and a match count.
 *
 * Uses Electron's webContents.findInPage, which highlights matches natively and
 * reports the active match index — no DOM scanning, no scroll math.
 */

import { BrowserWindow, type WebContents } from "electron";

type FindState = { query: string; matches: number; active: number };

const state = new Map<number, FindState>();

function send(contents: WebContents, channel: string, payload: unknown): void {
	if (contents.isDestroyed()) return;
	contents.send(channel, payload);
}

/** Run a find request for the window that owns `contents`. */
export function findInPage(contents: WebContents, query: string, forward = true): void {
	const current = state.get(contents.id);
	state.set(contents.id, { query, matches: current?.matches ?? 0, active: current?.active ?? 0 });
	if (!query) {
		contents.stopFindInPage("clearSelection");
		send(contents, "noishi:find-result", { query: "", matches: 0, active: 0 });
		return;
	}
	contents.findInPage(query, { forward, findNext: current !== undefined });
}

/** Wire the found-in-page event once per window. */
export function wireFindInPage(win: BrowserWindow): void {
	const contents = win.webContents;
	contents.on("found-in-page", (_event, result) => {
		const current = state.get(contents.id) ?? { query: "", matches: 0, active: 0 };
		state.set(contents.id, { ...current, matches: result.matches, active: result.activeMatchOrdinal });
		send(contents, "noishi:find-result", {
			query: current.query,
			matches: result.matches,
			active: result.activeMatchOrdinal,
		});
	});
	contents.on("destroyed", () => state.delete(contents.id));
}

/** Open the find bar in the focused window (Ctrl+F). */
export function openFindBar(): void {
	const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	if (!win) return;
	send(win.webContents, "noishi:find-open", null);
}

/** Clear the find session when the last match is dismissed. */
export function clearFind(contents: WebContents): void {
	contents.stopFindInPage("clearSelection");
	state.delete(contents.id);
}
