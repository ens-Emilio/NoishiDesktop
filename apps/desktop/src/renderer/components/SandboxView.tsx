import { Suspense, lazy } from "react";

const LazySandboxTerminal = lazy(() => import("../SandboxTerminal.js").then((m) => ({ default: m.SandboxTerminal })));

export type SandboxTask = {
	id: string;
	command: string;
	cwd: string;
	status: "queued" | "running" | "done" | "failed";
	output: string;
	exitCode: number | null;
	startedAt: number;
	finishedAt?: number;
};

export type SandboxArtifact = {
	id: string;
	name: string;
	taskId?: string;
	createdAt: number;
	size: number;
	preview: string;
	path: string;
};

export type SandboxInstance = { id: string; root: string; workspace: string; booted: boolean; tasks: number; vcpu: number; memoryMb: number };

export type SandboxStatus = {
	ready: boolean;
	dir: string;
	workspace: string;
	qemu: boolean;
	virtiofsd: boolean;
	booted: boolean;
	vcpu: number;
	memoryMb: number;
	allowlist: string[];
	tasks: SandboxTask[];
	artifacts: SandboxArtifact[];
	egress: { at: number; host: string; allowed: boolean; method: string }[];
	limits: { maxCpu: number; maxMemoryMb: number; maxSeconds: number };
	schedules: { id: string; command: string; everySeconds: number; lastRun?: number }[];
	snapshots: { name: string; createdAt: number; files: number }[];
	instances: SandboxInstance[];
	activeInstance: string;
};

