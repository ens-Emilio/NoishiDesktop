/**
 * Thin pi RPC client: spawns the noishi CLI in `--mode rpc` and speaks JSONL.
 *
 * Protocol (pi rpc-types): JSON commands on stdin; responses (id-matched)
 * and events on stdout. We implement only what the desktop uses. Kept local
 * on purpose — importing pi's dist inside the Electron main pulls node:sqlite
 * (unavailable in Electron 33's node 20).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killProcessGroup, trackProcess } from "./process-supervisor.js";

export type RpcEvent = Record<string, unknown>;

export type RpcResponse = {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

export type RpcClientOptions = {
	entryPath: string;
	cwd: string;
	provider?: string;
	model?: string;
};

const REQUEST_TIMEOUT_MS = 60_000;

export class ThinRpcClient {
	private child: ChildProcess | null = null;
	private readonly listeners = new Set<(event: RpcEvent) => void>();
	private readonly pending = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
	private requestId = 0;
	private stderrTail = "";
	private exitError: Error | null = null;
	private stopping = false;
	private readonly decoder = new StringDecoder("utf8");
	private readonly options: RpcClientOptions;

	constructor(options: RpcClientOptions) {
		this.options = options;
	}

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async start(): Promise<void> {
		const args = [this.options.entryPath, "--mode", "rpc"];
		if (this.options.provider) args.push("--provider", this.options.provider);
		if (this.options.model) args.push("--model", this.options.model);
		// Inside Electron, process.execPath is Electron (node 20, no node:sqlite).
		// The pi CLI needs the host Node; fall back to execPath when run bare.
		const command = process.env.ELECTRON_RUN_AS_NODE ? process.execPath : "node";
		this.stopping = false;
		this.exitError = null;
		this.stdoutBuffer = "";
		this.child = spawn(command, args, {
			cwd: this.options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		trackProcess(`rpc:${this.options.cwd}:${Date.now()}`, "noushi-rpc", this.child);
		this.child.on("error", (error) => {
			this.exitError = new Error(`spawn failed: ${error.message}`);
			for (const pending of this.pending.values()) pending.reject(this.exitError);
			this.pending.clear();
		});
		console.log("[noishi-desktop] rpc child spawned pid=", this.child.pid);
		this.child.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
		});
		this.child.stdout?.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
		this.child.on("exit", (code, signal) => {
			console.log("[noishi-desktop] rpc child exited code=", code, "signal=", signal);
			const message = `noishi rpc exited (code=${code} signal=${signal}). stderr: ${this.stderrTail}`;
			this.exitError = new Error(message);
			for (const pending of this.pending.values()) pending.reject(this.exitError);
			this.pending.clear();
			if (!this.stopping) {
				for (const listener of [...this.listeners]) {
					listener({ type: "rpc_exit", code, signal, message });
				}
			}
		});
	}

	private stdoutBuffer = "";

	private consumeStdout(chunk: Buffer): void {
		this.stdoutBuffer += this.decoder.write(chunk);
		let start = 0;
		let newlineIndex = this.stdoutBuffer.indexOf("\n", start);
		while (newlineIndex !== -1) {
			const line = this.stdoutBuffer.slice(start, newlineIndex).trim();
			start = newlineIndex + 1;
			if (line) this.handleLine(line);
			newlineIndex = this.stdoutBuffer.indexOf("\n", start);
		}
		if (start > 0) this.stdoutBuffer = this.stdoutBuffer.slice(start);
	}

	private handleLine(line: string): void {
		let data: RpcEvent;
		try {
			data = JSON.parse(line) as RpcEvent;
		} catch {
			return;
		}
		if (data.type === "response" && typeof data.id === "string") {
			const pending = this.pending.get(data.id);
			if (pending) {
				this.pending.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}
		}
		for (const listener of [...this.listeners]) listener(data);
	}

	async send(command: Record<string, unknown>): Promise<unknown> {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || this.exitError) {
			throw this.exitError ?? new Error("rpc not started");
		}
		const id = `req_${++this.requestId}`;
		// esbuild 0.21 (electron-vite 2.x) doesn't know ES2024; avoid withResolvers.
		let resolvePending: (value: unknown) => void = () => {};
		let rejectPending: (reason: Error) => void = () => {};
		const promise = new Promise<unknown>((resolve, reject) => {
			resolvePending = resolve;
			rejectPending = reject;
		});
		const timeout = setTimeout(() => {
			this.pending.delete(id);
			rejectPending(new Error(`timeout waiting for ${String(command.type)}`));
		}, REQUEST_TIMEOUT_MS);
		this.pending.set(id, {
			resolve: (response) => {
				clearTimeout(timeout);
				if (response.success) resolvePending(response.data);
				else rejectPending(new Error(response.error ?? "rpc command failed"));
			},
			reject: (error) => {
				clearTimeout(timeout);
				rejectPending(error);
			},
		});
		stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		return promise;
	}

	async getState(): Promise<Record<string, unknown>> {
		return this.send({ type: "get_state" }) as Promise<Record<string, unknown>>;
	}

	answerExtensionUi(response: { id: string } & Record<string, unknown>): void {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed) return;
		stdin.write(`${JSON.stringify({ type: "extension_ui_response", ...response })}\n`);
	}

	async stop(): Promise<void> {
		const child = this.child;
		this.child = null;
		this.stopping = true;
		if (!child) return;
		const pid = child.pid;
		// esbuild 0.21 (electron-vite 2.x) doesn't know ES2024; avoid withResolvers.
		let exitResolve: () => void = () => {};
		const promise = new Promise<void>((resolve) => {
			exitResolve = resolve;
		});
		const timer = setTimeout(() => {
			if (pid) killProcessGroup(pid, "SIGKILL");
			exitResolve();
		}, 2500);
		child.once("exit", () => {
			clearTimeout(timer);
			exitResolve();
		});
		child.stdin?.end();
		if (pid) killProcessGroup(pid, "SIGTERM");
		else child.kill();
		await promise;
	}
}
