/**
 * Noishi Desktop main process entry.
 *
 * Owns: window lifecycle, the session host (RpcClient per session), the IPC
 * router, and later: cowork VM, MCP registry.
 */

import { app, BrowserWindow, ipcMain, Menu, nativeTheme, Notification } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	CHANNELS,
	type AgentEvent,
	type DesktopEnv,
	type ExtensionUiRequest,
	type ExtensionUiResponse,
	type SessionCommand,
	type SessionCommandResult,
} from "@noishi/rpc-bridge";
import { resolveCli, resolveCliWithVersion, type CliResolution } from "@noishi/noishi-sdk";
import { SessionHost } from "./services/session-host.js";
import { registerDeepLinks, type DeepLinkRoute } from "./services/deep-link.js";
import { createTray, minimizeToTrayEnabled, setTrayBadge, trayStatus } from "./services/tray.js";
import { installNativeManifests, sharePrompt, startNativeHost } from "./services/native-host.js";
import { createTerminal, disposeAll as disposeTerminals, disposeTerminal, resizeTerminal, writeTerminal } from "./services/terminal.js";
import { acceleratorFor, refreshShortcuts, registerQuickWindow, setQuickQuitting, toggleQuickWindow, warmQuickWindow } from "./services/quick-window.js";
import { CoworkService } from "./services/cowork-service.js";
import { BuddyWindow } from "./services/buddy-window.js";
import { installPackage, listInstalled, removePackage, setServerEnabled } from "./services/mcp-registry.js";
import { showAboutWindow } from "./services/about-window.js";
import { showArtifactWindow } from "./services/artifact-window.js";
import { installSearchProvider } from "./services/search-provider.js";
import { installFileAssociations, packageFromArgv } from "./services/file-associations.js";
import { findInPage, openFindBar, wireFindInPage } from "./services/find-in-page.js";
import { createDesktopCommands } from "./services/desktop-commands.js";
import { exportPdf } from "./services/pdf.js";
import { flushPrefs, readPrefs } from "./services/prefs.js";
import { shutdownAllProcesses } from "./services/process-supervisor.js";
import { appliedTokens, applyThemeToAll } from "./services/themes.js";
import { hardenWindow } from "./services/window-security.js";

app.setName("noishi-desktop");

let isQuitting = false;
let shutdownStarted = false;

function resolveAppVersion(): string {
	const v = app.getVersion();
	if (v && v !== "0.0" && v !== "0.0.0") return v;
	try {
		const pkgPath = join(import.meta.dirname, "../../package.json");
		if (existsSync(pkgPath)) {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
			if (pkg.version) return pkg.version;
		}
	} catch {
		// fall through
	}
	return v || "0.1.0";
}

let mainWindow: BrowserWindow | null = null;
let stopNativeHost: (() => void) | null = null;
let sessionHost: SessionHost | null = null;
const cowork = new CoworkService();
const desktopCommand = createDesktopCommands(cowork, {
	setZoom: (level) => {
		for (const win of BrowserWindow.getAllWindows()) {
			if (!win.isDestroyed()) win.webContents.setZoomLevel(level);
		}
	},
	getZoom: () => {
		const win = mainWindow;
		return win && !win.isDestroyed() ? win.webContents.getZoomLevel() : readPrefs().zoomLevel;
	},
	trayBadge: (count) => setTrayBadge(count),
	applyTheme: (name) => applyThemeToAll(name),
	exportPdf: (html, target) => exportPdf(html, target),
	refreshShortcuts: () => refreshShortcuts(),
	windowControl: (action) => {
		const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
		if (!win || win.isDestroyed()) return;
		if (action === "minimize") win.minimize();
		else if (action === "maximize") {
			if (win.isMaximized()) win.unmaximize();
			else win.maximize();
		} else win.close();
	},
	windowState: () => {
		const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
		return { maximized: Boolean(win && !win.isDestroyed() && win.isMaximized()), fullscreen: Boolean(win && !win.isDestroyed() && win.isFullScreen()) };
	},
});
const buddy = new BuddyWindow();
let cli: CliResolution = resolveCli();

function cliDisplay(resolution: CliResolution): string | null {
	if (resolution.source === "none") return null;
	return `${resolution.command} ${resolution.args.join(" ")}`.trim();
}

function createMainWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 720,
		minHeight: 480,
		title: "Noishi",
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1820" : "#faf8fc",
		show: false,
		// Sem moldura do SO: a barra de título é a nossa, com a mesma altura e
		// densidade do resto da UI. `titleBarStyle: hidden` mantém os botões de
		// janela do sistema (Linux/macOS) e deixa a faixa arrastável por CSS.
		// Moldura do SO sai; os botões passam a ser nossos (ver .window-controls).
		frame: false,
		titleBarStyle: "hidden",
		// No Linux `titleBarStyle` não existe: com frame:false precisamos dos
		// botões próprios, senão não há como fechar a janela.
		thickFrame: true,
		// A faixa superior é arrastável; os controles dentro dela não são.
		trafficLightPosition: { x: 14, y: 15 },
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	win.once("ready-to-show", () => {
		console.log("[noishi-desktop] ready-to-show fired");
		win.show();
	});
	win.webContents.on("did-fail-load", (_e, code, desc) => console.error("[noishi-desktop] did-fail-load", code, desc));
	win.webContents.on("did-finish-load", () => console.log("[noishi-desktop] renderer did-finish-load"));
	win.webContents.on("console-message", (_e, level, message, line, sourceId) =>
		console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`),
	);
	const windowId = win.webContents.id;
	win.on("closed", () => {
		disposeTerminal(windowId);
		console.log("[noishi-desktop] main window closed");
	});
	// With a tray, closing hides the window; without one it quits (otherwise the
	// user would have no way back). --minimize-to-tray=false forces quitting.
	win.on("close", (event) => {
		if (isQuitting || !minimizeToTrayEnabled()) return;
		event.preventDefault();
		win.hide();
	});
	hardenWindow(win);
	win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
	return win;
}

function wireSessionEvents(win: BrowserWindow): void {
	win.webContents.on("did-finish-load", () => {
		const host = sessionHost;
		if (!host) {
			console.error("[noishi-desktop] session host not ready at renderer load");
			return;
		}
		host.subscribe(
			win.webContents.id,
			(event: AgentEvent) => {
				win.webContents.send(CHANNELS.sessionEvent, event);
				// Native notification when a turn settles while the window is hidden.
				if ((event.type === "agent_settled" || event.type === "agent_end") && !win.isVisible()) {
					new Notification({ title: "Noishi", body: "Resposta concluída." }).show();
				}
			},
			(request: ExtensionUiRequest) => {
				win.webContents.send(CHANNELS.extensionUiRequest, request);
				if (request.method === "notify" && !win.isVisible()) {
					new Notification({ title: "Noishi", body: request.message ?? "" }).show();
				}
			},
		);
	});
}

async function init(): Promise<void> {
	console.log("[noishi-desktop] init starting");
	const singleLock = app.requestSingleInstanceLock();
	if (!singleLock) {
		app.quit();
		return;
	}

	// Session host exists before any window or IPC can touch it.
	cli = await resolveCliWithVersion();
	sessionHost = new SessionHost(cli);

	const currentTheme = (): "dark" | "light" => (nativeTheme.shouldUseDarkColors ? "dark" : "light");

	const env = (): DesktopEnv => ({
		appVersion: resolveAppVersion(),
		platform: process.platform,
		theme: currentTheme(),
		cliPath: cliDisplay(cli),
		cliVersion: cli.version,
	});

	ipcMain.handle(CHANNELS.getEnv, env);
	ipcMain.handle(CHANNELS.getTheme, currentTheme);

	// Follow the OS theme live: every window repaints its background and the
	// renderer flips data-theme.
	nativeTheme.on("updated", () => {
		const theme = currentTheme();
		for (const win of BrowserWindow.getAllWindows()) {
			if (win.isDestroyed()) continue;
			win.setBackgroundColor(theme === "dark" ? "#1a1820" : "#faf8fc");
			win.webContents.send(CHANNELS.themeChanged, theme);
		}
	});

	const handleRoute = async (route: DeepLinkRoute): Promise<void> => {
		switch (route.kind) {
			case "chat/new":
				await sessionHost?.runCommand({ type: "newSession" });
				break;
			case "code/new":
				await sessionHost?.runCommand({ type: "startIn", cwd: route.cwd ?? process.env.HOME ?? "/" });
				break;
			case "code/continue": {
				const newest = await import("./services/session-files.js").then((m) => m.newestSessionFile());
				if (newest) await sessionHost?.runCommand({ type: "switchSession", sessionPath: newest });
				break;
			}
			case "buddy": {
				const cwd = route.cwd ?? process.env.HOME ?? "/";
				if (sessionHost) buddy.open(cwd, () => new SessionHost(cli, cwd));
				return; // buddy window is its own surface; don't focus main
			}
			case "cowork/shared-artifact":
				showArtifactWindow(route.artifactId ?? "");
				return;
			case "code/needs-input":
				// The session is paused waiting for an answer: surface it in the
				// renderer so the banner appears, then focus the window.
				break;
		}
		mainWindow?.webContents.send("noishi:deep-link", route);
		mainWindow?.show();
	};

	app.on("second-instance", (_event, argv) => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
		registerDeepLinks.handleSecondInstance(argv);
		const arg = argv.find((a) => a.startsWith("noishi://"));
		if (arg) {
			const route = registerDeepLinks.parse(arg);
			if (route) void handleRoute(route);
		}
		const pkg = packageFromArgv(argv);
		if (pkg) void installPackageFromPath(pkg);
	});

	registerDeepLinks.install();

	// Browser extension bridge: page shares become a prompt in the main window.
	// Packaged: extraFiles land beside the executable (app root), not in resources/.
	const hostDir = app.isPackaged
		? join(dirname(process.resourcesPath), "native-host")
		: join(import.meta.dirname, "../../native-host");
	installNativeManifests(hostDir);
	stopNativeHost = startNativeHost((share) => {
		void handleRoute({ kind: "chat/share", prompt: sharePrompt(share) });
	});
	installSearchProvider();
	installFileAssociations();
	// Sandbox lifecycle and task events fan out to every open window.
	cowork.onEvent((sandboxEvent) => {
		for (const win of BrowserWindow.getAllWindows()) {
			if (win.isDestroyed()) continue;
			win.webContents.send(CHANNELS.sandboxEvent, sandboxEvent);
		}
	});

	/** Install a package dropped on the app (file association / argv). */
	const installPackageFromPath = async (path: string): Promise<void> => {
		try {
			const result = await installPackage(path);
			mainWindow?.webContents.send(CHANNELS.sandboxEvent, {
				type: "package-installed",
				detail: `${result.kind}: ${result.name}`,
			});
		} catch (error) {
			mainWindow?.webContents.send(CHANNELS.sandboxEvent, {
				type: "package-error",
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	};
	ipcMain.handle(CHANNELS.sessionCommand, async (event, command: SessionCommand): Promise<SessionCommandResult> => {
		// Buddy windows own their session: route by sender webContents id.
		const buddyHost = [...buddy.hosts()].find((h) => h.hasSubscriber(event.sender.id));
		if (buddyHost) return buddyHost.runCommand(command);
		// Desktop-owned commands (prefs, files, git, checkpoints, system) never
		// touch the agent session; the router answers them or returns null.
		const desktopResult = await desktopCommand(command);
		if (desktopResult) return desktopResult;
		if (command.type === "sandboxBoot") {
			try {
				await cowork.boot();
				return { ok: true, data: cowork.status() };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		if (command.type === "sandboxExec") {
			try {
				const output = await cowork.exec(command.command, { cwd: command.cwd });
				return { ok: true, data: { output } };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		if (command.type === "sandboxStatus") {
			return { ok: true, data: cowork.status() };
		}
		if (command.type === "sandboxTask") {
			try {
				const task = cowork.runTask(command.command, { cwd: command.cwd, name: command.name });
				return { ok: true, data: task };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		if (command.type === "sandboxArtifact") {
			const body = cowork.readArtifact(command.artifactId);
			return body === null ? { ok: false, error: "artifact not found" } : { ok: true, data: { body } };
		}
		if (command.type === "sandboxAllowlist") {
			cowork.setAllowlist(command.domains);
			return { ok: true, data: cowork.status() };
		}
		if (command.type === "sandboxShutdown") {
			await cowork.shutdown();
			return { ok: true, data: cowork.status() };
		}
		if (command.type === "installPackage") {
			try {
				const result = await installPackage(command.path);
				return { ok: true, data: result };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		if (command.type === "listInstalled") {
			return { ok: true, data: await listInstalled() };
		}
		if (command.type === "setServerEnabled") {
			try {
				return { ok: true, data: await setServerEnabled(command.name, command.enabled) };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		if (command.type === "removePackage") {
			try {
				return { ok: true, data: await removePackage(command.kind, command.name) };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		const host = sessionHost;
		if (!host) return { ok: false, error: "session host not ready" };
		const result = await host.runCommand(command);
		if (!result.ok) console.log("[noishi-desktop] command failed:", command.type, result.error);
		return result;
	});

	ipcMain.handle(CHANNELS.ptyCreate, (event, payload: { cwd: string; cols: number; rows: number }) =>
		createTerminal(event.sender, payload.cwd, payload.cols, payload.rows),
	);
	ipcMain.on(CHANNELS.ptyWrite, (event, data: string) => writeTerminal(event.sender.id, data));
	ipcMain.on(CHANNELS.ptyResize, (event, payload: { cols: number; rows: number }) =>
		resizeTerminal(event.sender.id, payload.cols, payload.rows),
	);

	ipcMain.on(CHANNELS.extensionUiResponse, (event, response: ExtensionUiResponse) => {
		if (buddy.answerExtensionUi(event.sender.id, response)) return;
		sessionHost?.answerExtensionUi(response);
	});
	ipcMain.on(CHANNELS.openMain, () => {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();
	});
	ipcMain.on(CHANNELS.findQuery, (event, payload: { text: string; forward: boolean }) => {
		findInPage(event.sender, payload.text, payload.forward);
	});

	// Interactive shell inside the sandbox VM (feature 41): one serial session
	// per window, streamed back on the tty channel.
	const ttys = new Map<number, { write(data: string): void; close(): void }>();
	ipcMain.handle(CHANNELS.sandboxTtyOpen, async (event) => {
		try {
			ttys.get(event.sender.id)?.close();
			const tty = cowork.openTty((chunk) => {
				if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.sandboxTtyData, { data: chunk });
			});
			ttys.set(event.sender.id, tty);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.on(CHANNELS.sandboxTtyWrite, (event, data: string) => ttys.get(event.sender.id)?.write(data));
	ipcMain.on(CHANNELS.sandboxTtyClose, (event) => {
		ttys.get(event.sender.id)?.close();
		ttys.delete(event.sender.id);
	});

	app.whenReady().then(() => {
		console.log("[noishi-desktop] app ready; creating window");
		const win = createMainWindow();
		mainWindow = win;
		wireSessionEvents(win);
		wireFindInPage(win);
		// Persisted zoom and custom theme tokens (features 46, 47).
		const prefs = readPrefs();
		if (prefs.zoomLevel) win.webContents.setZoomLevel(prefs.zoomLevel);
		win.webContents.on("did-finish-load", () => {
			win.webContents.send(CHANNELS.themeTokens, appliedTokens());
		});
		registerQuickWindow(toggleQuickWindow);
		warmQuickWindow();
		createTray({
			show: () => {
				mainWindow?.show();
				mainWindow?.focus();
			},
			toggleMain: () => {
				if (!mainWindow || mainWindow.isDestroyed()) return;
				if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
				else {
					mainWindow.show();
					mainWindow.focus();
				}
			},
			newChat: () => {
				void handleRoute({ kind: "chat/new" });
			},
			newCode: () => {
				void handleRoute({ kind: "code/new", cwd: process.env.HOME ?? "/" });
			},
			openBuddy: () => {
				void handleRoute({ kind: "buddy", cwd: process.env.HOME ?? "/" });
			},
			quick: () => toggleQuickWindow(),
			about: () => showAboutWindow({ tray: trayStatus() }),
		});
		// Application menu with About (also fixes Alt menu on Linux)
		const menu = Menu.buildFromTemplate([
			{
				label: "Noishi",
				submenu: [
					{ label: "Sobre o Noishi", click: () => showAboutWindow({ tray: trayStatus() }) },
					{ type: "separator" },
					{ role: "quit", label: "Sair" },
				],
			},
			{
				label: "Editar",
				submenu: [
					{ role: "undo", label: "Desfazer" },
					{ role: "redo", label: "Refazer" },
					{ type: "separator" },
					{ role: "cut", label: "Recortar" },
					{ role: "copy", label: "Copiar" },
					{ role: "paste", label: "Colar" },
					{ role: "selectAll", label: "Selecionar tudo" },
					{ type: "separator" },
					{ label: "Localizar…", accelerator: acceleratorFor("find", "CommandOrControl+F"), click: () => openFindBar() },
				],
			},
			{ role: "viewMenu", label: "Ver" },
		]);
		Menu.setApplicationMenu(menu);
		const startupRoute = registerDeepLinks.drain();
		if (startupRoute) void handleRoute(startupRoute);
		const startupPackage = packageFromArgv(process.argv);
		if (startupPackage) void installPackageFromPath(startupPackage);
	});

	app.on("window-all-closed", () => {
		if (process.platform === "darwin") return;
		app.quit();
	});

	app.on("before-quit", (event) => {
		isQuitting = true;
		setQuickQuitting(true);
		flushPrefs();
		if (shutdownStarted) return;
		shutdownStarted = true;
		event.preventDefault();
		void Promise.race([
			Promise.all([
				sessionHost?.disposeAll() ?? Promise.resolve(),
				buddy.disposeAll(),
				cowork.shutdown(),
				Promise.resolve(disposeTerminals()),
				Promise.resolve(stopNativeHost?.()),
			]).then(() => shutdownAllProcesses()),
			new Promise<void>((resolve) => setTimeout(resolve, 4000)),
		]).finally(() => {
			stopNativeHost = null;
			app.exit(0);
		});
	});
}

init();
