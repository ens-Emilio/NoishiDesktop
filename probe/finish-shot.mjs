// Screenshot do estado de repouso + hover + foco do composer, para olhar o
// acabamento. Também mede o que muda entre os estados (não confia no CSS).
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

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

const shot = async (name) => {
	const s = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(`/tmp/${name}.png`, Buffer.from(s.data, "base64"));
	return `/tmp/${name}.png`;
};

const rest = await evalJs(`getComputedStyle(document.querySelector(".composer")).boxShadow`);
console.log("composer repouso:", rest);

const box = await evalJs(`(() => { const r = document.querySelector(".composer textarea").getBoundingClientRect(); return { x: Math.round(r.x + 40), y: Math.round(r.y + 12) }; })()`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
await new Promise((r) => setTimeout(r, 400));
const focused = await evalJs(`getComputedStyle(document.querySelector(".composer")).boxShadow`);
const ring = await evalJs(`getComputedStyle(document.querySelector(".composer")).borderColor`);
console.log("composer foco:", focused);
console.log("borda foco:", ring);

// hover num botão para ver a camada de pintura
const btn = await evalJs(`(() => { const b = document.querySelector(".btn--ghost"); if(!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
if (btn) {
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: btn.x, y: btn.y });
	await new Promise((r) => setTimeout(r, 200));
}
console.log("shot:", await shot("noishi-finish"));
ws.close();
