/**
 * Sandbox manager: owns the set of local VMs and answers the desktop's
 * sandbox commands. Each VM is a SandboxVm with its own workspace, artifacts,
 * snapshots and sockets, so several tasks can run in parallel (feature 36)
 * without sharing a workspace.
 *
 * Asset layout (~/noishi-cowork, override with NOISHI_SANDBOX_DIR):
 *   alpine-virt.iso, iso-extract/boot/{vmlinuz-virt,initramfs-virt}
 *   workspace/ artifacts/      — the default instance
 *   instances/<id>/…           — every extra instance
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readPrefs } from "./prefs.js";
import { SandboxVm, type SandboxArtifact, type SandboxEvent, type SandboxPaths, type SandboxTask } from "./sandbox-vm.js";

const SANDBOX_DIR = process.env.NOISHI_SANDBOX_DIR ?? join(homedir(), "noishi-cowork");

export type { SandboxArtifact, SandboxEvent, SandboxTask };

export type SandboxInstance = {
	id: string;
	root: string;
	workspace: string;
	booted: boolean;
	tasks: number;
	vcpu: number;
	memoryMb: number;
};

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

function pathsFor(id: string): SandboxPaths {
	const root = id === "default" ? SANDBOX_DIR : join(SANDBOX_DIR, "instances", id);
	return {
		id,
		root,
		workspace: join(root, "workspace"),
		artifacts: join(root, "artifacts"),
		snapshots: join(root, "snapshots"),
		serialSock: `/tmp/noishi-sandbox-${id}-serial.sock`,
		virtiofsSock: `/tmp/noishi-sandbox-${id}-virtiofs.sock`,
	};
}

export class CoworkService {
	private readonly vms = new Map<string, SandboxVm>();
	private readonly listeners = new Set<(event: SandboxEvent) => void>();
	private active = "default";

	constructor() {
		const limits = readPrefs().sandbox;
		this.vm("default").setLimits(limits.maxCpu, limits.maxMemoryMb, limits.maxSeconds);
	}

	onEvent(listener: (event: SandboxEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private vm(id: string): SandboxVm {
		const existing = this.vms.get(id);
		if (existing) return existing;
		const vm = new SandboxVm(pathsFor(id), () => this.assets(), (names) => this.binary(names));
		vm.onEvent((event) => {
			for (const listener of [...this.listeners]) listener(event);
		});
		try {
			vm.setAllowlist(readPrefs().sandbox.allowlist);
		} catch {
			// Prefs unreadable: the proxy falls back to its defaults.
		}
		this.vms.set(id, vm);
		return vm;
	}

	/** The instance tasks run against; the UI switches it. */
	setActive(id: string): void {
		this.active = id;
	}

	activeId(): string {
		return this.active;
	}

	instances(): SandboxInstance[] {
		return [...this.vms.values()].map((vm) => ({
			id: vm.paths.id,
			root: vm.paths.root,
			workspace: vm.paths.workspace,
			booted: vm.isBooted(),
			tasks: vm.taskList().length,
			vcpu: vm.limits.maxCpu,
			memoryMb: vm.limits.maxMemoryMb,
		}));
	}

	createInstance(name: string): SandboxInstance {
		const id = name.trim().replace(/[^\w.-]/g, "_").slice(0, 40) || `vm-${this.vms.size}`;
		if (this.vms.has(id)) throw new Error(`instância ${id} já existe`);
		const vm = this.vm(id);
		this.active = id;
		return {
			id,
			root: vm.paths.root,
			workspace: vm.paths.workspace,
			booted: false,
			tasks: 0,
			vcpu: vm.limits.maxCpu,
			memoryMb: vm.limits.maxMemoryMb,
		};
	}

	async destroyInstance(id: string): Promise<boolean> {
		if (id === "default") throw new Error("a instância default não pode ser removida");
		const vm = this.vms.get(id);
		if (!vm) return false;
		await vm.shutdown();
		this.vms.delete(id);
		if (this.active === id) this.active = "default";
		return true;
	}

	/* ---------- host prerequisites ---------- */

	private assets(): { kernel: string; initrd: string; iso: string } | null {
		const kernel = join(SANDBOX_DIR, "iso-extract/boot/vmlinuz-virt");
		const initrd = join(SANDBOX_DIR, "iso-extract/boot/initramfs-virt");
		const iso = join(SANDBOX_DIR, "alpine-virt.iso");
		if (!existsSync(kernel) || !existsSync(initrd) || !existsSync(iso)) return null;
		return { kernel, initrd, iso };
	}

	private binary(names: string[]): string | null {
		for (const name of names) {
			for (const dir of ["/usr/bin", "/usr/local/bin", "/bin"]) {
				const candidate = `${dir}/${name}`;
				if (existsSync(candidate)) return candidate;
			}
		}
		// Fall back to PATH resolution by name (spawn/find it there).
		const fromPath = process.env.PATH?.split(":").find((dir) => existsSync(`${dir}/${names[0]}`));
		return fromPath ? `${fromPath}/${names[0]}` : null;
	}

	assetStatus(): { ready: boolean; dir: string; workspace: string; qemu: boolean; virtiofsd: boolean } {
		const vm = this.vm(this.active);
		return {
			ready: this.assets() !== null,
			dir: SANDBOX_DIR,
			workspace: vm.paths.workspace,
			qemu: this.binary(["qemu-system-x86_64"]) !== null,
			virtiofsd: this.binary(["virtiofsd"]) !== null,
		};
	}

	isBooted(): boolean {
		return this.vm(this.active).isBooted();
	}

	status(): SandboxStatus {
		const vm = this.vm(this.active);
		const base = this.assetStatus();
		return {
			...base,
			booted: vm.isBooted(),
			vcpu: vm.limits.maxCpu,
			memoryMb: vm.limits.maxMemoryMb,
			allowlist: vm.allowlist(),
			tasks: vm.taskList(),
			artifacts: vm.listArtifacts(),
			egress: vm.egress(),
			limits: { ...vm.limits },
			schedules: [...vm.schedules.values()].map((entry) => ({
				id: entry.id,
				command: entry.command,
				everySeconds: entry.everySeconds,
				lastRun: entry.lastRun,
			})),
			snapshots: vm.listSnapshots(),
			instances: this.instances(),
			activeInstance: this.active,
		};
	}

	/* ---------- lifecycle ---------- */

	async boot(id = this.active): Promise<void> {
		const vm = this.vm(id);
		const limits = readPrefs().sandbox;
		vm.setLimits(limits.maxCpu, limits.maxMemoryMb, limits.maxSeconds);
		await vm.boot();
	}

	async exec(command: string, options: { cwd?: string; timeoutMs?: number } = {}, id = this.active): Promise<string> {
		return this.vm(id).exec(command, options);
	}

	runTask(command: string, options: { cwd?: string; name?: string } = {}, id = this.active): SandboxTask {
		return this.vm(id).runTask(command, options);
	}

	readArtifact(id: string, instance = this.active): string | null {
		return this.vm(instance).readArtifact(id);
	}

	setAllowlist(domains: string[]): void {
		for (const vm of this.vms.values()) vm.setAllowlist(domains);
	}

	setLimits(maxCpu: number, maxMemoryMb: number, maxSeconds: number): void {
		this.vm(this.active).setLimits(maxCpu, maxMemoryMb, maxSeconds);
	}

	workspaceDiff(): Promise<{ path: string; status: "added" | "modified" | "deleted" }[]> {
		return this.vm(this.active).workspaceDiff();
	}

	createSnapshot(name: string): Promise<{ name: string; files: number; bytes: number }> {
		return this.vm(this.active).createSnapshot(name);
	}

	restoreSnapshot(name: string): Promise<{ name: string; restored: number }> {
		return this.vm(this.active).restoreSnapshot(name);
	}

	listSnapshots(): { name: string; createdAt: number; files: number }[] {
		return this.vm(this.active).listSnapshots();
	}

	schedule(command: string, everySeconds: number): { id: string; command: string; everySeconds: number } {
		return this.vm(this.active).schedule(command, everySeconds);
	}

	unschedule(id: string): void {
		this.vm(this.active).unschedule(id);
	}

	provision(toolchain: string[]): Promise<{ installed: string[]; output: string }> {
		return this.vm(this.active).provision(toolchain);
	}

	/** Interactive shell inside the guest (feature 41). */
	openTty(onData: (chunk: string) => void): { write(data: string): void; close(): void } {
		return this.vm(this.active).openTty(onData);
	}

	async shutdown(): Promise<void> {
		await Promise.all([...this.vms.values()].map((vm) => vm.shutdown().catch(() => undefined)));
	}
}
