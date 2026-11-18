/**
 * One sandbox VM (QEMU/KVM) with its own workspace, artifacts and sockets.
 *
 * Isolation comes from the hypervisor, not from the guest:
 *  - `-netdev user,restrict=on` — no routing to the outside world. The only
 *    reachable address is the `guestfwd` channel, which pipes the guest's
 *    traffic to the host-side egress proxy (sandbox-proxy.ts) where the domain
 *    allowlist is enforced.
 *  - `virtiofsd` shares a host workspace directory into the guest at
 *    /workspace, so a task can read a project and leave artifacts behind
 *    without copying anything over the serial console.
 *  - the serial console on a unix socket carries the commands, and doubles as
 *    the interactive terminal (`openTty`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deferred } from "./deferred.js";
import { openSerial, type SerialSession } from "./serial-pty.js";
import { startSandboxProxy, type SandboxProxy } from "./sandbox-proxy.js";

const BOOT_TIMEOUT_MS = 90_000;

export type SandboxPaths = {
	id: string;
	root: string;
	workspace: string;
	artifacts: string;
	snapshots: string;
	serialSock: string;
	virtiofsSock: string;
};

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
	/** Text content when small enough to inline in the viewer. */
	preview: string;
	path: string;
};

export type SandboxEvent = {
	type: "boot" | "command" | "error" | "shutdown" | "task";
	detail?: string;
};

/** Asset layout shared by every instance: the ISO and its extracted boot files. */
export type SandboxAssets = { kernel: string; initrd: string; iso: string };

export class SandboxVm {
	private child: ChildProcess | null = null;
	private virtiofsd: ChildProcess | null = null;
	private proxy: SandboxProxy | null = null;
	private serialPath: string | null = null;
	private readonly listeners = new Set<(event: SandboxEvent) => void>();
	private booted = false;
	private tasks = new Map<string, SandboxTask>();
	/** Shell env established once per boot; prepended to every exec. */
	private shellPrelude = "";
	limits = { maxCpu: 4, maxMemoryMb: 2048, maxSeconds: 300 };
	schedules = new Map<string, { id: string; command: string; everySeconds: number; timer: NodeJS.Timeout; lastRun?: number }>();

	readonly paths: SandboxPaths;
	private readonly assets: () => SandboxAssets | null;
	private readonly binary: (names: string[]) => string | null;

	constructor(paths: SandboxPaths, assets: () => SandboxAssets | null, binary: (names: string[]) => string | null) {
		this.paths = paths;
		this.assets = assets;
		this.binary = binary;
	}

