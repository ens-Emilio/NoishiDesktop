import DOMPurify from "dompurify";
import type { MarkdownWorkerRequest, MarkdownWorkerResponse } from "./workers/markdown.worker";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (rawHtml: string) => void>();
const htmlCache = new Map<string, string>();
const CACHE_LIMIT = 300;

function sanitizeHtml(raw: string): string {
	return DOMPurify.sanitize(raw, {
		ADD_ATTR: ["target", "rel", "data-copy-code"],
		FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
	});
}

function cacheSet(key: string, value: string): void {
	if (htmlCache.size >= CACHE_LIMIT) {
		const oldest = htmlCache.keys().next().value;
		if (oldest !== undefined) htmlCache.delete(oldest);
	}
	htmlCache.set(key, value);
}

function getWorker(): Worker | null {
	if (typeof Worker === "undefined") return null;
	if (!worker) {
		worker = new Worker(new URL("./workers/markdown.worker.ts", import.meta.url), {
			type: "module",
		});
		worker.onmessage = (event: MessageEvent<MarkdownWorkerResponse>): void => {
			const { id, html } = event.data;
			const resolve = pending.get(id);
			if (resolve) {
				pending.delete(id);
				resolve(html);
			}
		};
	}
	return worker;
}

export function getCachedMarkdown(markdown: string): string | undefined {
	return htmlCache.get(markdown);
}

export async function renderMarkdownAsync(markdown: string): Promise<string> {
	const cached = htmlCache.get(markdown);
	if (cached !== undefined) return cached;
	const w = getWorker();
	if (!w) {
		const { renderMarkdown } = await import("./markdown.js");
		const safe = renderMarkdown(markdown);
		cacheSet(markdown, safe);
		return safe;
	}
	const id = nextId++;
	const raw = await new Promise<string>((resolve) => {
		pending.set(id, resolve);
		const req: MarkdownWorkerRequest = { id, markdown };
		w.postMessage(req);
	});
	// DOMPurify runs on the main thread where a real DOM exists.
	const safe = sanitizeHtml(raw);
	cacheSet(markdown, safe);
	return safe;
}
