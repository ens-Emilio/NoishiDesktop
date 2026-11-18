/**
 * System tray: Noishi identity, menu with quick actions (chat/code/sair).
 *
 * Plasma 6 / GNOME need StatusNotifierItem, which Electron only registers when
 * libayatana-appindicator (or libappindicator) is present at runtime. We detect
 * that up front and say so in the log instead of failing silently, and we
 * re-apply the context menu after the item is registered — some compositors
 * bind the SNI late and drop a menu set before that.
 */

import { app, Menu, nativeImage, Tray, BrowserWindow } from "electron";
import { existsSync } from "node:fs";

const ICON_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAASElEQVR42mNgQAOzW178x4cZcAFCGvEaRKpmDEMoMgCbhJSEAhjj4qMYgs8AmKaBNQDdMPoagM079DeAYCAOfEqkSmaiJDsDAH4wYRe/ablqAAAAAElFTkSuQmCC";

/** Paths where the SNI backend may live, per distro. */
const APPINDICATOR_PATHS = [
	"/usr/lib/libayatana-appindicator3.so.1",
	"/usr/lib/libayatana-appindicator3.so",
	"/usr/lib/x86_64-linux-gnu/libayatana-appindicator3.so.1",
	"/usr/lib64/libayatana-appindicator3.so.1",
	"/usr/lib/libappindicator3.so.1",
	"/usr/lib/x86_64-linux-gnu/libappindicator3.so.1",
];

export type TrayStatus = { available: boolean; reason?: string };

let tray: Tray | null = null;
let status: TrayStatus = { available: false, reason: "not created" };

function hasAppIndicator(): boolean {
	return APPINDICATOR_PATHS.some((path) => existsSync(path));
}

function trayIcon(): Electron.NativeImage {
	const image = nativeImage.createFromBuffer(Buffer.from(ICON_PNG, "base64"));
	// Plasma scales 16px icons up and they blur; 22px is the panel's native size.
	const sized = image.resize({ width: 22, height: 22, quality: "best" });
	if (sized.isEmpty()) return nativeImage.createFromNamedImage("dialog-information");
	sized.setTemplateImage(false);
	return sized;
}

export function trayStatus(): TrayStatus {
	return status;
}

/**
 * Whether closing the main window should hide it to the tray instead of
 * quitting. Only meaningful when a tray exists; `--minimize-to-tray=false`
 * (or NOISHI_MINIMIZE_TO_TRAY=0) turns it off for users whose desktop has no
 * SNI support and who would otherwise lose the window.
 */
export function minimizeToTrayEnabled(): boolean {
	const flag = process.argv.find((arg) => arg.startsWith("--minimize-to-tray="));
	if (flag) return flag.split("=")[1] !== "false";
	const env = process.env.NOISHI_MINIMIZE_TO_TRAY;
	if (env !== undefined) return env !== "0" && env.toLowerCase() !== "false";
	return status.available;
}

export function createTray(actions: { show: () => void; newChat: () => void; newCode: () => void; openBuddy: () => void; quick: () => void; about: () => void }): Tray | null {
	if (!hasAppIndicator()) {
		status = {
			available: false,
			reason: "libayatana-appindicator3 ausente — instale libayatana-appindicator (Arch) ou libayatana-appindicator3-1 (Debian)",
		};
		console.log(`[noishi-desktop] tray: ${status.reason}`);
		return null;
	}
	const menu = Menu.buildFromTemplate([
		{ label: "Nova conversa", click: () => actions.newChat() },
		{ label: "Nova sessão Code", click: () => actions.newCode() },
		{ label: "Quick window", accelerator: "CommandOrControl+Shift+Space", click: () => actions.quick() },
		{ label: "Buddy window…", click: () => actions.openBuddy() },
		{ type: "separator" },
		{ label: "Sobre o Noishi", click: () => actions.about() },
		{ type: "separator" },
		{ label: "Mostrar Noishi", click: () => actions.show() },
		{ type: "separator" },
		{ label: "Sair", click: () => app.quit() },
	]);
	try {
		tray = new Tray(trayIcon());
	} catch (error) {
		status = { available: false, reason: error instanceof Error ? error.message : String(error) };
		console.log(`[noishi-desktop] tray: falhou ao criar — ${status.reason}`);
		return null;
	}
	tray.setToolTip("Noishi");
	tray.setContextMenu(menu);
	// Some compositors register the SNI a beat after construction and drop a
	// menu set before that; re-apply once the item is live.
	setTimeout(() => {
		if (!tray || tray.isDestroyed()) return;
		tray.setContextMenu(menu);
		tray.setToolTip("Noishi — agent desktop");
	}, 1500);
	tray.on("click", () => {
		const win: BrowserWindow | undefined = BrowserWindow.getAllWindows()[0];
		if (!win) return;
		if (win.isVisible() && win.isFocused()) win.hide();
		else {
			win.show();
			win.focus();
		}
	});
	status = { available: true };
	console.log("[noishi-desktop] tray: registrado (SNI)");
	return tray;
}

/* ---------- badge (feature 44) ---------- */

/** Show the count of sessions needing attention in the tooltip. */
export function setTrayBadge(count: number): void {
	if (!tray || tray.isDestroyed()) return;
	tray.setToolTip(count > 0 ? `Noishi — ${count} aguardando` : "Noishi — agent desktop");
}