	onEvent(listener: (event: SandboxEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: SandboxEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	isBooted(): boolean {
		return this.booted;
	}

	allowlist(): string[] {
		return this.proxy?.allowlist ?? [];
	}

	egress(): { at: number; host: string; allowed: boolean; method: string }[] {
		return this.proxy?.log().slice(-50) ?? [];
	}

	taskList(): SandboxTask[] {
		return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	private ensureDirs(): void {
		for (const dir of [this.paths.root, this.paths.workspace, this.paths.artifacts]) {
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		}
	}

	setAllowlist(domains: string[]): void {
		this.proxy?.setAllowlist(domains);
	}

	/** Boot the VM with the shared workspace and the egress proxy wired in. */
	async boot(): Promise<void> {
		if (this.booted && this.child) return;
		this.ensureDirs();
		const assets = this.assets();
		if (!assets) throw new Error(`sandbox assets missing (alpine-virt.iso + iso-extract/boot/*)`);
		const qemu = this.binary(["qemu-system-x86_64"]);
		if (!qemu) throw new Error("qemu-system-x86_64 not found (install qemu-desktop / qemu-system-x86)");
		const virtiofsd = this.binary(["virtiofsd"]);
		if (!virtiofsd) throw new Error("virtiofsd not found (install virtiofsd)");
		const socat = this.binary(["socat"]);
		if (!socat) throw new Error("socat not found (install socat)");

		this.emit({ type: "boot", detail: "starting egress proxy" });
		this.proxy = await startSandboxProxy();

		this.emit({ type: "boot", detail: "starting virtiofsd" });
		if (existsSync(this.paths.virtiofsSock)) rmSync(this.paths.virtiofsSock, { force: true });
		this.virtiofsd = spawn(
			virtiofsd,
			[`--shared-dir=${this.paths.workspace}`, `--socket-path=${this.paths.virtiofsSock}`, "--cache=auto", "--sandbox=none"],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		const fs = deferred<void>();
		const fsDeadline = setTimeout(() => fs.reject(new Error("virtiofsd socket not ready")), 10_000);
		const fsCheck = setInterval(() => {
			if (existsSync(this.paths.virtiofsSock)) {
				clearInterval(fsCheck);
				clearTimeout(fsDeadline);
				fs.resolve();
			}
		}, 100);
		this.virtiofsd.on("exit", (code) => {
			clearInterval(fsCheck);
			clearTimeout(fsDeadline);
			fs.reject(new Error(`virtiofsd exited ${code}`));
		});
		await fs.promise;

		this.emit({ type: "boot", detail: "starting qemu" });
		if (existsSync(this.paths.serialSock)) rmSync(this.paths.serialSock, { force: true });
		const child = spawn(
			qemu,
			[
				"-m", String(this.limits.maxMemoryMb),
				"-smp", String(this.limits.maxCpu),
				"-enable-kvm", "-cpu", "host",
				"-kernel", assets.kernel,
				"-initrd", assets.initrd,
				"-append", "console=ttyS0",
				"-cdrom", assets.iso,
				// Shared memory is required by vhost-user-fs.
				"-object", `memory-backend-memfd,id=sandboxmem,size=${this.limits.maxMemoryMb}M,share=on`,
				"-numa", "node,memdev=sandboxmem",
				"-chardev", `socket,id=fs0,path=${this.paths.virtiofsSock}`,
				"-device", "vhost-user-fs-pci,chardev=fs0,tag=workspace",
				// No outside routing; only the guestfwd channel to the proxy.
				"-netdev", `user,id=n0,restrict=on,guestfwd=tcp:10.0.2.100:3128-cmd:${socat} - TCP:127.0.0.1:${this.proxy.port}`,
				"-device", "virtio-net-pci,netdev=n0",
				"-display", "none",
				"-serial", `unix:${this.paths.serialSock},server=on,wait=off`,
				"-monitor", "none",
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		const stderr: string[] = [];
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr.push(chunk.toString());
			if (stderr.length > 50) stderr.shift();
		});
		this.serialPath = this.paths.serialSock;
		const serial = deferred<void>();
		const serialDeadline = setTimeout(
			() => serial.reject(new Error(`qemu serial socket not ready: ${stderr.join("").slice(0, 200)}`)),
			15_000,
		);
		const serialCheck = setInterval(() => {
			if (existsSync(this.paths.serialSock)) {
				clearInterval(serialCheck);
				clearTimeout(serialDeadline);
				serial.resolve();
			}
		}, 100);
		child.on("exit", (code) => {
			clearInterval(serialCheck);
			clearTimeout(serialDeadline);
			serial.reject(new Error(`qemu exited ${code}: ${stderr.join("").slice(0, 400)}`));
		});
		await serial.promise;
		this.child = child;
		await this.prepareGuest();
		this.booted = true;
		this.emit({ type: "boot", detail: "ready" });
	}

	/** Log in and configure the guest: workspace mount + proxy env. */
	private async prepareGuest(): Promise<void> {
		const serial = openSerial(this.serialPath as string);
		try {
			const sawLogin = await serial.waitFor(/login:/, BOOT_TIMEOUT_MS);
			if (!sawLogin) throw new Error("guest login prompt not seen");
			serial.write("root\n");
			await serial.waitFor(/[:~#]\s*$/, 30_000);
			// ash probes the terminal with a DSR cursor query on every prompt;
			// it holds typed input until we answer with the cursor report.
			serial.write("\x1b[1;1R");
			serial.clear();
		} finally {
			serial.close();
		}

		const proxyEndpoint = this.proxy?.guestEndpoint ?? "10.0.2.100:3128";
		// A booted Alpine keeps this in a profile script so every exec (which
		// starts a fresh shell) sees the same env: proxy, workspace cwd, PATH.
		const profile = [
			"#!/bin/sh",
			`export http_proxy=http://${proxyEndpoint}`,
			`export https_proxy=http://${proxyEndpoint}`,
			`export HTTP_PROXY=http://${proxyEndpoint}`,
			`export HTTPS_PROXY=http://${proxyEndpoint}`,
			"export NODE_EXTRA_CA_CERTS=",
			"PS1='sandbox# '",
			"cd /workspace 2>/dev/null || true",
			"",
		].join("\n");
		const setup = [
			"ip link set eth0 up 2>/dev/null",
			"ip addr add 10.0.2.15/24 dev eth0 2>/dev/null",
			"mkdir -p /workspace",
			"mount -t virtiofs workspace /workspace 2>/dev/null || mount -t 9p -o trans=virtio,version=9p2000.L hostshare /workspace 2>/dev/null || true",
			`printf '%s\\n' ${profile.split("\n").map((line) => `'${line.replace(/'/g, "'\\''")}'`).join(" ")} > /etc/profile.d/sandbox.sh`,
			"chmod 644 /etc/profile.d/sandbox.sh",
			// The CD-ROM repo is read-only and limited; add the network repo so
			// the guest can install toolchains through the allowlisted proxy.
			"grep -q dl-cdn /etc/apk/repositories 2>/dev/null || echo 'http://dl-cdn.alpinelinux.org/alpine/v3.21/main' >> /etc/apk/repositories",
			"grep -q dl-cdn/alpine/v3.21/community /etc/apk/repositories 2>/dev/null || echo 'http://dl-cdn.alpinelinux.org/alpine/v3.21/community' >> /etc/apk/repositories",
			"echo SETUP_DONE",
		].join("; ");
		// Setup runs against the login shell's original prompt.
		await this.execRaw(setup, 60_000, "localhost:~# ");
		// The serial console is ONE persistent shell: set the fixed prompt here
		// and every later exec anchors on it.
		await this.execRaw("PS1='sandbox# '; echo PS1_SET", 15_000, "localhost:~# ");
		this.shellPrelude = ". /etc/profile.d/sandbox.sh 2>/dev/null; ";
		const mounted = await this.execRaw("mount | grep -c virtiofs || true", 15_000);
		if (!/^[1-9]/m.test(mounted.trim())) {
			throw new Error(`workspace mount failed in guest: ${mounted.trim().slice(0, 200)}`);
		}
		// Replay the recorded toolchain: the guest disk is fresh on every boot.
		// execRaw does not prepend the profile, so the proxy env is sourced here —
		// without it apk has no route and fails silently.
		const toolchain = this.recordedToolchain();
		if (toolchain.length > 0) {
			const replay = `${this.shellPrelude}apk add --no-cache ${toolchain.join(" ")} 2>&1 | tail -3; echo TOOLCHAIN_DONE`;
			const output = await this.execRaw(replay, 900_000);
			if (!output.includes("TOOLCHAIN_DONE")) {
				this.emit({ type: "error", detail: `toolchain não reaplicado: ${output.slice(-200)}` });
			}
		}
	}

	/** exec without the login/setup dance; used during boot. */
	private async execRaw(command: string, timeoutMs: number, prompt = "sandbox# "): Promise<string> {
		if (!this.serialPath) throw new Error("sandbox serial not ready");
		const serial = openSerial(this.serialPath);
		try {
			const marker = `D${Date.now() % 100000}X`;
			// Anchor on a fixed PS1 (set in the profile) instead of the default
			// `host:cwd#`, which changes whenever a command cds elsewhere.
			serial.write(`echo ${marker}_START; ${command}; echo ${marker}_END\n`);
			const seen = await serial.waitFor(new RegExp(`${marker}_END\\r\\n${prompt}`), timeoutMs);
			if (!seen) return "";
			const buffer = serial.drain();
			const startMatch = new RegExp(`(?:^|\\r\\n)${marker}_START\\r\\n`).exec(buffer);
			const endMatch = new RegExp(`\\r\\n${marker}_END\\r\\n${prompt}`).exec(buffer);
			if (!startMatch || !endMatch || endMatch.index < startMatch.index) return "";
			// Strip CR and ANSI sequences (ash emits cursor escapes like \e[0;0m).
			return buffer
				.slice(startMatch.index + startMatch[0].length, endMatch.index)
				.replace(/\r/g, "")
				// eslint-disable-next-line no-control-regex -- ANSI escapes are the point
				.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
				.trimEnd();
		} finally {
			serial.close();
		}
	}

	async exec(command: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
		if (!this.booted) throw new Error("sandbox vm not booted");
		const cwd = options.cwd ? `cd ${JSON.stringify(options.cwd)} && ` : "";
		const wrapped = `${cwd}{ ${command}; } 2>&1; echo "__EXIT:$?"`;
		const raw = await this.execRaw(`${this.shellPrelude}${wrapped}`, options.timeoutMs ?? this.limits.maxSeconds * 1000);
		const match = /__EXIT:(\d+)\s*$/.exec(raw);
		const exitCode = match ? Number(match[1]) : null;
		const output = match ? raw.slice(0, match.index) : raw;
		if (exitCode !== null && exitCode !== 0) {
			const error = new Error(output.trim() || `command exited ${exitCode}`) as Error & { output: string; exitCode: number };
			error.output = output;
			error.exitCode = exitCode;
			throw error;
		}
		return output;
	}

	/**
	 * Interactive terminal: a persistent shell on the serial console whose
	 * output streams to the caller (feature 41). The command markers used by
	 * exec() are not written here, so the human's shell stays untouched.
	 */
	openTty(onData: (chunk: string) => void): { write(data: string): void; close(): void } {
		if (!this.serialPath) throw new Error("sandbox vm not booted");
		const serial: SerialSession = openSerial(this.serialPath);
		const timer = setInterval(() => {
			const chunk = serial.drain();
			if (chunk) onData(chunk);
		}, 40);
		return {
			write(data: string): void {
				serial.write(data.replace(/\n/g, "\r"));
			},
			close(): void {
				clearInterval(timer);
				serial.close();
			},
		};
	}

	/**
	 * Install a toolchain (feature 34). The guest filesystem is ephemeral, so the
	 * package list is also written to the shared workspace and replayed on the
	 * next boot — what the user asked for survives even though the image does not.
	 */
	async provision(packages: string[]): Promise<{ installed: string[]; output: string }> {
		const clean = packages.map((name) => name.trim()).filter((name) => /^[a-z0-9][a-z0-9._+-]*$/i.test(name));
		if (clean.length === 0) throw new Error("nenhum pacote válido");
		const output = await this.exec(`apk add --no-cache ${clean.join(" ")}`, { timeoutMs: 600_000 });
		const manifestPath = join(this.paths.root, "toolchain.txt");
		const existing = existsSync(manifestPath) ? readFileSync(manifestPath, "utf-8").split("\n").map((line) => line.trim()).filter(Boolean) : [];
		const merged = [...new Set([...existing, ...clean])];
		mkdirSync(this.paths.root, { recursive: true });
		writeFileSync(manifestPath, `${merged.join("\n")}\n`);
		return { installed: merged, output: output.slice(-4000) };
	}

	/** Packages recorded by provision(), replayed after every boot. */
	private recordedToolchain(): string[] {
		const manifestPath = join(this.paths.root, "toolchain.txt");
		if (!existsSync(manifestPath)) return [];
		return readFileSync(manifestPath, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^[a-z0-9][a-z0-9._+-]*$/i.test(line));
	}

	/** Run a task in the sandbox, tracking status and collecting an artifact. */
	runTask(command: string, options: { cwd?: string; name?: string } = {}): SandboxTask {
		const task: SandboxTask = {
			id: randomUUID(),
			command,
			cwd: options.cwd ?? "/workspace",
			status: "queued",
			output: "",
			exitCode: null,
			startedAt: Date.now(),
		};
		this.tasks.set(task.id, task);
		this.emit({ type: "task", detail: task.id });
		void this.executeTask(task, options.name);
		return task;
	}

	private async executeTask(task: SandboxTask, name?: string): Promise<void> {
		try {
			if (!this.booted) await this.boot();
			task.status = "running";
			this.emit({ type: "task", detail: task.id });
			const output = await this.exec(task.command, { cwd: task.cwd });
			task.output = output;
			task.exitCode = 0;
			task.status = "done";
			await this.collectArtifact(task, name);
		} catch (error) {
			const detailed = error as Error & { output?: string; exitCode?: number };
			task.output = detailed.output ?? (error instanceof Error ? error.message : String(error));
			task.exitCode = detailed.exitCode ?? null;
			task.status = "failed";
			await this.collectArtifact(task, name).catch(() => undefined);
		} finally {
			task.finishedAt = Date.now();
			this.emit({ type: "task", detail: task.id });
		}
	}

	/** Persist a task's output (+ the workspace listing) as a shareable artifact. */
	async collectArtifact(task: SandboxTask, name?: string): Promise<SandboxArtifact> {
		this.ensureDirs();
		const id = randomUUID();
		const dir = join(this.paths.artifacts, id);
		mkdirSync(dir, { recursive: true });
		// BusyBox find has no -newermt; list the workspace (bounded) instead.
		const listing = await this.exec("find /workspace -type f 2>/dev/null | head -50 || true").catch(() => "");
		const body = [
			`# ${name ?? task.command.slice(0, 60)}`,
			"",
			`status: ${task.status}`,
			`command: ${task.command}`,
			"",
			"## output",
			"```",
			task.output || "(sem saída)",
			"```",
			"",
			"## arquivos recentes no workspace",
			"```",
			listing.trim() || "(nenhum)",
			"```",
			"",
		].join("\n");
		const path = join(dir, "artifact.md");
		writeFileSync(path, body);
		writeFileSync(
			join(dir, "meta.json"),
			JSON.stringify({ id, name: name ?? task.command.slice(0, 60), taskId: task.id, createdAt: Date.now() }, null, 2),
		);
		return {
			id,
			name: name ?? task.command.slice(0, 60),
			taskId: task.id,
			createdAt: Date.now(),
			size: Buffer.byteLength(body),
			preview: body.slice(0, 4000),
			path,
		};
	}

	listArtifacts(): SandboxArtifact[] {
		if (!existsSync(this.paths.artifacts)) return [];
		const artifacts: SandboxArtifact[] = [];
		for (const id of readdirSync(this.paths.artifacts)) {
			const dir = join(this.paths.artifacts, id);
			const metaPath = join(dir, "meta.json");
			const artifactPath = join(dir, "artifact.md");
			if (!existsSync(metaPath)) continue;
			try {
				const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { name?: string; taskId?: string; createdAt?: number };
				const body = existsSync(artifactPath) ? readFileSync(artifactPath, "utf8") : "";
				artifacts.push({
					id,
					name: meta.name ?? id,
					taskId: meta.taskId,
					createdAt: meta.createdAt ?? statSync(dir).mtimeMs,
					size: Buffer.byteLength(body),
					preview: body.slice(0, 4000),
					path: artifactPath,
				});
			} catch {
				// A half-written artifact dir is skipped, not fatal.
			}
		}
		return artifacts.sort((a, b) => b.createdAt - a.createdAt);
	}

	readArtifact(id: string): string | null {
		const path = join(this.paths.artifacts, id, "artifact.md");
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	}

	setLimits(maxCpu: number, maxMemoryMb: number, maxSeconds: number): void {
		this.limits = {
			maxCpu: Math.max(1, Math.min(16, Math.round(maxCpu))),
			maxMemoryMb: Math.max(512, Math.min(8192, Math.round(maxMemoryMb))),
			maxSeconds: Math.max(10, Math.min(3600, Math.round(maxSeconds))),
		};
	}

	/* ---------- workspace diff ---------- */

	/** Compare the shared workspace against the __baseline__ snapshot. */
	async workspaceDiff(): Promise<{ path: string; status: "added" | "modified" | "deleted" }[]> {
		const baseline = join(this.paths.snapshots, "__baseline__");
		if (!existsSync(baseline)) {
			// First call establishes the baseline so later diffs are meaningful.
			await this.createSnapshot("__baseline__");
			return [];
		}
		const index = (root: string): Map<string, number> => {
			const out = new Map<string, number>();
			const walk = (dir: string, prefix: string): void => {
				let entries: string[];
				try {
					entries = readdirSync(dir);
				} catch {
					return;
				}
				for (const name of entries) {
					const full = join(dir, name);
					const rel = prefix ? `${prefix}/${name}` : name;
					let info;
					try {
						info = statSync(full);
					} catch {
						continue;
					}
					if (info.isDirectory()) walk(full, rel);
					else out.set(rel, info.size + info.mtimeMs);
				}
			};
			walk(root, "");
			return out;
		};
		const before = index(baseline);
		const after = index(this.paths.workspace);
		const changes: { path: string; status: "added" | "modified" | "deleted" }[] = [];
		for (const [path, sig] of after) {
			if (!before.has(path)) changes.push({ path, status: "added" });
			else if (before.get(path) !== sig) changes.push({ path, status: "modified" });
		}
		for (const path of before.keys()) if (!after.has(path)) changes.push({ path, status: "deleted" });
		return changes.sort((a, b) => a.path.localeCompare(b.path));
	}

	/* ---------- workspace snapshots ---------- */

	async createSnapshot(name: string): Promise<{ name: string; files: number; bytes: number }> {
		const target = join(this.paths.snapshots, name.replace(/[^\w.-]/g, "_"));
		rmSync(target, { recursive: true, force: true });
		mkdirSync(target, { recursive: true });
		let files = 0;
		let bytes = 0;
		const walk = (dir: string, prefix: string): void => {
			let entries: string[];
			try {
				entries = readdirSync(dir);
			} catch {
				return;
			}
			for (const entry of entries) {
				const full = join(dir, entry);
				const rel = prefix ? `${prefix}/${entry}` : entry;
				let info;
				try {
					info = statSync(full);
				} catch {
					continue;
				}
				if (info.isDirectory()) {
					walk(full, rel);
					continue;
				}
				const dest = join(target, rel);
				mkdirSync(join(dest, ".."), { recursive: true });
				try {
					writeFileSync(dest, readFileSync(full));
					files++;
					bytes += info.size;
				} catch {
					// Unreadable files are skipped; the snapshot still succeeds.
				}
			}
		};
		walk(this.paths.workspace, "");
		return { name, files, bytes };
	}

	async restoreSnapshot(name: string): Promise<{ name: string; restored: number }> {
		const source = join(this.paths.snapshots, name.replace(/[^\w.-]/g, "_"));
		if (!existsSync(source)) throw new Error(`snapshot não encontrado: ${name}`);
		rmSync(this.paths.workspace, { recursive: true, force: true });
		mkdirSync(this.paths.workspace, { recursive: true });
		let restored = 0;
		const walk = (dir: string, prefix: string): void => {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				const rel = prefix ? `${prefix}/${entry}` : entry;
				const info = statSync(full);
				if (info.isDirectory()) {
					walk(full, rel);
					continue;
				}
				const dest = join(this.paths.workspace, rel);
				mkdirSync(join(dest, ".."), { recursive: true });
				writeFileSync(dest, readFileSync(full));
				restored++;
			}
		};
		walk(source, "");
		return { name, restored };
	}

	listSnapshots(): { name: string; createdAt: number; files: number }[] {
		const dir = this.paths.snapshots;
		if (!existsSync(dir)) return [];
		const out: { name: string; createdAt: number; files: number }[] = [];
		for (const name of readdirSync(dir)) {
			if (name.startsWith("__")) continue;
			const full = join(dir, name);
			let files = 0;
			const count = (path: string): void => {
				for (const entry of readdirSync(path)) {
					const next = join(path, entry);
					if (statSync(next).isDirectory()) count(next);
					else files++;
				}
			};
			try {
				count(full);
				out.push({ name, createdAt: statSync(full).mtimeMs, files });
			} catch {
				// A snapshot removed mid-listing is skipped.
			}
		}
		return out.sort((a, b) => b.createdAt - a.createdAt);
	}

	/* ---------- scheduled tasks ---------- */

	schedule(command: string, everySeconds: number): { id: string; command: string; everySeconds: number } {
		const id = randomUUID();
		const interval = Math.max(30, Math.round(everySeconds)) * 1000;
		const timer = setInterval(() => {
			const entry = this.schedules.get(id);
			if (entry) entry.lastRun = Date.now();
			this.runTask(command, { name: `agendada: ${command.slice(0, 40)}` });
		}, interval);
		this.schedules.set(id, { id, command, everySeconds: Math.round(everySeconds), timer });
		return { id, command, everySeconds: Math.round(everySeconds) };
	}

	unschedule(id: string): void {
		const entry = this.schedules.get(id);
		if (!entry) return;
		clearInterval(entry.timer);
		this.schedules.delete(id);
	}

	async shutdown(): Promise<void> {
		if (!this.booted) return;
		this.emit({ type: "shutdown" });
		try {
			await this.execRaw("poweroff", 15_000);
		} catch {
			// pty may close before poweroff output lands
		}
		this.booted = false;
		this.serialPath = null;
		this.child?.kill();
		this.child = null;
		this.virtiofsd?.kill();
		this.virtiofsd = null;
		await this.proxy?.close().catch(() => undefined);
		this.proxy = null;
		for (const entry of this.schedules.values()) clearInterval(entry.timer);
		this.schedules.clear();
	}
}
