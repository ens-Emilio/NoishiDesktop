import type { MarkdownWorkerRequest, MarkdownWorkerResponse } from "./workers/markdown.worker";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (html: string) => void>();

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

export function renderMarkdownAsync(markdown: string): Promise<string> {
	const w = getWorker();
	if (!w) return Promise.resolve(markdown);
	const id = nextId++;
	return new Promise<string>((resolve) => {
		pending.set(id, resolve);
		const req: MarkdownWorkerRequest = { id, markdown };
		w.postMessage(req);
	});
}
