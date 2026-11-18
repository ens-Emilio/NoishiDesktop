/**
 * Review panel: the accumulated diff of a session, with accept/reject per file.
 *
 * The diff comes from the main process (checkpoints pre-images vs. disk), so
 * this component never guesses what changed. Word-level highlighting and the
 * side-by-side layout are pure presentation over the same hunks.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionCommand, SessionCommandResult } from "@noishi/rpc-bridge";

type HunkLine = { kind: " " | "-" | "+"; text: string };
type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: HunkLine[] };
type FileDiff = {
	path: string;
	patch: string;
	hunks: Hunk[];
	add: number;
	del: number;
	status: "added" | "modified" | "deleted";
	entryId: string;
	createdAt: number;
};
type BlameLine = { line: number; hash: string; author: string; date: string; summary: string };
type ConflictView = { path: string; ours: string[]; theirs: string[]; hasMarkers: boolean };
type Checkpoint = { entryId: string; createdAt: number; files: number };

type Run = (command: SessionCommand) => Promise<SessionCommandResult>;

/** Split a line into tokens so a changed word can be marked inside it. */
function words(text: string): string[] {
	return text.split(/(\s+)/).filter((token) => token.length > 0);
}

function WordDiff({ before, after }: { before: string; after: string }) {
	const left = words(before);
	const right = words(after);
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	return (
		<div className="word-diff">
			<div className="word-side">
				{left.map((token, index) => (
					<span key={index} className={rightSet.has(token) ? "" : "word-del"}>{token}</span>
				))}
			</div>
			<div className="word-side">
				{right.map((token, index) => (
					<span key={index} className={leftSet.has(token) ? "" : "word-add"}>{token}</span>
				))}
			</div>
		</div>
	);
}

/** Pair removed/added lines inside a hunk so word diffs have something to compare. */
function pairedLines(hunk: Hunk): { before: string; after: string }[] {
	const removed = hunk.lines.filter((line) => line.kind === "-").map((line) => line.text);
	const added = hunk.lines.filter((line) => line.kind === "+").map((line) => line.text);
	const pairs: { before: string; after: string }[] = [];
	for (let i = 0; i < Math.max(removed.length, added.length); i++) {
		pairs.push({ before: removed[i] ?? "", after: added[i] ?? "" });
	}
	return pairs;
}

