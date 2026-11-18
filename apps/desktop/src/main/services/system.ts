/**
 * System services: update check, CLI version check, diagnostics, crash log.
 *
 * No auto-download: the app is distributed as AppImage/deb and an in-place
 * updater would need a signed feed. This checks a release endpoint and tells
 * the user where to get the new build — honest about what it does.
 */

import { app } from "electron";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCliWithVersion, type CliResolution } from "@noishi/noishi-sdk";
import { readPrefs, writePrefs } from "./prefs.js";
import type { CoworkService } from "./cowork-service.js";

const RELEASE_URL =
	process.env.NOISHI_RELEASE_URL ?? "https://api.github.com/repos/noishi/noishi-desktop/releases/latest";
const CRASH_LOG = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "noishi", "crash.log");

export type UpdateCheck = {
	current: string;
	latest: string | null;
	updateAvailable: boolean;
	url: string | null;
	checkedAt: number;
	error?: string;
};

/** Compare dotted numeric versions; non-numeric suffixes are ignored. */
function isNewer(current: string, latest: string): boolean {
	const a = current.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
	const b = latest.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const left = a[i] ?? 0;
		const right = b[i] ?? 0;
		if (right > left) return true;
		if (right < left) return false;
	}
	return false;
}

export async function checkForUpdates(currentVersion: string): Promise<UpdateCheck> {
	const checkedAt = Date.now();
	const fallback: UpdateCheck = {
		current: currentVersion,
		latest: null,
		updateAvailable: false,
		url: null,
		checkedAt,
	};
	try {
		const response = await fetch(RELEASE_URL, {
			headers: { accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) return { ...fallback, error: `HTTP ${response.status}` };
		const payload = (await response.json()) as { tag_name?: string; html_url?: string };
		const latest = payload.tag_name ?? null;
		writePrefs({ lastUpdateCheck: checkedAt });
		return {
			...fallback,
			latest,
			url: payload.html_url ?? null,
			updateAvailable: Boolean(latest && isNewer(currentVersion, latest)),
		};
	} catch (error) {
		return { ...fallback, error: error instanceof Error ? error.message : String(error) };
	}
}

export type CliCheck = {
	path: string | null;
	version: string | null;
	compatible: boolean;
	minimum: string;
	error?: string;
};

/**
 * The desktop needs a CLI new enough to speak this bridge. The bridge contract
 * (JSONL commands in packages/rpc-bridge) shipped with 0.1.0, so that is the
 * floor; bump it only when a command the UI depends on changes shape.
 */
export const MIN_CLI_VERSION = "0.1.0";

export async function checkCliVersion(): Promise<CliCheck> {
	const lowercase = (value: string): number[] => value.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
	try {
		const cli: CliResolution = await resolveCliWithVersion();
		const version = cli.version ?? null;
		let compatible = false;
		if (version) {
			const actual = lowercase(version);
			const required = lowercase(MIN_CLI_VERSION);
			for (let i = 0; i < required.length; i++) {
				const a = actual[i] ?? 0;
				const r = required[i] ?? 0;
				if (a > r) {
					compatible = true;
					break;
				}
				if (a < r) break;
				if (i === required.length - 1) compatible = true;
			}
		}
		return { path: cli.command ?? null, version, compatible, minimum: MIN_CLI_VERSION };
	} catch (error) {
		return {
			path: null,
			version: null,
			compatible: false,
			minimum: MIN_CLI_VERSION,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export type DiagnosticItem = { name: string; ok: boolean; detail: string };

function which(binary: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (dir && existsSync(join(dir, binary))) return join(dir, binary);
	}
	return null;
}

/** Everything the setup can get wrong, in one list, with the fix. */
export async function runDiagnostics(cowork: CoworkService): Promise<{
	items: DiagnosticItem[];
	app: { version: string; electron: string; node: string; platform: string };
}> {
	const cli = await checkCliVersion();
	const sandbox = cowork.assetStatus();
	const prefs = readPrefs();
	const items: DiagnosticItem[] = [
		{ name: "CLI noishi", ok: Boolean(cli.path), detail: cli.path ? `${cli.path} (${cli.version ?? "?"})` : "não encontrado — defina NOISHI_CLI_ROOT ou instale em ~/.noishi/bin" },
		{ name: "CLI compatível", ok: cli.compatible, detail: cli.compatible ? `>= ${cli.minimum}` : `precisa >= ${cli.minimum}, encontrado ${cli.version ?? "?"}` },
		{ name: "qemu-system-x86_64", ok: sandbox.qemu, detail: sandbox.qemu ? "ok" : "instale qemu-desktop / qemu-system-x86" },
		{ name: "virtiofsd", ok: sandbox.virtiofsd, detail: sandbox.virtiofsd ? "ok" : "instale virtiofsd" },
		{ name: "socat", ok: which("socat") !== null, detail: which("socat") ?? "instale socat" },
		{ name: "Assets do sandbox", ok: sandbox.ready, detail: sandbox.ready ? sandbox.dir : `coloque alpine-virt.iso + iso-extract/boot/ em ${sandbox.dir}` },
		{ name: "git", ok: which("git") !== null, detail: which("git") ?? "instale git (painel e diffs)" },
		{ name: "Editor ($EDITOR)", ok: Boolean(process.env.EDITOR ?? process.env.VISUAL), detail: process.env.EDITOR ?? process.env.VISUAL ?? "usa xdg-open" },
		{ name: "libayatana-appindicator", ok: existsSync("/usr/lib/libayatana-appindicator3.so.1") || existsSync("/usr/lib/x86_64-linux-gnu/libayatana-appindicator3.so.1"), detail: "necessário para o tray (SNI)" },
		{ name: "gjs", ok: which("gjs") !== null, detail: which("gjs") ?? "necessário para o search provider do GNOME" },
		{ name: "Telemetria", ok: true, detail: prefs.telemetry.enabled ? "ativa (opt-in)" : "desligada" },
	];
	return {
		items,
		app: {
			version: app.getVersion(),
			electron: process.versions.electron ?? "?",
			node: process.versions.node ?? "?",
			platform: `${process.platform} ${process.arch}`,
		},
	};
}

/* ---------- crash log ---------- */

export function crashLogPath(): string {
	return CRASH_LOG;
}

/**
 * Append a crash entry. Local only: nothing leaves the machine unless the user
 * opted into telemetry, and then only the message, never file contents.
 */
export function recordCrash(message: string, stack?: string): void {
	try {
		mkdirSync(dirname(CRASH_LOG), { recursive: true });
		const entry = JSON.stringify({ at: new Date().toISOString(), message, stack: stack ?? null }) + "\n";
		appendFileSync(CRASH_LOG, entry);
		reportToTelemetry(message, stack);
	} catch {
		// A crash log that itself crashes must stay silent.
	}
}

function reportToTelemetry(message: string, stack?: string): void {
	const prefs = readPrefs();
	if (!prefs.telemetry.enabled || !prefs.telemetry.endpoint) return;
	fetch(prefs.telemetry.endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ kind: "crash", message, stack, version: app.getVersion() }),
		signal: AbortSignal.timeout(5000),
	}).catch(() => undefined);
}

/** Last N crash lines, for the diagnostics panel. */
export function recentCrashes(limit = 20): string[] {
	if (!existsSync(CRASH_LOG)) return [];
	return readFileSync(CRASH_LOG, "utf-8").trim().split("\n").filter(Boolean).slice(-limit);
}

/** Version string used in telemetry and the About window. */
export function runtimeVersions(): { electron: string; node: string; chrome: string } {
	return {
		electron: process.versions.electron ?? "?",
		node: process.versions.node ?? "?",
		chrome: process.versions.chrome ?? "?",
	};
}

/** Timeout helper used by the update/telemetry fetches. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

/** exe path used by the .desktop exec line in dev runs. */
export function appExecutable(): string {
	return process.execPath;
}
