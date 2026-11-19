/**
 * Skill Miner.
 *
 * Detects successful threads with ≥3 tool calls and generates SKILL.md
 * drafts in ~/.noishi/skills/pending/. User approves via API to move
 * to ~/.noishi/skills/active/.
 *
 * Heuristic trigger (YAGNI): avoids LLM calls on trivial conversations.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";

const SKILLS_DIR = join(homedir(), ".noishi", "skills");
const PENDING_DIR = join(SKILLS_DIR, "pending");
const ACTIVE_DIR = join(SKILLS_DIR, "active");
const MIN_TOOL_CALLS = 3;

export interface SkillDraft {
	id: string;
	name: string;
	description: string;
	steps_md: string;
	constraints_md: string;
	source_thread_id: string;
	tool_call_count: number;
}

function ensureSkillDirs(): void {
	if (!existsSync(PENDING_DIR)) mkdirSync(PENDING_DIR, { recursive: true });
	if (!existsSync(ACTIVE_DIR)) mkdirSync(ACTIVE_DIR, { recursive: true });
}

/** Check if a thread qualifies for skill mining (≥3 tool calls, finished successfully). */
export function shouldMineThread(threadId: string): boolean {
	const db = openDb();

	const thread = db.prepare("SELECT status FROM threads WHERE id = ?").get(threadId) as { status: string } | undefined;
	if (!thread || thread.status !== "finished") return false;

	const count = db
		.prepare("SELECT COUNT(*) as cnt FROM thread_events WHERE thread_id = ? AND event_type = 'TOOL_CALL_END'")
		.get(threadId) as { cnt: number };

	return count.cnt >= MIN_TOOL_CALLS;
}

/** Extract tool call sequence from a thread for skill synthesis. */
function getToolCallSequence(threadId: string): Array<{ tool: string; args: unknown; success: boolean }> {
	const db = openDb();
	const events = db
		.prepare(
			"SELECT event_type, payload_json FROM thread_events WHERE thread_id = ? AND event_type IN ('TOOL_CALL_START', 'TOOL_CALL_END') ORDER BY sequence_num ASC",
		)
		.all(threadId) as Array<{ event_type: string; payload_json: string }>;

	const calls: Array<{ tool: string; args: unknown; success: boolean }> = [];
	let currentTool: string | null = null;

	for (const evt of events) {
		const payload = JSON.parse(evt.payload_json ?? "{}");
		if (evt.event_type === "TOOL_CALL_START") {
			currentTool = payload.tool;
		} else if (evt.event_type === "TOOL_CALL_END" && currentTool) {
			calls.push({
				tool: currentTool,
				args: payload.args ?? {},
				success: payload.success ?? false,
			});
			currentTool = null;
		}
	}

	return calls;
}

/** Generate a SKILL.md draft from a tool call sequence. */
export function mineSkill(threadId: string): SkillDraft | null {
	if (!shouldMineThread(threadId)) return null;

	ensureSkillDirs();

	const calls = getToolCallSequence(threadId);
	if (calls.length < MIN_TOOL_CALLS) return null;

	const id = randomUUID();

	// Heuristic name/description from tool names (LLM synthesis deferred to S5 enhancement)
	const toolNames = [...new Set(calls.map((c) => c.tool))];
	const name = toolNames.slice(0, 3).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "-");
	const description = `Auto-generated skill from thread ${threadId.slice(0, 8)} using tools: ${toolNames.join(", ")}`;

	const steps = calls
		.map((c, i) => `${i + 1}. Call \`${c.tool}\` with args: \`${JSON.stringify(c.args).slice(0, 200)}\``)
		.join("\n");

	const constraints = "- Verify each step succeeded before proceeding\n- Review generated steps for correctness before activating";

	const draft: SkillDraft = {
		id,
		name,
		description,
		steps_md: steps,
		constraints_md: constraints,
		source_thread_id: threadId,
		tool_call_count: calls.length,
	};

	// Write markdown file to pending directory
	const mdContent = `---
name: ${draft.name}
description: ${draft.description}
source_thread: ${draft.source_thread_id}
tool_call_count: ${draft.tool_call_count}
---

## Passos
${draft.steps_md}

## Restrições e Cuidados
${draft.constraints_md}
`;

	writeFileSync(join(PENDING_DIR, `${id}.md`), mdContent, "utf-8");

	// Insert into skills table
	const db = openDb();
	db.prepare(
		"INSERT INTO skills (id, name, description, steps_md, constraints_md, status, source_thread_id, tool_call_count, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
	).run(id, draft.name, draft.description, draft.steps_md, draft.constraints_md, threadId, calls.length, Date.now());

	console.log(`[skill-miner] Generated skill draft ${id} from thread ${threadId}`);
	return draft;
}

