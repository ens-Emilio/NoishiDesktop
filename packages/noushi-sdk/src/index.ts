/**
 * Resolve the noushi CLI binary for session spawning.
 *
 * Resolution order:
 *  1. NOUSHI_DESKTOP_CLI env override
 *  2. The NoushiCLI checkout (dev sibling repo), dist/cli.js run with node
 *  3. ~/.noushi/bin/noushi (npm link / installer layout)
 *  4. PATH
 *
 * Spawn shape: { command, args } - Electron's child_process.spawn can run
 * plain executables; a JS entry needs the node prefix.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

export type CliResolution = {
	command: string;
	args: string[];
	version: string | null;
	/** How the CLI was found, for the About window. */
	source: "env" | "checkout" | "install-dir" | "path" | "none";
};

const CHECKOUT_ROOT = process.env.NOUSHI_CLI_ROOT;

function fromCheckout(): CliResolution | null {
	const entry = CHECKOUT_ROOT
		? join(CHECKOUT_ROOT, "packages/coding-agent/dist/cli.js")
		: join(import.meta.dirname ?? process.cwd(), "..", "NoushiCLI", "packages/coding-agent/dist/cli.js");
	if (!existsSync(entry)) return null;
	// Inside Electron, process.execPath is the Electron binary; a JS entry needs the host node.
	const node = process.env.ELECTRON_RUN_AS_NODE ? process.execPath : "node";
	return { command: node, args: [entry], version: null, source: "checkout" };
}

function fromInstallDir(): CliResolution | null {
	for (const dir of [join(homedir(), ".noushi", "bin")]) {
		const bin = join(dir, "noushi");
		if (existsSync(bin)) return { command: bin, args: [], version: null, source: "install-dir" };
	}
	return null;
}

function fromPath(): CliResolution {
	return { command: "noushi", args: [], version: null, source: "path" };
}

export function resolveCli(): CliResolution {
	const envOverride = process.env.NOUSHI_DESKTOP_CLI;
	if (envOverride && existsSync(envOverride)) {
		const isJs = envOverride.endsWith(".js") || envOverride.endsWith(".mjs");
		return {
			command: isJs ? process.execPath : envOverride,
			args: isJs ? [envOverride] : [],
			version: null,
			source: "env",
		};
	}
	return fromCheckout() ?? fromInstallDir() ?? fromPath();
}

export function readVersion(resolution: CliResolution): Promise<string | null> {
	if (resolution.source === "none") return Promise.resolve(null);
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile(
		resolution.command,
		[...resolution.args, "--version"],
		{ timeout: 10_000 },
		(error, stdout) => resolve(error ? null : stdout.trim() || null),
	);
	return promise;
}

export async function resolveCliWithVersion(): Promise<CliResolution> {
	const resolution = resolveCli();
	resolution.version = await readVersion(resolution);
	return resolution;
}
