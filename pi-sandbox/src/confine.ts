import {
	type ConfinedSandboxMode,
	canonicalPath,
	type SandboxMode,
} from "./policy";
import {
	bwrapProfileArgs,
	LAUNCHER_BIN,
	LAUNCHER_FAILURE_EXIT,
	type RunnerHooks,
	type RunnerPolicy,
	runnerInvocation,
	type SandboxEnforcement,
	type SelectedRunner,
	selectRunner,
	windowsAclAvailability,
} from "./runners";

export interface RunnerFailureRule {
	/** Non-zero exit-code gate; by default any non-zero exit is allowed. */
	allowedExitCodes?: readonly number[];
	/** Non-empty substrings (within a single line) that identify a fatal runner diagnostic. */
	fatalSignatures: readonly string[];
	/** Benign stderr lines dropped by whole-line equality before fatal matching. */
	informationalLines?: readonly string[];
}

export interface ConfinedArgv {
	argv: string[];
	enforcement: SandboxEnforcement;
	/** This backend's denial dialect: stderr substrings produced when the sandbox denies a file effect. */
	denialSignatures: readonly string[];
	runnerFailureRules: readonly RunnerFailureRule[];
}

/** Fail-closed: the command was not executed. The escape hatch is an explicit danger-full-access setting. */
export class SandboxUnavailableError extends Error {
	constructor(mode: ConfinedSandboxMode, detail?: string) {
		super(
			detail
				? `SANDBOX_UNAVAILABLE (${mode}): sandbox runner failed before the command ran: ${detail}`
				: `SANDBOX_UNAVAILABLE (${mode}): no usable sandbox runner on this host; the command was NOT executed. Install bwrap (Linux) or set mode "danger-full-access" explicitly to run unsandboxed.`,
		);
		this.name = "SandboxUnavailableError";
	}
}

/** Each backend's own denial dialect (do not union them across backends, spec §6). */
export const DENIAL_SIGNATURES = {
	bwrap: ["read-only file system"],
	landlock: ["permission denied"],
	seatbelt: ["operation not permitted"],
	runnerCommand: ["read-only file system", "permission denied"],
	// Port contract (Ruling 6): cover four dialects — cmd (Access is denied), pwsh/.NET
	// (Access to the path…), Node EACCES/EPERM, and git-bash (permission denied / operation not permitted).
	"windows-acl": [
		"access is denied",
		"access to the path",
		"permission denied",
		"operation not permitted",
	],
} as const;

export const RUNNER_FAILURE_RULES = {
	bwrap: [{ fatalSignatures: ["bwrap: "] }],
	landlock: [
		{
			allowedExitCodes: [LAUNCHER_FAILURE_EXIT],
			fatalSignatures: [`${LAUNCHER_BIN}: `],
			informationalLines: [
				`${LAUNCHER_BIN}: partial enforcement (older Landlock ABI)`,
			],
		},
	],
	seatbelt: [{ fatalSignatures: ["sandbox-exec: "] }],
	// Port contract (Ruling 7): exit 127 gate plus a runner-prefix signature, so a confined
	// command that prints the same wording is not mistaken for a runner failure (if the
	// command actually ran, never classify it as a runner failure).
	"windows-acl": [
		{ allowedExitCodes: [127], fatalSignatures: ["windows-acl-run: "] },
	],
} as const satisfies Record<
	"bwrap" | "landlock" | "seatbelt" | "windows-acl",
	readonly RunnerFailureRule[]
>;

/** Confined mode on Windows supports only pwsh (Ruling 2): bash is refused in every confined mode and is never spawned.
 *  Defense in depth: on win32 this package registers bash as `exposure: "hidden"` (D3 rev 3: unreachable by the model, and not activatable by name via
 *  `defaultTools` / `--tools`), so on the normal path the model never sees bash. This class remains a **refusal shell**
 *  in case a future host changes activation semantics or someone calls the tool definition directly.
 *  The message gives only **effective** guidance: `-bash` in `defaultTools` cannot remove an extension-registered tool, so we no longer tell the user to edit
 *  `defaultTools`. It only says to use powershell, that bash stays fail-closed, and that danger-full-access is the only explicit escape hatch. */
export class UnsupportedWindowsShellError extends Error {
	constructor(shell: string) {
		super(
			`[sandbox: ${shell} is not supported on Windows]\n` +
				`pi-sandbox confines Windows commands through the powershell tool only (requires pi >= 1.0.0); use the powershell tool instead of bash — the command was NOT executed.\n` +
				`bash stays fail-closed on Windows: enabling it explicitly does not unconfine it.\n` +
				`"danger-full-access" remains the only explicit bypass.`,
		);
		this.name = "UnsupportedWindowsShellError";
	}
}