/** Approve a pending skill: move file to active/ and update DB status. */
export function approveSkill(skillId: string): boolean {
	const db = openDb();
	const skill = db.prepare("SELECT * FROM skills WHERE id = ? AND status = 'pending'").get(skillId) as { id: string } | undefined;
	if (!skill) return false;

	const pendingPath = join(PENDING_DIR, `${skillId}.md`);
	const activePath = join(ACTIVE_DIR, `${skillId}.md`);

	try {
		if (existsSync(pendingPath)) {
			renameSync(pendingPath, activePath);
		}
		db.prepare("UPDATE skills SET status = 'active', approved_at = ? WHERE id = ?").run(Date.now(), skillId);
		console.log(`[skill-miner] Approved skill ${skillId}`);
		return true;
	} catch (err) {
		console.error(`[skill-miner] Failed to approve ${skillId}:`, err);
		return false;
	}
}

/** Reject a pending skill: remove file and DB row. */
export function rejectSkill(skillId: string): boolean {
	const db = openDb();
	const skill = db.prepare("SELECT * FROM skills WHERE id = ? AND status = 'pending'").get(skillId) as { id: string } | undefined;
	if (!skill) return false;

	const pendingPath = join(PENDING_DIR, `${skillId}.md`);
	try {
		if (existsSync(pendingPath)) unlinkSync(pendingPath);
	} catch {
		// File may already be gone
	}

	db.prepare("DELETE FROM skills WHERE id = ?").run(skillId);
	console.log(`[skill-miner] Rejected skill ${skillId}`);
	return true;
}

/** List all skills with optional status filter. */
export function listSkills(status?: "pending" | "active" | "rejected"): Array<{
	id: string;
	name: string;
	description: string;
	status: string;
	source_thread_id: string | null;
	tool_call_count: number;
	created_at: number;
	approved_at: number | null;
}> {
	const db = openDb();
	if (status) {
		return db
			.prepare("SELECT id, name, description, status, source_thread_id, tool_call_count, created_at, approved_at FROM skills WHERE status = ? ORDER BY created_at DESC")
			.all(status) as Array<{ id: string; name: string; description: string; status: string; source_thread_id: string | null; tool_call_count: number; created_at: number; approved_at: number | null }>;
	}
	return db
		.prepare("SELECT id, name, description, status, source_thread_id, tool_call_count, created_at, approved_at FROM skills ORDER BY created_at DESC")
		.all() as Array<{ id: string; name: string; description: string; status: string; source_thread_id: string | null; tool_call_count: number; created_at: number; approved_at: number | null }>;
}

/** Read the markdown content of a skill. */
export function getSkillContent(skillId: string): string | null {
	const db = openDb();
	const skill = db.prepare("SELECT status FROM skills WHERE id = ?").get(skillId) as { status: string } | undefined;
	if (!skill) return null;

	const dir = skill.status === "active" ? ACTIVE_DIR : PENDING_DIR;
	const path = join(dir, `${skillId}.md`);

	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}