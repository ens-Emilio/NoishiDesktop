// Contract fixtures for the review service: patch parsing, hunk application,
// diff generation and the approval policy glob.
//
// These run against the source bundle (esbuild), because the logic is what the
// review panel relies on to apply or reject a file change — a silent mismatch
// would write the wrong bytes.
//
// Run: node probe/review-contract.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outDir = mkdtempSync(join(tmpdir(), "noishi-review-"));
const bundle = join(outDir, "review.mjs");
execFileSync(
	"npx",
	["esbuild", "apps/desktop/src/main/services/review.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`],
	{ stdio: "ignore" },
);
const { parsePatch, applyHunks, applyPatch, lineDiff, toPatch, decide } = await import(pathToFileURL(bundle).href);

const cases = [];
const check = (name, fn) => cases.push({ name, fn });

/* ---------- parsing ---------- */

check("parse: one hunk with three line kinds", () => {
	const hunks = parsePatch("--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n keep\n-old\n+new\n");
	assert.equal(hunks.length, 1);
	assert.deepEqual(hunks[0].lines, [
		{ kind: " ", text: "keep" },
		{ kind: "-", text: "old" },
		{ kind: "+", text: "new" },
	]);
	assert.equal(hunks[0].oldStart, 2);
	assert.equal(hunks[0].newLines, 3);
});

check("parse: missing count means 1", () => {
	const hunks = parsePatch("@@ -5 +5 @@\n-a\n+b\n");
	assert.equal(hunks[0].oldLines, 1);
	assert.equal(hunks[0].newLines, 1);
});

check("parse: no hunk header yields no hunks", () => {
	assert.deepEqual(parsePatch("just text\nmore"), []);
});

/* ---------- applying ---------- */

check("apply: replaces a matched line", () => {
	const result = applyHunks(["a", "b", "c"], [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: [{ kind: "-", text: "b" }, { kind: "+", text: "B" }] }]);
	assert.equal(result.ok, true);
	assert.deepEqual(result.lines, ["a", "B", "c"]);
});

check("apply: refuses when context does not match", () => {
	const result = applyHunks(["a", "x", "c"], [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: [{ kind: "-", text: "b" }, { kind: "+", text: "B" }] }]);
	assert.equal(result.ok, false);
	assert.match(result.error, /não confere/);
});

check("apply: out-of-order hunks are rejected", () => {
	const result = applyHunks(["a", "b"], [
		{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: [{ kind: "-", text: "b" }] },
		{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: "-", text: "a" }] },
	]);
	assert.equal(result.ok, false);
});

check("applyPatch writes the file", () => {
	const dir = mkdtempSync(join(tmpdir(), "noishi-patch-"));
	const file = join(dir, "x.txt");
	writeFileSync(file, "one\ntwo\nthree\n");
	const patch = "--- a/x.txt\n+++ b/x.txt\n@@ -2,1 +2,2 @@\n-two\n+TWO\n+EXTRA\n";
	const result = applyPatch(dir, "x.txt", patch);
	assert.equal(result.ok, true);
	assert.equal(readFileSync(file, "utf-8"), "one\nTWO\nEXTRA\nthree\n");
});

/* ---------- generating ---------- */

check("lineDiff: identical content has no hunks", () => {
	assert.deepEqual(lineDiff(["a", "b"], ["a", "b"]), []);
});

check("lineDiff: middle replacement keeps prefix and suffix", () => {
	const hunks = lineDiff(["a", "b", "c", "d"], ["a", "X", "c", "d"]);
	assert.equal(hunks.length, 1);
	assert.equal(hunks[0].oldStart, 2);
	assert.deepEqual(hunks[0].lines, [
		{ kind: "-", text: "b" },
		{ kind: "+", text: "X" },
	]);
});

check("toPatch round-trips through parsePatch", () => {
	const hunks = lineDiff(["a", "b"], ["a", "c"]);
	const patch = toPatch("f.txt", hunks);
	const parsed = parsePatch(patch);
	assert.deepEqual(parsed, hunks);
});

/* ---------- approval policy ---------- */

check("decide: no rule asks", () => {
	assert.equal(decide([], "bash", "rm -rf /"), "ask");
});

check("decide: tool-only rule applies to every arg", () => {
	assert.equal(decide([{ tool: "write", decision: "allow" }], "write", "/etc/passwd"), "allow");
});

check("decide: glob restricts by path", () => {
	const rules = [
		{ tool: "write", pattern: "src/**", decision: "allow" },
		{ tool: "write", pattern: "*.env", decision: "deny" },
	];
	assert.equal(decide(rules, "write", "src/a/b.ts"), "allow");
	assert.equal(decide(rules, "write", "config.env"), "deny");
	assert.equal(decide(rules, "write", "docs/readme.md"), "ask");
});

check("decide: wildcard tool matches anything", () => {
	assert.equal(decide([{ tool: "*", decision: "deny" }], "bash", "ls"), "deny");
});

check("decide: first matching rule wins", () => {
	const rules = [
		{ tool: "bash", pattern: "git status*", decision: "allow" },
		{ tool: "bash", decision: "ask" },
	];
	assert.equal(decide(rules, "bash", "git status --short"), "allow");
	assert.equal(decide(rules, "bash", "rm -rf /"), "ask");
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
console.log(`\n${cases.length - failed}/${cases.length} review fixtures passed`);
process.exit(failed ? 1 : 0);
