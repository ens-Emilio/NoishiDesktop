/**
 * Cross-platform sandbox driver abstraction.
 *
 * Linux uses QEMU/KVM + virtiofsd (default). macOS (Virtualization.framework /
 * Lima) and Windows (WSL2) adapters share the same `sandbox-proxy.ts` egress
 * allowlist layer.
 */

export type SandboxDriverStatus = {
	platform: NodeJS.Platform;
	driver: "qemu-kvm" | "lima-vz" | "wsl2";
	available: boolean;
	reason?: string;
};

export interface SandboxDriver {
	readonly name: SandboxDriverStatus["driver"];
	probe(): Promise<SandboxDriverStatus>;
	boot(opts: { workspaceDir: string; proxyPort: number }): Promise<void>;
	exec(command: string, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>;
	shutdown(): Promise<void>;
}

export class LimaVzDriver implements SandboxDriver {
	readonly name = "lima-vz" as const;

	async probe(): Promise<SandboxDriverStatus> {
		return {
			platform: process.platform,
			driver: this.name,
			available: process.platform === "darwin",
			reason: process.platform === "darwin" ? undefined : "Requires macOS",
		};
	}

	async boot(): Promise<void> {
		throw new Error("LimaVzDriver.boot: not yet wired to limactl");
	}

	async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
		throw new Error("LimaVzDriver.exec: not yet wired to limactl");
	}

	async shutdown(): Promise<void> {
		// No-op until booted
	}
}

export class Wsl2Driver implements SandboxDriver {
	readonly name = "wsl2" as const;

	async probe(): Promise<SandboxDriverStatus> {
		return {
			platform: process.platform,
			driver: this.name,
			available: process.platform === "win32",
			reason: process.platform === "win32" ? undefined : "Requires Windows",
		};
	}

	async boot(): Promise<void> {
		throw new Error("Wsl2Driver.boot: not yet wired to wsl.exe");
	}

	async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
		throw new Error("Wsl2Driver.exec: not yet wired to wsl.exe");
	}

	async shutdown(): Promise<void> {
		// No-op until booted
	}
}

export function selectPlatformDriverName(platform: NodeJS.Platform = process.platform): SandboxDriverStatus["driver"] {
	if (platform === "darwin") return "lima-vz";
	if (platform === "win32") return "wsl2";
	return "qemu-kvm";
}
