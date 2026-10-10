import { lstatSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
	dirname,
	isAbsolute,
	join,
	parse,
	resolve as resolvePath,
} from "node:path";
import type { DenialRecord } from "./denial-ledger";
import { canonicalizeTarget, grantTooWide, isWithinRoots } from "./fence";
import { canonicalPath } from "./policy";

export { grantTooWide };

const QUOTED_ABSOLUTE = /['"]((?:\/|[A-Za-z]:[\\/])[^'"]+)['"]/g;
const BARE_ABSOLUTE = /(?:^|[\s(])((?:\/|[A-Za-z]:[\\/])[^\s:'"]+)/g;

/** Expand `~` and `~/...`, then resolve relative paths against cwd. The model sees the raw argument; the host does not expand it for this tool first. */
export function resolveGrantRequest(raw: string, cwd: string): string {
	const trimmed = raw.trim();
	let expanded = trimmed;
	if (trimmed === "~") expanded = homedir();
	else if (trimmed.startsWith("~/") || trimmed.startsWith("~\\"))
		expanded = join(homedir(), trimmed.slice(2));
	return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

/**
 * Before approval, confirm this path can be a directory. If it exists it must be a
 * directory (following symlinks). If it does not, the nearest existing ancestor must
 * be a directory, otherwise mkdir would land on a file.
 */
export function assertCanCreateDirectory(path: string): void {
	let current = path;
	for (;;) {
		try {
			if (!statSync(current).isDirectory()) {
				throw new Error(`sandbox_grant_write path is not a directory: ${path}`);
			}
			return;
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.startsWith("sandbox_grant_write")
			)
				throw error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			let listed: ReturnType<typeof lstatSync> | undefined;
			try {
				listed = lstatSync(current);
			} catch {
				listed = undefined;
			}
			if (
				listed !== undefined &&
				!listed.isSymbolicLink() &&
				!listed.isDirectory()
			) {
				throw new Error(`sandbox_grant_write path is not a directory: ${path}`);
			}
			const parent = dirname(current);
			if (parent === current)
				throw new Error(`sandbox_grant_write path is not a directory: ${path}`);
			current = parent;
		}
	}
}

/**
 * Create missing directories level by level and return only those actually created
 * this time (including parents created along the way). An existing directory is EEXIST
 * and does not count as ours. On a mid-way failure, remove the empty directories just
 * created so nothing is left half-built.
 */
export function createMissingGrantDirectories(directory: string): string[] {
	const created: string[] = [];
	const { root } = parse(directory);
	const segments = directory
		.slice(root.length)
		.split(/[\\/]+/u)
		.filter((segment) => segment.length > 0);
	let current = root;
	try {
		for (const segment of segments) {
			current = join(current, segment);
			try {
				mkdirSync(current);
				created.push(canonicalPath(current));
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") throw error;
				if (!statSync(current).isDirectory()) {
					throw new Error(
						`sandbox_grant_write path is not a directory: ${directory}`,
					);
				}
			}
		}
	} catch (error) {
		removeEmptyCreatedDirectories(created);
		throw error;
	}
	return created;
}

/**
 * When the grant is revoked, delete newly created directories that are still empty.
 * Deeper ones go first, so a parent that becomes empty after its children are removed
 * disappears too. Non-empty directories, symlinks, `/`, and the home directory are left
 * in place. rmdir itself never deletes contents.
 */
export function removeEmptyCreatedDirectories(
	created: readonly string[],
): void {
	const unique = [...new Set(created.filter((path) => path.length > 0))].sort(
		(a, b) => segmentCount(b) - segmentCount(a) || b.length - a.length,
	);
	for (const dir of unique) {
		if (grantTooWide(dir)) continue;
		try {
			if (!lstatSync(dir).isDirectory()) continue;
			rmdirSync(dir);
		} catch {
			// Non-empty, already gone, or no permission: leave it in place.
		}
	}
}

function segmentCount(path: string): number {
	return path.split(/[\\/]+/u).filter((segment) => segment.length > 0).length;
}

/** Extract absolute paths from denial text. Command text is excluded: the model wrote it, so it is not denial evidence. */
export function extractAbsolutePaths(text: string): string[] {
	const found: string[] = [];
	for (const pattern of [QUOTED_ABSOLUTE, BARE_ABSOLUTE]) {
		pattern.lastIndex = 0;
		for (;;) {
			const match = pattern.exec(text);
			if (match === null) break;
			const path = match[1]?.replace(/[),.;]+$/u, "") ?? "";
			if (path.length > 1) found.push(path);
		}
	}
	return found;
}

/** For write/edit, target is the denied path. For a shell, only absolute paths in stderr / error count. */
export function deniedPaths(record: DenialRecord): string[] {
	if (record.tool === "write" || record.tool === "edit") {
		return record.target.trim().length > 0 ? [record.target] : [];
	}
	return extractAbsolutePaths(`${record.stderr ?? ""}\n${record.error ?? ""}`);
}

/** The requested directory covers at least one path in this denial (after canonicalization). */
export function grantCoversDenial(
	grantPath: string,
	record: DenialRecord,
): boolean {
	return deniedPaths(record).some((path) =>
		isWithinRoots(canonicalizeTarget(path), [grantPath]),
	);
}
