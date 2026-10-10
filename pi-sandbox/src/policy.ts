import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Three file-effect policy tiers (spec §4). read-only is the floor: no escalation targets it.
 */
export type SandboxMode =
	| "read-only"
	| "workspace-write"
	| "danger-full-access";
export type ConfinedSandboxMode = Exclude<SandboxMode, "danger-full-access">;

export const SANDBOX_MODES: readonly SandboxMode[] = [
	"read-only",
	"workspace-write",
	"danger-full-access",
];

export function isSandboxMode(value: unknown): value is SandboxMode {
	return (
		typeof value === "string" &&
		(SANDBOX_MODES as readonly string[]).includes(value)
	);
}

/**
 * Resolve a grant root to the path the enforcement layer actually compares (symlinks
 * resolved). On failure, keep the original spelling. A root that does not exist matches
 * no path, which is the conservative result (same as deepseek roots.ts).
 */
export function canonicalPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

/**
 * workspace-write = workspace + tmp roots (default defaultTmpRoots(): POSIX is "/tmp" +
 * os.tmpdir(), win32 is only os.tmpdir(), i.e. %TEMP%), canonicalized and deduped.
 * read-only's default roots are empty, but extraRoots approved this turn count in both
 * confined modes. danger-full-access skips the fence and returns empty.
 * The seatbelt profile and the fs fence share this derivation so the semantics cannot
 * drift (spec §4). Neither side passes tmpRoots; the default is the production semantics.
 * tmpRoots exists only for test injection (testing.md "parameter injection").
 */
export function writableRoots(
	mode: SandboxMode,
	workspaceRoot: string,
	tmpRoots: readonly string[] = defaultTmpRoots(),
	extraRoots: readonly string[] = [],
): string[] {
	if (mode === "danger-full-access") return [];
	const base = mode === "workspace-write" ? [workspaceRoot, ...tmpRoots] : [];
	return [...new Set([...base, ...extraRoots].map(canonicalPath))];
}

/** win32 has no POSIX /tmp: the only tmp root is os.tmpdir() (%TEMP%, spec §5; platform is injectable for unit tests). */
export function defaultTmpRoots(platform: string = process.platform): string[] {
	return platform === "win32" ? [tmpdir()] : ["/tmp", tmpdir()];
}

/**
 * Resolve the effective mode for each tool call: process-wide /permission override >
 * config default. (An approved escalation applies only to that one call and is handled
 * separately in the tools layer, spec §4.)
 */
export function resolveEffectiveMode(
	userOverride: SandboxMode | null,
	configDefault: SandboxMode,
): SandboxMode {
	return userOverride ?? configDefault;
}
