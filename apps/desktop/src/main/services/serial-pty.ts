/**
 * Minimal serial (unix socket) client shared by cowork exec sessions.
 * Each openSerial gets its own connection; waitFor scans an accumulating buffer.
 */

import net from "node:net";

export type SerialSession = {
	write(data: string): void;
	waitFor(pattern: RegExp, timeoutMs: number): Promise<string | null>;
	close(): void;
};

export function openSerial(path: string): SerialSession {
	const socket = net.connect(path);
	socket.setEncoding("utf-8");
	let buffer = "";
	let closed = false;
	socket.on("data", (chunk: string) => {
		buffer += chunk;
	});

	return {
		write(data: string): void {
			if (closed || socket.destroyed) return;
			socket.write(data);
		},
		waitFor(pattern: RegExp, timeoutMs: number): Promise<string | null> {
			return new Promise((resolve) => {
				const deadline = Date.now() + timeoutMs;
				const check = setInterval(() => {
					if (pattern.test(buffer)) {
						clearInterval(check);
						const snapshot = buffer;
						resolve(snapshot);
						return;
					}
					if (Date.now() > deadline) {
						clearInterval(check);
						resolve(null);
					}
				}, 200);
			});
		},
		close(): void {
			closed = true;
			socket.destroy();
		},
	};
}
