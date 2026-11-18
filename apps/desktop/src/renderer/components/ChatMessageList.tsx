import { memo, useEffect, useMemo, useState } from "react";
import { getCachedMarkdown, renderMarkdownAsync } from "../markdownWorkerClient.js";
import type { ChatBlock } from "../stores/sessionStore.js";

type DiffLine = { n: string; text: string; kind: "" | "add" | "del" };

function parseArgs(raw: string): Record<string, unknown> | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	try {
		const value = JSON.parse(trimmed) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function diffFromTool(toolName: string, raw: string): { file: string; lines: DiffLine[]; add: number; del: number } | null {
	const args = parseArgs(raw);
	if (!args) return null;
	const file = readString(args.path) ?? readString(args.file_path) ?? "";
	if (toolName === "edit") {
		const edits = Array.isArray(args.edits) ? args.edits : [];
		const rows: DiffLine[] = [];
		let add = 0;
		let del = 0;
		for (const edit of edits) {
			if (typeof edit !== "object" || edit === null) continue;
			const rec = edit as Record<string, unknown>;
			const oldText = readString(rec.oldText) ?? readString(rec.oldString) ?? "";
			const newText = readString(rec.newText) ?? readString(rec.newString) ?? "";
			for (const line of oldText.split("\n")) {
				if (!line) continue;
				rows.push({ n: "", text: `- ${line}`, kind: "del" });
				del++;
			}
			for (const line of newText.split("\n")) {
				if (!line) continue;
				rows.push({ n: "", text: `+ ${line}`, kind: "add" });
				add++;
			}
		}
		return rows.length ? { file, lines: rows, add, del } : null;
	}
	if (toolName === "write") {
		const content = readString(args.content);
		if (!content) return null;
		const rows = content.split("\n").map((line, index) => ({ n: String(index + 1), text: `+ ${line}`, kind: "add" as const }));
		return { file, lines: rows, add: rows.length, del: 0 };
	}
	return null;
}

const MarkdownBody = memo(function MarkdownBody({ content, onCopy }: { content: string; onCopy: (text: string) => void }) {
	const [html, setHtml] = useState<string>(() => getCachedMarkdown(content) ?? "");

	useEffect(() => {
		const cached = getCachedMarkdown(content);
		if (cached !== undefined) {
			setHtml(cached);
			return;
		}
		let cancelled = false;
		void renderMarkdownAsync(content).then((rendered) => {
			if (!cancelled) setHtml(rendered);
		});
		return () => {
			cancelled = true;
		};
	}, [content]);

	return (
		<div
			className="voice md"
			onClick={(e) => {
				const target = e.target;
				if (!(target instanceof HTMLElement)) return;
				const btn = target.closest<HTMLButtonElement>("[data-copy-code]");
				if (!btn) return;
				const code = btn.closest("pre")?.querySelector("code")?.textContent ?? "";
				if (!code) return;
				onCopy(code);
				btn.textContent = "Copiado";
				setTimeout(() => {
					btn.textContent = "Copiar";
				}, 1200);
			}}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
});

const ToolBlock = memo(function ToolBlock({
	block,
	terminalIcon,
}: {
	block: Extract<ChatBlock, { kind: "tool" }>;
	terminalIcon: React.ReactNode;
}) {
	const diff = useMemo(() => (block.streaming ? null : diffFromTool(block.toolName, block.args)), [block.args, block.streaming, block.toolName]);
	return (
		<div className="toolcall">
			<div className="tool-head">
				{terminalIcon}
				<span className="toolname">{block.toolName}</span>
				<span className={`tool-state ${block.streaming ? "is-live" : "is-ok"}`}>
					{block.streaming ? "executando…" : "concluído"}
				</span>
			</div>
			{diff ? (
				<>
					<div className="tool-meta">
						<span>{diff.file || "arquivo"}</span>
						<span className="add">+{diff.add}</span>
						<span className="del">−{diff.del}</span>
					</div>
					<div className="diff">
						{diff.lines.map((line, index) => (
							<div key={index} className={`diff-line ${line.kind}`}>
								<span className="diff-n">{line.n}</span>
								<span className="diff-c">{line.text}</span>
							</div>
						))}
					</div>
				</>
			) : block.args || block.output ? (
				<pre>{block.args}{block.output}</pre>
			) : null}
		</div>
	);
});

export const ChatBlockRow = memo(function ChatBlockRow({
	block,
	onFork,
	onCopy,
	onEdit,
	icons,
}: {
	block: ChatBlock;
	onFork: (entryId: string) => void;
	onCopy: (text: string) => void;
	onEdit: (blockId: number, content: string) => void;
	icons: { fork: React.ReactNode; copy: React.ReactNode; edit: React.ReactNode; terminal: React.ReactNode };
}) {
	switch (block.kind) {
		case "text":
			if (block.role === "user") {
				return (
					<div className="row user">
						<div className="bubble">{block.content}</div>
					</div>
				);
			}
			return (
				<div className="row assistant msg-stack">
					<div>
						<MarkdownBody content={block.content} onCopy={onCopy} />
						{block.streaming ? <span className="cursor" /> : null}
						{!block.streaming ? (
							<div className="msg-tools">
								<button
									className="btn btn--ghost btn--sm"
									onClick={() => { if (block.entryId) onFork(block.entryId); }}
									disabled={!block.entryId}
									title={block.entryId ? "Fork desta mensagem" : "Sem entry id"}
									type="button"
								>
									{icons.fork}
									Fork daqui
								</button>
								<button className="btn btn--ghost btn--icon btn--sm" onClick={() => onCopy(block.content)} title="Copiar" aria-label="Copiar resposta" type="button">
									{icons.copy}
								</button>
								<button
									className="btn btn--ghost btn--icon btn--sm"
									onClick={() => onEdit(block.id, block.content)}
									title="Editar"
									aria-label="Editar e reenviar"
									type="button"
								>
									{icons.edit}
								</button>
							</div>
						) : null}
					</div>
				</div>
			);
		case "thinking":
			return (
				<details className="thinking">
					<summary>{block.streaming ? "pensando…" : "raciocínio"}</summary>
					<pre>{block.content}</pre>
				</details>
			);
		case "tool":
			return <ToolBlock block={block} terminalIcon={icons.terminal} />;
		case "error":
			return <div className={`error${block.info ? " is-info" : ""}`}>{block.message}</div>;
	}
});
