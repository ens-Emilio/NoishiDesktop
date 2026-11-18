// Verifies the interaction layer actually applies: press transform, spring
// transition, focus ring, and field shadow. Reads computed style, not source.
import WebSocket from "ws";

const PORT = Number(process.env.NOISHI_CDP_PORT ?? 9224);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("file://"));
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0;
const pending = new Map();
ws.on("message", (buf) => {
	const m = JSON.parse(buf.toString());
	if (m.id && pending.has(m.id)) {
		const p = pending.get(m.id);
		pending.delete(m.id);
		m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
	}
});
const send = (method, params = {}) => {
	const id = ++seq;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
await new Promise((r) => ws.on("open", r));
const evalJs = async (expression) => {
	const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
	return r.result.value;
};

const checks = [];
const expect = (name, ok, detail = "") => {
	checks.push({ name, ok: Boolean(ok) });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const tokens = await evalJs(`(() => {
	const s = getComputedStyle(document.documentElement);
	const get = (n) => s.getPropertyValue(n).trim();
	return {
		press: get("--press-scale"),
		spring: get("--ease-spring"),
		fast: get("--d-fast"),
		slow: get("--d-slow"),
		focus: get("--focus-ring"),
		field: get("--shadow-field"),
	};
})()`);
expect("token de press", tokens.press === "0.975", tokens.press);
expect("token de mola", tokens.spring.includes("1.0764"), "curva passa do alvo");
expect("durações", tokens.fast === "60ms" && tokens.slow === "450ms", `${tokens.fast}/${tokens.slow}`);
expect("anel de foco tem halo", tokens.focus.includes("6px"), tokens.focus.slice(0, 60));

const btn = await evalJs(`(() => {
	const b = document.querySelector(".btn");
	if (!b) return null;
	const s = getComputedStyle(b);
	return { transition: s.transitionProperty, duration: s.transitionDuration, origin: s.transformOrigin, w: b.offsetWidth, h: b.offsetHeight };
})()`);
expect("botão existe", btn);
expect("botão anima transform", btn?.transition.includes("transform"), btn?.transition);
expect("retorno usa 0.45s", btn?.duration.includes("0.45s"), btn?.duration);
// `50%` computa para px (largura/2 × altura/2): comparar os dois lados.
const origin = (btn?.origin ?? "").split(" ").map((v) => parseFloat(v));
expect("origem do scale é o centro", origin.length === 2 && Math.abs(origin[0] - origin[1] * (btn?.w / btn?.h || 1)) < 2, btn?.origin);

// Press real via CDP: o navegador entra em :active e o transform computa.
const box = await evalJs(`(() => {
	const b = document.querySelector(".btn:not(:disabled)") ?? document.querySelector(".chip");
	if (!b) return null;
	const r = b.getBoundingClientRect();
	return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
let pressedTransform = null;
if (box) {
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
	await new Promise((r) => setTimeout(r, 80));
	pressedTransform = await evalJs(`getComputedStyle(document.querySelector(".btn:not(:disabled)") ?? document.querySelector(".chip")).transform`);
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
	await new Promise((r) => setTimeout(r, 600));
}
const releasedTransform = await evalJs(`getComputedStyle(document.querySelector(".btn:not(:disabled)") ?? document.querySelector(".chip")).transform`);
expect("press aplica scale", /matrix\(0\.97[0-9]*/.test(pressedTransform ?? ""), pressedTransform);
expect("solta volta ao normal", releasedTransform === "none" || /matrix\(1, 0, 0, 1/.test(releasedTransform ?? ""), releasedTransform);

const field = await evalJs(`(() => {
	const f = document.querySelector(".field");
	if (!f) return null;
	const s = getComputedStyle(f);
	return { shadow: s.boxShadow, transition: s.transitionProperty };
})()`);
expect("campo tem sombra de repouso", field?.shadow && field.shadow !== "none", field?.shadow?.slice(0, 50));
expect("campo anima sombra", field?.transition.includes("box-shadow"), field?.transition);

ws.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} interaction checks passed`);
process.exit(failed.length ? 1 : 0);
