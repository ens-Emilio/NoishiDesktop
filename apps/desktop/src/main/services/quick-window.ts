/**
 * Quick window: small always-on-top capture window (the "quick capture"
 * surface). Opened by tray menu / global shortcut; loads the same renderer
 * with a compact preset.
 */

import { BrowserWindow, globalShortcut, nativeTheme } from "electron";
import { join } from "node:path";

let quick: BrowserWindow | null = null;

export function registerQuickWindow(toggle: () => void): void {
	globalShortcut.register("CommandOrControl+Shift+Space", toggle);
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
