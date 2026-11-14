#!/usr/bin/env node
/**
 * Noishi native messaging host.
 *
 * Chrome launches this binary and speaks length-prefixed JSON on stdin/stdout:
 *   4-byte uint32 little-endian length, then that many UTF-8 bytes of JSON.
 *
 * We don't answer Chrome with page data; we forward each request to the running
 * Noishi app over a Unix socket and reply with a one-line ack. If the app isn't
 * running, we reply with an error so the extension can show a real message
 * instead of hanging.
 *
 * Security: the only thing trusted here is the manifest's allowed_origins
 * (Chrome enforces it) plus our own shape validation. Message content is
 * untrusted: it's page text the user chose to share.
 */

import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const SOCKET = join(process.env.XDG_RUNTIME_DIR || join(homedir(), ".cache"), "noishi", "native.sock");
const MAX_FRAME = 16 * 1024 * 1024;
const ALLOWED_KINDS = new Set(["share-page", "share-selection", "ping"]);

function writeFrame(obj) {
	const body = Buffer.from(JSON.stringify(obj), "utf8");
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length, 0);
	process.stdout.write(Buffer.concat([head, body]));
}

/** Narrow and normalize an incoming message before it reaches the app. */
function validate(msg) {
	if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { error: "mensagem não é um objeto" };
	const kind = typeof msg.kind === "string" ? msg.kind : "";
	if (!ALLOWED_KINDS.has(kind)) return { error: `tipo desconhecido: ${kind || "(vazio)"}` };
	const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
	return {
		value: {
			kind,
			url: str(msg.url, 8192),
			title: str(msg.title, 512),
			selection: str(msg.selection, 200_000),
		},
	};
}

function forward(payload) {
	return new Promise((resolve) => {
		const socket = connect(SOCKET);
		let settled = false;
		const done = (result) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(4000, () => done({ ok: false, error: "app Noishi não respondeu" }));
		socket.on("connect", () => socket.end(JSON.stringify(payload)));
		socket.on("error", () => done({ ok: false, error: "app Noishi não está aberto" }));
		socket.on("data", (buf) => {
			try {
				done(JSON.parse(buf.toString("utf8")));
			} catch {
				done({ ok: true });
			}
		});
	});
}

/** Read one length-prefixed frame; resolves null at a clean EOF. */
function readFrame() {
	return new Promise((resolve) => {
		let need = null;
		let chunks = [];
		let have = 0;
		const cleanup = () => {
			process.stdin.off("data", onData);
			process.stdin.off("end", onEnd);
		};
		const onData = (buf) => {
			chunks.push(buf);
			have += buf.length;
			if (need === null && have >= 4) {
				const all = Buffer.concat(chunks);
				need = all.readUInt32LE(0);
				chunks = [all.subarray(4)];
				have = chunks[0].length;
			}
			if (need !== null && need > MAX_FRAME) {
				cleanup();
				resolve(null);
				return;
			}
			if (need !== null && have >= need) {
				cleanup();
				const all = Buffer.concat(chunks);
				const body = all.subarray(0, need);
				const rest = all.subarray(need);
				if (rest.length) process.stdin.unshift(rest);
				resolve(body.toString("utf8"));
			}
		};
		const onEnd = () => {
			cleanup();
			resolve(null);
		};
		process.stdin.on("data", onData);
		process.stdin.on("end", onEnd);
	});
}

process.stdin.on("error", () => process.exit(0));

for (;;) {
	const raw = await readFrame();
	if (raw === null) break;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		writeFrame({ ok: false, error: "JSON inválido" });
		continue;
	}
	const checked = validate(parsed);
	if (checked.error) {
		writeFrame({ ok: false, error: checked.error });
		continue;
	}
	if (checked.value.kind === "ping") {
		writeFrame({ ok: true, app: "noishi" });
		continue;
	}
	writeFrame(await forward(checked.value));
}
process.exit(0);
