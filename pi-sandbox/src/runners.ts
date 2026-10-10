import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	grantArgs,
	LAUNCHER_BIN,
	LAUNCHER_FAILURE_EXIT,
	launcherPath,
	probe as probeLandlockLauncher,
} from "@deepseek-ai/node-addon-system/landlock-run";
import {
	type ConfinedSandboxMode,
	canonicalPath,
	defaultTmpRoots,
	writableRoots,
} from "./policy";

export { LAUNCHER_BIN, LAUNCHER_FAILURE_EXIT };

export type SandboxEnforcement = "full" | "partial";
export type RunnerKind = "bwrap" | "landlock" | "seatbelt" | "windows-acl";
export type SelectedRunner =
	| { runner: RunnerKind; enforcement: SandboxEnforcement }
	| { runner: "unavailable" };

export interface RunnerPolicy {
	mode: ConfinedSandboxMode;
	workspaceRoot: string;
	/** Extra writable directories approved for this turn (canonical). Mount them under read-only too, or an approval still cannot write. */
	extraRoots?: readonly string[];
}

/** Test hooks: inject platform/probe/launcher paths so unit tests do not depend on a real bwrap/landlock (same pattern as deepseek). */
export interface RunnerHooks {
	platform?: string;
	probeBwrap?: (timeoutMs: number) => boolean;
	probeLandlock?: (
		launcher: string,
		timeoutMs: number,
	) => SandboxEnforcement | "unusable";
	launcherPath?: () => string;
	seatbeltExec?: string;
	/** Override the win32 rung preflight result (test injection); returning undefined means that rung is unavailable. */
	windowsAclRung?: () => { node: string; runner: string } | undefined;
	/** Inject the win32 node executable; if the property is present it is authoritative (explicit undefined = simulate node not found) and the real probe is not run. */
	nodeExecutable?: string;
	/** Override the win32 runner entry-file path. */
	windowsRunnerPath?: string;
	/** Override the koffi resolvability probe. */
	koffiResolvable?: () => boolean;
}

/**
 * bwrap mount profile (deepseek profiles.ts semantics; the /tmp entry is an intentional divergence dated 2026-10-01, see spec §4):
 * ro-bind the host / for the whole disk (everything is readable), and workspace-write adds rw binds of the host /tmp and the workspace—
 * both are transparent at the original path: /tmp inside the sandbox is the host /tmp (consistent across commands and across the read/write tools).
 */
export function bwrapProfileArgs(policy: RunnerPolicy): string[] {
	const args = [
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--unshare-pid",
		"--proc",
		"/proc",
		"--die-with-parent",
	];
	if (policy.mode === "workspace-write") {
		args.push("--bind", "/tmp", "/tmp");
		args.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
	}
	for (const extra of policy.extraRoots ?? [])
		args.push("--bind", extra, extra);
	return args;
}

/** Landlock allow-list: readOnly / plus readWrite /dev/null (workspace-write also adds /tmp and the workspace). */
export function landlockProfileArgs(policy: RunnerPolicy): string[] {
	const readWrite = ["/dev/null"];
	if (policy.mode === "workspace-write") {
		readWrite.push("/tmp", policy.workspaceRoot);
	}
	for (const extra of policy.extraRoots ?? []) readWrite.push(extra);
	return grantArgs({ readOnly: ["/"], readWrite });
}

