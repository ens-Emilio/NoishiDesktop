/**
 * User preferences: one JSON file in ~/.config/noishi/prefs.json.
 *
 * Everything the UI can tune lives here so it survives restarts: theme, zoom,
 * shortcuts, approval policy, budget guard, sandbox allowlist/limits, telemetry
 * opt-in. Reads are synchronous at boot; writes are debounced.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type { ApprovalRule, Shortcut } from "@noishi/rpc-bridge";

import type { ApprovalRule, Shortcut } from "@noishi/rpc-bridge";

export type Prefs = {
	theme: "dark" | "light" | "system";
	zoomLevel: number;
	chatFontSize: number;
	composerHeight: number;
	shortcuts: Shortcut[];
	approvalRules: ApprovalRule[];
	budget: { warnUsd: number | null; stopUsd: number | null };
	promptHistory: string[];
	savedPrompts: { id: string; title: string; body: string }[];
	sandbox: {
		allowlist: string[];
		maxCpu: number;
		maxMemoryMb: number;
		maxSeconds: number;
	};
	telemetry: { enabled: boolean; endpoint: string | null };
	lastUpdateCheck: number | null;
	trustedWorkspaces: string[];
};

export const DEFAULTS: Prefs = {
	theme: "system",
	zoomLevel: 0,
	chatFontSize: 16,
	composerHeight: 40,
	shortcuts: [
		{ action: "quick-window", accelerator: "CommandOrControl+Shift+Space" },
		{ action: "find", accelerator: "CommandOrControl+F" },
		{ action: "new-chat", accelerator: "CommandOrControl+N" },
	],
	approvalRules: [],
	budget: { warnUsd: null, stopUsd: null },
	promptHistory: [],
	savedPrompts: [],
	sandbox: { allowlist: [], maxCpu: 4, maxMemoryMb: 2048, maxSeconds: 300 },
	telemetry: { enabled: false, endpoint: null },
	lastUpdateCheck: null,
	trustedWorkspaces: [],
};

function configDir(): string {
	return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "noishi");
}

export function prefsPath(): string {
	return join(configDir(), "prefs.json");
}

let cache: Prefs | null = null;
let writeTimer: NodeJS.Timeout | undefined;

export function readPrefs(): Prefs {
	if (cache) return cache;
	const path = prefsPath();
	if (!existsSync(path)) {
		cache = structuredClone(DEFAULTS);
		return cache;
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<Prefs>;
		cache = {
			...structuredClone(DEFAULTS),
			...parsed,
			budget: { ...DEFAULTS.budget, ...(parsed.budget ?? {}) },
			sandbox: { ...DEFAULTS.sandbox, ...(parsed.sandbox ?? {}) },
			telemetry: { ...DEFAULTS.telemetry, ...(parsed.telemetry ?? {}) },
		};
	} catch {
		cache = structuredClone(DEFAULTS);
	}
	return cache;
}

export function flushPrefs(): void {
	clearTimeout(writeTimer);
	writeTimer = undefined;
	if (!cache) return;
	const path = prefsPath();
	mkdirSync(configDir(), { recursive: true });
	writeFileSync(path, JSON.stringify(cache, null, 2));
}

function flush(): void {
	flushPrefs();
}

export function writePrefs(patch: Partial<Prefs>): Prefs {
	const current = readPrefs();
	cache = {
		...current,
		...patch,
		budget: { ...current.budget, ...(patch.budget ?? {}) },
		sandbox: { ...current.sandbox, ...(patch.sandbox ?? {}) },
		telemetry: { ...current.telemetry, ...(patch.telemetry ?? {}) },
	};
	clearTimeout(writeTimer);
	writeTimer = setTimeout(flush, 120);
	return cache;
}

/** Push a prompt into the bounded history (most recent first, 100 entries). */
export function rememberPrompt(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return readPrefs().promptHistory;
	const current = readPrefs();
	const history = [trimmed, ...current.promptHistory.filter((entry) => entry !== trimmed)].slice(0, 100);
	writePrefs({ promptHistory: history });
	return history;
}
