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

console.log("status:", JSON.stringify(await call({ type: "sandboxStatus" })).slice(0, 300));
const boot = await call({ type: "sandboxBoot" });
console.log("boot:", JSON.stringify(boot).slice(0, 200));
if (!boot.ok) { ws.close(); process.exit(1); }

const inst = await call({ type: "sandboxCreateInstance", name: "vm2" });
console.log("create instance:", JSON.stringify(inst).slice(0, 200));
const destroy = await call({ type: "sandboxDestroyInstance", id: "vm2" });
console.log("destroy instance:", JSON.stringify(destroy).slice(0, 120));

const provision = await call({ type: "sandboxProvision", toolchain: ["jq"] });
console.log("provision:", JSON.stringify(provision).slice(0, 200));

const task = await call({ type: "sandboxTask", command: "uname -a; jq --version", cwd: "/workspace" });
console.log("task:", JSON.stringify(task).slice(0, 160));
await new Promise((r) => setTimeout(r, 12000));
const after = await call({ type: "sandboxStatus" });
const tasks = after.data.tasks;
console.log("task result:", JSON.stringify(tasks[0]).slice(0, 500));

const snap = await call({ type: "sandboxSnapshot", name: "e2e" });
console.log("snapshot:", JSON.stringify(snap).slice(0, 160));
const diff = await call({ type: "sandboxWorkspaceDiff" });
console.log("workspaceDiff:", JSON.stringify(diff).slice(0, 200));

const limits = await call({ type: "sandboxSetLimits", maxCpu: 3, maxMemoryMb: 2048, maxSeconds: 200 });
console.log("limits:", JSON.stringify(limits));

const sched = await call({ type: "sandboxSchedule", command: "date", everySeconds: 60 });
console.log("schedule:", JSON.stringify(sched).slice(0, 160));
const unsched = await call({ type: "sandboxUnschedule", id: sched.data.id });
console.log("unschedule:", JSON.stringify(unsched));

const allow = await call({ type: "sandboxAllowlist", domains: ["registry.npmjs.org", "dl-cdn.alpinelinux.org"] });
console.log("allowlist:", JSON.stringify(allow).slice(0, 140));

// Interactive terminal: collect what the serial console streams back.
const tty = await evalJs(`(() => {
	window.__tty = "";
	window.__offTty = window.noishi.sandboxTty.onData((data) => { window.__tty += data; });
	return window.noishi.sandboxTty.open(80, 24);
})()`);
console.log("tty:", JSON.stringify(tty));
await evalJs(`window.noishi.sandboxTty.write("echo TTY_OK\\n")`);
await new Promise((r) => setTimeout(r, 3000));
const ttyData = await evalJs(`(() => { window.__offTty?.(); window.noishi.sandboxTty.close(); return window.__tty ?? ""; })()`);
console.log("tty output has marker:", String(ttyData).includes("TTY_OK"), JSON.stringify(String(ttyData).slice(-120)));

const shutdown = await call({ type: "sandboxShutdown" });
console.log("shutdown:", shutdown.ok);
ws.close();
process.exit(String(ttyData).includes("TTY_OK") ? 0 : 1);
