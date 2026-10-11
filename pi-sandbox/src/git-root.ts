import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalPath } from "./policy";

/**
 * Git metadata roots for a workspace that lives inside a git repository ("git-managed
 * subdirectory"). `git commit` writes into the repository's `.git` directory, which sits above
 * the workspace when the session cwd is a subdirectory — without binding it, every commit is
 * denied by the sandbox. The derived roots are added to the writable roots of one call
 * (workspace-write only, and only while the `includeGitRoot` config switch is on), so all
 * runners and the fs fence see the same set.
 *
 * Detection walks up from the cwd once per unique cwd (memoized): the scan is a stat per
 * ancestor, and pi does not chdir, so a session repeats the same cwd and pays the scan once.
 *
 * Fail-closed in both directions:
 * - a directory holding no `.git` yields no extra root (nothing is widened);
 * - a layer whose `.git` cannot be fully resolved (unstatable entry, unparseable `gitdir:`
 *   pointer, a pointer target that is not an existing directory) widens nothing and stops the
 *   walk — the scan never falls back to an outer repository that may not be the intended one.
 *   The anomaly surfaces through git's own error instead of silently opening the wrong tree.
 */

type GitEntryKind = "directory" | "file";

/** The path exists but cannot be inspected (or is neither a directory nor a file): do not guess. */
const UNKNOWN = Symbol("git-root:unknown");

function isAbsent(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** "directory" / "file" / undefined (definitely absent) / UNKNOWN (exists but uninspectable). */
function gitEntryKind(path: string): GitEntryKind | undefined | typeof UNKNOWN {
	try {
		const stat = statSync(path);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
		return UNKNOWN;
	} catch (error) {
		return isAbsent(error) ? undefined : UNKNOWN;
	}
}

/** File text / undefined (definitely absent) / UNKNOWN (exists but unreadable). */
function readTextFile(path: string): string | undefined | typeof UNKNOWN {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		return isAbsent(error) ? undefined : UNKNOWN;
	}
}

/** `gitdir: <path>` — the first non-empty line of a `.git` file (linked worktrees and submodules). */
function parseGitDirPointer(text: string): string | undefined {
	const line = text
		.split(/\r?\n/)
		.find((candidate) => candidate.trim().length > 0);
	if (line === undefined) return undefined;
	const trimmed = line.trim();
	const prefix = "gitdir:";
	if (!trimmed.startsWith(prefix)) return undefined;
	const target = trimmed.slice(prefix.length).trim();
	return target.length === 0 ? undefined : target;
}

/**
 * The real git directory behind a `.git` file, plus its shared directory (`commondir`, linked
 * worktrees only: commits write objects/refs into the common directory, so a worktree whose
 * `commondir` is left unbound cannot commit either). `undefined` = the pointer cannot be
 * resolved safely: widen nothing (fail-closed).
 */
function pointerRoots(gitFilePath: string): string[] | undefined {
	const text = readTextFile(gitFilePath);
	if (text === UNKNOWN || text === undefined) return undefined;
	const pointer = parseGitDirPointer(text);
	if (pointer === undefined) return undefined;
	// A relative `gitdir:` resolves against the directory holding the `.git` file.
	const gitDir = resolve(dirname(gitFilePath), pointer);
	const roots = [gitDir];
	const commonText = readTextFile(join(gitDir, "commondir"));
	if (commonText === UNKNOWN) return undefined;
	if (commonText !== undefined) {
		const common = commonText.trim();
		if (common.length > 0) roots.push(resolve(gitDir, common));
	}
	// Every resolved target must be an existing directory; a broken pointer opens nothing.
	if (roots.some((root) => gitEntryKind(root) !== "directory")) return undefined;
	return roots;
}

/** The writable roots one cwd needs for git; `[]` when the cwd is not inside a repository. */
function scanGitRoots(rawCwd: string): readonly string[] {
	const start = canonicalPath(rawCwd);
	let dir = start;
	for (;;) {
		const gitEntry = join(dir, ".git");
		const kind = gitEntryKind(gitEntry);
		if (kind === UNKNOWN) return []; // undeterminable layer: widen nothing, stop
		if (kind !== undefined) {
			const extra = kind === "directory" ? [] : pointerRoots(gitEntry);
			if (extra === undefined) return [];
			// The workspace root itself is already writable; only layers above it are added.
			return [
				...new Set(
					[dir, ...extra]
						.map(canonicalPath)
						.filter((root) => root !== start),
				),
			];
		}
		const parent = dirname(dir);
		if (parent === dir) return [];
		dir = parent;
	}
}

const gitRootsCache = new Map<string, readonly string[]>();

/**
 * Writable git roots for one cwd, scanned once per unique cwd (module-level cache, the same
 * pattern as tools.ts's workspaceRootFor). Returns the repository root (the layer holding
 * `.git`) and, for a `.git` file, the resolved `gitdir` target plus its `commondir`.
 */
export function gitWritableRoots(rawCwd: string): readonly string[] {
	let roots = gitRootsCache.get(rawCwd);
	if (roots === undefined) {
		roots = scanGitRoots(rawCwd);
		gitRootsCache.set(rawCwd, roots);
	}
	return roots;
}

/** Test-only cache reset (production code must not call this). */
export function resetGitRootsForTests(): void {
	gitRootsCache.clear();
}
