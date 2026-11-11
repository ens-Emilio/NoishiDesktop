/**
 * System tray: Noushi identity, menu with quick actions (chat/code/sair).
 * Icon is a 16x16 accent-square PNG embedded as data URL (no asset pipeline).
 */

import { app, Menu, nativeImage, Tray, BrowserWindow } from "electron";

const ICON_PNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGklEQVR4nGOoWvT9PyWYYdSAUQNGDRguBgAA/4USLopAgIwAAAAASUVORK5CYII=";

let tray: Tray | null = null;

function trayIcon(): Electron.NativeImage {
	const image = nativeImage.createFromBuffer(Buffer.from(ICON_PNG, "base64"));
	const sized = image.resize({ width: 16, height: 16 });
	if (sized.isEmpty()) return nativeImage.createFromNamedImage("dialog-information");
	return sized;
}

export function createTray(actions: { show: () => void; newChat: () => void; newCode: () => void }): Tray {
	try {
		tray = new Tray(trayIcon());
	} catch (error) {
		// Known Electron 33 + plasma6 SNI registration gap; the app stays usable without the tray.
		console.log("[noushi-desktop] tray unavailable:", error instanceof Error ? error.message : String(error));
		return null as unknown as Tray;
	}
	tray.setToolTip("Noushi");
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: "Nova conversa", click: () => actions.newChat() },
			{ label: "Nova sessão Code", click: () => actions.newCode() },
			{ type: "separator" },
			{ label: "Mostrar Noushi", click: () => actions.show() },
			{ type: "separator" },
			{ label: "Sair", click: () => app.quit() },
		]),
	);
	// Electron 33 + plasma6: some compositors only bind the SNI after a re-set.
	setTimeout(() => {
		if (tray && !tray.isDestroyed()) tray.setToolTip("Noushi - agent desktop");
	}, 1500);
	tray.on("click", () => {
		const win: BrowserWindow | undefined = BrowserWindow.getAllWindows()[0];
		if (win) {
			if (win.isVisible() && win.isFocused()) win.hide();
			else {
				win.show();
				win.focus();
			}
		}
	});
	return tray;
}
