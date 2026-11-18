import WebSocket from "ws";
import { writeFileSync } from "node:fs";
const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("file://"));
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0; const pending = new Map();
ws.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r, j) => pending.set(id, { resolve: r, reject: j })); };
await new Promise((r) => ws.on("open", r));
const evalJs = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0,300)); return r.result.value; };
for (const tab of ["Revisão","Git","Contexto","Ajustes"]) {
  await evalJs(`[...document.querySelectorAll(".view-tab")].find(t=>t.textContent.trim()===${JSON.stringify(tab)})?.click()`);
  await new Promise((r) => setTimeout(r, 700));
  const s = await send("Page.captureScreenshot", { format: "png" });
  const name = "/tmp/panel-" + tab.normalize("NFD").replace(/[^a-zA-Z]/g,"") + ".png";
  writeFileSync(name, Buffer.from(s.data, "base64"));
  console.log(name);
}
ws.close();
