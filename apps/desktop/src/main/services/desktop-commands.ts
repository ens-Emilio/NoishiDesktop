/**
 * Desktop command router: everything the renderer asks for that is NOT an
 * agent-session RPC. Sessions stay in session-host; this module owns the
 * desktop's own surface (prefs, files, git, review, checkpoints, prompts,
 * sandbox, system).
 *
 * Returns `null` when the command belongs to the session host, so the caller
 * can fall through without a giant if/else in index.ts.
 */

import { readFileSync } from "node:fs";
import { app, shell } from "electron";
import type { ApprovalRule, SessionCommand, SessionCommandResult, Shortcut } from "@noishi/rpc-bridge";
import { listFolderIndex, searchSessions, setSessionFolder } from "./session-index.js";
import * as git from "./git.js";
import * as checkpoints from "./checkpoints.js";
import * as review from "./review.js";
import * as insights from "./session-insights.js";
import { listFiles, openInEditor, readTree, searchFiles } from "./workspace.js";
import { readPrefs, rememberPrompt, writePrefs } from "./prefs.js";
import * as secrets from "./secrets.js";
import { checkCliVersion, checkForUpdates, crashLogPath, recentCrashes, recordCrash, runDiagnostics } from "./system.js";
import { deleteTheme, listThemes, saveTheme } from "./themes.js";
import { transcribe } from "./voice.js";
import { isSafeExternalUrl } from "./window-security.js";
import type { CoworkService } from "./cowork-service.js";

type Handler = (command: Record<string, unknown>) => Promise<SessionCommandResult> | SessionCommandResult;

/** Electron-side effects the router cannot own (windows, tray, zoom). */
export type DesktopHooks = {
	setZoom(level: number): void;
	getZoom(): number;
	trayBadge(count: number): void;
	applyTheme(name: string): void;
	/** Render HTML to a PDF file (Electron's printToPDF) and return its path. */
	exportPdf(html: string, target: string): Promise<{ path: string; bytes: number }>;
	/** Re-register global shortcuts after a rebind (feature 45). */
	refreshShortcuts(): void;
	/** Controles da janela sem moldura: minimizar, maximizar/restaurar, fechar. */
	windowControl(action: "minimize" | "maximize" | "close"): void;
	/** Estado atual, para o botão de maximizar desenhar o ícone certo. */
	windowState(): { maximized: boolean; fullscreen: boolean };
};

function ok(data: unknown): SessionCommandResult {
	return { ok: true, data };
}

