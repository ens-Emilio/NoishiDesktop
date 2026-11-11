// Drive the app renderer via CDP: type a prompt, wait for agent_settled, read status.
import WebSocket from "ws";

const list = await (await fetch("http://127.0.0.1:9223/json")).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("file://"));
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0;
const pending = new Map();
function send(method, params = {}) {
	const id = ++seq;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
	});
}
ws.on("message", (buf) => {
	const msg = JSON.parse(buf.toString());
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
	}
});
await new Promise((r) => ws.on("open", r));

const evalJs = async (expression) => {
	const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
	return r.result.value;
};

// sanity: bridge present
const env = await evalJs("(async () => window.noushi ? await window.noushi.getEnv() : null)()");
console.log("[drive] env:", JSON.stringify(env));

// clear + send prompt
await evalJs(`(async () => {
	const ta = document.querySelector(".composer textarea");
	ta.value = "Responda exatamente: PONG-desktop";
	ta.dispatchEvent(new Event("input", { bubbles: true }));
	ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
})()`);
console.log("[drive] prompt sent; waiting for agent_settled…");

// wait for settled by watching the status text
const deadline = Date.now() + 120000;
let status = "";
while (Date.now() < deadline) {
	status = await evalJs("document.querySelector('.status')?.textContent ?? ''");
	if (status.includes("pronto") && !status.includes("0 tok · $0.0000")) break;
	
	await new Promise((r) => setTimeout(r, 1000));
}

const bubbles = await evalJs(`Array.from(document.querySelectorAll('.bubble.assistant')).map(b => b.textContent).join(' || ')`);
console.log("[drive] assistant bubbles:", JSON.stringify(bubbles));
console.log("[drive] final status:", status);
ws.close();
