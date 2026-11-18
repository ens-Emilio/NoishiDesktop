/**
 * Context panel: what the session is made of, what it cost, and how to get it
 * out (features 28, 30, 31, 33).
 *
 * The numbers come from the CLI's own session JSONL, so they match what the
 * provider billed — nothing is re-estimated here.
 */

import { useCallback, useEffect, useState } from "react";
import type { SessionCommand, SessionCommandResult } from "@noishi/rpc-bridge";

type Run = (command: SessionCommand) => Promise<SessionCommandResult>;

type SessionCost = {
	messages: number;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: { input: number; output: number; total: number };
	byModel: { model: string; messages: number; tokens: number; cost: number }[];
	firstAt: number | null;
	lastAt: number | null;
};

type ContextSlice = { label: string; chars: number; messages: number; share: number };
type ContextBreakdown = {
	usedTokens: number;
	contextWindow: number;
	slices: ContextSlice[];
	largest: { role: string; chars: number; preview: string }[];
};

function money(value: number): string {
	return `$${value.toFixed(4)}`;
}

function duration(from: number | null, to: number | null): string {
	if (!from || !to) return "—";
	const minutes = Math.round((to - from) / 60_000);
	if (minutes < 60) return `${minutes} min`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function ContextPanel({
	run,
	sessionPath,
	contextWindow,
	usedTokens,
	onBudgetWarn,
}: {
	run: Run;
	sessionPath: string;
	contextWindow: number;
	usedTokens: number;
	onBudgetWarn: (message: string) => void;
}) {
	const [cost, setCost] = useState<SessionCost | null>(null);
	const [context, setContext] = useState<ContextBreakdown | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [portOpen, setPortOpen] = useState(false);
	const [portCwd, setPortCwd] = useState("");

	const load = useCallback(async (): Promise<void> => {
		if (!sessionPath) return;
		const [costResult, contextResult] = await Promise.all([
			run({ type: "sessionCost", sessionPath }),
			run({ type: "contextBreakdown", sessionPath, contextWindow }),
		]);
		if (costResult.ok && costResult.data) setCost(costResult.data as SessionCost);
		if (contextResult.ok && contextResult.data) setContext(contextResult.data as ContextBreakdown);
	}, [contextWindow, run, sessionPath]);

	useEffect(() => {
		void load();
	}, [load]);

	const exportAs = useCallback(
		async (kind: "markdown" | "pdf"): Promise<void> => {
			if (!sessionPath) return;
			const result = await run({ type: kind === "markdown" ? "exportMarkdown" : "exportPdf", sessionPath });
			setNote(result.ok ? `${kind}: ${JSON.stringify(result.data)}` : `falhou: ${result.error}`);
		},
		[run, sessionPath],
	);

	const port = useCallback(async (): Promise<void> => {
		const cwd = portCwd.trim();
		if (!sessionPath || !cwd) return;
		const result = await run({ type: "portSession", sessionPath, cwd });
		setNote(result.ok ? `sessão copiada para ${cwd}` : `falhou: ${result.error}`);
		if (result.ok) {
			setPortCwd("");
			setPortOpen(false);
		}
	}, [portCwd, run, sessionPath]);

	const budget = cost && cost.cost.total;

	useEffect(() => {
		if (!budget) return;
		void run({ type: "getPrefs" }).then((result) => {
			if (!result.ok || !result.data) return;
			const prefs = result.data as { budget: { warnUsd: number | null; stopUsd: number | null } };
			if (prefs.budget.warnUsd && budget >= prefs.budget.warnUsd) {
				onBudgetWarn(`orçamento: ${money(budget)} passou do aviso de ${money(prefs.budget.warnUsd)}`);
			}
		});
	}, [budget, onBudgetWarn, run]);

	const ratio = contextWindow > 0 ? Math.min(1, usedTokens / contextWindow) : 0;

	if (!sessionPath) {
		return (
			<div className="cds-panel">
				<div className="cds-panel-head">
					<b>Contexto e custo</b>
				</div>
				<div className="cds-empty">Inicie ou selecione uma conversa para ver uso de contexto, composição e custos.</div>
			</div>
		);
	}

	return (
		<div className="cds-panel">
			<div className="cds-panel-head">
				<b>Contexto e custo</b>
				<span className="cds-badge cds-badge--mono" data-tone="accent">{money(cost?.cost.total ?? 0)}</span>
				<div className="cds-toolbar">
					<button className="btn btn--ghost btn--sm" onClick={() => void load()} type="button">Atualizar</button>
				</div>
			</div>
			{note ? <div className="panel-note">{note}</div> : null}

			<div className="cds-panel-body">
				<div className="cds-section">
					<div className="cds-meter">
						<div className="cds-meter-label">
							<span>janela de contexto</span>
							<span className="mono">
								{usedTokens.toLocaleString("pt-BR")} / {contextWindow.toLocaleString("pt-BR")} · {Math.round(ratio * 100)}%
							</span>
						</div>
						<div className="cds-meter-track">
							<div
								className="cds-meter-fill"
								data-tone={ratio >= 0.9 ? "danger" : ratio >= 0.7 ? "warn" : undefined}
								style={{ width: `${Math.round(ratio * 100)}%` }}
							/>
						</div>
					</div>
				</div>

				<div className="cds-section">
					<div className="cds-stats">
						<div className="cds-stat"><b>{cost?.messages ?? 0}</b><span>mensagens</span></div>
						<div className="cds-stat"><b>{cost?.userMessages ?? 0}</b><span>seus turnos</span></div>
						<div className="cds-stat"><b>{cost?.toolCalls ?? 0}</b><span>ferramentas</span></div>
						<div className="cds-stat"><b>{duration(cost?.firstAt ?? null, cost?.lastAt ?? null)}</b><span>duração</span></div>
						<div className="cds-stat"><b>{cost?.tokens.cacheRead.toLocaleString("pt-BR") ?? 0}</b><span>cache lido</span></div>
						<div className="cds-stat"><b>{money(cost?.cost.input ?? 0)}</b><span>entrada</span></div>
					</div>
				</div>

				{context ? (
					<div className="cds-section">
						<h4>Composição do contexto</h4>
						{context.slices.map((slice) => (
							<div key={slice.label} className="cds-meter">
								<div className="cds-meter-label">
									<span>{slice.label}</span>
									<span className="mono">{slice.chars.toLocaleString("pt-BR")} ch · {slice.messages} msg</span>
								</div>
								<div className="cds-meter-track">
									<div className="cds-meter-fill" style={{ width: `${Math.max(2, Math.round(slice.share * 100))}%` }} />
								</div>
							</div>
						))}
						{context.largest.length > 0 ? (
							<details className="settings-details">
								<summary>maiores blocos</summary>
								{context.largest.map((item, index) => (
									<div key={index} className="cds-row" data-static>
										<span className="cds-badge cds-badge--mono" data-outline>{item.role} · {item.chars} ch</span>
										<span className="cds-row-main">{item.preview}…</span>
									</div>
								))}
							</details>
						) : null}
					</div>
				) : null}

				{cost && cost.byModel.length > 0 ? (
					<div className="cds-section">
						<h4>Por modelo</h4>
						{cost.byModel.map((model) => (
							<div key={model.model} className="cds-row" data-static>
								<span className="mono cds-row-main">{model.model}</span>
								<span className="cds-badge cds-badge--mono" data-outline>{model.messages} msg</span>
								<span className="cds-badge cds-badge--mono" data-outline>{model.tokens.toLocaleString("pt-BR")} tok</span>
								<span className="cds-badge cds-badge--mono" data-tone="accent">{money(model.cost)}</span>
							</div>
						))}
					</div>
				) : null}
			</div>

			{portOpen ? (
				<div className="cds-field-row" style={{ padding: "8px 14px", borderTop: "1px solid var(--line)" }}>
					<input
						className="field"
						value={portCwd}
						onChange={(e) => setPortCwd(e.target.value)}
						placeholder="/caminho/absoluto/do/projeto"
						aria-label="Projeto de destino"
						onKeyDown={(e) => {
							if (e.key === "Enter") void port();
							if (e.key === "Escape") setPortOpen(false);
						}}
					/>
					<button className="btn btn--primary btn--sm" onClick={() => void port()} disabled={!portCwd.trim()} type="button">Copiar</button>
					<button className="btn btn--ghost btn--sm" onClick={() => setPortOpen(false)} type="button">Cancelar</button>
				</div>
			) : null}

			<div className="cds-panel-foot">
				<span className="spacer" />
				<button className="btn btn--sm" onClick={() => void exportAs("markdown")} type="button">Exportar .md</button>
				<button className="btn btn--sm" onClick={() => void exportAs("pdf")} type="button">Exportar .pdf</button>
				<button className="btn btn--ghost btn--sm" onClick={() => setPortOpen((o) => !o)} type="button">Mover para projeto…</button>
			</div>
		</div>
	);
}
