/**
 * Quick window: small always-on-top capture window (the "quick capture"
 * surface). Opened by tray menu / global shortcut; loads the same renderer
 * with a compact preset.
 */

import { BrowserWindow, globalShortcut, nativeTheme } from "electron";
import { join } from "node:path";
import { readPrefs } from "./prefs.js";

let quick: BrowserWindow | null = null;
let toggleHandler: (() => void) | null = null;

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
	quick = new BrowserWindow({
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
	quick.once("ready-to-show", () => quick?.show());
	quick.loadFile(join(import.meta.dirname, "../renderer/index.html"), { query: { window: "quick" } });
	quick.on("closed", () => {
		quick = null;
	});
}
