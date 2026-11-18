import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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

const repo = mkdtempSync(join(tmpdir(), "noishi-git-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
writeFileSync(join(repo, "a.txt"), "um\n");
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
writeFileSync(join(repo, "a.txt"), "um\ndois\n");
writeFileSync(join(repo, "b.txt"), "novo\n");

const status = await call({ type: "gitStatus", cwd: repo });
console.log("status:", status.data.isRepo, status.data.branch, JSON.stringify(status.data.files));

const diff = await call({ type: "gitDiff", cwd: repo, path: "a.txt", staged: false });
console.log("diff has +dois:", String(diff.data).includes("+dois"));

console.log("stage:", JSON.stringify(await call({ type: "gitStage", cwd: repo, paths: ["a.txt"] })));
const staged = await call({ type: "gitStatus", cwd: repo });
console.log("staged flag:", JSON.stringify(staged.data.files.find((f) => f.path === "a.txt")));

// Session commit: only the files the session touched.
await call({ type: "snapshotFile", sessionId: "git-demo", entryId: "g1", path: join(repo, "a.txt") });
const commit = await call({ type: "gitCommitSession", cwd: repo, message: "sessão", sessionId: "git-demo" });
console.log("commitSession:", JSON.stringify(commit));

const worktree = await call({ type: "gitWorktreeForSession", cwd: repo, sessionId: "git-demo" });
console.log("worktree:", JSON.stringify(worktree).slice(0, 200));
const trees = await call({ type: "gitWorktrees", cwd: repo });
console.log("worktrees:", trees.data.length);

const blame = await call({ type: "gitBlame", cwd: repo, path: "a.txt" });
console.log("blame lines:", blame.data.length, JSON.stringify(blame.data[0]));

const discard = await call({ type: "gitDiscard", cwd: repo, path: "b.txt" });
console.log("discard:", JSON.stringify(discard));
ws.close();
