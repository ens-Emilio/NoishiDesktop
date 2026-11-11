/**
 * Noushi Desktop main process entry.
 *
 * Owns: window lifecycle, the session host (RpcClient per session), the IPC
 * router, and later: cowork VM, MCP registry.
 */

import { app, BrowserWindow, ipcMain, Notification } from "electron";
import { join } from "node:path";
import {
	CHANNELS,
	type AgentEvent,
	type DesktopEnv,
	type ExtensionUiRequest,
	type ExtensionUiResponse,
	type SessionCommand,
	type SessionCommandResult,
} from "@noushi/rpc-bridge";
import { resolveCli, resolveCliWithVersion, type CliResolution } from "@noushi/noushi-sdk";
import { SessionHost } from "./services/session-host.js";
import { registerDeepLinks, type DeepLinkRoute } from "./services/deep-link.js";
import { createTray } from "./services/tray.js";
import { registerQuickWindow, toggleQuickWindow } from "./services/quick-window.js";
import { CoworkService } from "./services/cowork-service.js";
import { installPackage, listInstalled } from "./services/mcp-registry.js";

app.setName("noushi-desktop");

let mainWindow: BrowserWindow | null = null;
let sessionHost: SessionHost | null = null;
const cowork = new CoworkService();
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
		title: "Noushi",
		backgroundColor: "#111318",
		show: false,
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	win.once("ready-to-show", () => {
		console.log("[noushi-desktop] ready-to-show fired");
		win.show();
	});
	win.webContents.on("did-fail-load", (_e, code, desc) => console.error("[noushi-desktop] did-fail-load", code, desc));
	win.webContents.on("did-finish-load", () => console.log("[noushi-desktop] renderer did-finish-load"));
	win.webContents.on("console-message", (_e, level, message, line, sourceId) =>
		console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`),
	);
	win.on("closed", () => console.log("[noushi-desktop] main window closed"));
	win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
	return win;
}

function wireSessionEvents(win: BrowserWindow): void {
	win.webContents.on("did-finish-load", () => {
		const host = sessionHost;
		if (!host) {
			console.error("[noushi-desktop] session host not ready at renderer load");
			return;
		}
		host.subscribe(
			win.webContents.id,
			(event: AgentEvent) => {
				win.webContents.send(CHANNELS.sessionEvent, event);
				// Native notification when a turn settles while the window is hidden.
				if ((event.type === "agent_settled" || event.type === "agent_end") && !win.isVisible()) {
					new Notification({ title: "Noushi", body: "Resposta concluída." }).show();
				}
			},
			(request: ExtensionUiRequest) => {
				win.webContents.send(CHANNELS.extensionUiRequest, request);
				if (request.method === "notify" && !win.isVisible()) {
					new Notification({ title: "Noushi", body: request.message ?? "" }).show();
				}
			},
		);
	});
}

async function init(): Promise<void> {
	console.log("[noushi-desktop] init starting");
	const singleLock = app.requestSingleInstanceLock();
	if (!singleLock) {
		app.quit();
		return;
	}

	// Session host exists before any window or IPC can touch it.
	cli = await resolveCliWithVersion();
	sessionHost = new SessionHost(cli);

	const env = (): DesktopEnv => ({
		appVersion: app.getVersion(),
		platform: process.platform,
		cliPath: cliDisplay(cli),
		cliVersion: cli.version,
	});

	ipcMain.handle(CHANNELS.getEnv, env);

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
			case "code/needs-input":
			case "cowork/shared-artifact":
				break;
		}
		mainWindow?.webContents.send("noushi:deep-link", route);
		mainWindow?.show();
	};

	app.on("second-instance", (_event, argv) => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
		registerDeepLinks.handleSecondInstance(argv);
		const arg = argv.find((a) => a.startsWith("noushi://"));
		if (arg) {
			const route = registerDeepLinks.parse(arg);
			if (route) void handleRoute(route);
		}
	});

	registerDeepLinks.install();

	ipcMain.handle(CHANNELS.sessionCommand, async (_event, command: SessionCommand): Promise<SessionCommandResult> => {
		if (command.type === "coworkBoot") {
			try {
				await cowork.boot();
				return { ok: true, data: { booted: true } };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		if (command.type === "coworkExec") {
			try {
				const output = await cowork.exec(command.command);
				return { ok: true, data: { output } };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		if (command.type === "coworkStatus") {
			return { ok: true, data: { ...cowork.assetStatus(), booted: cowork.assetStatus().ready && cowork["booted"] === true } };
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
		const host = sessionHost;
		if (!host) return { ok: false, error: "session host not ready" };
		const result = await host.runCommand(command);
		if (!result.ok) console.log("[noushi-desktop] command failed:", command.type, result.error);
		return result;
	});

	ipcMain.on(CHANNELS.extensionUiResponse, (_event, response: ExtensionUiResponse) => {
		sessionHost?.answerExtensionUi(response);
	});

	app.whenReady().then(() => {
		console.log("[noushi-desktop] app ready; creating window");
		const win = createMainWindow();
		mainWindow = win;
		wireSessionEvents(win);
		registerQuickWindow(toggleQuickWindow);
		createTray({
			show: () => mainWindow?.show(),
			newChat: () => {
				void handleRoute({ kind: "chat/new" });
			},
			newCode: () => {
				void handleRoute({ kind: "code/new", cwd: process.env.HOME ?? "/" });
			},
		});
		// quick capture on Ctrl+Shift+Space
		registerQuickWindow(toggleQuickWindow);
		const startupRoute = registerDeepLinks.drain();
		if (startupRoute) void handleRoute(startupRoute);
	});

	app.on("window-all-closed", () => {
		if (process.platform === "darwin") return;
		app.quit();
	});

	app.on("before-quit", () => {
		sessionHost?.disposeAll();
		void cowork.shutdown();
	});
}

init();
