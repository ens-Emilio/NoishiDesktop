/**
 * Cowork service: runs tasks inside a local Alpine VM (QEMU/KVM) with the
 * host network fully denied at the hypervisor level (-nic none => no NIC).
 *
 * Asset layout (~/noishi-cowork/): alpine-virt.iso + extracted kernel/initrd.
 * Direct-kernel boot with console=ttyS0; commands over the serial pty.
 * Allowlist networking (mitm proxy) is the v2 upgrade path; v1 is deny-all,
 * which satisfies "rede restrita" strictly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COWORK_DIR = process.env.NOISHI_COWORK_DIR ?? join(homedir(), "noishi-cowork");
const VM_MEM_MB = 1024;
const VM_SMP = 2;
const BOOT_TIMEOUT_MS = 90_000;
const COMMAND_TIMEOUT_MS = 120_000;

type CoworkEvent = { type: "boot" | "command" | "error" | "shutdown"; detail?: string };

export class CoworkService {
	private child: ChildProcess | null = null;
	private ptyPath: string | null = null;
	private pendingBuffer = "";
	private readonly listeners = new Set<(event: CoworkEvent) => void>();
	private booted = false;

	onEvent(listener: (event: CoworkEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: CoworkEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	private assets(): { kernel: string; initrd: string; iso: string } | null {
		const kernel = join(COWORK_DIR, "iso-extract/boot/vmlinuz-virt");
		const initrd = join(COWORK_DIR, "iso-extract/boot/initramfs-virt");
		const iso = join(COWORK_DIR, "alpine-virt.iso");
		if (!existsSync(kernel) || !existsSync(initrd) || !existsSync(iso)) return null;
		return { kernel, initrd, iso };
	}

	assetStatus(): { ready: boolean; dir: string } {
		return { ready: this.assets() !== null, dir: COWORK_DIR };
	}

	async boot(): Promise<void> {
		if (this.booted && this.child) return;
		const assets = this.assets();
		if (!assets) throw new Error(`cowork assets missing in ${COWORK_DIR} (alpine-virt.iso + iso-extract/boot/*)`);
		this.emit({ type: "boot", detail: "starting qemu" });
		const child = spawn(
			"qemu-system-x86_64",
			[
				"-m", String(VM_MEM_MB),
				"-smp", String(VM_SMP),
				"-enable-kvm", "-cpu", "host",
				"-kernel", assets.kernel,
				"-initrd", assets.initrd,
				"-append", "console=ttyS0",
				"-cdrom", assets.iso,
				// No NIC at all: the deny-all restricted network guarantee.
				"-nic", "none",
				"-display", "none",
				"-serial", "unix:/tmp/noishi-cowork-serial.sock,server=on,wait=off",
				"-monitor", "none",
			],
			{ stdio: ["ignore", "ignore", "pipe"], detached: false },
		);
		const stderr: string[] = [];
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr.push(chunk.toString());
			// qemu prints the pty path on stderr before daemonizing.
			const match = /redirected to (\/dev\/pts\/\d+)/.exec(stderr.join(""));
			if (match && !this.ptyPath) {
				this.ptyPath = match[1] ?? null;
			}
		});
		// Fixed unix socket path — no stderr parsing needed.
		this.ptyPath = "/tmp/noishi-cowork-serial.sock";
		await new Promise<void>((resolve, reject) => {
			const deadline = setTimeout(() => reject(new Error(`qemu serial socket not ready: ${stderr.join("").slice(0, 200)}`)), 15_000);
			const check = setInterval(() => {
				if (existsSync(this.ptyPath as string)) {
					clearInterval(check);
					clearTimeout(deadline);
					resolve();
				}
			}, 100);
			child.on("exit", (code) => {
				clearInterval(check);
				clearTimeout(deadline);
				reject(new Error(`qemu exited ${code}: ${stderr.join("").slice(0, 400)}`));
			});
		});
		this.child = child;
		if (!this.ptyPath) throw new Error(`qemu serial pty not found: ${stderr.join("").slice(0, 200)}`);
		await this.login();
		this.booted = true;
		this.emit({ type: "boot", detail: "ready" });
	}

	private async login(): Promise<void> {
		const { openSerial } = await import("./serial-pty.js");
		const serial = openSerial(this.ptyPath as string);
		try {
			// Wait for login prompt, log in, wait for shell prompt.
			const sawLogin = await serial.waitFor(/login:/, BOOT_TIMEOUT_MS);
			if (!sawLogin) throw new Error("vm login prompt not seen");
			serial.write("root\n");
			await serial.waitFor(/[:~#]\s*$/, 30_000);
			// ash probes the terminal with a DSR cursor query on every prompt;
			// it holds the typed command until we answer with the cursor report.
			serial.write("\x1b[1;1R");
		} finally {
			serial.close();
		}
	}

	async exec(command: string): Promise<string> {
		if (!this.booted || !this.ptyPath) throw new Error("cowork vm not booted");
		const { openSerial } = await import("./serial-pty.js");
		const serial = openSerial(this.ptyPath as string);
		try {
		// Short marker: the serial console wraps at 80 columns and a wrapped
		// marker never matches, so keep the whole marker line well under that.
			const marker = `D${Date.now() % 100000}X`;
			// START first, then the command: the echoed command line can WRAP at
			// 80 columns and split a marker mid-line (never matches), and the
			// echo itself contains both markers. Executed START/END always begin
			// at line start; output sits strictly between them.
			serial.write(`echo ${marker}_START; ${command}; echo ${marker}_END\n`);
			await serial.waitFor(new RegExp(`${marker}_END\\r\\nlocalhost:~#`), COMMAND_TIMEOUT_MS);
			const buffer = serial.drain();
			const startMatch = new RegExp(`(?:^|\\r\\n)${marker}_START\\r\\n`).exec(buffer);
			const endMatch = new RegExp(`\\r\\n${marker}_END\\r\\nlocalhost:~#`).exec(buffer);
			if (!startMatch || !endMatch || endMatch.index < startMatch.index) return "";
			return buffer.slice(startMatch.index + startMatch[0].length, endMatch.index).replace(/\r/g, "").trimEnd();
		} finally {
			serial.close();
		}
	}

	async shutdown(): Promise<void> {
		if (!this.booted) return;
		this.emit({ type: "shutdown" });
		try {
			await this.exec("poweroff");
		} catch {
			// pty may close before poweroff output lands
		}
		this.booted = false;
		this.ptyPath = null;
		this.child = null;
	}
}
