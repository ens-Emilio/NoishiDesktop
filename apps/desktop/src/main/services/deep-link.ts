/**
 * Deep links: noushi:// protocol handling with single-instance routing.
 *
 * Routes (mirroring the Claude Desktop surface, Noushi names):
 *   noushi://chat/new
 *   noushi://code/new?cwd=/abs/path
 *   noushi://code/continue
 *   noushi://code/needs-input
 *   noushi://cowork/shared-artifact
 */

import { app, type BrowserWindow } from "electron";

const SCHEME = "noushi";

export type DeepLinkRoute =
	| { kind: "chat/new" }
	| { kind: "code/new"; cwd?: string }
	| { kind: "code/continue" }
	| { kind: "code/needs-input" }
	| { kind: "cowork/shared-artifact"; artifactId?: string };

export function parseDeepLink(url: string): DeepLinkRoute | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== `${SCHEME}:`) return null;
	const host = parsed.hostname || parsed.pathname.replace(/^\/\//, "").split("/")[0];
	const params = parsed.searchParams;
	const cwd = params.get("cwd") ?? undefined;
	switch (host) {
		case "chat":
			return { kind: "chat/new" };
		case "code":
			if (parsed.pathname.includes("continue") || params.has("continue")) return { kind: "code/continue" };
			if (parsed.pathname.includes("needs-input")) return { kind: "code/needs-input" };
			return { kind: "code/new", cwd };
		case "cowork":
			return { kind: "cowork/shared-artifact", artifactId: params.get("id") ?? undefined };
		default:
			return null;
	}
}

type PendingRoute = { route: DeepLinkRoute; resolve: (value: DeepLinkRoute | null) => void };

const pending: PendingRoute[] = [];

/** App-lifecycle deep link installation. */
export const registerDeepLinks = {
	/** Must run before app ready. */
	install(): void {
		if (process.defaultApp) {
			// dev: protocol arrives as argv
			const arg = process.argv.find((a) => a.startsWith(`${SCHEME}://`));
			if (arg) {
				const route = parseDeepLink(arg);
				if (route) pending.push({ route, resolve: () => {} });
			}
			return;
		}
		app.setAsDefaultProtocolClient(SCHEME);
	},

	/** Windows/Linux second instance carries the URL in argv. */
	handleSecondInstance(argv: string[]): void {
		const arg = argv.find((a) => a.startsWith(`${SCHEME}://`));
		if (!arg) return;
		const route = parseDeepLink(arg);
		if (!route) return;
		for (const p of pending) p.resolve(route);
		pending.length = 0;
		pending.push({ route, resolve: () => {} });
	},

	parse(url: string): DeepLinkRoute | null {
		return parseDeepLink(url);
	},

	/** Drain one pending route (the main window asks on load). */
	drain(): DeepLinkRoute | null {
		const first = pending.shift();
		return first?.route ?? null;
	},
};
