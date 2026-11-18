import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { Marked } from "marked";

const marked = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		code({ text, lang }: { text: string; lang?: string }): string {
			const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
			const highlighted = hljs.highlight(text, { language }).value;
			return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
		},
	},
});

export type MarkdownWorkerRequest = {
	id: number;
	markdown: string;
};

export type MarkdownWorkerResponse = {
	id: number;
	html: string;
};

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>): void => {
	const { id, markdown } = event.data;
	const raw = marked.parse(markdown, { async: false }) as string;
	const html = DOMPurify.sanitize(raw);
	const response: MarkdownWorkerResponse = { id, html };
	self.postMessage(response);
};
