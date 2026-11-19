/**
 * OpenBot sandbox lifecycle manager for NoishiDesktop.
 *
 * Manages ONLY the agent-computer and supervisor containers via Docker Compose.
 * The intelligence layer (threads, memory, skills, AG-UI streaming) runs as a
 * local Node.js daemon (LocalIntelligenceDaemon) — no PostgreSQL, no CopilotKit
 * Intelligence, no license token required.
 *
 * Lifecycle:
 *   stopped → installing → starting → running → stopping → stopped
 *                            ↘ error ↙
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { startDaemon, stopDaemon, getDaemonHandle, isDaemonRunning } from "./local-intelligence/daemon-manager.js";

export interface SandboxStatus {
	sandbox: "stopped" | "installing" | "starting" | "running" | "stopping" | "error";
	engine: "docker" | "podman" | "none";
	engineAvailable: boolean;
	ports: {
		computer: number;
		supervisor: number;
	};
	daemonPort: number | null;
	version?: string;
	error?: string;
}

export interface SandboxConfig {
	workspace: string;
	enabled: boolean;
}

const OPENBOT_DIR = join(homedir(), ".noishi", "openbot");
const COMPOSE_FILE = join(OPENBOT_DIR, "docker-compose.yml");

const DEFAULT_PORTS = {
	computer: 4100,
	supervisor: 4500,
};

async function detectEngine(): Promise<{ engine: "docker" | "podman"; available: boolean }> {
	for (const engine of ["docker", "podman"] as const) {
		try {
			const out = await execCmd(engine, ["info", "--format", "{{.ServerVersion}}"]);
			if (out.code === 0) return { engine, available: true };
		} catch {
			// try next
		}
	}
	return { engine: "docker", available: false };
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

function defer<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function execCmd(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const { promise, resolve } = defer<{ code: number; stdout: string; stderr: string }>();
	const child = spawn(cmd, args, { cwd, stdio: "pipe" });
	let stdout = "", stderr = "";
	child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
	child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
	child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
	return promise;
}

async function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
	const { promise, resolve } = defer<boolean>();
	const socket = createConnection({ host, port, timeout: 2000 });
	socket.on("connect", () => {
		socket.destroy();
		resolve(true);
	});
	socket.on("timeout", () => {
		socket.destroy();
		resolve(false);
	});
	socket.on("error", () => {
		socket.destroy();
		resolve(false);
	});
	return promise;
}

function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Generate docker-compose.yml with ONLY agent-computer + supervisor. */
function generateCompose(noishiWorkspace: string): string {
	return [
		'version: "3.9"',
		"",
		"services:",
		"  agent-computer:",
		"    image: ghcr.io/copilotkit/openbot:1.0.3",
		"    command: /app/bin/openbot-computer",
		"    environment:",
		"      COMPUTER_TOKEN_FILE: /run/secrets/computer_token",
		"      COMPUTER_SUPERVISOR_URL: http://supervisor:4500",
		`      COMPUTER_WORKSPACE_DIR: ${noishiWorkspace}`,
		"      COMPUTER_SHELL_ENV: NOISHI_SANDBOX=1",
		"    secrets:",
		"      - computer_token",
		"    volumes:",
		`      - ${noishiWorkspace}:${noishiWorkspace}`,
		"    networks:",
		"      - openbot_net",
		"    ports:",
		`      - "${DEFAULT_PORTS.computer}:4100"`,
		"    restart: unless-stopped",
		"",
		"  supervisor:",
		"    image: ghcr.io/copilotkit/openbot:1.0.3",
		"    command: /app/bin/openbot-supervisor",
		"    environment:",
		`      COMPUTER_RUNTIME: ${process.platform === "linux" ? "runsc" : ""}`,
		"    networks:",
		"      - openbot_net",
		"    ports:",
		`      - "${DEFAULT_PORTS.supervisor}:4500"`,
		"    volumes:",
		"      - /var/run/docker.sock:/var/run/docker.sock",
		"    restart: unless-stopped",
		"",
		"secrets:",
		"  computer_token:",
		`    file: ${OPENBOT_DIR}/secrets/computer_token`,
		"",
		"networks:",
		"  openbot_net:",
		"    driver: bridge",
		"",
	].join("\n");
}

