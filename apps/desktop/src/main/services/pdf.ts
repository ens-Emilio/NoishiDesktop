/**
 * PDF export: render a self-contained HTML document offscreen and print it.
 *
 * A hidden BrowserWindow is the only way to get Chromium's layout engine
 * without a visible window; it is destroyed as soon as the file is written.
 */

import { BrowserWindow } from "electron";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export async function exportPdf(html: string, target: string): Promise<{ path: string; bytes: number }> {
	const win = new BrowserWindow({
		show: false,
		width: 900,
		height: 1200,
		webPreferences: { offscreen: true, javascript: false, sandbox: true },
	});
	try {
		await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
		const pdf = await win.webContents.printToPDF({
			printBackground: true,
			margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
		});
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, pdf);
		return { path: target, bytes: statSync(target).size };
	} finally {
		if (!win.isDestroyed()) win.destroy();
	}
}