function fail(error: unknown): SessionCommandResult {
	return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export function createDesktopCommands(
	cowork: CoworkService,
	hooks: DesktopHooks,
): (command: SessionCommand) => Promise<SessionCommandResult> | null {
	const handlers: Record<string, Handler> = {
		/* ---------- preferences ---------- */
		getPrefs: () => ok(readPrefs()),
		setPrefs: (command) => {
			const patch = command.patch;
			return ok(writePrefs(typeof patch === "object" && patch !== null ? (patch as Record<string, never>) : {}));
		},

		/* ---------- workspace / files ---------- */
		readTree: async (command) => ok(await readTree(str(command.root), num(command.maxDepth, 3))),
		searchFiles: async (command) => ok(await searchFiles(str(command.root), str(command.query))),
		openFile: (command) => {
			openInEditor(str(command.path));
			return ok(true);
		},
		listFiles: async (command) => ok(await listFiles(str(command.root))),
		searchSessions: async (command) => ok(await searchSessions(str(command.query))),
		setSessionFolder: async (command) => {
			await setSessionFolder(
				str(command.sessionPath),
				typeof command.folder === "string" ? command.folder : null,
				strings(command.tags),
			);
			return ok(true);
		},
		listFolders: async () => ok(await listFolderIndex()),

		/* ---------- git ---------- */
		gitStatus: async (command) => ok(await git.status(str(command.cwd))),
		gitDiff: async (command) => ok(await git.diffFile(str(command.cwd), str(command.path), Boolean(command.staged))),
		gitStage: async (command) => ok(await git.stage(str(command.cwd), strings(command.paths))),
		gitUnstage: async (command) => ok(await git.unstage(str(command.cwd), strings(command.paths))),
		gitDiscard: async (command) => ok(await git.discard(str(command.cwd), str(command.path))),
		gitCommit: async (command) =>
			ok(await git.commit(str(command.cwd), str(command.message), strings(command.paths).length ? strings(command.paths) : undefined)),
		gitWorktrees: async (command) => ok(await git.listWorktrees(str(command.cwd))),
		gitAddWorktree: async (command) =>
			ok(await git.addWorktree(str(command.cwd), str(command.path), str(command.branch), Boolean(command.createBranch))),
		gitBlame: async (command) => ok(await git.blame(str(command.cwd), str(command.path))),
		gitConflicts: async (command) => ok(await git.readConflict(str(command.cwd), str(command.path))),
		gitResolveConflict: async (command) =>
			ok(await git.resolveConflict(str(command.cwd), str(command.path), command.choice === "theirs" ? "theirs" : "ours")),
		/** Commit only the files this session touched (feature 16). */
		gitCommitSession: async (command) => {
			const cwd = str(command.cwd);
			const sessionId = str(command.sessionId);
			const paths = checkpoints.sessionChanges(sessionId).map((change) => change.path);
			if (paths.length === 0) return ok({ ok: false, error: "a sessão não alterou arquivos" });
			return ok(await git.commit(cwd, str(command.message), paths));
		},
		/** Isolated checkout for a session (feature 17). */
		gitWorktreeForSession: async (command) => {
			const cwd = str(command.cwd);
			const sessionId = str(command.sessionId);
			const branch = `noishi/${sessionId.slice(0, 8)}`;
			const target = `${cwd}/../${cwd.split("/").pop() ?? "repo"}-${sessionId.slice(0, 8)}`;
			return ok(await git.addWorktree(cwd, target, branch, true));
		},

		/* ---------- review / diff ---------- */
		applyDiff: (command) => ok(review.applyPatch(str(command.cwd), str(command.path), str(command.patch))),
		sessionDiff: (command) => ok(review.sessionDiff(str(command.sessionId))),
		getApprovalRules: () => ok(readPrefs().approvalRules),
		setApprovalRules: (command) => {
			const rules = (Array.isArray(command.rules) ? command.rules : []) as ApprovalRule[];
			return ok(writePrefs({ approvalRules: rules }).approvalRules);
		},

		/* ---------- checkpoints ---------- */
		snapshotFile: (command) => {
			checkpoints.snapshotFile(str(command.sessionId), str(command.entryId), str(command.path));
			return ok(true);
		},
		revertFile: (command) => ok(checkpoints.revertFile(str(command.sessionId), str(command.entryId), str(command.path))),
		rewindTo: (command) => ok(checkpoints.rewindTo(str(command.sessionId), str(command.entryId))),
		sessionChanges: (command) => ok(checkpoints.sessionChanges(str(command.sessionId))),
		listCheckpoints: (command) => ok(checkpoints.listCheckpoints(str(command.sessionId))),

		/* ---------- prompts ---------- */
		rememberPrompt: (command) => ok(rememberPrompt(str(command.text))),
		savePrompt: (command) => {
			const prefs = readPrefs();
			const id = `p${Date.now().toString(36)}`;
			const saved = [...prefs.savedPrompts, { id, title: str(command.title, "Prompt"), body: str(command.body) }];
			return ok(writePrefs({ savedPrompts: saved }).savedPrompts);
		},
		deletePrompt: (command) => {
			const prefs = readPrefs();
			return ok(writePrefs({ savedPrompts: prefs.savedPrompts.filter((p) => p.id !== str(command.id)) }).savedPrompts);
		},

		/* ---------- context / cost / portability ---------- */
		sessionCost: (command) => ok(insights.sessionCost(str(command.sessionPath))),
		contextBreakdown: (command) => ok(insights.contextBreakdown(str(command.sessionPath), num(command.contextWindow, 0))),
		exportMarkdown: (command) => ok(insights.exportMarkdown(str(command.sessionPath), str(command.outputPath) || undefined)),
		exportPdf: async (command) => {
			const html = insights.sessionToHtml(str(command.sessionPath));
			const target = str(command.sessionPath).replace(/\.jsonl$/, ".pdf");
			return ok(await hooks.exportPdf(html, target));
		},
		portSession: (command) => ok(insights.portSession(str(command.sessionPath), str(command.cwd))),
		sessionTranscript: (command) => ok(insights.sessionTranscript(str(command.sessionPath))),

		/* ---------- sandbox ---------- */
		sandboxSetLimits: (command) => {
			const maxCpu = num(command.maxCpu, 4);
			const maxMemoryMb = num(command.maxMemoryMb, 2048);
			const maxSeconds = num(command.maxSeconds, 300);
			cowork.setLimits(maxCpu, maxMemoryMb, maxSeconds);
			const prefs = writePrefs({ sandbox: { ...readPrefs().sandbox, maxCpu, maxMemoryMb, maxSeconds } });
			return ok(prefs.sandbox);
		},
		sandboxWorkspaceDiff: async () => ok(await cowork.workspaceDiff()),
		sandboxSnapshot: async (command) => ok(await cowork.createSnapshot(str(command.name))),
		sandboxRestoreSnapshot: async (command) => ok(await cowork.restoreSnapshot(str(command.name))),
		sandboxListSnapshots: () => ok(cowork.listSnapshots()),
		sandboxSchedule: (command) => ok(cowork.schedule(str(command.command), num(command.everySeconds, 3600))),
		sandboxUnschedule: (command) => {
			cowork.unschedule(str(command.id));
			return ok(true);
		},
		sandboxAllowlist: (command) => {
			const domains = strings(command.domains);
			cowork.setAllowlist(domains);
			writePrefs({ sandbox: { ...readPrefs().sandbox, allowlist: domains } });
			return ok(cowork.status());
		},
		sandboxInstances: () => ok(cowork.instances()),
		sandboxSetActive: (command) => {
			cowork.setActive(str(command.id, "default"));
			return ok(cowork.status());
		},
		sandboxCreateInstance: (command) => ok(cowork.createInstance(str(command.name))),
		sandboxDestroyInstance: async (command) => ok(await cowork.destroyInstance(str(command.id))),
		sandboxProvision: async (command) => ok(await cowork.provision(strings(command.toolchain))),

		/* ---------- secrets vault ---------- */
		vaultStatus: () => ok({ available: secrets.isVaultAvailable(), keys: secrets.listSecretKeys() }),
		listSecrets: () => ok(secrets.listSecretKeys()),
		setSecret: (command) => {
			const key = str(command.key).trim();
			const value = str(command.value);
			if (!key) return fail("chave vazia");
			if (!secrets.setSecret(key, value)) return fail("cofre seguro do SO indisponível");
			return ok(secrets.listSecretKeys());
		},
		deleteSecret: (command) => ok(secrets.deleteSecret(str(command.key))),

		/* ---------- voice ---------- */
		transcribe: async (command) => ok(await transcribe(str(command.audioBase64), str(command.mime, "audio/webm"))),

		/* ---------- system ---------- */
		checkForUpdates: async () => ok(await checkForUpdates(app.getVersion())),
		cliVersionCheck: async () => ok(await checkCliVersion()),
		diagnostics: async () => ok(await runDiagnostics(cowork)),
		saveTheme: (command) => ok(saveTheme(str(command.name, "custom"), (command.theme ?? {}) as Record<string, string>)),
		listThemes: () => ok(listThemes()),
		deleteTheme: (command) => ok(deleteTheme(str(command.name))),
		importTheme: (command) => {
			const path = str(command.path);
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as { name?: string; tokens?: Record<string, string> };
			return ok(saveTheme(parsed.name ?? "importado", parsed.tokens ?? {}));
		},
		applyTheme: (command) => {
			hooks.applyTheme(str(command.name));
			return ok(true);
		},
		reportCrash: (command) => {
			recordCrash(str(command.message), typeof command.stack === "string" ? command.stack : undefined);
			return ok({ path: crashLogPath() });
		},
		recentCrashes: () => ok(recentCrashes()),
		setTelemetry: (command) => {
			const enabled = Boolean(command.enabled);
			const endpoint = typeof command.endpoint === "string" && command.endpoint ? command.endpoint : null;
			return ok(writePrefs({ telemetry: { enabled, endpoint } }).telemetry);
		},
		setZoom: (command) => {
			const level = Math.max(-3, Math.min(5, num(command.level, 0)));
			hooks.setZoom(level);
			return ok(writePrefs({ zoomLevel: level }).zoomLevel);
		},
		getZoom: () => ok(hooks.getZoom()),
		windowControl: (command) => {
			const action = str(command.action);
			if (action !== "minimize" && action !== "maximize" && action !== "close") return fail("ação inválida");
			hooks.windowControl(action);
			return ok(true);
		},
		windowState: () => ok(hooks.windowState()),
		setShortcuts: (command) => {
			const shortcuts = (Array.isArray(command.shortcuts) ? command.shortcuts : []) as Shortcut[];
			const saved = writePrefs({ shortcuts }).shortcuts;
			hooks.refreshShortcuts();
			return ok(saved);
		},
		trayBadge: (command) => {
			hooks.trayBadge(num(command.count, 0));
			return ok(true);
		},
		openExternal: (command) => {
			const url = str(command.url);
			if (!isSafeExternalUrl(url)) return fail(`URL bloqueada: esquema inválido (${url})`);
			void shell.openExternal(url);
			return ok(true);
		},
	};

	return (command) => {
		const raw = command as unknown as Record<string, unknown>;
		const type = typeof raw.type === "string" ? raw.type : "";
		const handler = handlers[type];
		if (!handler) return null;
		try {
			const result = handler(raw);
			return result instanceof Promise ? result : Promise.resolve(result);
		} catch (error) {
			return Promise.resolve(fail(error));
		}
	};
}