function ensureSecrets(): void {
	const secretsDir = join(OPENBOT_DIR, "secrets");
	ensureDir(secretsDir);

	const computerToken = join(secretsDir, "computer_token");
	if (!existsSync(computerToken)) {
		writeFileSync(computerToken, randomBytes(32).toString("hex"), { mode: 0o600 });
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** SandboxStack: manages agent-computer + supervisor containers and the local intelligence daemon. */
export class SandboxStack {
	private _status: SandboxStatus["sandbox"] = "stopped";
	private _engine: "docker" | "podman" = "docker";
	private _engineAvailable = false;
	private _process: ChildProcess | null = null;
	private _workspace: string;
	private _config: SandboxConfig;
	private _lastError = "";

	constructor(workspace: string, config?: Partial<SandboxConfig>) {
		this._workspace = workspace;
		this._config = {
			workspace,
			enabled: false,
			...config,
		};
	}

	get status(): SandboxStatus["sandbox"] {
		return this._status;
	}

	get engine(): "docker" | "podman" {
		return this._engine;
	}

	get engineAvailable(): boolean {
		return this._engineAvailable;
	}

	async probe(): Promise<SandboxStatus> {
		const { engine, available } = await detectEngine();
		this._engine = engine;
		this._engineAvailable = available;

		const running = await this._isSandboxRunning();
		if (this._status === "stopped" && running) this._status = "running";
		if (this._status === "running" && !running) this._status = "stopped";

		return this.getStatus();
	}

	async getStatus(): Promise<SandboxStatus> {
		const running = await this._isSandboxRunning();
		const daemon = getDaemonHandle();
		return {
			sandbox: running ? "running" : this._status,
			engine: this._engine,
			engineAvailable: this._engineAvailable,
			ports: { ...DEFAULT_PORTS },
			daemonPort: daemon?.port ?? null,
			version: "1.0.3",
			error: this._status === "error" ? this._lastError : undefined,
		};
	}

	private _setError(msg: string): void {
		this._lastError = msg;
		this._status = "error";
	}

	private async _deploy(): Promise<void> {
		ensureDir(OPENBOT_DIR);
		ensureSecrets();

		const compose = generateCompose(this._workspace);
		writeFileSync(COMPOSE_FILE, compose);

		// Pull images in background
		const pull = spawn(this._engine, ["compose", "-p", "noishi-sandbox", "-f", COMPOSE_FILE, "pull"], {
			cwd: OPENBOT_DIR,
			stdio: "ignore",
		});
		void pull;
	}

	/** Start sandbox containers + local intelligence daemon. */
	async start(): Promise<void> {
		if (this._status === "running" || this._status === "starting") return;

		this._status = "starting";

		try {
			const { engine, available } = await detectEngine();
			this._engine = engine;
			this._engineAvailable = available;

			if (!available) {
				this._setError("No container engine found. Install Docker or Podman.");
				return;
			}

			await this._deploy();

			const up = spawn(
				this._engine,
				["compose", "-p", "noishi-sandbox", "-f", COMPOSE_FILE, "up", "-d"],
				{ cwd: OPENBOT_DIR, stdio: "pipe" },
			);
			this._process = up;

			// Wait for agent-computer to be healthy (up to 60s)
			for (let i = 0; i < 60; i++) {
				await sleep(1000);
				if (await isPortOpen(DEFAULT_PORTS.computer)) {
					this._status = "running";
					break;
				}
			}

			if (this._status !== "running") {
				this._setError("Sandbox started but agent-computer did not become healthy within 60s.");
				return;
			}

			// Start local intelligence daemon (lazy, non-blocking)
			try {
				await startDaemon();
			} catch (err) {
				console.error("[sandbox] Failed to start intelligence daemon:", err);
				// Non-fatal: sandbox still usable without intelligence
			}
		} catch (err) {
			this._setError(err instanceof Error ? err.message : String(err));
		}
	}

	/** Stop sandbox containers + local intelligence daemon. */
	async stop(): Promise<void> {
		if (this._status === "stopped" || this._status === "stopping") return;

		this._status = "stopping";

		try {
			// Stop daemon first
			await stopDaemon();

			// Then stop containers
			const result = await execCmd(
				this._engine,
				["compose", "-p", "noishi-sandbox", "-f", COMPOSE_FILE, "down", "--remove-orphans"],
				OPENBOT_DIR,
			);

			if (result.code !== 0) {
				this._setError(`Stop failed: ${result.stderr}`);
				return;
			}

			this._status = "stopped";
		} catch (err) {
			this._setError(err instanceof Error ? err.message : String(err));
		}
	}

	async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}

	private async _isSandboxRunning(): Promise<boolean> {
		if (!existsSync(COMPOSE_FILE)) return false;
		const result = await execCmd(
			this._engine,
			["compose", "-p", "noishi-sandbox", "-f", COMPOSE_FILE, "ps", "--format", "json"],
			OPENBOT_DIR,
		);
		if (result.code !== 0) return false;
		try {
			const services = JSON.parse(result.stdout) as Array<{ Name: string; State: string }>;
			return services.some((s) => s.Name.includes("agent-computer") && s.State === "running");
		} catch {
			return false;
		}
	}

	/** Get the local intelligence daemon URL (null if not running). */
	getDaemonUrl(): string | null {
		const handle = getDaemonHandle();
		return handle?.baseUrl ?? null;
	}

	/** Check if the intelligence daemon is running. */
	isDaemonRunning(): boolean {
		return isDaemonRunning();
	}

	updateConfig(patch: Partial<SandboxConfig>): void {
		this._config = { ...this._config, ...patch };
	}

	getConfig(): SandboxConfig {
		return { ...this._config };
	}
}