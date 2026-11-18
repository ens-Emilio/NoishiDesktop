/**
 * Shared BrowserWindow security hardening: blocks arbitrary navigation and
 * window.open() popups in every Electron surface.
 */

import { shell, type BrowserWindow } from "electron";

export function isSafeExternalUrl(raw: string): boolean {
	try {
		const parsed = new URL(raw);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

export function hardenWindow(win: BrowserWindow): void {
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (isSafeExternalUrl(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, url) => {
		// Allow local renderer reloads/queries only; external links open in OS browser.
		if (url.startsWith("file://")) return;
		event.preventDefault();
		if (isSafeExternalUrl(url)) void shell.openExternal(url);
	});
}
