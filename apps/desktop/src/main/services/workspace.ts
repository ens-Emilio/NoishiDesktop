/**
 * Workspace service: file tree, fuzzy path search (@-mention), open-in-editor.
 *
 * The renderer never touches the filesystem directly (sandboxed, no Node). All
 * listing/search goes through here. Trees are cached briefly because the find
 * bar and @-mention re-query on every keystroke.
 */

import { readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const IGNORED: Record<string, true> = {
	node_modules: true,
	".git": true,
	dist: true,
	out: true,
	build: true,
	".next": true,
	".cache": true,
	target: true,
	vendor: true,
	__pycache__: true,
	".venv": true,
	venv: true,
};

export type FileNode = { name: string; path: string; dir: boolean; size?: number; children?: FileNode[] };

/** Build a bounded depth-limited tree; never walks into ignore dirs. */
export async function readTree(root: string, maxDepth = 3, maxEntries = 800): Promise<FileNode[]> {
	let budget = maxEntries;
	const walk = async (dir: string, depth: number): Promise<FileNode[]> => {
		if (depth > maxDepth || budget <= 0) return [];
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return [];
		}
		entries.sort((a, b) => {
			const aDir = !a.includes(".");
			const bDir = !b.includes(".");
			if (aDir !== bDir) return aDir ? -1 : 1;
			return a.localeCompare(b);
		});
		const nodes: FileNode[] = [];
		for (const name of entries) {
			if (budget <= 0) break;
			if (name.startsWith(".") && name !== ".github") continue;
			if (IGNORED[name] === true) continue;
			const full = join(dir, name);
			let info;
			try {
				info = await stat(full);
			} catch {
				continue;
			}
			budget--;
			if (info.isDirectory()) {
				nodes.push({ name, path: full, dir: true, children: await walk(full, depth + 1) });
			} else {
				nodes.push({ name, path: full, dir: false, size: info.size });
			}
		}
		return nodes;
	};
	return walk(resolve(root), 0);
}

/** Flat list of file paths for fuzzy matching (bounded). */
export async function listFiles(root: string, limit = 5000): Promise<string[]> {
	const tree = await readTree(root, 6, limit);
	const out: string[] = [];
	const push = (node: FileNode): void => {
		if (!node.dir) out.push(node.path);
		for (const child of node.children ?? []) push(child);
	};
	for (const node of tree) push(node);
	return out.slice(0, limit);
}

/** Subsequence score: higher is better, null means no match. */
function fuzzyScore(query: string, text: string): number | null {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	let qi = 0;
	let score = 0;
	let streak = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			qi++;
			streak++;
			score += 1 + streak * 2;
			if (ti === 0 || t[ti - 1] === "/" || t[ti - 1] === ".") score += 6;
		} else {
			streak = 0;
		}
	}
	return qi === q.length ? score : null;
}

export async function searchFiles(root: string, query: string, limit = 20): Promise<{ path: string; rel: string; score: number }[]> {
	if (!query.trim()) return [];
	const files = await listFiles(root);
	const scored: { path: string; rel: string; score: number }[] = [];
	for (const file of files) {
		const rel = relative(root, file);
		const score = fuzzyScore(query, rel);
		if (score === null) continue;
		scored.push({ path: file, rel, score });
	}
	scored.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
	return scored.slice(0, limit);
}

/** Open a path with the user's default application (editor for text files). */
export function openInEditor(path: string): void {
	const target = isAbsolute(path) ? path : resolve(path);
	if (!existsSync(target)) throw new Error(`arquivo não existe: ${basename(target)}`);
	const editor = process.env.NOISHI_EDITOR || process.env.VISUAL || process.env.EDITOR;
	if (editor) {
		// Honour $EDITOR when set: split on spaces so "code -w" works.
		const [cmd, ...args] = editor.split(/\s+/);
		if (cmd) execFile(cmd, [...args, target], { timeout: 10_000 }, () => undefined);
		return;
	}
	execFile("xdg-open", [target], { timeout: 10_000 }, () => undefined);
}
