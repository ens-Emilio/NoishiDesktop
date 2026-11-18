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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("boot:", (await call({ type: "sandboxBoot" })).ok);
console.log("provision:", JSON.stringify(await call({ type: "sandboxProvision", toolchain: ["jq"] })).slice(0, 120));
await call({ type: "sandboxTask", command: "jq --version", cwd: "/workspace" });
await wait(8000);
let tasks = (await call({ type: "sandboxStatus" })).data.tasks;
console.log("jq before reboot:", JSON.stringify(tasks[0].output.trim()));

await call({ type: "sandboxShutdown" });
await wait(4000);
console.log("reboot:", (await call({ type: "sandboxBoot" })).ok);
await call({ type: "sandboxTask", command: "jq --version || echo MISSING", cwd: "/workspace" });
await wait(12000);
tasks = (await call({ type: "sandboxStatus" })).data.tasks;
console.log("jq after reboot:", JSON.stringify(tasks[0].output.trim()));
await call({ type: "sandboxShutdown" });
ws.close();
