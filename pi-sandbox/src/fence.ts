import {
	lstatSync,
	readlinkSync,
	realpathSync,
	type Stats,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	join,
	resolve as resolvePath,
	sep,
} from "node:path";
import { denialFollowupHint, sandboxDenialMarker } from "./escalation";
import { canonicalPath, type SandboxMode, writableRoots } from "./policy";

/** fs write-fence denial: message carries the denial marker, the next-step hint, and path. */
export class FenceDenialError extends Error {
	constructor(
		path: string,
		mode: SandboxMode,
		customRunner = false,
		asDirectory = false,
	) {
		const choice = customRunner
			? {}
			: grantDirectoryForDenial([path], asDirectory);
		super(
			`${sandboxDenialMarker(mode)}\n${denialFollowupHint({
				subject: "operation",
				customRunner,
				targetPath: path,
				...choice,
			})}\npath: ${path}`,
		);
		this.name = "FenceDenialError";
	}
}

/**
 * Canonicalize a write target: resolve the symlink of the **deepest existing ancestor**, and keep the spelling of the tail that does not exist.
 * realpath on the whole path fails for a write target that does not exist yet; skipping the ancestor lets a
 * ws/link → /etc style symlink escape (the lexical prefix hits ws/ but the real location is outside the fence).
 * Ruling 7: where realpath fails, lstat first to tell a "dangling symlink" from "truly missing"—a dangling symlink
 * must still be followed (readlink, with a relative target resolved against dirname), or staying on the lexical spelling would allow
 * ws/dangling → a target outside the fence, and the kernel follows the symlink on write and escapes; after the ELOOP guard hits 40
 * fall back to the lexical spelling (the kernel write ELOOPs the same way, so the check and the landing point do not diverge).
 */
export function canonicalizeTarget(path: string): string {
	let current = resolvePath(path);
	const tail: string[] = [];
	let symlinkGuard = 0;
	for (;;) {
		try {
			const real = realpathSync.native(current);
			return tail.length === 0 ? real : join(real, ...tail.reverse());
		} catch {
			let lst: Stats | undefined;
			try {
				lst = lstatSync(current);
			} catch {
				lst = undefined;
			}
			if (lst?.isSymbolicLink()) {
				if (++symlinkGuard > 40) return resolvePath(path); // symlink cycle: conservatively fall back to the lexical spelling
				current = resolvePath(dirname(current), readlinkSync(current));
				continue;
			}
			const parent = dirname(current);
			if (parent === current) return resolvePath(path); // even the root cannot be resolved: keep the lexical spelling (conservative; it matches nothing outside a granted root)
			tail.push(basename(current));
			current = parent;
		}
	}
}

/** Filesystem identity: the host shape of `ino`/`dev` depends on how it was read (a bigint read is BigInt, a number read is Number). */
type FileIdentity = { dev: bigint | number; ino: bigint | number };

/**
 * Make an identity exact: a win32 NTFS FileId is 64 bits (16-bit sequence number + 48-bit MFT record number), and adjacent directories under the same parent
 * differ by 1; `Stats.ino` as a number rounds to even past `2^53`—on real-machine CI the real id of `outside`
 * `…C5` and `fake-tmp`'s `…C4` both displayed as `14355223812536772` (caught by the fence self-check on 2026-10-05),
 * so the identity fallback judged something outside the fence to be a granted root, fail-open. Identity comparison therefore always goes through BigInt.
 *
 * The number shape appears only under injection / an abnormal host (production always reads with `{ bigint: true }`), and only a value inside
 * `Number.isSafeInteger` is guaranteed not to have been rounded—imprecise means the identity is unknown and must not be used for equality.
 *
 * Note: the number branch is unreachable on the production path, but it is **not dead code**—it is the fail-closed guard when an injected / abnormal host (a mock fs, or a host that ignores
 * options) degrades to a number identity, pinned by the "zero identity" and "a rounded number counts as unknown" cases in `fence.test.ts`. Deleting it would fail-open on that kind of host.
 */
