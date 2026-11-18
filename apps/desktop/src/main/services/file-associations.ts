/**
 * File associations for agent packages (.mcpb / .skill).
 *
 * The .deb ships a MIME XML + desktop entry MimeType, but a user-level install
 * (AppImage, dev run) has no package manager to register them. This writes the
 * same registration into the user's XDG dirs at boot so double-clicking a
 * package opens Noishi and installs it.
 *
 * Failure is non-fatal.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MIME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-noishi-package">
    <comment>Noishi agent package</comment>
    <glob pattern="*.mcpb"/>
    <glob pattern="*.skill"/>
    <glob pattern="*.dxt"/>
  </mime-type>
</mime-info>
`;

function dataHome(): string {
	return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/** Executable that should be launched for a package file. */
function execPath(): string {
	return process.execPath;
}

export function installFileAssociations(): void {
	const data = dataHome();
	const mimeDir = join(data, "mime", "packages");
	const appsDir = join(data, "applications");
	const mimeFile = join(mimeDir, "noishi-package.xml");
	const desktopFile = join(appsDir, "noishi-desktop.desktop");

	try {
		mkdirSync(mimeDir, { recursive: true });
		mkdirSync(appsDir, { recursive: true });
		writeFileSync(mimeFile, MIME_XML);

		// Only write the desktop entry when the packaged one is absent: a .deb
		// install already provides /usr/share/applications/noishi-desktop.desktop
		// and a user copy would shadow it with a dev path.
		if (!existsSync(desktopFile)) {
			writeFileSync(
				desktopFile,
				[
					"[Desktop Entry]",
					"Name=Noishi",
					`Exec=${execPath()} %U`,
					"Terminal=false",
					"Type=Application",
					"Icon=noishi-desktop",
					"StartupWMClass=com.noishi.desktop",
					"Comment=Noishi coding agent desktop",
					"MimeType=x-scheme-handler/noishi;application/x-noishi-package;",
					"Categories=Development;",
					"",
				].join("\n"),
			);
			chmodSync(desktopFile, 0o644);
		}
	} catch (error) {
		console.log(`[noishi-desktop] file associations: falhou — ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** True when the path looks like an agent package we can install. */
export function isPackagePath(path: string): boolean {
	return /\.(mcpb|skill|dxt)$/i.test(path);
}

/** First package path in an argv array, if any. */
export function packageFromArgv(argv: string[]): string | null {
	return argv.find((arg) => !arg.startsWith("-") && isPackagePath(arg)) ?? null;
}
