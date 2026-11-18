/**
 * Preload: exposes the typed Noishi bridge via contextBridge.
 * No Node APIs leak; every call goes through ipcRenderer channels.
 */

import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type AgentEvent, type DeepLinkPayload, type ExtensionUiRequest, type ExtensionUiResponse, type NoishiBridge, type SessionCommand, type SessionCommandResult } from "@noishi/rpc-bridge";

const api: NoishiBridge = {
	onDeepLinkRoute: (listener: (route: DeepLinkPayload) => void): (() => void) => {
		const handler = (_event: unknown, payload: DeepLinkPayload): void => listener(payload);
		ipcRenderer.on("noishi:deep-link", handler);
		return () => ipcRenderer.off("noishi:deep-link", handler);
	},
	getEnv: () => ipcRenderer.invoke(CHANNELS.getEnv),
	getTheme: () => ipcRenderer.invoke(CHANNELS.getTheme),
	onThemeChange: (listener: (theme: "dark" | "light") => void): (() => void) => {
		const handler = (_event: unknown, theme: "dark" | "light"): void => listener(theme);
		ipcRenderer.on(CHANNELS.themeChanged, handler);
		return () => ipcRenderer.off(CHANNELS.themeChanged, handler);
	},
	onThemeTokens: (listener: (tokens: Record<string, string>) => void): (() => void) => {
		const handler = (_event: unknown, tokens: Record<string, string>): void => listener(tokens);
		ipcRenderer.on(CHANNELS.themeTokens, handler);
		return () => ipcRenderer.off(CHANNELS.themeTokens, handler);
	},
	sandboxTty: {
		open: (cols: number, rows: number) => ipcRenderer.invoke(CHANNELS.sandboxTtyOpen, { cols, rows }),
		write: (data: string): void => {
			ipcRenderer.send(CHANNELS.sandboxTtyWrite, data);
		},
		close: (): void => {
			ipcRenderer.send(CHANNELS.sandboxTtyClose);
		},
		onData: (listener: (data: string) => void): (() => void) => {
			const handler = (_event: unknown, payload: { data: string }): void => listener(payload.data);
			ipcRenderer.on(CHANNELS.sandboxTtyData, handler);
			return () => ipcRenderer.off(CHANNELS.sandboxTtyData, handler);
		},
	},
	runSessionCommand: (command: SessionCommand): Promise<SessionCommandResult> =>
		ipcRenderer.invoke(CHANNELS.sessionCommand, command),
	onSessionEvent: (listener: (event: AgentEvent) => void): (() => void) => {
		const handler = (_event: unknown, payload: AgentEvent): void => listener(payload);
		ipcRenderer.on(CHANNELS.sessionEvent, handler);
		return () => ipcRenderer.off(CHANNELS.sessionEvent, handler);
	},
	onSandboxEvent: (listener: (event: { type: string; detail?: string }) => void): (() => void) => {
		const handler = (_event: unknown, payload: { type: string; detail?: string }): void => listener(payload);
		ipcRenderer.on(CHANNELS.sandboxEvent, handler);
		return () => ipcRenderer.off(CHANNELS.sandboxEvent, handler);
	},
	onExtensionUiRequest: (listener: (request: ExtensionUiRequest) => void): (() => void) => {
		const handler = (_event: unknown, payload: ExtensionUiRequest): void => listener(payload);
		ipcRenderer.on(CHANNELS.extensionUiRequest, handler);
		return () => ipcRenderer.off(CHANNELS.extensionUiRequest, handler);
	},
	pty: {
		create: (cwd: string, cols: number, rows: number) => ipcRenderer.invoke(CHANNELS.ptyCreate, { cwd, cols, rows }),
		write: (data: string): void => {
			ipcRenderer.send(CHANNELS.ptyWrite, data);
		},
		resize: (cols: number, rows: number): void => {
			ipcRenderer.send(CHANNELS.ptyResize, { cols, rows });
		},
		onData: (listener: (data: string) => void): (() => void) => {
			const handler = (_event: unknown, payload: { data: string }): void => listener(payload.data);
			ipcRenderer.on(CHANNELS.ptyData, handler);
			return () => ipcRenderer.off(CHANNELS.ptyData, handler);
		},
		onExit: (listener: (exitCode: number) => void): (() => void) => {
			const handler = (_event: unknown, payload: { exitCode: number }): void => listener(payload.exitCode);
			ipcRenderer.on(CHANNELS.ptyExit, handler);
			return () => ipcRenderer.off(CHANNELS.ptyExit, handler);
		},
	},
	answerExtensionUi: (response: ExtensionUiResponse): void => {
		ipcRenderer.send(CHANNELS.extensionUiResponse, response);
	},
	openMainWindow: (): void => {
		ipcRenderer.send(CHANNELS.openMain);
	},
	find: {
		query: (text: string, forward = true): void => {
			ipcRenderer.send(CHANNELS.findQuery, { text, forward });
		},
		clear: (): void => {
			ipcRenderer.send(CHANNELS.findQuery, { text: "", forward: true });
		},
		onOpen: (listener: () => void): (() => void) => {
			const handler = (): void => listener();
			ipcRenderer.on(CHANNELS.findOpen, handler);
			return () => ipcRenderer.off(CHANNELS.findOpen, handler);
		},
		onResult: (listener: (result: { query: string; matches: number; active: number }) => void): (() => void) => {
			const handler = (_event: unknown, payload: { query: string; matches: number; active: number }): void => listener(payload);
			ipcRenderer.on(CHANNELS.findResult, handler);
			return () => ipcRenderer.off(CHANNELS.findResult, handler);
		},
	},
};

contextBridge.exposeInMainWorld("noishi", api);
