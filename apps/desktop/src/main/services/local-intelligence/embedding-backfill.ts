/**
 * Embedding Backfill Worker.
 *
 * Periodically scans for memories with embedding_status='pending' and
 * attempts to generate embeddings. On success, updates the row with the
 * embedding blob and marks status='done'. On failure, leaves status='pending'
 * for the next cycle. Failed permanently after MAX_RETRIES → status='failed'.
 *
 * This ensures memory insertion NEVER blocks on embedding availability.
 */

import { openDb } from "./db.js";
import { embeddingToBlob, generateEmbedding } from "./embeddings.js";

const BACKFILL_INTERVAL_MS = 60_000; // check every 60s
const BATCH_SIZE = 10; // process up to 10 pending per cycle
const MAX_RETRIES = 5;

let timer: NodeJS.Timeout | null = null;
let processing = false;

interface PendingMemory {
	id: string;
	content: string;
	retry_count: number;
}

async function processBatch(): Promise<void> {
	if (processing) return;
	processing = true;

	try {
		const db = openDb();

		const pending = db
			.prepare(
				"SELECT id, content FROM memories WHERE embedding_status = 'pending' LIMIT ?",
			)
			.all(BATCH_SIZE) as PendingMemory[];

		if (pending.length === 0) return;

		console.log(`[backfill] Processing ${pending.length} pending embeddings`);

		for (const mem of pending) {
			const result = await generateEmbedding(mem.content);

			if (result) {
				const blob = embeddingToBlob(result.embedding);
				db.prepare(
					"UPDATE memories SET embedding = ?, embedding_status = 'done', embedding_model = ? WHERE id = ?",
				).run(blob, result.model, mem.id);
			} else {
				// Increment retry count; mark failed after MAX_RETRIES
				const retries = (mem.retry_count ?? 0) + 1;
				const newStatus = retries >= MAX_RETRIES ? "failed" : "pending";
				db.prepare(
					"UPDATE memories SET embedding_status = ? WHERE id = ?",
				).run(newStatus, mem.id);
			}
		}
	} catch (err) {
		console.error("[backfill] Batch error:", err);
	} finally {
		processing = false;
	}
}

/** Start the periodic backfill worker. */
export function startBackfill(): void {
	clearInterval(timer!);
	timer = setInterval(() => {
		void processBatch();
	}, BACKFILL_INTERVAL_MS);
}

/** Stop the backfill worker. */
export function stopBackfill(): void {
	clearInterval(timer!);
	timer = null;
}

/** Trigger an immediate backfill pass (useful after inserting new memories). */
export async function triggerBackfill(): Promise<void> {
	await processBatch();
}