/**
 * MCP registry: installs .mcpb / .skill packages (zip bundles) into the
 * Noishi agent directory and keeps them registered.
 *
 * - .mcpb -> extracted to ~/.noishi/agent/mcp-servers/<name>/, manifest.json's
 *   server entry appended to ~/.noishi/agent/mcp.json (mcpServers).
 * - .skill -> extracted to ~/.noishi/agent/skills/<name>/ (SKILL.md at root).
 *
 * Validation: zip must contain a manifest.json (mcpb) or SKILL.md (skill).
 */

import { lstat, mkdir, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, isAbsolute } from "node:path";
import { resolveWithin, sanitizeSegment } from "./path-guard.js";

const AGENT_DIR = join(homedir(), ".noishi", "agent");
const MCP_SERVERS_DIR = join(AGENT_DIR, "mcp-servers");
const SKILLS_DIR = join(AGENT_DIR, "skills");
const MCP_JSON = join(AGENT_DIR, "mcp.json");

export type InstallResult = {
	kind: "mcpb" | "skill";
	name: string;
	installedPath: string;
	registered: boolean;
};

async function agentDirSetup(): Promise<void> {
	if (!existsSync(MCP_SERVERS_DIR)) await mkdir(MCP_SERVERS_DIR, { recursive: true });
	if (!existsSync(SKILLS_DIR)) await mkdir(SKILLS_DIR, { recursive: true });
}

export function registryDirs(): { mcpServers: string; skills: string; mcpJson: string } {
	return { mcpServers: MCP_SERVERS_DIR, skills: SKILLS_DIR, mcpJson: MCP_JSON };
}

async function assertNoSymlinkEscape(root: string, dir: string): Promise<void> {
	for (const entry of await readdir(dir)) {
		const full = join(dir, entry);
		const info = await lstat(full);
		if (info.isSymbolicLink()) {
			resolveWithin(root, full);
		} else if (info.isDirectory()) {
			await assertNoSymlinkEscape(root, full);
		}
	}
}

/** Extract a zip bundle using the host unzip binary after checking entries against zip-slip. */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
	const entries = await new Promise<string[]>((resolve, reject) => {
		execFile("unzip", ["-Z", "-1", zipPath], { timeout: 15_000 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`zip inspect failed: ${stderr.slice(0, 200)}`));
			else resolve(stdout.split("\n").filter(Boolean));
		});
	});
	if (entries.length > 2000) throw new Error("zip excede o limite de 2000 entradas");
	for (const entry of entries) {
		if (isAbsolute(entry) || entry.split("/").includes("..")) {
			throw new Error(`zip-slip bloqueado: ${entry}`);
		}
	}
	await mkdir(destDir, { recursive: true });
	await new Promise<void>((resolve, reject) => {
		execFile("unzip", ["-o", "-q", zipPath, "-d", destDir], { timeout: 30_000 }, (error, _stdout, stderr) => {
			if (error) reject(new Error(`unzip failed: ${stderr.slice(0, 200)}`));
			else resolve();
		});
	});
	await assertNoSymlinkEscape(destDir, destDir);
}

export async function installPackage(packagePath: string): Promise<InstallResult> {
	await agentDirSetup();
	const rawName = basename(packagePath).replace(/\.(mcpb|skill|dxt)$/i, "");
	const name = sanitizeSegment(rawName, "nome do pacote");
	const isSkill = /\.skill$/i.test(packagePath);
	const baseDir = isSkill ? SKILLS_DIR : MCP_SERVERS_DIR;
	const destDir = resolveWithin(baseDir, name);
	if (existsSync(destDir)) await rm(destDir, { recursive: true });
	await extractZip(packagePath, destDir);

	if (isSkill) {
		if (!existsSync(join(destDir, "SKILL.md"))) {
			await rm(destDir, { recursive: true });
			throw new Error("invalid .skill: SKILL.md not found at bundle root");
		}
		return { kind: "skill", name, installedPath: destDir, registered: true };
	}

	// mcpb: manifest.json at root (or one level deep — some bundles nest)
	const manifestPath = existsSync(join(destDir, "manifest.json"))
		? join(destDir, "manifest.json")
		: join(destDir, readdirSafe(destDir)[0] ?? "", "manifest.json");
	if (!existsSync(manifestPath)) {
		await rm(destDir, { recursive: true });
		throw new Error("invalid .mcpb: manifest.json not found");
	}

	const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
		name?: string;
		mcpServers?: Record<string, unknown>;
		server?: Record<string, unknown>;
	};
	const serverEntry = manifest.mcpServers ?? (manifest.server ? { [manifest.name ?? name]: manifest.server } : null);
	if (!serverEntry) {
		await rm(destDir, { recursive: true });
		throw new Error("invalid .mcpb: no mcpServers/server entry in manifest");
	}
	await registerMcpServers(serverEntry as Record<string, unknown>);
	return { kind: "mcpb", name, installedPath: destDir, registered: true };
}

function readdirSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

async function registerMcpServers(servers: Record<string, unknown>): Promise<void> {
	let config: { mcpServers?: Record<string, unknown> } = {};
	if (existsSync(MCP_JSON)) {
		config = JSON.parse(await readFile(MCP_JSON, "utf-8")) as { mcpServers?: Record<string, unknown> };
	}
	config.mcpServers = { ...(config.mcpServers ?? {}), ...servers };
	await writeFile(MCP_JSON, JSON.stringify(config, null, 2));
}

export type InstalledSummary = {
	skills: string[];
	mcpServers: string[];
	/** Names currently registered in ~/.noishi/agent/mcp.json. */
	enabledServers: string[];
};

type McpConfig = { mcpServers?: Record<string, unknown>; disabledMcpServers?: Record<string, unknown> };

async function readConfig(): Promise<McpConfig> {
	if (!existsSync(MCP_JSON)) return { mcpServers: {}, disabledMcpServers: {} };
	try {
		const parsed = JSON.parse(await readFile(MCP_JSON, "utf-8")) as McpConfig;
		return { mcpServers: parsed.mcpServers ?? {}, disabledMcpServers: parsed.disabledMcpServers ?? {} };
	} catch {
		return { mcpServers: {}, disabledMcpServers: {} };
	}
}

export async function listInstalled(): Promise<InstalledSummary> {
	const skills = existsSync(SKILLS_DIR) ? await readdir(SKILLS_DIR) : [];
	const mcpServers = existsSync(MCP_SERVERS_DIR) ? await readdir(MCP_SERVERS_DIR) : [];
	const config = await readConfig();
	return { skills, mcpServers, enabledServers: Object.keys(config.mcpServers ?? {}) };
}

/**
 * Enable or disable an MCP server. Disabling moves its entry from `mcpServers`
 * to `disabledMcpServers` — the files stay on disk, so re-enabling is instant
 * and no configuration is lost.
 */
export async function setServerEnabled(name: string, enabled: boolean): Promise<InstalledSummary> {
	const config = await readConfig();
	const active = config.mcpServers ?? {};
	const disabled = config.disabledMcpServers ?? {};
	if (enabled) {
		if (disabled[name] !== undefined) {
			active[name] = disabled[name];
			delete disabled[name];
		}
	} else if (active[name] !== undefined) {
		disabled[name] = active[name];
		delete active[name];
	}
	await writeFile(MCP_JSON, JSON.stringify({ ...config, mcpServers: active, disabledMcpServers: disabled }, null, 2));
	return listInstalled();
}

/** Remove an installed server or skill, including its config entry. */
export async function removePackage(kind: "skill" | "mcp", name: string): Promise<InstalledSummary> {
	const safeName = sanitizeSegment(name, "nome do pacote");
	const target = resolveWithin(kind === "skill" ? SKILLS_DIR : MCP_SERVERS_DIR, safeName);
	if (existsSync(target)) await rm(target, { recursive: true, force: true });
	if (kind === "mcp") {
		const config = await readConfig();
		const active = config.mcpServers ?? {};
		const disabled = config.disabledMcpServers ?? {};
		delete active[name];
		delete disabled[name];
		await writeFile(MCP_JSON, JSON.stringify({ ...config, mcpServers: active, disabledMcpServers: disabled }, null, 2));
	}
	return listInstalled();
}

/** Disabled server names, for the settings list. */
export async function listDisabledServers(): Promise<string[]> {
	const config = await readConfig();
	return Object.keys(config.disabledMcpServers ?? {});
}
