/**
 * Audit log helper for tool call tracking.
 *
 * Records every tool execution decision and result to the audit_logs table
 * for compliance, debugging, and skill mining.
 */

import { openDb } from "./db.js";

export interface AuditEntry {
	threadId: string | null;
	toolName: string;
	args: unknown;
	resultSummary: string | null;
	approvedBy: string | null; // null = auto-approved, user_id = manual approval
}

/** Record a tool call in the audit log. */
export function recordAudit(entry: AuditEntry): void {
	const db = openDb();
	db.prepare(
		"INSERT INTO audit_logs (thread_id, tool_name, args_json, result_summary, approved_by, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		entry.threadId,
		entry.toolName,
		JSON.stringify(entry.args),
		entry.resultSummary,
		entry.approvedBy,
		Date.now(),
	);
}

/** Get recent audit entries for a thread (newest first). */
export function getAuditForThread(threadId: string, limit = 50): Array<{
	id: number;
	tool_name: string | null;
	args_json: string | null;
	result_summary: string | null;
	timestamp: number;
}> {
	const db = openDb();
	return db
		.prepare(
			"SELECT id, tool_name, args_json, result_summary, timestamp FROM audit_logs WHERE thread_id = ? ORDER BY timestamp DESC LIMIT ?",
		)
		.all(threadId, limit) as Array<{
		id: number;
		tool_name: string | null;
		args_json: string | null;
		result_summary: string | null;
		timestamp: number;
	}>;
}