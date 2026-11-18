/**
 * Themes: user-defined token overrides on top of the built-in dark/light.
 *
 * A theme is a flat map of CSS custom properties (`--accent`, `--bg-window`, …)
 * applied to `:root` after the base tokens. Stored as JSON files so a theme can
 * be shared by copying one file.
 */

import { BrowserWindow } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const THEMES_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "noishi", "themes");

export type Theme = { name: string; tokens: Record<string, string> };

function safeName(name: string): string {
	return name.replace(/[^\w-]/g, "_").slice(0, 60) || "custom";
}

export function listThemes(): Theme[] {
	if (!existsSync(THEMES_DIR)) return [];
	const themes: Theme[] = [];
	for (const file of readdirSync(THEMES_DIR)) {
		if (!file.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(readFileSync(join(THEMES_DIR, file), "utf-8")) as Theme;
			if (parsed && typeof parsed.tokens === "object") {
				themes.push({ name: parsed.name ?? file.replace(/\.json$/, ""), tokens: parsed.tokens });
			}
		} catch {
			// A malformed theme file is skipped, not fatal.
		}
	}
	return themes.sort((a, b) => a.name.localeCompare(b.name));
}

/** Only CSS custom properties are accepted: a theme cannot inject selectors. */
function sanitize(tokens: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(tokens)) {
		if (!/^--[a-z0-9-]+$/i.test(key)) continue;
		if (typeof value !== "string" || value.length > 200) continue;
		if (/[;{}<>]/.test(value)) continue;
		out[key] = value;
	}
	return out;
}

export function saveTheme(name: string, tokens: Record<string, string>): Theme {
	mkdirSync(THEMES_DIR, { recursive: true });
	const theme: Theme = { name: safeName(name), tokens: sanitize(tokens) };
	writeFileSync(join(THEMES_DIR, `${theme.name}.json`), JSON.stringify(theme, null, 2));
	return theme;
}

export function deleteTheme(name: string): boolean {
	const path = join(THEMES_DIR, `${safeName(name)}.json`);
	if (!existsSync(path)) return false;
	rmSync(path, { force: true });
	return true;
}

export function themesDir(): string {
	return THEMES_DIR;
}

/* ---------- applying a theme (feature 46) ---------- */

let applied: Record<string, string> = {};

/** Current custom-token overrides, so a re-apply can clear the previous set. */
export function appliedTokens(): Record<string, string> {
	return applied;
}

/**
 * Push a theme's tokens to every window: a `noishi:theme-tokens` message the
 * renderer paints onto :root. Selecting "none" clears the overrides.
 */
export function applyThemeToAll(name: string): void {
	applied = name === "none" ? {} : (listThemes().find((theme) => theme.name === name)?.tokens ?? {});
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.webContents.send("noishi:theme-tokens", applied);
	}
}
