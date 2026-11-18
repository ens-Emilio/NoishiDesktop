// Contract fixtures for the pi RPC -> desktop bridge translation.
//
// The bridge is the one place where an upstream protocol change silently breaks
// the UI: a renamed field yields `undefined` and the renderer just shows blanks.
// These fixtures pin the shapes the desktop depends on, so a NoishiCLI bump that
// changes them fails here instead of in the app.
//
// Run: node probe/rpc-contract.mjs
//
// The translator is bundled on the fly so the fixtures run against the source
// (the app build inlines it into out/main/index.js).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outDir = mkdtempSync(join(tmpdir(), "noishi-contract-"));
const bundle = join(outDir, "rpc-translate.mjs");
execFileSync(
	"npx",
	["esbuild", "apps/desktop/src/main/services/rpc-translate.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`],
	{ stdio: "ignore" },
);
const { translateEvent, translateExtensionUi } = await import(pathToFileURL(bundle).href);

const cases = [];
const check = (name, fn) => cases.push({ name, fn });

/* ---------- agent events ---------- */

check("agent_start", () => {
	assert.deepEqual(translateEvent({ type: "agent_start" }), { type: "agent_start" });
});

check("agent_end carries aborted", () => {
	assert.deepEqual(translateEvent({ type: "agent_end", aborted: true }), { type: "agent_end", aborted: true });
});

check("agent_settled carries aborted", () => {
	assert.deepEqual(translateEvent({ type: "agent_settled", aborted: false }), { type: "agent_settled", aborted: false });
});

check("turn_start / turn_end", () => {
	assert.deepEqual(translateEvent({ type: "turn_start" }), { type: "turn_start" });
	assert.deepEqual(translateEvent({ type: "turn_end" }), { type: "turn_end" });
});

check("bash_execution_update delta is a string", () => {
	const out = translateEvent({ type: "bash_execution_update", delta: "ls\n" });
	assert.equal(out.type, "bash_execution_update");
	assert.equal(out.delta, "ls\n");
});

check("compaction_start defaults reason", () => {
	const out = translateEvent({ type: "compaction_start" });
	assert.equal(out.type, "compaction_start");
	assert.equal(out.reason, "manual");
});

check("compaction_end flags", () => {
	const out = translateEvent({ type: "compaction_end", aborted: true, willRetry: false });
	assert.deepEqual(out, { type: "compaction_end", aborted: true, willRetry: false });
});

check("message_update requires usage + assistantMessageEvent", () => {
	assert.equal(translateEvent({ type: "message_update" }), null);
	assert.equal(translateEvent({ type: "message_update", usage: {} }), null);
	const out = translateEvent({
		type: "message_update",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01, input: 0.005, output: 0.005 } },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
	});
	assert.equal(out.type, "message_update");
	assert.equal(out.usage.totalTokens, 15);
	assert.equal(out.usage.cost.total, 0.01);
	assert.equal(out.event.type, "text_delta");
});

check("session_info_changed name is optional", () => {
	assert.deepEqual(translateEvent({ type: "session_info_changed", name: "x" }), { type: "session_info_changed", name: "x" });
	assert.deepEqual(translateEvent({ type: "session_info_changed" }), { type: "session_info_changed", name: undefined });
});

check("unknown event types are dropped", () => {
	assert.equal(translateEvent({ type: "something_new" }), null);
});

/* ---------- extension UI requests ---------- */

check("select carries options", () => {
	const out = translateExtensionUi({ id: "1", method: "select", title: "Pick", options: ["a", "b"] });
	assert.deepEqual(out, { id: "1", method: "select", title: "Pick", options: ["a", "b"] });
});

check("confirm carries message", () => {
	const out = translateExtensionUi({ id: "2", method: "confirm", title: "Sure?", message: "rm -rf" });
	assert.equal(out.method, "confirm");
	assert.equal(out.message, "rm -rf");
});

check("input carries placeholder", () => {
	const out = translateExtensionUi({ id: "3", method: "input", title: "Path", placeholder: "~/x" });
	assert.equal(out.placeholder, "~/x");
});

check("editor carries prefill", () => {
	const out = translateExtensionUi({ id: "4", method: "editor", title: "Edit", prefill: "text" });
	assert.equal(out.method, "editor");
	assert.equal(out.prefill, "text");
});

check("notify carries type", () => {
	const out = translateExtensionUi({ id: "5", method: "notify", message: "done", notifyType: "info" });
	assert.equal(out.method, "notify");
	assert.equal(out.notifyType, "info");
});

check("setStatus / setWidget / setTitle", () => {
	assert.equal(translateExtensionUi({ id: "6", method: "setStatus", statusKey: "k", statusText: "v" }).statusKey, "k");
	assert.equal(translateExtensionUi({ id: "7", method: "setWidget", widgetKey: "w", widgetLines: ["a"] }).widgetKey, "w");
	assert.equal(translateExtensionUi({ id: "8", method: "setTitle", title: "T" }).title, "T");
});

check("requests without id/method are dropped", () => {
	assert.equal(translateExtensionUi({ method: "select" }), null);
	assert.equal(translateExtensionUi({ id: "9" }), null);
});

/* ---------- run ---------- */

let failed = 0;
for (const { name, fn } of cases) {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}: ${error.message}`);
	}
}
console.log(`\n${cases.length - failed}/${cases.length} contract fixtures passed`);
process.exit(failed ? 1 : 0);
