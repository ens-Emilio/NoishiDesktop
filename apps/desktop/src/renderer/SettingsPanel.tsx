/**
 * Settings panel: everything the prefs file holds, in one place.
 *
 * Sections map 1:1 to the features they serve: approval policy (5), budget
 * guard (29), shortcuts (45), themes (46), zoom (47), telemetry (50), sandbox
 * allowlist and limits (39, 40), diagnostics (48), updates (42, 43).
 */

import { useCallback, useEffect, useState } from "react";
import type { ApprovalRule, SessionCommand, SessionCommandResult, Shortcut } from "@noishi/rpc-bridge";

type Run = (command: SessionCommand) => Promise<SessionCommandResult>;

type Prefs = {
	theme: "dark" | "light" | "system";
	zoomLevel: number;
	chatFontSize: number;
	shortcuts: Shortcut[];
	approvalRules: ApprovalRule[];
	budget: { warnUsd: number | null; stopUsd: number | null };
	sandbox: { allowlist: string[]; maxCpu: number; maxMemoryMb: number; maxSeconds: number };
	telemetry: { enabled: boolean; endpoint: string | null };
};

type DiagnosticItem = { name: string; ok: boolean; detail: string };
type Theme = { name: string; tokens: Record<string, string> };
type UpdateCheck = { current: string; latest: string | null; updateAvailable: boolean; url: string | null; error?: string };
type CliCheck = { path: string | null; version: string | null; compatible: boolean; minimum: string; error?: string };

const DECISIONS: ApprovalRule["decision"][] = ["ask", "allow", "deny"];