export function ReviewPanel({ run, cwd, sessionId }: { run: Run; cwd: string; sessionId: string }) {
	const [diffs, setDiffs] = useState<FileDiff[]>([]);
	const [open, setOpen] = useState<string | null>(null);
	const [sideBySide, setSideBySide] = useState(false);
	const [wordLevel, setWordLevel] = useState(true);
	const [blame, setBlame] = useState<{ path: string; lines: BlameLine[] } | null>(null);
	const [conflict, setConflict] = useState<ConflictView | null>(null);
	const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
	const [message, setMessage] = useState<string | null>(null);
	const [confirmReject, setConfirmReject] = useState<string | null>(null);
	const [reviewed, setReviewed] = useState<Record<string, boolean>>({});

	const load = useCallback(async (): Promise<void> => {
		if (!sessionId) return;
		const [diffResult, checkpointResult] = await Promise.all([
			run({ type: "sessionDiff", sessionId }),
			run({ type: "listCheckpoints", sessionId }),
		]);
		if (diffResult.ok && Array.isArray(diffResult.data)) setDiffs(diffResult.data as FileDiff[]);
		if (checkpointResult.ok && Array.isArray(checkpointResult.data)) setCheckpoints(checkpointResult.data as Checkpoint[]);
	}, [run, sessionId]);

	/** Rewind every file touched at or after a checkpoint (feature 3). */
	const rewind = useCallback(
		async (entryId: string): Promise<void> => {
			const result = await run({ type: "rewindTo", sessionId, entryId });
			const data = result.ok ? (result.data as { ok: boolean; reverted: string[]; error?: string }) : null;
			setMessage(data?.ok ? `rewind: ${data.reverted.length} arquivos revertidos` : `falhou: ${data?.error ?? (result.ok ? "?" : result.error)}`);
			await load();
		},
		[load, run, sessionId],
	);

	useEffect(() => {
		void load();
	}, [load]);

	const reject = useCallback(
		async (diff: FileDiff): Promise<void> => {
			const result = await run({ type: "revertFile", sessionId, entryId: diff.entryId, path: diff.path });
			setMessage(result.ok ? `${diff.path}: revertido ao estado anterior` : `falhou: ${result.error}`);
			await load();
		},
		[load, run, sessionId],
	);

	const showBlame = useCallback(
		async (path: string): Promise<void> => {
			const result = await run({ type: "gitBlame", cwd, path });
			if (result.ok && Array.isArray(result.data)) setBlame({ path, lines: result.data as BlameLine[] });
		},
		[cwd, run],
	);

	const showConflict = useCallback(
		async (path: string): Promise<void> => {
			const result = await run({ type: "gitConflicts", cwd, path });
			if (result.ok && result.data) setConflict(result.data as ConflictView);
		},
		[cwd, run],
	);

	const resolve = useCallback(
		async (choice: "ours" | "theirs"): Promise<void> => {
			if (!conflict) return;
			await run({ type: "gitResolveConflict", cwd, path: conflict.path, choice });
			setConflict(null);
			await load();
		},
		[conflict, cwd, load, run],
	);

	const total = useMemo(
		() => diffs.reduce((sum, diff) => ({ add: sum.add + diff.add, del: sum.del + diff.del }), { add: 0, del: 0 }),
		[diffs],
	);

	return (
		<div className="cds-panel">
			<div className="cds-panel-head">
				<b>Revisão</b>
				<span className="cds-badge cds-badge--mono" data-outline>{diffs.length} arquivos</span>
				<span className="cds-badge cds-badge--mono" data-tone="ok">+{total.add}</span>
				<span className="cds-badge cds-badge--mono" data-tone="danger">−{total.del}</span>
				<div className="cds-toolbar">
					<div className="cds-segmented">
						<button aria-pressed={sideBySide} onClick={() => setSideBySide((v) => !v)} type="button">lado a lado</button>
						<button aria-pressed={wordLevel} onClick={() => setWordLevel((v) => !v)} type="button">palavra</button>
					</div>
					<button className="btn btn--ghost btn--sm" onClick={() => void load()} type="button">Atualizar</button>
				</div>
			</div>
			{message ? <div className="panel-note">{message}</div> : null}
			<div className="cds-panel-body">
			{diffs.length === 0 ? <div className="cds-empty">Nenhuma alteração registrada nesta sessão.</div> : null}
			<div className="review-list">
				{diffs.map((diff) => (
					<div key={diff.path} className="review-file">
						<div className="cds-row">
							<button className="review-toggle cds-row-main" onClick={() => setOpen(open === diff.path ? null : diff.path)} type="button">
								{diff.path}
							</button>
							<span className="cds-badge" data-tone={diff.status === "added" ? "ok" : diff.status === "deleted" ? "danger" : "warn"}>{diff.status}</span>
							<span className="cds-badge cds-badge--mono" data-tone="ok">+{diff.add}</span>
							<span className="cds-badge cds-badge--mono" data-tone="danger">−{diff.del}</span>
							<button className="btn btn--ghost btn--sm" onClick={() => void showBlame(diff.path)} type="button">blame</button>
							<button className="btn btn--ghost btn--sm" onClick={() => void showConflict(diff.path)} type="button">conflito</button>
							{confirmReject === diff.path ? (
								<>
									<button
										className="btn btn--danger btn--sm"
										onClick={() => {
											setConfirmReject(null);
											void reject(diff);
										}}
										type="button"
									>
										Confirmar reversão
									</button>
									<button className="btn btn--ghost btn--sm" onClick={() => setConfirmReject(null)} type="button">Cancelar</button>
								</>
							) : (
								<button className="btn btn--sm" onClick={() => setConfirmReject(diff.path)} type="button">Reverter</button>
							)}
							<button
								className={`btn btn--sm ${reviewed[diff.path] ? "btn--ghost" : "btn--primary"}`}
								onClick={() => {
									setReviewed((prev) => ({ ...prev, [diff.path]: !prev[diff.path] }));
									setMessage(reviewed[diff.path] ? `${diff.path}: revisão reaberta` : `${diff.path}: marcado como revisado`);
								}}
								type="button"
							>
								{reviewed[diff.path] ? "Revisado ✓" : "Marcar revisado"}
							</button>
						</div>
						{open === diff.path ? (
							<div className={`review-body${sideBySide ? " is-split" : ""}`}>
								{diff.hunks.map((hunk, hunkIndex) => (
									<div key={hunkIndex} className="review-hunk">
										<div className="review-hunk-head mono">
											@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
										</div>
										{sideBySide ? (
											<div className="review-split">
												<div className="review-side">
													{hunk.lines.filter((line) => line.kind !== "+").map((line, index) => (
														<div key={index} className={`diff-line ${line.kind === "-" ? "del" : ""}`}>
															<span className="diff-c">{line.text}</span>
														</div>
													))}
												</div>
												<div className="review-side">
													{hunk.lines.filter((line) => line.kind !== "-").map((line, index) => (
														<div key={index} className={`diff-line ${line.kind === "+" ? "add" : ""}`}>
															<span className="diff-c">{line.text}</span>
														</div>
													))}
												</div>
											</div>
										) : (
											hunk.lines.map((line, index) => (
												<div key={index} className={`diff-line ${line.kind === "+" ? "add" : line.kind === "-" ? "del" : ""}`}>
													<span className="diff-c">{line.text}</span>
												</div>
											))
										)}
										{wordLevel && !sideBySide
											? pairedLines(hunk)
													.filter((pair) => pair.before && pair.after)
													.slice(0, 6)
													.map((pair, index) => <WordDiff key={index} before={pair.before} after={pair.after} />)
											: null}
									</div>
								))}
							</div>
						) : null}
					</div>
				))}
			</div>

			{checkpoints.length > 0 ? (
				<div className="cds-section">
					<h4>Checkpoints (rewind até aqui)</h4>
					{checkpoints.slice(0, 12).map((checkpoint) => (
						<div key={checkpoint.entryId} className="cds-row" data-static>
							<span className="mono cds-row-main">{new Date(checkpoint.createdAt).toLocaleTimeString("pt-BR")}</span>
							<span className="cds-badge cds-badge--mono" data-outline>{checkpoint.files} arq.</span>
							<button className="btn btn--ghost btn--sm" onClick={() => void rewind(checkpoint.entryId)} type="button">Rewind</button>
						</div>
					))}
				</div>
			) : null}
			</div>

			{blame ? (
				<div className="panel-sheet">
					<div className="panel-head">
						<b className="mono">{blame.path}</b>
						<span className="spacer" />
						<button className="btn btn--ghost btn--sm" onClick={() => setBlame(null)} type="button">Fechar</button>
					</div>
					<div className="blame-list">
						{blame.lines.slice(0, 400).map((line) => (
							<div key={line.line} className="cds-row" data-static>
								<span className="mono blame-n">{line.line}</span>
								<span className="cds-badge cds-badge--mono" data-outline>{line.hash}</span>
								<span className="blame-author">{line.author}</span>
								<span className="mono blame-date">{line.date}</span>
								<span className="blame-summary cds-row-main">{line.summary}</span>
							</div>
						))}
					</div>
				</div>
			) : null}

			{conflict ? (
				<div className="panel-sheet">
					<div className="panel-head">
						<b className="mono">{conflict.path}</b>
						<span className="spacer" />
						<button className="btn btn--sm" onClick={() => void resolve("ours")} type="button">Ficar com ours</button>
						<button className="btn btn--sm" onClick={() => void resolve("theirs")} type="button">Ficar com theirs</button>
						<button className="btn btn--ghost btn--sm" onClick={() => setConflict(null)} type="button">Fechar</button>
					</div>
					{conflict.hasMarkers ? (
						<div className="review-split">
							<pre className="conflict-side">{conflict.ours.join("\n") || "(vazio)"}</pre>
							<pre className="conflict-side">{conflict.theirs.join("\n") || "(vazio)"}</pre>
						</div>
					) : (
						<div className="panel-empty">Sem marcadores de conflito neste arquivo.</div>
					)}
				</div>
			) : null}
		</div>
	);
}
