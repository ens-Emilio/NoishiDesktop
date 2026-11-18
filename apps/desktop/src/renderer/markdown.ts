/**
 * Markdown rendering for agent messages.
 *
 * The agent emits Markdown; the chat used to render it as plain text. This
 * converts it to HTML with `marked` and highlights fenced code with
 * `highlight.js`. Agent output is untrusted: the HTML is sanitized with
 * DOMPurify, so injected <script>/event handlers never reach the DOM.
 */

import { Marked } from "marked";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";

const marked = new Marked({ gfm: true, breaks: true });

marked.use({
	renderer: {
		code({ text, lang }) {
			const language = lang && hljs.getLanguage(lang) ? lang : null;
			const highlighted = language ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value;
			const label = language ?? "text";
			return `<pre class="md-code"><div class="md-code-head"><span class="md-lang">${label}</span><button type="button" class="md-copy" data-copy-code="1">Copiar</button></div><code class="hljs">${highlighted}</code></pre>`;
		},
		link({ href, text }) {
			const safe = /^(https?:|mailto:|noishi:)/i.test(href) ? href : "#";
			return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${text}</a>`;
		},
	},
});

/** Render Markdown to sanitized HTML. */
export function renderMarkdown(source: string): string {
	const raw = marked.parse(source, { async: false }) as string;
	return DOMPurify.sanitize(raw, {
		ADD_ATTR: ["target", "rel", "data-copy-code"],
		FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
	});
}
