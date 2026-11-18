// Accessibility audit of the running renderer: every interactive control has an
// accessible name, the tab strip exposes selection, and the live status region
// exists. Fails on the first unnamed control so the report names it.
//
// Run with the app listening on 9224.
import WebSocket from "ws";

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
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400));
	return result.result.value;
};

const checks = [];
const expect = (name, ok, detail = "") => {
	checks.push({ name, ok: Boolean(ok) });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// Walk every tab so controls that only exist in one panel are audited too.
const tabs = await evalJs(`[...document.querySelectorAll(".view-tab")].map((el) => el.textContent.trim())`);
for (const label of tabs) {
	await evalJs(`(() => {
		const tab = [...document.querySelectorAll(".view-tab")].find((el) => el.textContent.trim() === ${JSON.stringify(label)});
		tab?.click();
	})()`);
	await new Promise((resolve) => setTimeout(resolve, 250));
	const unnamed = await evalJs(`(() => {
		// Nome acessível de verdade: aria-label, aria-labelledby, <label for>,
		// label ancestral, title, texto e placeholder — nessa ordem.
		const name = (el) => {
			const aria = (el.getAttribute("aria-label") ?? "").trim();
			if (aria) return aria;
			const labelledBy = el.getAttribute("aria-labelledby");
			if (labelledBy) {
				const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
				if (text) return text;
			}
			if (el.id) {
				// percorre os labels à mão: evita montar seletor com aspas aqui
				for (const l of document.querySelectorAll("label[for]")) {
					if (l.getAttribute("for") !== el.id) continue;
					const text = (l.textContent ?? "").trim();
					if (text) return text;
				}
			}
			const wrapped = el.closest("label");
			if (wrapped) {
				const text = (wrapped.textContent ?? "").trim();
				if (text) return text;
			}
			return (
				(el.getAttribute("title") ?? "").trim() ||
				(el.textContent ?? "").trim() ||
				(el.getAttribute("placeholder") ?? "").trim()
			);
		};
		return [...document.querySelectorAll("button, [role=tab], input, select, textarea")]
			.filter((el) => el.offsetParent !== null)
			.filter((el) => !name(el))
			.map((el) => el.outerHTML.slice(0, 90));
	})()`);
	expect(`controles nomeados em ${label}`, unnamed.length === 0, unnamed.slice(0, 3).join(" | "));
}

const tablist = await evalJs(`Boolean(document.querySelector('[role="tablist"]'))`);
expect("tablist exposto", tablist);
const selected = await evalJs(`document.querySelectorAll('[role="tab"][aria-selected="true"]').length`);
expect("exatamente uma aba selecionada", selected === 1, `${selected}`);
const live = await evalJs(`Boolean(document.querySelector('[role="status"][aria-live]'))`);
expect("região viva de status", live);
const focusRing = await evalJs(`(() => {
	const style = getComputedStyle(document.documentElement);
	return Boolean(style.getPropertyValue("--accent"));
})()`);
expect("token de acento para foco", focusRing);

ws.close();
const failed = checks.filter((check) => !check.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} a11y checks passed`);
process.exit(failed.length ? 1 : 0);
