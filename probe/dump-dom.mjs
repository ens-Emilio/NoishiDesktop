// Dump the actual DOM tree of the active view so selectors stop being guesses.
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
const send = (method, params = {}) => {
	const id = ++seq;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((r) => pending.set(id, { resolve: r }));
};
await new Promise((r) => ws.on("open", r));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
const click = async (label) => {
	await ev(`[...document.querySelectorAll(".view-tab")].find(t=>t.textContent.trim()===${JSON.stringify(label)})?.click()`);
	await new Promise((r) => setTimeout(r, 800));
};

const WALK = `(() => {
	const walk = (el, d) => {
		if (d > 5) return [];
		return [...el.children].flatMap((c) => {
			const cls = (c.className?.toString?.() ?? "").split(" ").filter(Boolean).slice(0,2).join(".");
			const own = [...c.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
			const t = own ? " «" + c.textContent.trim().replace(/\\s+/g, " ").slice(0, 26) + "»" : "";
			const r = c.getBoundingClientRect();
			const box = " [" + Math.round(r.width) + "x" + Math.round(r.height) + "]";
			const line = "  ".repeat(d) + c.tagName.toLowerCase() + (cls ? "." + cls : "") + box + t;
			return [line, ...walk(c, d + 1)];
		});
	};
	const root = document.querySelector("#root") ?? document.body;
	return walk(root, 0);
})()`;

const view = process.argv[2];
if (view) {
	await click(view);
	console.log("=== " + view + " ===");
} else {
	console.log("=== whole app ===");
}
console.log((await ev(WALK)).join("\n"));
ws.close();
