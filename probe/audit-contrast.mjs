// Probe: computed contrast on real rendered text, breadcrumb truth, theme isolation.
// Reuses a running app on CDP 9224. No Playwright needed.
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const page = (await (await fetch("http://127.0.0.1:9224/json/list")).json())
	.find((t) => t.type === "page" && t.url.startsWith("file://"));
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0;
const pending = new Map();
ws.on("message", (buf) => {
	const m = JSON.parse(buf.toString());
	if (m.id && pending.has(m.id)) {
		const { resolve } = pending.get(m.id);
		pending.delete(m.id);
		resolve(m.result);
	}
});
const send = (method, params = {}) => {
	const id = ++seq;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve) => pending.set(id, { resolve }));
};
await new Promise((r) => ws.on("open", r));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;

// Contrast computation running INSIDE the page, against computed colors.
const contrast = async (theme) => await ev(`(() => {
	document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)});
	const lin = (v) => { v /= 255; return v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4) };
	const L = (rgb) => { const [r,g,b] = rgb.match(/[\\d.]+/g).map(Number); return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b) };
	const bg = (el) => { let e = el; while (e) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\\([^)]*,\\s*0\\s*\\)/.test(c) && c !== "transparent") return c; e = e.parentElement } return "rgb(10,11,14)" };
	const ratio = (el) => {
		const cs = getComputedStyle(el);
		const fg = cs.color;
		const back = bg(el);
		const l1 = L(fg), l2 = L(back);
		return Math.round(((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05))*100)/100;
	};
	const rows = [];
	const seen = new Set();
	for (const el of document.querySelectorAll("*")) {
		if (!el.childNodes.length) continue;
		const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
		if (!direct) continue;
		const cs = getComputedStyle(el);
		if (cs.display === "none" || cs.visibility === "hidden") continue;
		const key = el.className + "|" + cs.color + "|" + bg(el);
		if (seen.has(key)) continue;
		seen.add(key);
		rows.push({ el: el.tagName.toLowerCase() + "." + (el.className.toString().split(" ").slice(0,2).join(".")), text: el.textContent.trim().slice(0, 30), color: cs.color, bg: bg(el), ratio: ratio(el), size: cs.fontSize });
	}
	rows.sort((a, b) => a.ratio - b.ratio);
	return rows.slice(0, 22);
})()`);

const clickTab = async (label) => {
	await ev(`[...document.querySelectorAll(".view-tab")].find((t) => t.textContent.trim() === ${JSON.stringify(label)})?.click()`);
	await new Promise((r) => setTimeout(r, 600));
};

const report = {};
for (const theme of ["dark", "light"]) {
	await clickTab("Chat");
	report[`${theme}-chat`] = await contrast(theme);
}

// Git breadcrumb truth: does the crumb match the file list and the open file?
await ev(`document.documentElement.setAttribute("data-theme", "dark")`);
await clickTab("Git");
await new Promise((r) => setTimeout(r, 800));
report.git = await ev(`(() => {
	const selected = document.querySelector(".file-row.is-selected")?.textContent.trim();
	const crumb = document.querySelector(".file-panel-crumb")?.textContent.trim();
	const crumbFolder = crumb?.split(" / ")[0];
	return { selected, crumb, crumbFolder, selectedMatchesCrumb: selected ? crumb?.startsWith(selected) : null, rows: [...document.querySelectorAll(".file-row")].map((r) => r.textContent.trim().slice(0, 30)) };
})()`);

// Sidebar collapse state at 1200px default.
report.sidebarAt1200 = await ev(`(() => {
	const sb = document.querySelector(".sidebar");
	return { cls: sb?.className, w: Math.round(sb?.getBoundingClientRect().width), appMainW: Math.round(document.querySelector(".app-main").getBoundingClientRect().width) };
})()`);

// Terminal view: is the welcome panel the only content?
await clickTab("Terminal");
await new Promise((r) => setTimeout(r, 500));
report.terminal = await ev(`(() => ({
	welcomeVisible: !!document.querySelector(".terminal-welcome"),
	helpCmds: document.querySelector(".terminal-welcome__help")?.textContent.slice(0, 120),
}))()`);

writeFileSync("/tmp/noishi-audit/probe.json", JSON.stringify(report, null, 2));
console.log("=== lowest contrast, dark chat ===");
for (const r of report["dark-chat"].slice(0, 10)) console.log(String(r.ratio).padStart(6), r.size.padStart(6), r.el, "|", r.text);
console.log("\n=== lowest contrast, light chat ===");
for (const r of report["light-chat"].slice(0, 10)) console.log(String(r.ratio).padStart(6), r.size.padStart(6), r.el, "|", r.text);
console.log("\n=== git ===", JSON.stringify(report.git, null, 2));
console.log("=== sidebar ===", JSON.stringify(report.sidebarAt1200));
console.log("=== terminal ===", JSON.stringify(report.terminal));
ws.close();