/** Quote a path as an SBPL string literal (escape \ and "). */
function sbplString(path: string): string {
	return `"${path.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

/**
 * Seatbelt SBPL: allow by default, deny every file write, and allow /dev/null plus writableRoots
 * (derived from the same policy.writableRoots as the fs fence, so the semantics cannot drift).
 */
export function seatbeltProfileArgs(policy: RunnerPolicy): string[] {
	const forms = [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		`(allow file-write* (literal ${sbplString("/dev/null")}))`,
	];
	const roots = writableRoots(
		policy.mode,
		policy.workspaceRoot,
		defaultTmpRoots(),
		policy.extraRoots ?? [],
	);
	if (roots.length > 0) {
		forms.push(
			`(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`,
		);
	}
	return ["-p", forms.join(" ")];
}

const PLATFORM_CHAINS: Record<string, readonly RunnerKind[]> = {
	linux: ["bwrap", "landlock"],
	darwin: ["seatbelt"],
	// win32's only candidate (spec Ruling 1): no functional probe (never spawn during selection), only a resolvability preflight—
	// any missing runner file / koffi / node becomes unavailable at selection time, not a spawn ENOENT at runtime.
	win32: ["windows-acl"],
};

const STATIC_ENFORCEMENT: Record<RunnerKind, SandboxEnforcement> = {
	bwrap: "full",
	landlock: "full",
	seatbelt: "full",
	// spec Ruling 6: win32 is always partial. Three structural gaps (inherited from dsh, documented, and not closable):
	// 1. An NTFS hard link is an alias of the file object: a hard link outside the workspace to an authorized file inside it is writable too;
	// 2. Reads are unrestricted: WRITE_RESTRICTED cross-checks write access only, so a restricted process can read everything the caller can read;
	// 3. Files labeled with a package SID by another AppContainer tool are unreadable to a Low integrity token.
	"windows-acl": "partial",
};

let cachedVerdict: SelectedRunner | undefined;

/** Clear the probe cache (tests only; a production process probes once). */
export function resetRunnerCache(): void {
	cachedVerdict = undefined;
}

/** Default runner entry: the package's src/win32/runner.js (relative to this module; after publish it lives inside node_modules). */
function defaultWindowsRunnerPath(): string {
	return fileURLToPath(new URL("./win32/runner.js", import.meta.url));
}

/** win32 node executable: a Node runtime uses execPath; bun or a bundled runtime falls back to node.exe on PATH. */
function defaultNodeExecutable(): string | undefined {
	if (process.versions.node !== undefined && process.versions.bun === undefined)
		return process.execPath;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir.length === 0) continue;
		const candidate = join(dir, "node.exe");
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function defaultKoffiResolvable(): boolean {
	try {
		createRequire(import.meta.url).resolve("koffi");
		return true;
	} catch {
		return false;
	}
}

/**
 * win32 rung availability preflight (spec Ruling 1): the runner file exists, koffi resolves, and a node executable is present.
 * Return { node, runner } only when all three pass; any miss returns undefined (the caller turns that into SANDBOX_UNAVAILABLE).
 * Resolvability only; never spawn a process.
 *
 * Injection is authoritative: when `windowsAclRung` is present its return value is the verdict (including explicit undefined = unavailable);
 * when `nodeExecutable` is present, likewise do not fall back to the real probe (explicit undefined = simulate node not found).
 */
export function windowsAclAvailability(
	hooks: RunnerHooks = {},
): { node: string; runner: string } | undefined {
	if (hooks.windowsAclRung !== undefined) return hooks.windowsAclRung();
	const node = Object.hasOwn(hooks, "nodeExecutable")
		? hooks.nodeExecutable
		: defaultNodeExecutable();
	const runner = hooks.windowsRunnerPath ?? defaultWindowsRunnerPath();
	const koffiOk = (hooks.koffiResolvable ?? defaultKoffiResolvable)();
	if (node === undefined || !existsSync(runner) || !koffiOk) return undefined;
	return { node, runner };
}

export function defaultProbeBwrap(timeoutMs: number): boolean {
	const probe = spawnSync(
		"bwrap",
		[
			...bwrapProfileArgs({ mode: "read-only", workspaceRoot: "/" }),
			"--",
			"true",
		],
		{
			timeout: timeoutMs,
			stdio: "ignore",
		},
	);
	return probe.status === 0;
}

/**
 * Platform-chain selection (spec §3): a single candidate is selected directly (a seatbelt denial at execution time is fail-closed);
 * multiple candidates are functionally probed in order; if none is usable → unavailable (the caller must throw, and must never run unsandboxed).
 */
export function selectRunner(
	probeTimeoutMs: number,
	hooks: RunnerHooks = {},
): SelectedRunner {
	cachedVerdict ??= chainVerdict(probeTimeoutMs, hooks);
	return cachedVerdict;
}

function chainVerdict(
	probeTimeoutMs: number,
	hooks: RunnerHooks,
): SelectedRunner {
	const chain = PLATFORM_CHAINS[hooks.platform ?? process.platform] ?? [];
	const [first, ...rest] = chain;
	if (first === undefined) return { runner: "unavailable" };
	if (first === "windows-acl") {
		if (windowsAclAvailability(hooks) === undefined)
			return { runner: "unavailable" };
		return {
			runner: "windows-acl",
			enforcement: STATIC_ENFORCEMENT["windows-acl"],
		};
	}
	if (rest.length === 0)
		return { runner: first, enforcement: STATIC_ENFORCEMENT[first] };
	for (const kind of chain) {
		const enforcement = probeRunner(kind, probeTimeoutMs, hooks);
		if (enforcement !== "unusable") return { runner: kind, enforcement };
	}
	return { runner: "unavailable" };
}

function probeRunner(
	kind: RunnerKind,
	probeTimeoutMs: number,
	hooks: RunnerHooks,
): SandboxEnforcement | "unusable" {
	switch (kind) {
		case "bwrap":
			return (hooks.probeBwrap ?? defaultProbeBwrap)(probeTimeoutMs)
				? "full"
				: "unusable";
		case "landlock": {
			const launcher = (hooks.launcherPath ?? launcherPath)();
			const probe =
				hooks.probeLandlock ??
				((l: string, t: number) => probeLandlockLauncher(l, { timeoutMs: t }));
			return probe(launcher, probeTimeoutMs);
		}
		case "seatbelt":
			return "full"; // a single-candidate chain never reaches the probe; the branch is kept for completeness
		case "windows-acl":
			return "unusable"; // win32 is a single-candidate chain; chainVerdict already resolved resolvability up front, so the probe is never reached
	}
}

/** Prefix for the win32 runner: node + the package's runner.js + granted roots/mode; '--' and the command argv are appended by confine.
 * `--temp` uses the same root as the fs fence (canonicalPath(tmpdir()), win32's defaultTmpRoots). */
export function windowsAclRunnerArgv(
	policy: RunnerPolicy,
	availability: { node: string; runner: string },
): string[] {
	const argv = [
		availability.node,
		availability.runner,
		"--workspace",
		policy.workspaceRoot,
		"--temp",
		canonicalPath(tmpdir()),
		"--mode",
		policy.mode,
	];
	for (const extra of policy.extraRoots ?? []) argv.push("--extra", extra);
	return argv;
}

/**
 * Full invocation prefix of the selected runner for one policy ('--' and the command argv are appended by confine).
 * win32 needs the preflight verdict: by convention confine resolves it once and passes `availability` through (so it is not resolved twice);
 * when omitted, this function resolves it itself (hook injection first) and throws if it cannot—never build an argv that cannot run.
 */
export function runnerInvocation(
	selected: SelectedRunner & { runner: RunnerKind },
	policy: RunnerPolicy,
	hooks: RunnerHooks = {},
	availability?: { node: string; runner: string },
): string[] {
	switch (selected.runner) {
		case "bwrap":
			return ["bwrap", ...bwrapProfileArgs(policy)];
		case "landlock":
			return [
				(hooks.launcherPath ?? launcherPath)(),
				...landlockProfileArgs(policy),
			];
		case "seatbelt":
			return [
				hooks.seatbeltExec ?? "sandbox-exec",
				...seatbeltProfileArgs(policy),
			];
		case "windows-acl": {
			const resolved = availability ?? windowsAclAvailability(hooks);
			if (resolved === undefined) {
				throw new Error(
					"windows-acl is unavailable: missing runner file, koffi, or a node executable",
				);
			}
			return windowsAclRunnerArgv(policy, resolved);
		}
	}
}
