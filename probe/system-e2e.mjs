import WebSocket from "ws";
const list = await (await fetch("http://127.0.0.1:9224/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("file://"));
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0; const pending = new Map();
ws.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })); };
await new Promise((r) => ws.on("open", r));
const evalJs = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
const call = (cmd) => evalJs(`window.noishi.runSessionCommand(${JSON.stringify(cmd)})`);

console.log("zoom set:", JSON.stringify(await call({ type: "setZoom", level: 1 })));
console.log("zoom get:", JSON.stringify(await call({ type: "getZoom" })));
console.log("zoom reset:", JSON.stringify(await call({ type: "setZoom", level: 0 })));

console.log("trayBadge:", JSON.stringify(await call({ type: "trayBadge", count: 2 })));
console.log("trayBadge clear:", JSON.stringify(await call({ type: "trayBadge", count: 0 })));

const theme = await call({ type: "saveTheme", name: "e2e", theme: { "--accent": "#ff0000" } });
console.log("saveTheme:", JSON.stringify(theme));
console.log("listThemes:", JSON.stringify(await call({ type: "listThemes" })));
console.log("applyTheme:", JSON.stringify(await call({ type: "applyTheme", name: "e2e" })));
await new Promise((r) => setTimeout(r, 500));
const accent = await evalJs(`getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`);
console.log("accent applied:", accent);
console.log("apply none:", JSON.stringify(await call({ type: "applyTheme", name: "none" })));
await new Promise((r) => setTimeout(r, 500));
const accent2 = await evalJs(`getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`);
console.log("accent cleared:", accent2);
console.log("deleteTheme:", JSON.stringify(await call({ type: "deleteTheme", name: "e2e" })));

console.log("telemetry on:", JSON.stringify(await call({ type: "setTelemetry", enabled: true, endpoint: "https://example.invalid/crash" })));
console.log("telemetry off:", JSON.stringify(await call({ type: "setTelemetry", enabled: false, endpoint: null })));

console.log("reportCrash:", JSON.stringify(await call({ type: "reportCrash", message: "e2e crash" })));
const crashes = await call({ type: "recentCrashes" });
console.log("recentCrashes:", crashes.data.length, String(crashes.data.at(-1)).slice(0, 80));

const diag = await call({ type: "diagnostics" });
console.log("diagnostics items:", diag.data.items.length, "failing:", diag.data.items.filter((i) => !i.ok).map((i) => i.name));

const cli = await call({ type: "cliVersionCheck" });
console.log("cliVersionCheck:", JSON.stringify(cli).slice(0, 200));

const shortcuts = await call({ type: "setShortcuts", shortcuts: [{ action: "quick-window", accelerator: "CommandOrControl+Shift+Space" }, { action: "find", accelerator: "CommandOrControl+F" }] });
console.log("setShortcuts:", JSON.stringify(shortcuts));
ws.close();
