// Audit harness: drive the running renderer through every screen and dump both
// themes, plus a machine-readable snapshot of geometry, contrast and a11y facts.
//
//   NOISHI_CDP_PORT=9224 node probe/audit-shots.mjs
import WebSocket from "ws";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.env.NOISHI_CDP_PORT ?? 9224);
const OUT = process.env.NOISHI_AUDIT_DIR ?? "/tmp/noishi-audit";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("file://"));
if (!page) throw new Error("no page target");

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0;
const pending = new Map();
ws.on("message", (buf) => {
	const msg = JSON.parse(buf.toString());
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
	}
});
const send = (method, params = {}) => {
	const id = ++seq;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
await new Promise((resolve) => ws.on("open", resolve));

const evalJs = async (expression) => {
	const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
	return r.result.value;
};

const shot = async (name) => {
	const s = await send("Page.captureScreenshot", { format: "png" });
	const path = `${OUT}/${name}.png`;
	writeFileSync(path, Buffer.from(s.data, "base64"));
	console.log("shot:", path);
};

const setTheme = async (theme) => {
	await evalJs(`(() => {
		const root = document.documentElement;
		root.setAttribute("data-theme", ${JSON.stringify(theme)});
		return root.getAttribute("data-theme");
	})()`);
	await delay(300);
};

const clickTab = async (label) => {
	await evalJs(`[...document.querySelectorAll(".view-tab")].find((t) => t.textContent.trim() === ${JSON.stringify(label)})?.click()`);
	await delay(700);
};

// ── ground truth about the current DOM ──────────────────────────────────────
const facts = await evalJs(`(() => {
	const q = (s) => [...document.querySelectorAll(s)];
	const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
	const interactive = q("button, a[href], [role=button], [role=tab], input, select, textarea, [tabindex]");
	const small = interactive.map((el) => {
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		if (cs.display === "none" || cs.visibility === "hidden" || r.width === 0) return null;
		return { tag: el.tagName.toLowerCase(), cls: el.className?.toString?.().slice(0, 60) ?? "", w: Math.round(r.width), h: Math.round(r.height), label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40) };
	}).filter(Boolean);
	const unnamed = small.filter((x) => !x.label);
	const tiny = small.filter((x) => x.w < 24 || x.h < 24);
	const headings = q("h1,h2,h3,h4,h5,h6").map((h) => h.tagName + ": " + h.textContent.trim().slice(0, 40));
	const landmarks = q("header,nav,main,aside,footer,[role=tablist],[role=tabpanel],[role=status],[role=dialog],[role=alert]").map((el) => el.tagName.toLowerCase() + (el.getAttribute("role") ? "[" + el.getAttribute("role") + "]" : ""));
	return {
		interactiveCount: small.length,
		unnamed,
		tiny,
		headings,
		landmarks,
		viewport: { w: innerWidth, h: innerHeight },
		theme: document.documentElement.getAttribute("data-theme"),
		docScrollW: document.documentElement.scrollWidth,
		overflow: document.documentElement.scrollWidth > innerWidth,
		rawHex: (() => {
			const hits = [];
			for (const sheet of document.styleSheets) {
				let rules; try { rules = sheet.cssRules } catch { continue }
				for (const r of rules) {
					if (!r.style) continue;
					for (const p of r.style) {
						if (/^color|background|border|fill|stroke|outline/.test(p) && /#[0-9a-f]{3,8}/i.test(r.style.getPropertyValue(p))) {
							hits.push(r.selectorText + " { " + p + ": " + r.style.getPropertyValue(p) + " }");
						}
					}
				}
			}
			return hits.slice(0, 80);
		})(),
	};
})()`);

writeFileSync(`${OUT}/facts.json`, JSON.stringify(facts, null, 2));
console.log("interactive:", facts.interactiveCount, "| unnamed:", facts.unnamed.length, "| tiny(<24):", facts.tiny.length, "| overflow:", facts.overflow);
console.log("landmarks:", facts.landmarks.join(", "));
console.log("headings:", facts.headings.join(" | "));

// ── screens ─────────────────────────────────────────────────────────────────
const tabs = await evalJs(`[...document.querySelectorAll(".view-tab")].map((el) => el.textContent.trim())`);
console.log("tabs:", tabs.join(", "));

for (const theme of ["dark", "light"]) {
	await setTheme(theme);
	for (const label of tabs) {
		await clickTab(label);
		const slug = label.normalize("NFD").replace(/[^a-zA-Z]/g, "");
		await shot(`${theme}-${slug}`);
	}
}

await setTheme("dark");
await clickTab("Chat");
ws.close();
console.log("done");