/**
 * Confined mode on Windows supports only pwsh (Ruling 2): bash is refused in every confined mode and is never spawned.
 * @param shell - Shell name to run (`"bash"` / `"powershell"`).
 * @param platform - Host platform (injection point).
 * @param mode - Effective mode resolved for this call.
 */
export function assertShellAllowed(
	shell: string,
	platform: string,
	mode: SandboxMode,
): void {
	if (
		platform === "win32" &&
		shell === "bash" &&
		mode !== "danger-full-access"
	) {
		throw new UnsupportedWindowsShellError(shell);
	}
}

export interface ConfineOptions {
	/** Pre-resolved runner (test injection / caller cache); defaults to selectRunner. */
	selected?: SelectedRunner;
	runnerCommand?: string[] | null;
	runnerFailureSignatures?: string[] | null;
	probeTimeoutMs?: number;
	hooks?: RunnerHooks;
	/** Extra writable directories already approved this turn. Tools with a custom runner refuse to add more; this only forwards the existing list. */
	extraRoots?: readonly string[];
}

/**
 * Wrap argv in the selected runner's policy invocation (spec §2). workspaceRoot is
 * canonicalized once here so profile builders stay pure.
 */
export function confine(
	argv: readonly string[],
	mode: ConfinedSandboxMode,
	workspaceRoot: string,
	opts: ConfineOptions = {},
): ConfinedArgv {
	const policy: RunnerPolicy = {
		mode,
		workspaceRoot: canonicalPath(workspaceRoot),
		extraRoots: opts.extraRoots,
	};

	if (opts.runnerCommand && opts.runnerCommand.length > 0) {
		return {
			argv: [...opts.runnerCommand, ...bwrapProfileArgs(policy), "--", ...argv],
			enforcement: "full",
			denialSignatures: DENIAL_SIGNATURES.runnerCommand,
			runnerFailureRules: [
				{ fatalSignatures: opts.runnerFailureSignatures ?? [] },
			],
		};
	}

	const selected =
		opts.selected ?? selectRunner(opts.probeTimeoutMs ?? 5000, opts.hooks);
	if (selected.runner === "unavailable")
		throw new SandboxUnavailableError(mode);

	// Resolve win32 availability once and pass it through to runnerInvocation (Task 9).
	// Injection is authoritative: when the hook exists, its return value is the answer
	// (including an explicit undefined); never fall back to a real probe.
	// If it cannot be resolved, fail closed with SandboxUnavailableError and never build an argv that cannot run.
	let availability: { node: string; runner: string } | undefined;
	if (selected.runner === "windows-acl") {
		const hooks = opts.hooks ?? {};
		const injectedRung = hooks.windowsAclRung;
		availability =
			injectedRung !== undefined
				? injectedRung()
				: windowsAclAvailability(hooks);
		if (availability === undefined) {
			throw new SandboxUnavailableError(
				mode,
				"win32 runner is not resolvable (missing runner file, koffi, or a node executable)",
			);
		}
	}
	return {
		argv: [
			...runnerInvocation(selected, policy, opts.hooks, availability),
			"--",
			...argv,
		],
		enforcement: selected.enforcement,
		denialSignatures: DENIAL_SIGNATURES[selected.runner],
		runnerFailureRules: RUNNER_FAILURE_RULES[selected.runner],
	};
}

/**
 * Runner-failure classification (the command never ran; checked before denial).
 * Exit gate, then drop informationalLines by case-insensitive whole-line equality, then
 * case-insensitive substring match of fatalSignatures on the remaining lines. Returns the
 * fatal line that matched. exitCode 0/null (success or killed by a signal) is never a runner failure.
 */
export function classifyRunnerFailure(
	exitCode: number | null,
	stderr: string,
	rules: readonly RunnerFailureRule[],
): string | undefined {
	if (exitCode === null || exitCode === 0) return undefined;
	for (const rule of rules) {
		if (rule.allowedExitCodes && !rule.allowedExitCodes.includes(exitCode))
			continue;
		const informational = new Set(
			(rule.informationalLines ?? []).map((line) => line.toLowerCase()),
		);
		for (const line of stderr.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			if (informational.has(trimmed.toLowerCase())) continue;
			const lower = trimmed.toLowerCase();
			for (const signature of rule.fatalSignatures) {
				if (lower.includes(signature.toLowerCase())) return trimmed;
			}
		}
	}
	return undefined;
}

/** Denial classification: non-zero exit plus any dialect substring (case-insensitive) in stderr. */
export function classifyDenial(
	exitCode: number | null,
	stderr: string,
	signatures: readonly string[],
): boolean {
	if (exitCode === null || exitCode === 0) return false;
	const lower = stderr.toLowerCase();
	return signatures.some((signature) =>
		lower.includes(signature.toLowerCase()),
	);
}
