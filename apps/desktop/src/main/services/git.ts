/**
 * Git service: status, diff, staging, commit, worktrees and blame.
 *
 * Shells out to the system `git` (no bundling). Every call is bounded and
 * tolerant: a non-repo directory answers `isRepo: false` instead of throwing,
 * so the panel can render "not a repository" without error handling at each
 * call site.
 */

import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const GIT_TIMEOUT = 20_000;

type GitResult = { ok: boolean; out: string; err: string };

function git(cwd: string, args: string[], timeout = GIT_TIMEOUT): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({ ok: !error, out: stdout ?? "", err: stderr ?? String(error ?? "") });
		});
	});
}

export type GitFile = { path: string; status: string; staged: boolean };
export type GitStatus = {
	isRepo: boolean;
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	files: GitFile[];
	conflicts: string[];
};

export async function status(cwd: string): Promise<GitStatus> {
	const empty: GitStatus = { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [], conflicts: [] };
	if (!existsSync(join(cwd, ".git")) && !existsSync(cwd)) return empty;
	const probe = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (!probe.ok) return empty;

	const [branchRes, statusRes, trackRes, conflictRes] = await Promise.all([
		git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
		git(cwd, ["status", "--porcelain=v1"]),
		git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
		git(cwd, ["diff", "--name-only", "--diff-filter=U"]),
	]);

	const files: GitFile[] = [];
	for (const line of statusRes.out.split("\n")) {
		if (line.length < 4) continue;
		const index = line[0] ?? " ";
		const work = line[1] ?? " ";
		const path = line.slice(3).trim();
		if (index !== " " && index !== "?") files.push({ path, status: index, staged: true });
		if (work === "?" && index === "?") files.push({ path, status: "?", staged: false });
		else if (work !== " ") files.push({ path, status: work, staged: false });
	}

	let ahead = 0;
	let behind = 0;
	if (trackRes.ok) {
		const counts = await git(cwd, ["rev-list", "--left-right", "--count", `HEAD...@{u}`]);
		const [a, b] = counts.out.trim().split(/\s+/);
		ahead = Number(a ?? 0);
		behind = Number(b ?? 0);
	}

	const conflicts = conflictRes.out.split("\n").map((l) => l.trim()).filter(Boolean);
	return {
		isRepo: true,
		branch: branchRes.ok ? branchRes.out.trim() : null,
		upstream: trackRes.ok ? trackRes.out.trim() : null,
		ahead,
		behind,
		files,
		conflicts,
	};
}

/** Unified diff for one file (staged or working tree). */
export async function diffFile(cwd: string, path: string, staged: boolean): Promise<string> {
	const args = staged ? ["diff", "--cached", "--", path] : ["diff", "--", path];
	const result = await git(cwd, args);
	if (result.out.trim()) return result.out;
	// Untracked files have no diff: synthesize an all-added view.
	const statusRes = await git(cwd, ["status", "--porcelain=v1", "--", path]);
	if (statusRes.out.startsWith("??")) {
		const show = await git(cwd, ["diff", "--no-index", "--", "/dev/null", path]);
		return show.out;
	}
	return "";
}

export async function stage(cwd: string, paths: string[]): Promise<boolean> {
	const result = await git(cwd, ["add", "--", ...paths]);
	return result.ok;
}

export async function unstage(cwd: string, paths: string[]): Promise<boolean> {
	const result = await git(cwd, ["reset", "HEAD", "--", ...paths]);
	return result.ok;
}

/**
 * Discard working-tree changes for a path. A tracked file is restored with
 * `git checkout --`; an untracked one has nothing to restore, so it is removed
 * (that is what "discard" means for a file git never knew).
 */
export async function discard(cwd: string, path: string): Promise<boolean> {
	const tracked = await git(cwd, ["ls-files", "--error-unmatch", "--", path]);
	if (!tracked.ok) {
		const statusRes = await git(cwd, ["status", "--porcelain=v1", "--", path]);
		if (!statusRes.out.startsWith("??")) return false;
		const full = join(cwd, path);
		try {
			rmSync(full, { recursive: true, force: true });
			return true;
		} catch {
			return false;
		}
	}
	const result = await git(cwd, ["checkout", "--", path]);
	return result.ok;
}

export type CommitResult = { ok: boolean; hash?: string; error?: string };

