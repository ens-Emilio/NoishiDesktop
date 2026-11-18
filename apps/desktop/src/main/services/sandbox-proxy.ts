/**
 * Sandbox egress proxy: the only way out of the VM.
 *
 * QEMU runs with `-netdev user,restrict=on` — the guest has no route to the
 * outside world — plus `guestfwd`, which forwards one fixed guest address to
 * this server. Every request the guest makes to "the internet" therefore lands
 * here and is either tunnelled to an allowlisted host or refused.
 *
 * The guest is configured with `http_proxy`/`https_proxy` pointing at
 * `guestEndpoint`, so npm/pip/git send absolute-URI requests and CONNECT
 * tunnels here. Origin-form requests (no proxy env) are also accepted, resolving
 * the target from the Host header — a transparent fallback.
 *
 * Allowlist is per-domain: npm, PyPI, crates.io, GitHub. A domain matches itself
 * and its subdomains; everything else is denied and logged, which is what the
 * UI shows the user.
 */

import net from "node:net";

export const DEFAULT_ALLOWLIST = [
	"dl-cdn.alpinelinux.org",
	"registry.npmjs.org",
	"npmjs.com",
	"npmjs.org",
	"pypi.org",
	"files.pythonhosted.org",
	"crates.io",
	"static.crates.io",
	"index.crates.io",
	"github.com",
	"codeload.github.com",
	"objects.githubusercontent.com",
	"raw.githubusercontent.com",
	"api.github.com",
];

export type ProxyLogEntry = { at: number; host: string; allowed: boolean; method: string };

export type SandboxProxy = {
	port: number;
	allowlist: string[];
	setAllowlist(domains: string[]): void;
	log(): ProxyLogEntry[];
	close(): Promise<void>;
	/** Address the guest talks to; wired through QEMU guestfwd. */
	readonly guestEndpoint: string;
};

const GUEST_HOST = "10.0.2.100";
const GUEST_PORT = 3128;

function hostAllowed(host: string, allowlist: string[]): boolean {
	const lower = host.toLowerCase().replace(/\.$/, "");
	return allowlist.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

type RequestHead = { method: string; target: string; headers: string[]; rest: string };

/** Read a proxy request head (line + headers) off a raw socket. */
function readHead(socket: net.Socket): Promise<RequestHead | null> {
	return new Promise((resolve) => {
		let buffer = "";
		const done = (value: RequestHead | null): void => {
			socket.off("data", onData);
			socket.off("error", onError);
			socket.pause();
			resolve(value);
		};
		const onData = (chunk: Buffer): void => {
			buffer += chunk.toString("latin1");
			const end = buffer.indexOf("\r\n\r\n");
			if (end === -1) {
				if (buffer.length > 16_384) done(null);
				return;
			}
			const [line = "", ...headers] = buffer.slice(0, end).split("\r\n");
			const [method = "", target = ""] = line.split(" ");
			done({ method, target, headers, rest: buffer.slice(end + 4) });
		};
		const onError = (): void => done(null);
		socket.on("data", onData);
		socket.on("error", onError);
	});
}

/** Resolve the upstream host from a request head (absolute-URI, CONNECT, or Host). */
function resolveTarget(head: RequestHead): { host: string; port: number } | null {
	if (head.method === "CONNECT") {
		const [host, port] = head.target.split(":");
		return host ? { host, port: Number(port) || 443 } : null;
	}
	if (/^https?:\/\//i.test(head.target)) {
		try {
			const url = new URL(head.target);
			return { host: url.hostname, port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) };
		} catch {
			return null;
		}
	}
	// Origin-form: the guest was not told about the proxy; use the Host header.
	const hostHeader = head.headers.find((h) => /^host:/i.test(h));
	if (!hostHeader) return null;
	const value = hostHeader.slice(hostHeader.indexOf(":") + 1).trim();
	const [host, port] = value.split(":");
	if (!host) return null;
	return { host, port: Number(port) || 80 };
}

export async function startSandboxProxy(options: { allowlist?: string[]; port?: number } = {}): Promise<SandboxProxy> {
	const allowlist = [...(options.allowlist ?? DEFAULT_ALLOWLIST)];
	const entries: ProxyLogEntry[] = [];
	const sockets = new Set<net.Socket>();

	const record = (host: string, allowed: boolean, method: string): void => {
		entries.push({ at: Date.now(), host, allowed, method });
		if (entries.length > 500) entries.splice(0, entries.length - 500);
	};

	const server = net.createServer((client) => {
		sockets.add(client);
		client.on("close", () => sockets.delete(client));
		client.on("error", () => client.destroy());
		void handle(client);
	});

	async function handle(client: net.Socket): Promise<void> {
		const head = await readHead(client);
		if (!head) {
			client.destroy();
			return;
		}
		const target = resolveTarget(head);
		const host = target?.host ?? "";
		const allowed = Boolean(target) && hostAllowed(host, allowlist);
		record(host || `(unparsed) ${head.method} ${head.target.slice(0, 60)}`, allowed, head.method);

		if (!target || !allowed) {
			const body = `blocked by sandbox policy: ${host || "unknown host"} is not allowlisted\n`;
			client.end(
				`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
			);
			return;
		}

		const upstream = net.connect(target.port, target.host);
		sockets.add(upstream);
		upstream.on("close", () => sockets.delete(upstream));
		upstream.on("error", () => client.destroy());
		client.on("error", () => upstream.destroy());
		upstream.on("connect", () => {
			if (head.method === "CONNECT") {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			} else {
				// Replay the head upstream in origin-form, then stream the rest.
				const path = /^https?:\/\//i.test(head.target) ? new URL(head.target).pathname || "/" : head.target;
				const query = /^https?:\/\//i.test(head.target) ? new URL(head.target).search : "";
				upstream.write(`${head.method} ${path}${query} HTTP/1.1\r\n${head.headers.join("\r\n")}\r\n\r\n`);
				if (head.rest) upstream.write(head.rest, "latin1");
			}
			client.pipe(upstream);
			upstream.pipe(client);
			client.resume();
		});
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return {
		port,
		allowlist,
		guestEndpoint: `${GUEST_HOST}:${GUEST_PORT}`,
		setAllowlist(domains: string[]): void {
			allowlist.length = 0;
			allowlist.push(...domains);
		},
		log(): ProxyLogEntry[] {
			return [...entries];
		},
		async close(): Promise<void> {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