function exact(value: bigint | number): bigint | undefined {
	if (typeof value === "bigint") return value;
	return Number.isSafeInteger(value) ? BigInt(value) : undefined;
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
	const aIno = exact(a.ino);
	const bIno = exact(b.ino);
	const aDev = exact(a.dev);
	const bDev = exact(b.dev);
	// Unknown identity ≠ the same identity: libuv's Windows stat fallback (when a directory handle is briefly held by Defender/the indexer)
	// reports ino/dev = 0 as an "unknown identity", and `0 === 0` would judge two different directories to be the same (caught on real-machine CI,
	// 2026-10-04). A zero identity, and an identity that cannot be made exact as BigInt, never matches if either side hits it.
	if (
		aIno === undefined ||
		bIno === undefined ||
		aDev === undefined ||
		bDev === undefined
	)
		return false;
	if (aIno === 0n || bIno === 0n) return false;
	return aIno === bIno && aDev === bDev;
}

/**
 * Identity read: `{ bigint: true }` gets the full 64-bit FileId and avoids the number-precision trap in `Stats.ino`.
 * Even if an injected / abnormal host ignores options and returns a number, only a value inside `Number.isSafeInteger` takes part in equality
 * (see `exact`)—a rounded number identity is treated as unknown and can no longer collide as "the same directory".
 */
function readIdentity(path: string): FileIdentity {
	return statSync(path, { bigint: true });
}

/** Case folding: when the platform is case-insensitive, fold to lowercase (win32 drive-letter / directory-name spelling differences). */
function comparablePath(path: string, caseSensitive: boolean): string {
	return caseSensitive ? path : path.toLowerCase();
}

/** On win32 both "/" and "\\" are separators: normalize to path.sep before comparing; POSIX is left alone. */
const normalizeSeparators = (p: string) =>
	sep === "\\" ? p.replaceAll("/", "\\") : p;

/** Trailing separators: on win32 strip both (a drive root "C:\\" → "C:"); POSIX strips only "/"—"\\" is a legal filename character there. */
const TRAILING_SEPARATORS = sep === "\\" ? /[\\/]+$/ : /\/+$/;

/** A bare drive letter ("C:"): it means "current directory per drive" (drive-relative), not the drive root; a child path must continue with a separator. */
const DRIVE_LETTER_PREFIX = /^[A-Za-z]:$/;

/** A drive-relative path ("C:" / "C:work"): its meaning depends on the per-drive CWD, so it is ambiguous and must not enter the fence check. */
const DRIVE_RELATIVE_PATH = /^[A-Za-z]:(?![\\/])/;

/**
 * Lexical containment: separators use path.sep (on win32 both \ and / can appear, so normalize first),
 * and the match must land on a separator boundary—C:\work\demo2 is not a child of C:\work\demo.
 * Case is passed in by the caller per the platform convention; when the spelling differs (case, 8.3 short names, junctions)
 * the dev/ino identity fallback below still covers it.
 */
function isLexicallyUnder(
	target: string,
	root: string,
	caseSensitive: boolean,
): boolean {
	const t = comparablePath(normalizeSeparators(target), caseSensitive);
	// Strip trailing (repeated) separators: a root prefix must not keep a separator, or C:\work\demo2 is misjudged as a child path.
	// Stripping POSIX "/" leaves empty, and together with the empty root that keeps the root meaning.
	const r = comparablePath(
		normalizeSeparators(root).replace(TRAILING_SEPARATORS, "") || sep,
		caseSensitive,
	);
	// A win32 drive root "C:\\" becomes the bare drive letter "C:" after stripping; a bare drive letter is "current directory per drive", not the drive root,
	// so it can be a child path only when a separator continues (C:\…)—a bare "C:" and "C:work" do not count.
	if (DRIVE_LETTER_PREFIX.test(r)) return t.startsWith(`${r}${sep}`);
	if (t === r) return true;
	return t.startsWith(r === sep ? r : `${r}${sep}`);
}

/**
 * Containment check (deepseek dsh-fs-sandbox semantics): the lexical fast path handles ordinary canonical
 * spelling; when the spelling disagrees, walk up target's existing ancestors and compare filesystem identity (dev+ino, always read
 * and compared as bigint) with the granted root—tolerate a missing suffix, and stop an ancestor symlink from being retargeted into an escape.
 * caseSensitive defaults from the platform (win32 is insensitive); the identity fallback itself is independent of case.
 */
