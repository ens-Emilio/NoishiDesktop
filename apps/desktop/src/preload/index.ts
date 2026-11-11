/**
 * Preload: exposes the typed Noishi bridge via contextBridge.
 * No Node APIs leak; every call goes through ipcRenderer channels.
 */

import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type AgentEvent, type ExtensionUiRequest, type ExtensionUiResponse, type NoishiBridge, type SessionCommand, type SessionCommandResult } from "@noishi/rpc-bridge";

const api: NoishiBridge = {
	onDeepLinkRoute: (listener: (route: { kind: string }) => void): (() => void) => {
		const handler = (_event: unknown, payload: { kind: string }): void => listener(payload);
		ipcRenderer.on("noishi:deep-link", handler);
		return () => ipcRenderer.off("noishi:deep-link", handler);
	},
	getEnv: () => ipcRenderer.invoke(CHANNELS.getEnv),
	runSessionCommand: (command: SessionCommand): Promise<SessionCommandResult> =>
		ipcRenderer.invoke(CHANNELS.sessionCommand, command),
	onSessionEvent: (listener: (event: AgentEvent) => void): (() => void) => {
		const handler = (_event: unknown, payload: AgentEvent): void => listener(payload);
		ipcRenderer.on(CHANNELS.sessionEvent, handler);
		return () => ipcRenderer.off(CHANNELS.sessionEvent, handler);
	},
	onExtensionUiRequest: (listener: (request: ExtensionUiRequest) => void): (() => void) => {
		const handler = (_event: unknown, payload: ExtensionUiRequest): void => listener(payload);
		ipcRenderer.on(CHANNELS.extensionUiRequest, handler);
		return () => ipcRenderer.off(CHANNELS.extensionUiRequest, handler);
	},
	answerExtensionUi: (response: ExtensionUiResponse): void => {
		ipcRenderer.send(CHANNELS.extensionUiResponse, response);
	},
};

contextBridge.exposeInMainWorld("noishi", api);
