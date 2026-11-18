import WebSocket from "ws";
const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("file://"));
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0; const pending = new Map();
ws.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r, j) => pending.set(id, { resolve: r, reject: j })); };
await new Promise((r) => ws.on("open", r));
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0,400)); return r.result.value; };
await ev(`[...document.querySelectorAll(".view-tab")].find(t=>t.textContent.trim()==="Ajustes")?.click()`);
await new Promise((r) => setTimeout(r, 500));
console.log(await ev(`(() => {
  const q = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return {top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height)}; };
  return JSON.stringify({pane: q(".panel-pane"), panel: q(".cds-panel"), composer: q(".composer-wrap"), main: q(".main")}, null, 1);
})()`));
ws.close();
