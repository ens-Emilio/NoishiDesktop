// Contract fixtures for session insights: cost, context breakdown, markdown
// export and portability. They run against a synthetic JSONL that mirrors the
// shape the CLI writes, so a change in that shape fails here.
//
// Run: node probe/insights-contract.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outDir = mkdtempSync(join(tmpdir(), "noishi-insights-"));
const bundle = join(outDir, "insights.mjs");
execFileSync(
	"npx",
	["esbuild", "apps/desktop/src/main/services/session-insights.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`],
	{ stdio: "ignore" },
);
const { sessionCost, contextBreakdown, sessionToMarkdown, exportMarkdown, portSession, readSession, sessionTranscript } = await import(
	pathToFileURL(bundle).href
);

const dir = mkdtempSync(join(tmpdir(), "noishi-session-"));
const sessionPath = join(dir, "session.jsonl");
const records = [
	{ type: "session", id: "s1", timestamp: "2026-01-01T10:00:00.000Z", cwd: "/tmp/project", name: "Teste" },
	{ type: "model_change", provider: "ghostcli", modelId: "claude", timestamp: "2026-01-01T10:00:01.000Z" },
	{ type: "message", message: { role: "system", content: "You are a coding assistant." }, timestamp: "2026-01-01T10:00:02.000Z" },
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "olá" }] }, timestamp: "2026-01-01T10:05:00.000Z" },
	{
		type: "message",
		message: {
			role: "assistant",
			model: "claude",
			content: [
				{ type: "text", text: "oi" },
				{ type: "toolCall", name: "read" },
			],
			usage: { input: 1000, output: 20, cacheRead: 500, cacheWrite: 0, totalTokens: 1520, cost: { input: 0.01, output: 0.002, total: 0.012 } },
		},
		timestamp: "2026-01-01T10:06:00.000Z",
	},
	{
		type: "message",
		message: {
			role: "assistant",
			model: "claude",
			content: [{ type: "text", text: "feito" }],
			usage: { input: 500, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 510, cost: { input: 0.005, output: 0.001, total: 0.006 } },
		},
		timestamp: "2026-01-01T10:20:00.000Z",
	},
];
writeFileSync(sessionPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

const cases = [];
const check = (name, fn) => cases.push({ name, fn });

check("readSession skips blank/garbage lines", () => {
	writeFileSync(join(dir, "bad.jsonl"), '{"type":"session"}\nnot json\n\n{"type":"message"}\n');
	assert.equal(readSession(join(dir, "bad.jsonl")).length, 2);
	assert.deepEqual(readSession(join(dir, "missing.jsonl")), []);
});

check("sessionCost sums tokens and cost", () => {
	const cost = sessionCost(sessionPath);
	assert.equal(cost.messages, 4);
	assert.equal(cost.userMessages, 1);
	assert.equal(cost.assistantMessages, 2);
	assert.equal(cost.toolCalls, 1);
	assert.equal(cost.tokens.total, 2030);
	assert.equal(cost.tokens.cacheRead, 500);
	assert.equal(Number(cost.cost.total.toFixed(4)), 0.018);
});

check("sessionCost groups by model", () => {
	const cost = sessionCost(sessionPath);
	assert.equal(cost.byModel.length, 1);
	assert.equal(cost.byModel[0].model, "claude");
	assert.equal(cost.byModel[0].messages, 2);
});

check("sessionCost duration spans first and last timestamps", () => {
	const cost = sessionCost(sessionPath);
	assert.equal(cost.firstAt, Date.parse("2026-01-01T10:00:00.000Z"));
	assert.equal(cost.lastAt, Date.parse("2026-01-01T10:20:00.000Z"));
});

check("contextBreakdown shares sum to 1", () => {
	const context = contextBreakdown(sessionPath, 100_000);
	const total = context.slices.reduce((sum, slice) => sum + slice.share, 0);
	assert.ok(Math.abs(total - 1) < 1e-9);
	assert.ok(context.slices.some((slice) => slice.label === "system prompt"));
});

check("contextBreakdown uses the last assistant input as live context", () => {
	const context = contextBreakdown(sessionPath, 100_000);
	assert.equal(context.usedTokens, 500);
});

check("markdown export lists roles and skips the system prompt", () => {
	const markdown = sessionToMarkdown(sessionPath);
	assert.match(markdown, /^# Teste/);
	assert.match(markdown, /## Você/);
	assert.match(markdown, /## Noishi/);
	assert.doesNotMatch(markdown, /You are a coding assistant/);
});

check("exportMarkdown writes next to the session", () => {
	const result = exportMarkdown(sessionPath);
	assert.equal(result.path, sessionPath.replace(/\.jsonl$/, ".md"));
	assert.ok(readFileSync(result.path, "utf-8").includes("## Você"));
});

check("portSession rewrites the session cwd", () => {
	const target = mkdtempSync(join(tmpdir(), "noishi-port-"));
	const result = portSession(sessionPath, target);
	assert.equal(result.cwd, target);
	const ported = readSession(result.path);
	const session = ported.find((record) => record.type === "session");
	assert.equal(session.cwd, target);
});

check("sessionTranscript rebuilds text and tool blocks", () => {
	const transcript = sessionTranscript(sessionPath);
	const text = transcript.filter((block) => block.kind === "text");
	const tools = transcript.filter((block) => block.kind === "tool");
	assert.equal(text.length, 3);
	assert.equal(text[0].role, "user");
	assert.equal(text[1].role, "assistant");
	assert.equal(tools.length, 1);
	assert.equal(tools[0].toolName, "read");
	assert.match(tools[0].args, /\{/);
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
console.log(`\n${cases.length - failed}/${cases.length} insights fixtures passed`);
process.exit(failed ? 1 : 0);
