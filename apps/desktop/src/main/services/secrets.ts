/**
 * Native OS credential vault backed by Electron `safeStorage`
 * (KWallet / GNOME Keyring on Linux, Keychain on macOS, DPAPI on Windows).
 *
 * Encrypted secrets are persisted as base64 blobs in
 * `~/.config/noishi/secrets.enc.json`. Plaintext keys are never written to
 * `prefs.json`.
 */

import { safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function secretsDir(): string {
	return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "noishi");
}

function secretsPath(): string {
	return join(secretsDir(), "secrets.enc.json");
}

type SecretStore = Record<string, string>;

function readStore(): SecretStore {
	const path = secretsPath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as SecretStore;
	} catch {
		return {};
	}
}

function writeStore(store: SecretStore): void {
	mkdirSync(secretsDir(), { recursive: true });
	writeFileSync(secretsPath(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function isVaultAvailable(): boolean {
	try {
		return safeStorage.isEncryptionAvailable();
	} catch {
		return false;
	}
}

export function setSecret(key: string, value: string): boolean {
	if (!isVaultAvailable()) return false;
	const store = readStore();
	store[key] = safeStorage.encryptString(value).toString("base64");
	writeStore(store);
	return true;
}

export function getSecret(key: string): string | null {
	if (!isVaultAvailable()) return null;
	const store = readStore();
	const encoded = store[key];
	if (!encoded) return null;
	try {
		return safeStorage.decryptString(Buffer.from(encoded, "base64"));
	} catch {
		return null;
	}
}

export function deleteSecret(key: string): boolean {
	const store = readStore();
	if (!(key in store)) return false;
	delete store[key];
	writeStore(store);
	return true;
}

export function listSecretKeys(): string[] {
	return Object.keys(readStore());
}
