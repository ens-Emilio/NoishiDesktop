import hljs from "highlight.js/lib/common";
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: true });

marked.use({
	renderer: {
		code({ text, lang }: { text: string; lang?: string }): string {
			const language = lang && hljs.getLanguage(lang) ? lang : null;
			const highlighted = language ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value;
			const label = language ?? "text";
			return `<pre class="md-code"><div class="md-code-head"><span class="md-lang">${label}</span><button type="button" class="md-copy" data-copy-code="1">Copiar</button></div><code class="hljs">${highlighted}</code></pre>`;
		},
		link({ href, text }: { href: string; text: string }): string {
			const safe = /^(https?:|mailto:|noishi:)/i.test(href) ? href : "#";
			return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${text}</a>`;
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
	const html = marked.parse(markdown, { async: false }) as string;
	const response: MarkdownWorkerResponse = { id, html };
	self.postMessage(response);
};
