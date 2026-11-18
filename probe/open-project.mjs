// Open a real project through the app's own dialog, so every view has live data.
import WebSocket from "ws";

const ROOT = process.argv[2] ?? process.env.NOISHI_ROOT ?? "/run/media/zens/allkodex/all-kode/all-kodez/ens-kody/AgentCoding/NoishiDesktop";
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
const ev = async (e) => {
	const res = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
	if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300));
	return res.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Click "Abrir projeto…", fill the dialog input with a real path, submit.
await ev(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Abrir projeto"))?.click()`);
await wait(500);
const hasInput = await ev(`!!document.querySelector(".dialog input.field")`);
console.log("dialog input present:", hasInput);
if (hasInput) {
	await ev(`(() => {
		const input = document.querySelector(".dialog input.field");
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
		setter.call(input, ${JSON.stringify(ROOT)});
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	})()`);
	await wait(2000);
	console.log("after open, body:", (await ev(`document.querySelector(".crumb")?.textContent`)));
	console.log("file count:", await ev(`document.querySelector(".sidebar-section .count")?.textContent`));
}
ws.close();