export function SandboxView({
	sandbox,
	sandboxBusy,
	sandboxCmd,
	setSandboxCmd,
	sandboxOutput,
	openArtifact,
	setOpenArtifact,
	onSetActive,
	onCreateInstance,
	onDestroyInstance,
	onBoot,
	onShutdown,
	onTask,
	onExec,
	onSchedule,
	onUnschedule,
	onProvision,
	onDiff,
	onSnapshot,
	onRestore,
	onSaveLimits,
	onReadArtifact,
	onSendArtifactToChat,
	icons,
}: {
	sandbox: SandboxStatus;
	sandboxBusy: boolean;
	sandboxCmd: string;
	setSandboxCmd: (v: string) => void;
	sandboxOutput: string;
	openArtifact: { id: string; body: string } | null;
	setOpenArtifact: (v: { id: string; body: string } | null) => void;
	onSetActive: (id: string) => void;
	onCreateInstance: () => void;
	onDestroyInstance: (id: string) => void;
	onBoot: () => void;
	onShutdown: () => void;
	onTask: () => void;
	onExec: () => void;
	onSchedule: () => void;
	onUnschedule: (id: string) => void;
	onProvision: () => void;
	onDiff: () => void;
	onSnapshot: () => void;
	onRestore: (name: string) => void;
	onSaveLimits: (patch: { maxCpu?: number; maxMemoryMb?: number; maxSeconds?: number }) => void;
	onReadArtifact: (id: string) => void;
	onSendArtifactToChat: (id: string) => void;
	icons: { file: React.ReactNode; x: React.ReactNode; share: React.ReactNode };
}) {
	return (
		<div className="sandbox">
			<div className="sandbox-head">
				<span className={`dot ${sandbox.booted ? "dot--ok" : sandbox.ready && sandbox.qemu && sandbox.virtiofsd ? "" : "dot--warn"}`} />
				<b className="sandbox-status-title">
					{sandbox.booted
						? `VM ativa · alpine-virt · ${sandbox.vcpu} vCPU · ${Math.round(sandbox.memoryMb / 1024)} GB · ${sandbox.allowlist.length} domínios`
						: !sandbox.qemu
							? "qemu ausente — sudo pacman -S qemu-desktop"
							: !sandbox.virtiofsd
								? "virtiofsd ausente — sudo pacman -S virtiofsd"
								: sandbox.ready
									? "pronta para boot"
									: "assets ausentes"}
				</b>
				{sandbox.dir && !sandbox.ready && sandbox.qemu ? (
					<span className="mono sandbox-assets-hint" title={`coloque alpine-virt.iso + iso-extract/boot/ em ${sandbox.dir}`}>
						{sandbox.dir}
					</span>
				) : null}
				<span className="spacer" />
				<select
					className="field sandbox-instance"
					value={sandbox.activeInstance}
					onChange={(e) => onSetActive(e.target.value)}
					aria-label="Instância do sandbox"
				>
					{sandbox.instances.length === 0 ? <option value="default">default</option> : null}
					{sandbox.instances.map((instance) => (
						<option key={instance.id} value={instance.id}>
							{instance.id}{instance.booted ? " · ativa" : ""} · {instance.tasks} tarefas
						</option>
					))}
				</select>
				<button className="btn btn--ghost btn--sm" onClick={onCreateInstance} type="button">+ VM</button>
				{sandbox.activeInstance !== "default" ? (
					<button className="btn btn--ghost btn--sm" onClick={() => onDestroyInstance(sandbox.activeInstance)} type="button">Remover VM</button>
				) : null}
				{!sandbox.booted ? (
					<button className="btn btn--sm" onClick={onBoot} disabled={sandboxBusy || !sandbox.ready || !sandbox.qemu || !sandbox.virtiofsd} type="button">
						{sandboxBusy ? "bootando…" : "Boot VM"}
					</button>
				) : (
					<button className="btn btn--sm" onClick={onShutdown} type="button">
						Desligar
					</button>
				)}
			</div>

			{sandbox.booted ? (
				<>
					<div className="sandbox-bar">
						<span className="mono">/workspace ← {sandbox.workspace}</span>
						<span className="mono">{sandbox.egress.length ? `${sandbox.egress.filter((e) => e.allowed).length}/${sandbox.egress.length} egress liberados` : "sem tráfego"}</span>
					</div>
					<div className="sandbox-body">
						<input
							className="field mono"
							value={sandboxCmd}
							onChange={(e) => setSandboxCmd(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter") onTask(); }}
							placeholder="npm test"
							aria-label="Comando na VM"
						/>
						<button className="btn btn--sm" onClick={onTask} disabled={sandboxBusy || !sandboxCmd.trim()} type="button">Tarefa</button>
						<button className="btn btn--ghost btn--sm" onClick={onExec} disabled={sandboxBusy || !sandboxCmd.trim()} type="button">Exec</button>
						<button className="btn btn--ghost btn--sm" onClick={onSchedule} disabled={sandboxBusy || !sandboxCmd.trim()} type="button">Agendar</button>
					</div>
					<div className="sandbox-tools">
						<button className="btn btn--ghost btn--sm" onClick={onProvision} disabled={sandboxBusy} type="button">Instalar toolchain…</button>
						<button className="btn btn--ghost btn--sm" onClick={onDiff} type="button">Diff do workspace</button>
						<button className="btn btn--ghost btn--sm" onClick={onSnapshot} type="button">Snapshot</button>
						<span className="spacer" />
						<label className="sandbox-limit">
							vCPU
							<input className="field" type="number" min={1} max={16} value={sandbox.limits.maxCpu} onChange={(e) => onSaveLimits({ maxCpu: Number(e.target.value) })} aria-label="vCPU do sandbox" />
						</label>
						<label className="sandbox-limit">
							RAM MB
							<input className="field" type="number" min={512} max={8192} step={256} value={sandbox.limits.maxMemoryMb} onChange={(e) => onSaveLimits({ maxMemoryMb: Number(e.target.value) })} aria-label="Memória do sandbox" />
						</label>
						<label className="sandbox-limit">
							timeout s
							<input className="field" type="number" min={10} max={3600} value={sandbox.limits.maxSeconds} onChange={(e) => onSaveLimits({ maxSeconds: Number(e.target.value) })} aria-label="Timeout do sandbox" />
						</label>
					</div>
					<pre className="sandbox-out">{sandboxOutput || "—"}</pre>

					<div className="sandbox-grid">
						<div className="sandbox-col">
							<div className="sandbox-col-title">Tarefas</div>
							{sandbox.tasks.length === 0 ? <div className="sandbox-empty">Nenhuma tarefa ainda.</div> : null}
							{sandbox.tasks.map((task) => (
								<div key={task.id} className="task">
									<div className="task-head">
										<span className={`dot ${task.status === "done" ? "dot--ok" : task.status === "failed" ? "dot--danger" : ""}`} />
										<span className="mono task-cmd">{task.command}</span>
										<span className="task-state">{task.status === "running" ? "executando…" : task.status}</span>
									</div>
									{task.output ? <pre className="task-out">{task.output.slice(-1500)}</pre> : null}
								</div>
							))}
						</div>
						<div className="sandbox-col">
							<div className="sandbox-col-title">Artefatos</div>
							{sandbox.artifacts.length === 0 ? <div className="sandbox-empty">Tarefas concluídas geram artefatos.</div> : null}
							{sandbox.artifacts.map((artifact) => (
								<button key={artifact.id} className="artifact-row" onClick={() => onReadArtifact(artifact.id)} type="button">
									{icons.file}
									<span className="artifact-name">{artifact.name}</span>
									<span className="mono artifact-meta">{Math.round(artifact.size / 102.4) / 10} kB</span>
								</button>
							))}
						</div>
						<div className="sandbox-col">
							<div className="sandbox-col-title">Agendadas</div>
							{sandbox.schedules.length === 0 ? <div className="sandbox-empty">Nenhuma tarefa recorrente.</div> : null}
							{sandbox.schedules.map((entry) => (
								<div key={entry.id} className="task">
									<div className="task-head">
										<span className="mono task-cmd">{entry.command}</span>
										<span className="task-state">a cada {entry.everySeconds}s</span>
										<button className="btn btn--ghost btn--icon btn--sm" onClick={() => onUnschedule(entry.id)} title="Cancelar" aria-label="Cancelar agendamento" type="button">
											{icons.x}
										</button>
									</div>
								</div>
							))}
							<div className="sandbox-col-title">Snapshots</div>
							{sandbox.snapshots.length === 0 ? <div className="sandbox-empty">Nenhum snapshot.</div> : null}
							{sandbox.snapshots.map((snapshot) => (
								<div key={snapshot.name} className="task">
									<div className="task-head">
										<span className="mono task-cmd">{snapshot.name}</span>
										<span className="task-state">{snapshot.files} arq.</span>
										<button className="btn btn--ghost btn--sm" onClick={() => onRestore(snapshot.name)} type="button">Restaurar</button>
									</div>
								</div>
							))}
						</div>
					</div>
					<div className="sandbox-tty">
						<div className="sandbox-col-title">Terminal da VM</div>
						<Suspense fallback={<div className="sandbox-empty">Carregando terminal…</div>}>
							<LazySandboxTerminal booted={sandbox.booted} />
						</Suspense>
					</div>
				</>
			) : null}

			{openArtifact ? (
				<div className="artifact-sheet">
					<div className="artifact-sheet-head">
						<span className="mono">{openArtifact.id}</span>
						<span className="spacer" />
						<button className="btn btn--ghost btn--sm" onClick={() => onSendArtifactToChat(openArtifact.id)} type="button">
							{icons.share}
							Enviar ao chat
						</button>
						<button className="btn btn--ghost btn--sm" onClick={() => setOpenArtifact(null)} type="button">Fechar</button>
					</div>
					<pre className="artifact-sheet-body">{openArtifact.body}</pre>
				</div>
			) : null}
		</div>
	);
}
