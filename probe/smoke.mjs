// CI smoke: launch the built Electron app headless (xvfb-run outside), verify the
// renderer comes up with the bridge and a chat composer, then exit 0.
// No CLI/session spawn — the app must be functional as a shell without a CLI.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const DEBUG_PORT = 9224;
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const electron = `${repoRoot}node_modules/electron/dist/electron`;
const app = `${repoRoot}apps/desktop/out/main/index.js`;

const child = spawn(electron, [app, `--remote-debugging-port=${DEBUG_PORT}`], {
	stdio: ["ignore", "ignore", "inherit"],
	env: { ...process.env, NOISHI_CLI_ROOT: "" },
});

const fail = async (message) => {
	child.kill();
	console.error(`[smoke] FAIL: ${message}`);
	process.exit(1);
};

try {
	// wait for CDP
	let targets = null;
	for (let i = 0; i < 30; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
			targets = await res.json();
			break;
		} catch {
			await delay(1000);
		}
	}
	if (!targets) await fail("CDP never came up");

	const page = targets.find((t) => t.type === "page" && t.url.startsWith("file://"));
	if (!page) await fail("no page target");

	const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
	let seq = 0;
	const pending = new Map();
	ws.on("message", (buf) => {
		const msg = JSON.parse(buf.toString());
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
		}
	});
	await new Promise((r, reject) => { ws.on("open", r); ws.on("error", reject); });
	const send = (method, params = {}) => {
		const id = ++seq;
		ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
	};

	const evalJs = async (expression) => {
		const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
		return r.result.value;
	};

	for (let i = 0; i < 20; i++) {
		try {
			if (await evalJs("Boolean(window.noishi)")) break;
		} catch { /* renderer warming up */ }
		await delay(500);
		if (i === 19) await fail("window.noishi bridge not exposed");
	}

	const ui = await evalJs(`JSON.stringify({
		composer: Boolean(document.querySelector(".composer textarea")),
		send: Boolean(document.querySelector(".send")),
		brand: document.querySelector(".brand-name")?.textContent ?? "",
	})`);
	const uiState = JSON.parse(ui);
	if (!uiState.composer || !uiState.send || uiState.brand !== "Noishi") {
		await fail(`renderer UI incomplete: ${ui}`);
	}

	// graceful shutdown: the app quits when the window closes
	const quit = evalJs("window.close() ?? null");
	await Promise.race([quit, delay(5000)]);
	ws.close();
	console.log("[smoke] PASS: app launched headless, bridge exposed, composer rendered, clean exit");
	child.kill();
	process.exit(0);
} catch (error) {
	await fail(error.message);
}