export function isWithinRoots(
	target: string,
	roots: readonly string[],
	caseSensitive: boolean = process.platform !== "win32",
): boolean {
	// win32: a bare drive letter and a drive-relative path resolve against the per-drive CWD, and the result drifts with the process CWD;
	// the fence check must be determinate, so both are treated as inside no granted root (POSIX hosts have no such meaning, so this does not apply).
	if (sep === "\\" && DRIVE_RELATIVE_PATH.test(normalizeSeparators(target)))
		return false;
	for (const root of roots) {
		if (isLexicallyUnder(target, root, caseSensitive)) return true;
	}
	for (const root of roots) {
		let rootInfo: FileIdentity;
		try {
			rootInfo = readIdentity(root);
		} catch {
			continue; // granted root does not exist: it matches nothing
		}
		let ancestor = target;
		for (;;) {
			let info: FileIdentity | undefined;
			try {
				info = readIdentity(ancestor);
			} catch {
				info = undefined;
			}
			if (info && sameIdentity(info, rootInfo)) return true;
			const parent = dirname(ancestor);
			if (parent === ancestor) break;
			ancestor = parent;
		}
	}
	return false;
}

export interface FencePolicy {
	mode: SandboxMode;
	workspaceRoot: string;
	/** Test injection (testing.md "parameter injection"): whether fence comparison is case-sensitive; production omits it, and the default is derived from process.platform. */
	caseSensitive?: boolean;
	/** Test injection (testing.md "parameter injection"): replace the default tmp roots (`defaultTmpRoots()`: win32 is only `os.tmpdir()`, otherwise `"/tmp"` + `os.tmpdir()`); production omits it. */
	_tmpRoots?: readonly string[];
	/** Extra writable directories approved for this turn. They take part in the comparison under read-only too. */
	extraRoots?: readonly string[];
	/** A custom runner cannot accept an extra writable root. The denial copy then offers only a one-shot escalation. */
	customRunner?: boolean;
}

/**
 * `/`, the home directory, and any ancestor of home. That width is equivalent to allowing the whole disk, and should go through danger-full-access.
 * It lives on the fence side so the denial copy and the grant tool share one judgment, and so the grant-path → fence cycle is avoided.
 */
export function grantTooWide(
	canonical: string,
	home: string = homedir(),
): boolean {
	if (canonical === sep || canonical === "/" || canonical === "\\") return true;
	if (/^[A-Za-z]:\\?$/.test(canonical)) return true;
	let homePath = home;
	try {
		homePath = canonicalPath(home);
	} catch {
		homePath = home;
	}
	return isWithinRoots(homePath, [canonical]);
}

/**
 * Whether the paths in a denial collapse to one directory that can be granted.
 * An existing directory, and a mkdir target (asDirectory), use the path itself.
 * A file, or a write-file target that does not exist, uses its parent directory. With no path, or paths spread across different directories, no directory grant is offered.
 */
export function grantDirectoryForDenial(
	paths: readonly string[],
	asDirectory = false,
): {
	grantDirectory?: string;
	refusedDirectory?: string;
	split?: boolean;
} {
	const directories = new Set<string>();
	for (const raw of paths) {
		if (raw.trim().length === 0) continue;
		directories.add(
			narrowGrantDirectory(raw, asDirectory && paths.length === 1),
		);
	}
	if (directories.size === 0) return {};
	if (directories.size > 1) return { split: true };
	const directory = [...directories][0];
	if (directory === undefined) return {};
	if (grantTooWide(directory)) return { refusedDirectory: directory };
	return { grantDirectory: directory };
}

/** A directory path grants the directory itself; a file path grants its parent. asDirectory is for a mkdir target that does not exist yet. */
function narrowGrantDirectory(path: string, asDirectory: boolean): string {
	const canonical = canonicalizeTarget(path);
	if (asDirectory) return canonical;
	try {
		if (statSync(canonical).isDirectory()) return canonical;
	} catch {
		// Does not exist yet: use the file's parent directory.
	}
	return dirname(canonical);
}

/**
 * Check one write path. danger-full-access allows it; read-only denies everything; workspace-write
 * requires the path to land inside writableRoots after canonicalizeTarget. A violation throws FenceDenialError.
 * The caller (tools.ts) passes a path already resolved against cwd; resolvePath here is the fallback for a relative path.
 */
export function assertWriteAllowed(
	absPath: string,
	policy: FencePolicy,
	asDirectory = false,
): void {
	if (policy.mode === "danger-full-access") return;
	const roots = writableRoots(
		policy.mode,
		policy.workspaceRoot,
		policy._tmpRoots,
		policy.extraRoots,
	);
	const target = canonicalizeTarget(absPath);
	const caseSensitive = policy.caseSensitive ?? process.platform !== "win32";
	if (!isWithinRoots(target, roots, caseSensitive))
		throw new FenceDenialError(
			resolvePath(absPath),
			policy.mode,
			policy.customRunner === true,
			asDirectory,
		);
}
