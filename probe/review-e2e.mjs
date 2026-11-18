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

// Simulate a session that touched a file: snapshot then modify.
const fs = await import("node:fs");
const path = "/tmp/noishi-review-demo.txt";
fs.writeFileSync(path, "linha um\nlinha dois\nlinha três\n");
console.log("snapshot:", JSON.stringify(await call({ type: "snapshotFile", sessionId: "demo-session", entryId: "e1", path })));
fs.writeFileSync(path, "linha um\nlinha DOIS alterada\nlinha três\nlinha quatro\n");
const diff = await call({ type: "sessionDiff", sessionId: "demo-session" });
console.log("sessionDiff:", JSON.stringify(diff).slice(0, 400));
const file = diff.data[0];
console.log("add/del:", file.add, file.del, "status:", file.status);

// Reject: revert to the pre-image.
const revert = await call({ type: "revertFile", sessionId: "demo-session", entryId: "e1", path });
console.log("revert:", JSON.stringify(revert), "content:", JSON.stringify(fs.readFileSync(path, "utf-8")));

// Accept: apply the patch back.
const applied = await call({ type: "applyDiff", cwd: "/tmp", path, patch: file.patch });
console.log("applyDiff:", JSON.stringify(applied), "content:", JSON.stringify(fs.readFileSync(path, "utf-8")));

// Approval rules round-trip.
const rules = await call({ type: "setApprovalRules", rules: [{ tool: "bash", pattern: "git status*", decision: "allow" }] });
console.log("rules:", JSON.stringify(rules));
const read = await call({ type: "getApprovalRules" });
console.log("read back:", JSON.stringify(read));
await call({ type: "setApprovalRules", rules: [] });

// Cost/context/export on a real session file.
// A real session file from the CLI's own store (listSessions needs the CLI
// running; the file is enough for the read-only insights commands).
const os = await import("node:os");
const glob = fs.readdirSync(`${os.homedir()}/.noishi/agent/sessions`, { recursive: true })
	.filter((entry) => String(entry).endsWith(".jsonl"))
	.map((entry) => `${os.homedir()}/.noishi/agent/sessions/${entry}`);
const sessionPath = glob[0] ?? null;
console.log("session file:", sessionPath);
if (sessionPath) {
  const cost = await call({ type: "sessionCost", sessionPath });
  console.log("cost:", JSON.stringify(cost).slice(0, 220));
  const ctx = await call({ type: "contextBreakdown", sessionPath, contextWindow: 200000 });
  console.log("context slices:", ctx.data.slices.length, "used:", ctx.data.usedTokens);
  const md = await call({ type: "exportMarkdown", sessionPath });
  console.log("exportMarkdown:", JSON.stringify(md));
  const pdf = await call({ type: "exportPdf", sessionPath });
  console.log("exportPdf:", JSON.stringify(pdf).slice(0, 160));
  const transcript = await call({ type: "sessionTranscript", sessionPath });
  console.log("transcript blocks:", Array.isArray(transcript.data) ? transcript.data.length : transcript);
}
ws.close();
