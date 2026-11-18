/**
 * GNOME Shell search provider installation.
 *
 * The provider is a gjs D-Bus service (org.gnome.Shell.SearchProvider2) plus a
 * .ini that tells gnome-shell which desktop entry it belongs to. Both live in
 * the app bundle (extraFiles -> search-provider/) and are copied into the
 * user's XDG dirs at boot, because gnome-shell only scans those paths.
 *
 * Failure is non-fatal: the app works without search integration.
 */

import { app } from "electron";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SERVICE_NAME = "com.noishi.SearchProvider";

function dataHome(): string {
	return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/** Where the bundled provider files live (dev checkout vs packaged app). */
function providerDir(): string {
	return app.isPackaged
		? join(dirname(process.resourcesPath), "search-provider")
		: join(import.meta.dirname, "../../build/search-provider");
}

export function installSearchProvider(): string | null {
	const source = providerDir();
	const dbusScript = join(source, "noishi-search-provider-dbus");
	const ini = join(source, "noishi-search-provider.ini");
	if (!existsSync(dbusScript) || !existsSync(ini)) {
		console.log(`[noishi-desktop] search provider: arquivos ausentes em ${source}`);
		return null;
	}

	const data = dataHome();
	const providerTarget = join(data, "gnome-shell", "search-providers", "noishi-search-provider.ini");
	const serviceTarget = join(data, "dbus-1", "services", `${SERVICE_NAME}.service`);
	const scriptTarget = join(data, "noishi", "search-provider", "noishi-search-provider-dbus");

	try {
		mkdirSync(dirname(providerTarget), { recursive: true });
		mkdirSync(dirname(serviceTarget), { recursive: true });
		mkdirSync(dirname(scriptTarget), { recursive: true });

		copyFileSync(dbusScript, scriptTarget);
		chmodSync(scriptTarget, 0o755);
		copyFileSync(ini, providerTarget);
		// The service file must point at the copy we just made, not the bundle.
		writeFileSync(
			serviceTarget,
			`[D-BUS Service]\nName=${SERVICE_NAME}\nExec=/usr/bin/gjs ${scriptTarget}\n`,
		);
		console.log(`[noishi-desktop] search provider instalado em ${providerTarget}`);
		return providerTarget;
	} catch (error) {
		console.log(`[noishi-desktop] search provider: falhou — ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}
