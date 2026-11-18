import WebSocket from "ws";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const list = await (await fetch("http://127.0.0.1:9224/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("file://"));
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0; const pending = new Map();
ws.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })); };
await new Promise((r) => ws.on("open", r));
const evalJs = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
const call = (cmd) => evalJs(`window.noishi.runSessionCommand(${JSON.stringify(cmd)})`);

const dir = mkdtempSync(join(tmpdir(), "noishi-rewind-"));
const a = join(dir, "a.txt"), b = join(dir, "b.txt");
writeFileSync(a, "a0\n"); writeFileSync(b, "b0\n");
const sid = "rewind-demo";
await call({ type: "snapshotFile", sessionId: sid, entryId: "t1", path: a });
writeFileSync(a, "a1\n");
await new Promise((r) => setTimeout(r, 20));
await call({ type: "snapshotFile", sessionId: sid, entryId: "t2", path: b });
writeFileSync(b, "b1\n");

const list1 = await call({ type: "listCheckpoints", sessionId: sid });
console.log("checkpoints:", JSON.stringify(list1.data));
const changes = await call({ type: "sessionChanges", sessionId: sid });
console.log("changes:", changes.data.length);

const rewind = await call({ type: "rewindTo", sessionId: sid, entryId: "t2" });
console.log("rewind:", JSON.stringify(rewind.data));
console.log("a.txt:", JSON.stringify(readFileSync(a, "utf-8")), "b.txt:", JSON.stringify(readFileSync(b, "utf-8")));
const list2 = await call({ type: "listCheckpoints", sessionId: sid });
console.log("checkpoints after:", list2.data.length);
ws.close();
process.exit(0);
