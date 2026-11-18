/**
 * Buddy window: secondary chat window scoped to one project directory.
 * Runs its own SessionHost (own RPC child) so it never fights the main
 * window's session. Opened via tray/deep-link `noishi://buddy?cwd=...`.
 */

import { BrowserWindow, nativeTheme } from "electron";
import { join } from "node:path";
import type { SessionHost } from "./session-host.js";
import type { AgentEvent, ExtensionUiRequest, ExtensionUiResponse } from "@noishi/rpc-bridge";
import { CHANNELS } from "@noishi/rpc-bridge";

export class BuddyWindow {
	private readonly windows = new Map<string, { win: BrowserWindow; host: SessionHost }>();

	open(cwd: string, cliFactory: () => SessionHost): void {
		const existing = this.windows.get(cwd);
		if (existing) {
			if (!existing.win.isDestroyed()) {
				existing.win.show();
				existing.win.focus();
				return;
			}
			this.windows.delete(cwd);
		}
		const host = cliFactory();
		void host.runCommand({ type: "startIn", cwd });
		const win = new BrowserWindow({
			width: 760,
			height: 560,
			show: false,
			title: `Noishi — ${cwd.split("/").pop() || cwd}`,
			backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1820" : "#faf8fc",
			webPreferences: {
				preload: join(import.meta.dirname, "../preload/index.cjs"),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			},
		});
		win.loadFile(join(import.meta.dirname, "../renderer/index.html"), { query: { window: "buddy" } });
		// The buddy window owns its own SessionHost, so it must own the
		// subscription too — without this its RPC events never reached the UI.
		win.webContents.on("did-finish-load", () => {
			host.subscribe(
				win.webContents.id,
				(event: AgentEvent) => {
					if (win.isDestroyed()) return;
					win.webContents.send(CHANNELS.sessionEvent, event);
				},
				(request: ExtensionUiRequest) => {
					if (win.isDestroyed()) return;
					win.webContents.send(CHANNELS.extensionUiRequest, request);
				},
			);
		});
		win.on("closed", () => {
			host.disposeAll();
			this.windows.delete(cwd);
		});
		this.windows.set(cwd, { win, host });
	}

	answerExtensionUi(windowId: number, response: ExtensionUiResponse): boolean {
		for (const { host } of this.windows.values()) {
			if (host.hasSubscriber(windowId)) {
				host.answerExtensionUi(response);
				return true;
			}
		}
		return false;
	}

	hosts(): IterableIterator<SessionHost> {
		return [...this.windows.values()].map((entry) => entry.host)[Symbol.iterator]();
	}

	disposeAll(): void {
		for (const { win, host } of this.windows.values()) {
			host.disposeAll();
			if (!win.isDestroyed()) win.close();
		}
		this.windows.clear();
	}
}
