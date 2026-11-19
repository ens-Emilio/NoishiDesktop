/**
 * OpenAI-compatible embeddings client.
 *
 * Works with Ollama local (http://localhost:11434/v1), OpenAI, or any
 * compatible endpoint. Returns null on failure — callers must handle
 * degradation (e.g., fall back to FTS5 lexical search).
 */

const DEFAULT_ENDPOINT = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const DEFAULT_MODEL = "nomic-embed-text";
const EMBEDDING_DIM = 768; // nomic-embed-text dimension

export interface EmbeddingResult {
	embedding: Float32Array;
	model: string;
}

/** Generate an embedding for the given text. Returns null if the endpoint is unreachable. */
export async function generateEmbedding(
	text: string,
	endpoint?: string,
	model?: string,
): Promise<EmbeddingResult | null> {
	const baseUrl = endpoint ?? DEFAULT_ENDPOINT;
	const modelName = model ?? DEFAULT_MODEL;

	try {
		const res = await fetch(`${baseUrl}/v1/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: modelName,
				input: text,
			}),
			signal: AbortSignal.timeout(10_000), // 10s timeout
		});

		if (!res.ok) {
			console.warn(`[embeddings] Endpoint returned ${res.status}`);
			return null;
		}

		const json = (await res.json()) as {
			data: Array<{ embedding: number[] }>;
			model: string;
		};

		if (!json.data?.[0]?.embedding) {
			console.warn("[embeddings] No embedding in response");
			return null;
		}

		return {
			embedding: new Float32Array(json.data[0].embedding),
			model: json.model ?? modelName,
		};
	} catch (err) {
		console.warn(`[embeddings] Failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

/** Serialize a Float32Array to a Buffer for SQLite BLOB storage (sqlite-vec native format). */
export function embeddingToBlob(embedding: Float32Array): Buffer {
	return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/** Deserialize a SQLite BLOB back to Float32Array. */
export function blobToEmbedding(blob: Buffer): Float32Array {
	return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

export { EMBEDDING_DIM };