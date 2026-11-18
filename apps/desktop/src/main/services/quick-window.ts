/**
 * Quick window: small always-on-top capture window (the "quick capture"
 * surface). Opened by tray menu / global shortcut; loads the same renderer
 * with a compact preset.
 */

import { BrowserWindow, globalShortcut, nativeTheme } from "electron";
import { join } from "node:path";
import { readPrefs } from "./prefs.js";
import { hardenWindow } from "./window-security.js";

let quick: BrowserWindow | null = null;
let toggleHandler: (() => void) | null = null;
let quickQuitting = false;

export function setQuickQuitting(quitting: boolean): void {
	quickQuitting = quitting;
}

/** Accelerator for an action, from prefs, with the historical default. */
export function acceleratorFor(action: string, fallback: string): string {
	return readPrefs().shortcuts.find((shortcut) => shortcut.action === action)?.accelerator ?? fallback;
}

/**
 * Register the global shortcuts from prefs (feature 45). Called at boot and
 * again whenever the user rebinds one, so a change takes effect immediately.
 */
export function registerQuickWindow(toggle: () => void): void {
	toggleHandler = toggle;
	globalShortcut.unregisterAll();
	const accelerator = acceleratorFor("quick-window", "CommandOrControl+Shift+Space");
	if (!globalShortcut.register(accelerator, toggle)) {
		console.log(`[noishi-desktop] atalho ${accelerator} indisponível (já em uso por outro app)`);
	}
}

/** Re-apply the global shortcuts after a rebind. */
export function refreshShortcuts(): void {
	if (toggleHandler) registerQuickWindow(toggleHandler);
}

function createQuickWindow(showOnReady: boolean): BrowserWindow {
	const win = new BrowserWindow({
		width: 420,
		height: 320,
		show: false,
		alwaysOnTop: true,
		frame: false,
		resizable: true,
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1820" : "#faf8fc",
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	hardenWindow(win);
	if (showOnReady) win.once("ready-to-show", () => win.show());
	void win.loadFile(join(import.meta.dirname, "../renderer/index.html"), { query: { window: "quick" } });
	// Keep quick window warm in the background so Ctrl+Shift+Space opens instantly.
	win.on("close", (event) => {
		if (quickQuitting) return;
		event.preventDefault();
		win.hide();
	});
	win.on("closed", () => {
		quick = null;
	});
	return win;
}

export function warmQuickWindow(): void {
	if (quick && !quick.isDestroyed()) return;
	quick = createQuickWindow(false);
}

export function toggleQuickWindow(): void {
	if (quick && !quick.isDestroyed()) {
		if (quick.isVisible()) {
			quick.hide();
			return;
		}
		quick.show();
		quick.focus();
		return;
	}
	quick = createQuickWindow(true);
}