export function SettingsPanel({ run, onPrefs }: { run: Run; onPrefs: (prefs: Prefs) => void }) {
	const [prefs, setPrefs] = useState<Prefs | null>(null);
	const [themes, setThemes] = useState<Theme[]>([]);
	const [diagnostics, setDiagnostics] = useState<{ items: DiagnosticItem[]; app: Record<string, string> } | null>(null);
	const [update, setUpdate] = useState<UpdateCheck | null>(null);
	const [cli, setCli] = useState<CliCheck | null>(null);
	const [crashes, setCrashes] = useState<string[]>([]);
	const [note, setNote] = useState<string | null>(null);
	const [ruleTool, setRuleTool] = useState("");
	const [rulePattern, setRulePattern] = useState("");
	const [allowlistText, setAllowlistText] = useState("");

	const apply = useCallback(
		(next: Prefs): void => {
			setPrefs(next);
			onPrefs(next);
		},
		[onPrefs],
	);

	const load = useCallback(async (): Promise<void> => {
		const [prefsResult, themesResult] = await Promise.all([run({ type: "getPrefs" }), run({ type: "listThemes" })]);
		if (prefsResult.ok && prefsResult.data) {
			const data = prefsResult.data as Prefs;
			apply(data);
			setAllowlistText(data.sandbox.allowlist.join("\n"));
		}
		if (themesResult.ok && Array.isArray(themesResult.data)) setThemes(themesResult.data as Theme[]);
	}, [apply, run]);

	useEffect(() => {
		void load();
	}, [load]);

	const patch = useCallback(
		async (value: Record<string, unknown>): Promise<void> => {
			const result = await run({ type: "setPrefs", patch: value });
			if (result.ok && result.data) apply(result.data as Prefs);
		},
		[apply, run],
	);

	const addRule = useCallback(async (): Promise<void> => {
		if (!prefs || !ruleTool.trim()) return;
		const rule: ApprovalRule = { tool: ruleTool.trim(), decision: "ask" };
		if (rulePattern.trim()) rule.pattern = rulePattern.trim();
		const result = await run({ type: "setApprovalRules", rules: [...prefs.approvalRules, rule] });
		if (result.ok && Array.isArray(result.data)) {
			apply({ ...prefs, approvalRules: result.data as ApprovalRule[] });
			setRuleTool("");
			setRulePattern("");
		}
	}, [apply, prefs, rulePattern, ruleTool, run]);

	const setRuleDecision = useCallback(
		async (index: number, decision: ApprovalRule["decision"]): Promise<void> => {
			if (!prefs) return;
			const rules = prefs.approvalRules.map((rule, i) => (i === index ? { ...rule, decision } : rule));
			const result = await run({ type: "setApprovalRules", rules });
			if (result.ok && Array.isArray(result.data)) apply({ ...prefs, approvalRules: result.data as ApprovalRule[] });
		},
		[apply, prefs, run],
	);

	const removeRule = useCallback(
		async (index: number): Promise<void> => {
			if (!prefs) return;
			const rules = prefs.approvalRules.filter((_, i) => i !== index);
			const result = await run({ type: "setApprovalRules", rules });
			if (result.ok && Array.isArray(result.data)) apply({ ...prefs, approvalRules: result.data as ApprovalRule[] });
		},
		[apply, prefs, run],
	);

	const saveAllowlist = useCallback(async (): Promise<void> => {
		const domains = allowlistText
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const result = await run({ type: "sandboxAllowlist", domains });
		setNote(result.ok ? `allowlist: ${domains.length} domínios` : `falhou: ${result.error}`);
	}, [allowlistText, run]);

	const runDiagnostics = useCallback(async (): Promise<void> => {
		const [diag, crashList] = await Promise.all([run({ type: "diagnostics" }), run({ type: "recentCrashes" })]);
		if (diag.ok && diag.data) setDiagnostics(diag.data as { items: DiagnosticItem[]; app: Record<string, string> });
		if (crashList.ok && Array.isArray(crashList.data)) setCrashes(crashList.data as string[]);
	}, [run]);

	const checkUpdates = useCallback(async (): Promise<void> => {
		const [updateResult, cliResult] = await Promise.all([run({ type: "checkForUpdates" }), run({ type: "cliVersionCheck" })]);
		if (updateResult.ok && updateResult.data) setUpdate(updateResult.data as UpdateCheck);
		if (cliResult.ok && cliResult.data) setCli(cliResult.data as CliCheck);
	}, [run]);

	const importTheme = useCallback(async (): Promise<void> => {
		const path = window.prompt("Caminho do arquivo .json do tema");
		if (!path) return;
		const result = await run({ type: "importTheme", path });
		setNote(result.ok ? "tema importado" : `falhou: ${result.error}`);
		await load();
	}, [load, run]);

	if (!prefs) return <div className="panel-empty">Carregando preferências…</div>;

	return (
		<div className="cds-panel">
			<div className="cds-panel-head">
				<b>Preferências</b>
				<div className="cds-toolbar">
					<button className="btn btn--ghost btn--sm" onClick={() => void load()} type="button">Recarregar</button>
				</div>
			</div>
			{note ? <div className="panel-note">{note}</div> : null}
			<div className="cds-panel-body">

			<section className="cds-section">
				<h4>Aparência</h4>
				<div className="cds-field-row">
					<span>Tema base</span>
					<select
						className="field"
						value={prefs.theme}
						onChange={(e) => void patch({ theme: e.target.value })}
						aria-label="Tema base"
					>
						<option value="system">sistema</option>
						<option value="dark">escuro</option>
						<option value="light">claro</option>
					</select>
				</div>
				<div className="cds-field-row">
					<span>Zoom</span>
					<input
						className="field"
						type="number"
						min={-3}
						max={5}
						step={0.5}
						value={prefs.zoomLevel}
						onChange={(e) => void run({ type: "setZoom", level: Number(e.target.value) })}
						aria-label="Nível de zoom"
					/>
				</div>
				<div className="cds-field-row">
					<span>Tema customizado</span>
					<select
						className="field"
						defaultValue="none"
						onChange={(e) => void run({ type: "applyTheme", name: e.target.value })}
						aria-label="Tema customizado"
					>
						<option value="none">nenhum</option>
						{themes.map((theme) => (
							<option key={theme.name} value={theme.name}>{theme.name}</option>
						))}
					</select>
					<button className="btn btn--ghost btn--sm" onClick={() => void importTheme()} type="button">Importar…</button>
				</div>
			</section>

			<section className="cds-section">
				<h4>Política de aprovação</h4>
				<p className="settings-hint">A primeira regra que casar decide; sem regra, o agente pergunta.</p>
				{prefs.approvalRules.map((rule, index) => (
					<div key={`${rule.tool}-${index}`} className="settings-row">
						<span className="mono">{rule.tool}{rule.pattern ? ` · ${rule.pattern}` : ""}</span>
						<select
							className="field"
							value={rule.decision}
							onChange={(e) => void setRuleDecision(index, e.target.value as ApprovalRule["decision"])}
							aria-label={`Decisão para ${rule.tool}`}
						>
							{DECISIONS.map((decision) => (
								<option key={decision} value={decision}>{decision}</option>
							))}
						</select>
						<button className="btn btn--ghost btn--sm" onClick={() => void removeRule(index)} type="button">Remover</button>
					</div>
				))}
				<div className="cds-field-row">
					<input className="field" value={ruleTool} onChange={(e) => setRuleTool(e.target.value)} placeholder="ferramenta (bash, write…)" aria-label="Ferramenta da regra" />
					<input className="field" value={rulePattern} onChange={(e) => setRulePattern(e.target.value)} placeholder="glob opcional (*.ts)" aria-label="Padrão da regra" />
					<button className="btn btn--sm" onClick={() => void addRule()} type="button">Adicionar</button>
				</div>
			</section>

			<section className="cds-section">
				<h4>Orçamento</h4>
				<div className="cds-field-row">
					<span>Avisar em (US$)</span>
					<input
						className="field"
						type="number"
						step={0.5}
						min={0}
						value={prefs.budget.warnUsd ?? ""}
						onChange={(e) => void patch({ budget: { ...prefs.budget, warnUsd: e.target.value ? Number(e.target.value) : null } })}
						aria-label="Aviso de orçamento"
					/>
					<span>Parar em (US$)</span>
					<input
						className="field"
						type="number"
						step={0.5}
						min={0}
						value={prefs.budget.stopUsd ?? ""}
						onChange={(e) => void patch({ budget: { ...prefs.budget, stopUsd: e.target.value ? Number(e.target.value) : null } })}
						aria-label="Limite de orçamento"
					/>
				</div>
			</section>

			<section className="cds-section">
				<h4>Sandbox</h4>
				<div className="cds-field-row">
					<span>vCPU</span>
					<input className="field" type="number" min={1} max={16} value={prefs.sandbox.maxCpu} onChange={(e) => void run({ type: "sandboxSetLimits", maxCpu: Number(e.target.value), maxMemoryMb: prefs.sandbox.maxMemoryMb, maxSeconds: prefs.sandbox.maxSeconds })} aria-label="vCPU" />
					<span>RAM (MB)</span>
					<input className="field" type="number" min={512} max={8192} step={256} value={prefs.sandbox.maxMemoryMb} onChange={(e) => void run({ type: "sandboxSetLimits", maxCpu: prefs.sandbox.maxCpu, maxMemoryMb: Number(e.target.value), maxSeconds: prefs.sandbox.maxSeconds })} aria-label="Memória" />
					<span>Timeout (s)</span>
					<input className="field" type="number" min={10} max={3600} value={prefs.sandbox.maxSeconds} onChange={(e) => void run({ type: "sandboxSetLimits", maxCpu: prefs.sandbox.maxCpu, maxMemoryMb: prefs.sandbox.maxMemoryMb, maxSeconds: Number(e.target.value) })} aria-label="Timeout" />
				</div>
				<label className="settings-label" htmlFor="allowlist">Allowlist de domínios (um por linha)</label>
				<textarea id="allowlist" className="field settings-textarea" value={allowlistText} onChange={(e) => setAllowlistText(e.target.value)} rows={5} />
				<button className="btn btn--sm" onClick={() => void saveAllowlist()} type="button">Salvar allowlist</button>
			</section>

			<section className="cds-section">
				<h4>Atalhos</h4>
				{prefs.shortcuts.map((shortcut, index) => (
					<div key={shortcut.action} className="settings-row">
						<span className="mono">{shortcut.action}</span>
						<input
							className="field"
							value={shortcut.accelerator}
							onChange={(e) => {
								const shortcuts = prefs.shortcuts.map((item, i) => (i === index ? { ...item, accelerator: e.target.value } : item));
								void run({ type: "setShortcuts", shortcuts }).then((result) => {
									if (result.ok && Array.isArray(result.data)) apply({ ...prefs, shortcuts: result.data as Shortcut[] });
								});
							}}
							aria-label={`Atalho de ${shortcut.action}`}
						/>
					</div>
				))}
			</section>

			<section className="cds-section">
				<h4>Telemetria</h4>
				<div className="cds-field-row">
					<label>
						<input
							type="checkbox"
							aria-label="Enviar relatórios de crash"
							checked={prefs.telemetry.enabled}
							onChange={(e) => void run({ type: "setTelemetry", enabled: e.target.checked, endpoint: prefs.telemetry.endpoint })}
						/>{" "}
						enviar relatórios de crash (opt-in)
					</label>
					<input
						className="field"
						value={prefs.telemetry.endpoint ?? ""}
						onChange={(e) => void run({ type: "setTelemetry", enabled: prefs.telemetry.enabled, endpoint: e.target.value || null })}
						placeholder="https://…/crash"
						aria-label="Endpoint de telemetria"
					/>
				</div>
			</section>

			<section className="cds-section">
				<h4>Sistema</h4>
				<div className="cds-field-row">
					<button className="btn btn--sm" onClick={() => void checkUpdates()} type="button">Checar atualizações</button>
					<button className="btn btn--sm" onClick={() => void runDiagnostics()} type="button">Diagnóstico</button>
				</div>
				{update ? (
					<div className="settings-note">
						app {update.current} · {update.updateAvailable ? `nova versão ${update.latest}` : "atualizado"}
						{update.error ? ` · ${update.error}` : ""}
						{update.url ? (
							<button className="btn btn--ghost btn--sm" onClick={() => void run({ type: "openExternal", url: update.url ?? "" })} type="button">Abrir release</button>
						) : null}
					</div>
				) : null}
				{cli ? (
					<div className="settings-note">
						CLI {cli.version ?? "?"} · {cli.compatible ? "compatível" : `precisa >= ${cli.minimum}`}
					</div>
				) : null}
				{diagnostics ? (
					<div className="diag-list">
						{diagnostics.items.map((item) => (
							<div key={item.name} className="cds-row" data-static>
								<span className={`dot ${item.ok ? "dot--ok" : "dot--warn"}`} />
								<span className="diag-name cds-row-main">{item.name}</span>
								<span className="mono diag-detail">{item.detail}</span>
							</div>
						))}
						<div className="settings-note mono">
							{Object.entries(diagnostics.app).map(([key, value]) => `${key} ${value}`).join(" · ")}
						</div>
					</div>
				) : null}
				{crashes.length > 0 ? (
					<details className="settings-details">
						<summary>{crashes.length} relatórios de crash</summary>
						<pre className="git-diff">{crashes.join("\n")}</pre>
					</details>
				) : null}
			</section>
			</div>
		</div>
	);
}
