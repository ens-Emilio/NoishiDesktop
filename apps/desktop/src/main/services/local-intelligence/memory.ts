/**
 * Hybrid Memory Engine.
 *
 * Combines sqlite-vec semantic search with FTS5 lexical fallback.
 * When embeddings are unavailable (pending/failed), degrades gracefully
 * to BM25 text search so memory retrieval never blocks on endpoint status.
 */

import { randomUUID } from "node:crypto";
import { openDb } from "./db.js";
import { blobToEmbedding, embeddingToBlob, generateEmbedding } from "./embeddings.js";
import { triggerBackfill } from "./embedding-backfill.js";

export interface MemoryEntry {
	id: string;
	content: string;
	category: string;
	confidence: number;
	thread_id: string | null;
	created_at: number;
}

export interface SearchResult extends MemoryEntry {
	score: number;
	match_type: "semantic" | "lexical";
}

/** Insert a new memory. Embedding is attempted inline; on failure, saved as pending for backfill. */
export async function addMemory(
	content: string,
	opts: {
		category?: string;
		confidence?: number;
		threadId?: string;
		endpoint?: string;
		model?: string;
	},
): Promise<string> {
	const id = randomUUID();
	const now = Date.now();
	const category = opts.category ?? "fact";
	const confidence = opts.confidence ?? 1.0;
	const db = openDb();

	// Attempt inline embedding
	const result = await generateEmbedding(content, opts.endpoint, opts.model);

	if (result) {
		const blob = embeddingToBlob(result.embedding);
		db.prepare(
			"INSERT INTO memories (id, content, embedding, embedding_status, embedding_model, category, confidence, thread_id, created_at) VALUES (?, ?, ?, 'done', ?, ?, ?, ?, ?)",
		).run(id, content, blob, result.model, category, confidence, opts.threadId ?? null, now);
	} else {
		// Save without embedding — backfill will pick it up
		db.prepare(
			"INSERT INTO memories (id, content, embedding_status, category, confidence, thread_id, created_at) VALUES (?, ?, 'pending', ?, ?, ?, ?)",
		).run(id, content, category, confidence, opts.threadId ?? null, now);

		// Trigger async backfill
		void triggerBackfill();
	}

	// Update FTS5 index (always available regardless of embedding status)
	db.prepare("INSERT INTO memories_fts (rowid, content) SELECT rowid, content FROM memories WHERE id = ?").run(id);

	return id;
}

/** Search memories using hybrid strategy: semantic first, lexical fallback. */
export async function searchMemories(
	query: string,
	opts: {
		limit?: number;
		category?: string;
		endpoint?: string;
		model?: string;
	},
): Promise<SearchResult[]> {
	const limit = opts.limit ?? 5;
	const db = openDb();

	// Try semantic search first
	const queryEmbedding = await generateEmbedding(query, opts.endpoint, opts.model);

	if (queryEmbedding) {
		const blob = embeddingToBlob(queryEmbedding.embedding);

		// sqlite-vec KNN search
		// Note: requires sqlite-vec extension loaded; falls back to FTS5 if not available
		try {
			const rows = db
				.prepare(
					`SELECT m.id, m.content, m.category, m.confidence, m.thread_id, m.created_at,
					        vec_distance_cosine(m.embedding, ?) as distance
					 FROM memories m
					 WHERE m.embedding IS NOT NULL AND m.embedding_status = 'done'
					   AND (? IS NULL OR m.category = ?)
					 ORDER BY distance ASC
					 LIMIT ?`,
				)
				.all(blob, opts.category ?? null, opts.category ?? null, limit) as Array<{
				id: string;
				content: string;
				category: string;
				confidence: number;
				thread_id: string | null;
				created_at: number;
				distance: number;
			}>;

			if (rows.length > 0) {
				return rows.map((r) => ({
					id: r.id,
					content: r.content,
					category: r.category,
					confidence: r.confidence,
					thread_id: r.thread_id,
					created_at: r.created_at,
					score: 1 - r.distance, // convert distance to similarity score
					match_type: "semantic" as const,
				}));
			}
		} catch {
			// sqlite-vec not loaded or query failed — fall through to FTS5
		}
	}

	// FTS5 lexical fallback (BM25 ranking)
	const ftsRows = db
		.prepare(
			`SELECT m.id, m.content, m.category, m.confidence, m.thread_id, m.created_at,
			        rank
			 FROM memories_fts f
			 JOIN memories m ON m.rowid = f.rowid
			 WHERE memories_fts MATCH ?
			   AND (? IS NULL OR m.category = ?)
			 ORDER BY rank
			 LIMIT ?`,
		)
		.all(query, opts.category ?? null, opts.category ?? null, limit) as Array<{
		id: string;
		content: string;
		category: string;
		confidence: number;
		thread_id: string | null;
		created_at: number;
		rank: number;
	}>;

	return ftsRows.map((r) => ({
		id: r.id,
		content: r.content,
		category: r.category,
		confidence: r.confidence,
		thread_id: r.thread_id,
		created_at: r.created_at,
		score: -r.rank, // BM25 rank is negative (lower = better); negate for consistent scoring
		match_type: "lexical" as const,
	}));
}

/** Get all memories for a thread (for context injection). */
export function getMemoriesForThread(threadId: string, limit = 10): MemoryEntry[] {
	const db = openDb();
	return db
		.prepare(
			"SELECT id, content, category, confidence, thread_id, created_at FROM memories WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?",
		)
		.all(threadId, limit) as MemoryEntry[];
}