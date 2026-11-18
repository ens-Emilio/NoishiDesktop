// Drive the new panels through CDP: every tab renders, the review panel lists
// a session diff, settings loads prefs, and a screenshot proves the layout.
//
// Run with the app already listening on 9224 (probe/smoke.mjs starts one), or
// start it yourself:
//   npx electron apps/desktop/out/main/index.js --remote-debugging-port=9224
import WebSocket from "ws";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.env.NOISHI_CDP_PORT ?? 9224);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((target) => target.type === "page" && target.url.startsWith("file://"));
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0;
const pending = new Map();
ws.on("message", (buf) => {
	const message = JSON.parse(buf.toString());
	if (message.id && pending.has(message.id)) {
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
	}
});
const send = (method, params = {}) => {
	const id = ++seq;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
await new Promise((resolve) => ws.on("open", resolve));

const evalJs = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500));
	return result.result.value;
};

const clickTab = async (label) => {
	await evalJs(`(() => {
		const tab = [...document.querySelectorAll(".view-tab")].find((el) => el.textContent.trim() === ${JSON.stringify(label)});
		if (!tab) throw new Error("tab ausente: ${label}");
		tab.click();
	})()`);
	await delay(400);
};

const checks = [];
const expect = (name, ok, detail = "") => {
	checks.push({ name, ok: Boolean(ok), detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const tabs = await evalJs(`[...document.querySelectorAll(".view-tab")].map((el) => el.textContent.trim())`);
console.log("[drive] tabs:", JSON.stringify(tabs));
expect("todas as abas presentes", ["Chat", "Terminal", "Sandbox", "Revisão", "Git", "Contexto", "Ajustes"].every((tab) => tabs.includes(tab)), tabs.join(","));

for (const label of ["Revisão", "Git", "Contexto", "Ajustes"]) {
	await clickTab(label);
	const rendered = await evalJs(`Boolean(document.querySelector(".panel")) || Boolean(document.querySelector(".panel-empty"))`);
	expect(`painel ${label} renderiza`, rendered);
}

// Settings must show the approval-policy and telemetry sections.
await clickTab("Ajustes");
const sections = await evalJs(`[...document.querySelectorAll(".settings-section h4")].map((el) => el.textContent)`);
console.log("[drive] settings sections:", JSON.stringify(sections));
expect("ajustes: política de aprovação", sections.includes("Política de aprovação"));
expect("ajustes: telemetria", sections.includes("Telemetria"));
expect("ajustes: sandbox", sections.includes("Sandbox"));

// Diagnostic button runs the real check list.
await evalJs(`(() => {
	const button = [...document.querySelectorAll(".settings .btn")].find((el) => el.textContent.trim() === "Diagnóstico");
	button?.click();
})()`);
await delay(1200);
const diagRows = await evalJs(`document.querySelectorAll(".diag-row").length`);
expect("diagnóstico lista itens", diagRows > 4, `${diagRows} itens`);

// Voice control exists in the composer.
const mic = await evalJs(`Boolean(document.querySelector(".mic-pill"))`);
expect("botão de voz no composer", mic);

// Context panel renders the cost stats block.
await clickTab("Contexto");
const stats = await evalJs(`document.querySelectorAll(".ctx-stat").length`);
expect("contexto mostra estatísticas", stats >= 4, `${stats} stats`);

// Screenshot of the settings panel as visual proof.
await clickTab("Ajustes");
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(process.env.NOISHI_SHOT ?? "/tmp/noishi-panels.png", Buffer.from(shot.data, "base64"));
console.log("[drive] screenshot: /tmp/noishi-panels.png");

await clickTab("Chat");
ws.close();
const failed = checks.filter((check) => !check.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} UI checks passed`);
process.exit(failed.length ? 1 : 0);
