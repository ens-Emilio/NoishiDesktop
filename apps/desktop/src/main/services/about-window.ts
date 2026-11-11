/**
 * About window: small modal-style window with app/CLI version info.
 * Static HTML (no bridge dependency) so it works even without a CLI.
 */

import { BrowserWindow } from "electron";
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
	body { margin: 0; background: #191919; color: #ffffffed; font: 14px/1.55 ui-sans-serif, system-ui, sans-serif; display: grid; place-items: center; height: 100vh; user-select: none; }
	.card { text-align: center; padding: 24px; }
	.mark { width: 56px; height: 56px; border-radius: 14px; background: #d97757; color: #191919; font-weight: 800; font-size: 28px; display: grid; place-items: center; margin: 0 auto 14px; }
	h1 { font-size: 20px; font-weight: 650; margin: 0 0 4px; }
	p { color: #ffffff91; font-size: 12.5px; margin: 2px 0; }
</style>
</head>
<body>
	<div class="card">
		<div class="mark">N</div>
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
		backgroundColor: "#191919",
		webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
	});
	about.once("ready-to-show", () => about?.show());
	about.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
	about.on("closed", () => {
		about = null;
	});
}
