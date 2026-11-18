/**
 * Artifact window: read-only view of a shared session artifact
 * (`noishi://cowork/shared-artifact?id=…`). Loads the same renderer with
 * ?window=artifact so it reuses the design system and the session bridge.
 */

import { BrowserWindow, nativeTheme } from "electron";
import { join } from "node:path";
import { hardenWindow } from "./window-security.js";

let artifact: BrowserWindow | null = null;

export function showArtifactWindow(artifactId: string): void {
	if (artifact && !artifact.isDestroyed()) {
		void artifact.loadFile(join(import.meta.dirname, "../renderer/index.html"), {
			query: { window: "artifact", id: artifactId },
		});
		artifact.show();
		artifact.focus();
		return;
	}
	artifact = new BrowserWindow({
		width: 900,
		height: 640,
		minWidth: 560,
		minHeight: 400,
		show: false,
		title: "Noishi — artefato",
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1820" : "#faf8fc",
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	hardenWindow(artifact);
	artifact.once("ready-to-show", () => artifact?.show());
	void artifact.loadFile(join(import.meta.dirname, "../renderer/index.html"), {
		query: { window: "artifact", id: artifactId },
	});
	artifact.on("closed", () => {
		artifact = null;
	});
}
