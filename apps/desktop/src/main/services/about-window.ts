/**
 * About window: small modal-style window with app/CLI version info.
 * Static HTML (no bridge dependency) so it works even without a CLI.
 */

import { BrowserWindow, nativeTheme } from "electron";
import { join } from "node:path";
import { readFileSync } from "node:fs";

let about: BrowserWindow | null = null;

export function showAboutWindow(): void {
	if (about && !about.isDestroyed()) {
		about.focus();
		return;
	}
	let version = "?";
	try {
		const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf-8")) as { version?: string };
		version = pkg.version ?? "?";
	} catch {
		// packaged layout may differ; fall back to ?
	}
	const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<style>
	:root { color-scheme: dark; }
	body { margin: 0; background: #1a1820; color: #f3f0f7; font: 14px/1.55 ui-sans-serif, system-ui, sans-serif; display: grid; place-items: center; height: 100vh; user-select: none; }
	.card { text-align: center; padding: 24px; }
	.mark { display: grid; place-items: center; margin: 0 auto 14px; color: #f3f0f7; }
	h1 { font-size: 20px; font-weight: 650; margin: 0 0 4px; }
	p { color: #a9a2b8; font-size: 12.5px; margin: 2px 0; }
</style>
</head>
<body>
	<div class="card">
		<div class="mark"><svg width="52" height="52" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="7" fill="none" stroke="currentColor" stroke-opacity=".28"/><path d="M7.6 17V7l8.8 10V7" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="square"/><circle cx="16.4" cy="17" r="1.5" fill="#9b84e8"/></svg></div>
		<h1>Noishi Desktop</h1>
		<p>versão ${version}</p>
		<p>motor: NoishiCLI (pi rpc)</p>
	</div>
</body>
</html>`;
	about = new BrowserWindow({
		width: 320,
		height: 260,
		show: false,
		resizable: false,
		minimizable: false,
		maximizable: false,
		title: "Sobre o Noishi",
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1820" : "#faf8fc",
		webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
	});
	about.once("ready-to-show", () => about?.show());
	about.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
	about.on("closed", () => {
		about = null;
	});
}