export async function commit(cwd: string, message: string, paths?: string[]): Promise<CommitResult> {
	if (paths?.length) await stage(cwd, paths);
	const result = await git(cwd, ["commit", "-m", message]);
	if (!result.ok) return { ok: false, error: (result.err || result.out).trim().slice(0, 400) };
	const hash = await git(cwd, ["rev-parse", "--short", "HEAD"]);
	return { ok: true, hash: hash.out.trim() };
}

/** Worktrees: list and create, so a session can isolate its own checkout. */
export type Worktree = { path: string; branch: string | null; head: string | null };

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
	const result = await git(cwd, ["worktree", "list", "--porcelain"]);
	if (!result.ok) return [];
	const out: Worktree[] = [];
	let current: Partial<Worktree> = {};
	for (const line of result.out.split("\n")) {
		if (line.startsWith("worktree ")) current = { path: line.slice(9) };
		else if (line.startsWith("HEAD ")) current.head = line.slice(5, 12);
		else if (line.startsWith("branch ")) current.branch = line.slice(7).replace("refs/heads/", "");
		else if (line.trim() === "" && current.path) {
			out.push({ path: current.path, branch: current.branch ?? null, head: current.head ?? null });
			current = {};
		}
	}
	if (current.path) out.push({ path: current.path, branch: current.branch ?? null, head: current.head ?? null });
	return out;
}

export async function addWorktree(cwd: string, targetPath: string, branch: string, createBranch: boolean): Promise<Worktree> {
	const args = createBranch ? ["worktree", "add", "-b", branch, targetPath] : ["worktree", "add", targetPath, branch];
	const result = await git(cwd, args, 60_000);
	if (!result.ok) throw new Error((result.err || result.out).trim().slice(0, 400));
	return { path: targetPath, branch, head: null };
}

/** Per-line blame for a file (short hash + author + summary). */
export type BlameLine = { line: number; hash: string; author: string; date: string; summary: string };

export async function blame(cwd: string, path: string): Promise<BlameLine[]> {
	const result = await git(cwd, ["blame", "--line-porcelain", "--", path], 40_000);
	if (!result.ok) return [];
	const lines: BlameLine[] = [];
	let hash = "";
	let author = "";
	let date = "";
	let lineNo = 0;
	for (const raw of result.out.split("\n")) {
		if (/^[0-9a-f]{40} /.test(raw)) {
			hash = raw.slice(0, 8);
			const match = / [0-9]+ ([0-9]+)$/.exec(raw);
			lineNo = match ? Number(match[1]) : lineNo + 1;
		} else if (raw.startsWith("author ")) author = raw.slice(7);
		else if (raw.startsWith("author-time ")) {
			date = new Date(Number(raw.slice(12)) * 1000).toISOString().slice(0, 10);
		} else if (raw.startsWith("summary ")) {
			lines.push({ line: lineNo, hash, author, date, summary: raw.slice(8) });
		}
	}
	return lines;
}

/** Merge conflict detail for one file: ours vs theirs hunks. */
export type ConflictView = { path: string; ours: string[]; theirs: string[]; hasMarkers: boolean };

export async function readConflict(cwd: string, path: string): Promise<ConflictView> {
	const full = join(cwd, path);

	const content = await readFile(full, "utf-8").catch(() => "");
	const ours: string[] = [];
	const theirs: string[] = [];
	let section: "none" | "ours" | "theirs" = "none";
	for (const line of content.split("\n")) {
		if (line.startsWith("<<<<<<<")) {
			section = "ours";
			continue;
		}
		if (line.startsWith("=======")) {
			section = "theirs";
			continue;
		}
		if (line.startsWith(">>>>>>>")) {
			section = "none";
			continue;
		}
		if (section === "ours") ours.push(line);
		else if (section === "theirs") theirs.push(line);
	}
	return { path, ours, theirs, hasMarkers: ours.length > 0 || theirs.length > 0 };
}

/** Resolve a conflict by writing one side or both, then staging the file. */
export async function resolveConflict(cwd: string, path: string, choice: "ours" | "theirs"): Promise<boolean> {
	const result = await git(cwd, ["checkout", `--${choice}`, "--", path]);
	if (!result.ok) return false;
	const stageRes = await git(cwd, ["add", "--", path]);
	return stageRes.ok;
}
