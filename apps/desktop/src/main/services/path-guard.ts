/**
 * Shared path containment and segment sanitization helpers.
 * Prevents path traversal (../, symlinks escaping root) across main services.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve `targetPath` relative to `baseDir` and assert it stays inside `baseDir`.
 * Rejects `..` escapes and symlinks pointing outside `baseDir`.
 */
export function resolveWithin(baseDir: string, targetPath: string): string {
	const base = resolve(baseDir);
	const candidate = isAbsolute(targetPath) ? resolve(targetPath) : resolve(base, targetPath);
	const rel = relative(base, candidate);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`caminho fora do diretório permitido: ${targetPath}`);
	}
	const realBase = existsSync(base) ? realpathSync(base) : base;
	if (existsSync(candidate)) {
		const realTarget = realpathSync(candidate);
		const realRel = relative(realBase, realTarget);
		if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
			throw new Error(`symlink fora do diretório permitido: ${targetPath}`);
		}
	}
	return candidate;
}

/** Validate a single filename/ID segment (no slashes, no `.` or `..`). */
export function sanitizeSegment(value: string, label = "identificador"): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "." || trimmed === ".." || /[/\\]/.test(trimmed) || !/^[\w.-]+$/.test(trimmed)) {
		throw new Error(`${label} inválido: ${value}`);
	}
	return trimmed;
}
