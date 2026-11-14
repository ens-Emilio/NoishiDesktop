/**
 * Native messaging socket: the browser extension's host forwards page shares
 * here as JSON lines. We turn each one into a chat prompt in the main window.
 *
 * The socket lives in XDG_RUNTIME_DIR (user-private, mode 0600) so only the
 * logged-in user can talk to it. Framing is one JSON object per connection;
 * payloads are validated by the host before they ever reach us.
 */

import { createServer, type Server } from "node:net";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PageShare = { kind: "share-page" | "share-selection"; url: string; title: string; selection: string };

const MAX_BYTES = 4 * 1024 * 1024;

function socketPath(): string {
	const dir = join(process.env.XDG_RUNTIME_DIR || join(homedir(), ".cache"), "noishi");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return join(dir, "native.sock");
}

/** Build the prompt the agent receives for a shared page. */
export function sharePrompt(share: PageShare): string {
	const header = share.title ? `[${share.title}](${share.url})` : share.url;
	const body = share.selection.trim();
	return body ? `Página compartilhada do navegador: ${header}\n\n---\n\n${body}` : `Página compartilhada do navegador: ${header}`;
}

export function startNativeHost(onShare: (share: PageShare) => void): () => void {
	const path = socketPath();
	try {
		rmSync(path, { force: true });
	} catch {
		// stale socket we can't remove -> the listen below will fail loudly
	}
	const server: Server = createServer((socket) => {
		const chunks: Buffer[] = [];
		let size = 0;
		socket.on("data", (buf) => {
			size += buf.length;
			if (size > MAX_BYTES) {
				socket.end(JSON.stringify({ ok: false, error: "payload grande demais" }));
				socket.destroy();
				return;
			}
			chunks.push(buf);
		});
		socket.on("end", () => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				socket.end(JSON.stringify({ ok: false, error: "JSON inválido" }));
				return;
			}
			const msg = parsed as Partial<PageShare>;
			if (msg?.kind !== "share-page" && msg?.kind !== "share-selection") {
				socket.end(JSON.stringify({ ok: false, error: "tipo desconhecido" }));
				return;
			}
			onShare({
				kind: msg.kind,
				url: typeof msg.url === "string" ? msg.url : "",
				title: typeof msg.title === "string" ? msg.title : "",
				selection: typeof msg.selection === "string" ? msg.selection : "",
			});
			socket.end(JSON.stringify({ ok: true }));
		});
		socket.on("error", () => socket.destroy());
	});
	server.on("error", (err) => console.error("[noishi-desktop] native host:", err.message));
	server.listen(path, () => {
		try {
			chmodSync(path, 0o600);
		} catch {
			// non-fatal: the directory is already user-private
		}
		console.log(`[noishi-desktop] native host escutando em ${path}`);
	});
	return () => {
		server.close();
		try {
			rmSync(path, { force: true });
		} catch {
			// fine
		}
	};
}

/**
 * Install the native messaging manifest for every Chromium-family browser we
 * can find. Chrome only launches hosts listed in its own directory, so this
 * has to be written per browser; a missing browser is skipped silently.
 *
 * The manifest's `path` must be absolute, so we rewrite it from the packaged
 * location on every boot — that keeps it correct after an AppImage moves.
 */
export function installNativeManifests(hostDir: string): string[] {
	const manifest = {
		name: "com.noishi.desktop",
		description: "Noishi Desktop native messaging host",
		path: join(hostDir, "noishi-native-host.sh"),
		type: "stdio",
		allowed_origins: ["chrome-extension://clbifamdddpbjofnkmdkiinepdbgbaec/"],
	};
	const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	const targets = [
		join(config, "google-chrome", "NativeMessagingHosts"),
		join(config, "google-chrome-beta", "NativeMessagingHosts"),
		join(config, "chromium", "NativeMessagingHosts"),
		join(config, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
		join(config, "microsoft-edge", "NativeMessagingHosts"),
		join(config, "vivaldi", "NativeMessagingHosts"),
	];
	const written: string[] = [];
	for (const dir of targets) {
		const browserRoot = dir.replace(/\/NativeMessagingHosts$/, "");
		if (!existsSync(browserRoot)) continue;
		try {
			mkdirSync(dir, { recursive: true });
			const file = join(dir, "com.noishi.desktop.json");
			writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
			written.push(file);
		} catch (error) {
			console.error("[noishi-desktop] native manifest:", dir, error instanceof Error ? error.message : error);
		}
	}
	if (written.length) console.log(`[noishi-desktop] native manifest instalado em ${written.length} navegador(es)`);
	else console.log("[noishi-desktop] native manifest: nenhum navegador Chromium encontrado");
	return written;
}

