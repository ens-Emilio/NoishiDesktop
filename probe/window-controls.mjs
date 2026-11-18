// Os botões de janela existem e AGEM: maximiza de verdade, restaura, e o estado
// reportado pela ponte acompanha. Fechar é verificado pelo efeito no processo.
import WebSocket from "ws";

const list = await (await fetch("http://127.0.0.1:9224/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("file://"));
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0;
const pending = new Map();
ws.on("message", (b) => {
	const m = JSON.parse(b.toString());
	if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r, j) => pending.set(id, { resolve: r, reject: j })); };
await new Promise((r) => ws.on("open", r));
const evalJs = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
const call = (cmd) => evalJs(`window.noishi.runSessionCommand(${JSON.stringify(cmd)})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const expect = (name, ok, detail = "") => { checks.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

const buttons = await evalJs(`[...document.querySelectorAll(".window-btn")].map((b) => b.getAttribute("aria-label"))`);
expect("três controles presentes", buttons.length === 3, buttons.join(", "));

const draggable = await evalJs(`getComputedStyle(document.querySelector(".topbar")).getPropertyValue("-webkit-app-region") || getComputedStyle(document.querySelector(".topbar")).getPropertyValue("app-region")`);
expect("topbar arrasta a janela", draggable.includes("drag"), draggable);

const noDrag = await evalJs(`getComputedStyle(document.querySelector(".window-controls")).getPropertyValue("-webkit-app-region") || getComputedStyle(document.querySelector(".window-controls")).getPropertyValue("app-region")`);
expect("controles não arrastam", noDrag.includes("no-drag"), noDrag);

const before = await call({ type: "windowState" });
expect("estado inicial reportado", before.ok && typeof before.data.maximized === "boolean", JSON.stringify(before.data));

await call({ type: "windowControl", action: "maximize" });
await wait(700);
const maxed = await call({ type: "windowState" });
expect("maximizou de fato", maxed.data.maximized === true, JSON.stringify(maxed.data));

await call({ type: "windowControl", action: "maximize" });
await wait(700);
const restored = await call({ type: "windowState" });
expect("restaurou", restored.data.maximized === false, JSON.stringify(restored.data));

const bad = await call({ type: "windowControl", action: "explode" });
expect("ação inválida é recusada", bad.ok === false, bad.error);

ws.close();
const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} window checks passed`);
process.exit(failed ? 1 : 0);
