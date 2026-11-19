/**
 * Local Intelligence SQLite persistence layer.
 *
 * Uses better-sqlite3 synchronously to avoid race conditions in WAL mode.
 * Schema is versioned via embedded SQL migrations applied on first open.
 */

import Database, { type Database as DatabaseType } from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NOISHI_DIR = join(homedir(), ".noishi");
const DB_PATH = join(NOISHI_DIR, "intelligence.db");

export interface Thread {
	id: string;
	title: string | null;
	agent_id: string | null;
	state_json: string | null;
	status: "idle" | "running" | "finished" | "error";
	created_at: number;
	updated_at: number;
}

export interface ThreadEvent {
	id: number;
	thread_id: string;
	sequence_num: number;
	event_type: string;
	payload_json: string | null;
	timestamp: number;
}

export interface AuditLog {
	id: number;
	thread_id: string | null;
	tool_name: string | null;
	args_json: string | null;
	result_summary: string | null;
	approved_by: string | null;
	timestamp: number;
}

let db: DatabaseType | null = null;

const MIGRATION_001 = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT,
  agent_id TEXT,
  state_json TEXT,
  status TEXT DEFAULT 'idle',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  sequence_num INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  timestamp INTEGER NOT NULL,
  UNIQUE(thread_id, sequence_num),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thread_events_seq ON thread_events(thread_id, sequence_num);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT,
  tool_name TEXT,
  args_json TEXT,
  result_summary TEXT,
  approved_by TEXT,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_thread ON audit_logs(thread_id);
`;

const MIGRATION_002 = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  embedding BLOB,
  embedding_status TEXT DEFAULT 'pending',
  embedding_model TEXT,
  category TEXT,
  confidence REAL,
  thread_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(embedding_status);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, content='memories', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE,
  description TEXT,
  steps_md TEXT,
  constraints_md TEXT,
  status TEXT DEFAULT 'pending',
  source_thread_id TEXT,
  tool_call_count INTEGER,
  created_at INTEGER NOT NULL,
  approved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
`;

/** Open (or create) the intelligence database with WAL mode and all migrations. */
export function openDb(): DatabaseType {
	if (db) return db;

	if (!existsSync(NOISHI_DIR)) mkdirSync(NOISHI_DIR, { recursive: true });

	db = new Database(DB_PATH);
	db.pragma("journal_mode=WAL");
	db.pragma("foreign_keys=ON");
	db.pragma("synchronous=NORMAL");

	// Apply migrations idempotently (all statements use IF NOT EXISTS)
	db.exec(MIGRATION_001);
	db.exec(MIGRATION_002);

	return db;
}

/** Close the database connection gracefully. */
export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

/** Get the next sequence number for a thread (monotonic per thread_id). */
export function getNextSequenceNum(threadId: string): number {
	const d = openDb();
	const row = d
		.prepare("SELECT MAX(sequence_num) as max_seq FROM thread_events WHERE thread_id = ?")
		.get(threadId) as { max_seq: number | null } | undefined;
	return (row?.max_seq ?? 0) + 1;
}

/** Insert a thread event and return its sequence number. */
export function insertThreadEvent(
	threadId: string,
	eventType: string,
	payload: unknown,
): number {
	const d = openDb();
	const seq = getNextSequenceNum(threadId);
	const now = Date.now();
	d.prepare(
		"INSERT INTO thread_events (thread_id, sequence_num, event_type, payload_json, timestamp) VALUES (?, ?, ?, ?, ?)",
	).run(threadId, seq, eventType, JSON.stringify(payload), now);
	return seq;
}

/** Replay events for a thread after a given sequence number (for Last-Event-ID). */
export function getEventsAfter(threadId: string, afterSeq: number): ThreadEvent[] {
	const d = openDb();
	return d
		.prepare(
			"SELECT * FROM thread_events WHERE thread_id = ? AND sequence_num > ? ORDER BY sequence_num ASC",
		)
		.all(threadId, afterSeq) as ThreadEvent[];
}

/** Create or update a thread. */
export function upsertThread(
	id: string,
	opts?: { title?: string; agentId?: string; status?: Thread["status"] },
): Thread {
	const d = openDb();
	const now = Date.now();
	const existing = d.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Thread | undefined;

	if (existing) {
		d.prepare(
			"UPDATE threads SET title = COALESCE(?, title), agent_id = COALESCE(?, agent_id), status = COALESCE(?, status), updated_at = ? WHERE id = ?",
		).run(opts?.title ?? null, opts?.agentId ?? null, opts?.status ?? null, now, id);
	} else {
		d.prepare(
			"INSERT INTO threads (id, title, agent_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(id, opts?.title ?? null, opts?.agentId ?? null, opts?.status ?? "idle", now, now);
	}

	return d.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Thread;
}

/** Get a thread by ID. */
export function getThread(id: string): Thread | undefined {
	const d = openDb();
	return d.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Thread | undefined;
}