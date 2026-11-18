/**
 * Git panel: status, staging, commit, worktrees and per-session commit.
 *
 * Everything is a thin view over the main-process git service; the panel never
 * runs git itself. A non-repository cwd renders as a single line, not an error.
 */

import { useCallback, useEffect, useState } from "react";
import type { SessionCommand, SessionCommandResult } from "@noishi/rpc-bridge";

type GitFile = { path: string; status: string; staged: boolean };
type GitStatus = {
	isRepo: boolean;
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	files: GitFile[];
	conflicts: string[];
};
type Worktree = { path: string; branch: string | null; head: string | null };

type Run = (command: SessionCommand) => Promise<SessionCommandResult>;

/** Tom do badge por status git — cor só onde significa estado. */
const TONE: Record<string, string> = { M: "warn", A: "ok", D: "danger", U: "danger", "?": "accent" };

const STATUS_LABEL: Record<string, string> = {
	M: "modificado",
	A: "adicionado",
	D: "removido",
	R: "renomeado",
	"?": "novo",
	U: "conflito",
};

export function GitPanel({ run, cwd, sessionId }: { run: Run; cwd: string; sessionId: string }) {
	const [status, setStatus] = useState<GitStatus | null>(null);
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [message, setMessage] = useState("");
	const [note, setNote] = useState<string | null>(null);
	const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
	const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		if (!cwd) return;
		const [statusResult, worktreeResult] = await Promise.all([
			run({ type: "gitStatus", cwd }),
			run({ type: "gitWorktrees", cwd }),
		]);
		if (statusResult.ok && statusResult.data) setStatus(statusResult.data as GitStatus);
		if (worktreeResult.ok && Array.isArray(worktreeResult.data)) setWorktrees(worktreeResult.data as Worktree[]);
	}, [cwd, run]);

	useEffect(() => {
		void load();
	}, [load]);

	const stage = useCallback(
		async (path: string, staged: boolean): Promise<void> => {
			await run(staged ? { type: "gitUnstage", cwd, paths: [path] } : { type: "gitStage", cwd, paths: [path] });
			await load();
		},
		[cwd, load, run],
	);

	const discard = useCallback(
		async (path: string): Promise<void> => {
			await run({ type: "gitDiscard", cwd, path });
			await load();
		},
		[cwd, load, run],
	);

	const commit = useCallback(async (): Promise<void> => {
		const text = message.trim();
		if (!text) return;
		const result = await run({ type: "gitCommit", cwd, message: text });
		const data = result.ok ? (result.data as { ok: boolean; hash?: string; error?: string }) : null;
		setNote(data?.ok ? `commit ${data.hash}` : `falhou: ${data?.error ?? (result.ok ? "?" : result.error)}`);
		if (data?.ok) setMessage("");
		await load();
	}, [cwd, load, message, run]);

	const commitSession = useCallback(async (): Promise<void> => {
		const text = message.trim() || "sessão Noishi";
		const result = await run({ type: "gitCommitSession", cwd, message: text, sessionId });
		const data = result.ok ? (result.data as { ok: boolean; hash?: string; error?: string }) : null;
		setNote(data?.ok ? `commit da sessão ${data.hash}` : `falhou: ${data?.error ?? (result.ok ? "?" : result.error)}`);
		await load();
	}, [cwd, message, run, sessionId]);

	const worktree = useCallback(async (): Promise<void> => {
		const result = await run({ type: "gitWorktreeForSession", cwd, sessionId });
		setNote(result.ok ? `worktree: ${(result.data as Worktree).path}` : `falhou: ${result.error}`);
		await load();
	}, [cwd, load, run, sessionId]);

	const showDiff = useCallback(
		async (path: string, staged: boolean): Promise<void> => {
			const result = await run({ type: "gitDiff", cwd, path, staged });
			setDiff({ path, text: result.ok ? String(result.data ?? "") : `erro: ${result.error}` });
		},
		[cwd, run],
	);

	if (status && !status.isRepo) return <div className="panel-empty">Este projeto não é um repositório git.</div>;

	return (
		<div className="cds-panel">
			<div className="cds-panel-head">
				<b>Git</b>
				<span className="cds-badge cds-badge--mono" data-outline>
					{status?.branch ?? "—"}
					{status?.upstream ? ` → ${status.upstream}` : ""}
				</span>
				{status && (status.ahead || status.behind) ? (
					<span className="cds-badge cds-badge--mono" data-tone="accent">↑{status.ahead} ↓{status.behind}</span>
				) : null}
				<div className="cds-toolbar">
					<button className="btn btn--ghost btn--sm" onClick={() => void load()} type="button">Atualizar</button>
				</div>
			</div>
			{note ? <div className="panel-note">{note}</div> : null}
			<div className="git-commit">
				<input
					className="field"
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					placeholder="mensagem do commit"
					aria-label="Mensagem do commit"
					onKeyDown={(e) => {
						if (e.key === "Enter") void commit();
					}}
				/>
				<button className="btn btn--primary btn--sm" onClick={() => void commit()} disabled={!message.trim()} type="button">Commit</button>
				<button className="btn btn--sm" onClick={() => void commitSession()} disabled={!sessionId} type="button">Commit da sessão</button>
				<button className="btn btn--ghost btn--sm" onClick={() => void worktree()} disabled={!sessionId} type="button">Worktree</button>
			</div>
			<div className="cds-panel-body">
				{status?.files.length === 0 ? <div className="cds-empty">Árvore limpa.</div> : null}
				{status?.files.map((file) => (
					<div key={`${file.path}-${file.staged}`} className="cds-row">
						<button className="git-path mono cds-row-main" onClick={() => void showDiff(file.path, file.staged)} type="button" title="Ver diff">
							{file.path}
						</button>
						<span className="cds-badge" data-tone={TONE[file.status] ?? "neutral"}>{STATUS_LABEL[file.status] ?? file.status}</span>
						<span className="cds-badge cds-badge--mono" data-outline>{file.staged ? "staged" : "worktree"}</span>
						<button className="btn btn--ghost btn--sm" onClick={() => void stage(file.path, file.staged)} type="button">
							{file.staged ? "Unstage" : "Stage"}
						</button>
						{!file.staged ? (
							confirmDiscard === file.path ? (
								<>
									<button
										className="btn btn--danger btn--sm"
										onClick={() => {
											setConfirmDiscard(null);
											void discard(file.path);
										}}
										type="button"
									>
										Confirmar
									</button>
									<button className="btn btn--ghost btn--sm" onClick={() => setConfirmDiscard(null)} type="button">Cancelar</button>
								</>
							) : (
								<button className="btn btn--ghost btn--sm" onClick={() => setConfirmDiscard(file.path)} type="button">Descartar</button>
							)
						) : null}
					</div>
				))}
			</div>
			{worktrees.length > 1 ? (
				<div className="cds-section">
					<h4>Worktrees</h4>
					{worktrees.map((tree) => (
						<div key={tree.path} className="cds-row" data-static>
							<span className="mono cds-row-main">{tree.path}</span>
							<span className="cds-badge cds-badge--mono" data-outline>{tree.branch ?? "(detached)"}</span>
						</div>
					))}
				</div>
			) : null}
			{diff ? (
				<div className="panel-sheet">
					<div className="panel-head">
						<b className="mono">{diff.path}</b>
						<span className="spacer" />
						<button className="btn btn--ghost btn--sm" onClick={() => setDiff(null)} type="button">Fechar</button>
					</div>
					<pre className="git-diff">{diff.text || "(sem diferenças)"}</pre>
				</div>
			) : null}
		</div>
	);
}
