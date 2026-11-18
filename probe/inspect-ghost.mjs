// Inspect the computed color of the ghost "Clonar" button in light theme.
import WebSocket from "ws";

const page = (await (await fetch("http://127.0.0.1:9224/json/list")).json())
	.find((t) => t.type === "page" && t.url.startsWith("file://"));
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0;
const pending = new Map();
ws.on("message", (b) => {
	const m = JSON.parse(b.toString());
	if (m.id && pending.has(m.id)) {
		pending.get(m.id).resolve(m.result);
		pending.delete(m.id);
	}
});
const send = (m, p = {}) => {
	const id = ++seq;
	ws.send(JSON.stringify({ id, method: m, params: p }));
	return new Promise((r) => pending.set(id, { resolve: r }));
};
await new Promise((r) => ws.on("open", r));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.value;

await ev(`document.documentElement.setAttribute("data-theme", "light")`);
const info = await ev(`(() => {
	const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Clonar"));
	const cs = getComputedStyle(btn);
	const walk = (el) => { let e = el; const out = []; while (e) { const c = getComputedStyle(e).backgroundColor; out.push(e.tagName.toLowerCase()+"."+(e.className?.toString?.().split(" ")[0]??"")+" "+c); e = e.parentElement } return out };
	return { color: cs.color, opacity: cs.opacity, bg: cs.backgroundColor, chain: walk(btn) };
})()`);
console.log(JSON.stringify(info, null, 2));
ws.close();
