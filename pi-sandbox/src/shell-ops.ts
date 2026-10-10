import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { constants, access as fsAccess } from "node:fs/promises";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
	type ConfinedArgv,
	type ConfineOptions,
	classifyDenial,
	classifyRunnerFailure,
	confine,
	SandboxUnavailableError,
} from "./confine";
import { denialFollowupHint, sandboxDenialMarker } from "./escalation";
import { grantDirectoryForDenial } from "./fence";
import { extractAbsolutePaths } from "./grant-path";
import type { ConfinedSandboxMode, SandboxMode } from "./policy";

export type SpawnFn = (
	program: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

/** I3: kill the whole process group (detached spawn makes the child the group leader); on failure (no pid / group gone) fall back to killing the direct child. */
function killTree(
	child: ChildProcess,
	signal: NodeJS.Signals,
	platform: string,
): void {
	// win32 has no process groups: killing the runner closes the Job, and confined descendants die with it (spec §4.7)
	if (platform !== "win32" && child.pid !== undefined) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {}
	}
	child.kill(signal);
}

export interface ShellOpsOptions extends ConfineOptions {
	mode: SandboxMode;
	workspaceRoot: string;
	/** Translate the raw command into the shell's argv (bash: `["bash","-c",command]`; pwsh: see powershell-ops). */
	shell: (command: string) => readonly string[];
	/** Host-platform injection point (default process.platform): chooses the kill strategy and spawn options (detached). */
	platform?: string;
	/** Test injection point; production uses node:child_process spawn. */
	spawnFn?: SpawnFn;
	/** Accounting callback when the sandbox denies (classifyDenial matches): the denial-first gate uses it to allow one escalation retry. */
	onDenial?: (details: ShellDenialDetails) => void;
	/**
	 * Synchronous pre-guard for confined modes (not danger-full-access): a throw rejects and does not spawn.
	 * Called after the danger-full-access early return and before confine; that mode does not pass through the guard.
	 */
	guard?: (mode: SandboxMode) => void;
	/**
	 * Second line of the error when cwd does not exist. The default keeps the bash wording verbatim
	 * (existing bash-ops assertions depend on it); pwsh passes the PowerShell wording via powershell-ops.
	 */
	cwdErrorMessage?: string;
}

/** Tail kept for stdout/stderr classification and the reviewer input window: last 8KiB (denial/failure text is always near the end). */
const OUTPUT_TAIL_CHARS = 8192;

export interface ShellDenialDetails {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Shared execution path for a confined shell (spec §2): shell-translate argv, then guard
 * (confined modes), then confine, then a local spawn with transparent paths (cwd is the
 * host path as-is). Stream output and classify runner failure / denial, and keep the
 * timeout/abort contract. timeout is in seconds (pi's convention). bash and pwsh share this factory.
 */
export function createSandboxShellOps(opts: ShellOpsOptions): BashOperations {
	return {
		exec: async (command, cwd, execOpts) => {
			// M4: cwd existence pre-check, mirroring pi's local ops (dist/core/tools/bash.js:29-34)
			// friendly error verbatim and in the same order, before the abort early return.
			// Same for all three modes (otherwise the model only sees a raw spawn ENOENT).
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(
					`Working directory does not exist: ${cwd}\n${opts.cwdErrorMessage ?? "Cannot execute bash commands."}`,
				);
			}
			return new Promise<{ exitCode: number | null }>((resolve, reject) => {
				if (execOpts.signal?.aborted) {
					// Ruling 9 + I1: signal already aborted — do not spawn; reject "aborted" per pi's local ops contract
					reject(new Error("aborted"));
					return;
				}
				const platform = opts.platform ?? process.platform;
				const rawArgv = opts.shell(command);
				// Review Focus #3 + Ruling 10: pin message translation (LC_MESSAGES). Remove LC_ALL
				// (on POSIX it overrides LC_MESSAGES; leaving it makes every denial signature miss
				// in a non-English locale). Leave LANG/LC_CTYPE alone (encoding/collation stay the same).
				const env: NodeJS.ProcessEnv = {
					...process.env,
					...execOpts.env,
					LC_MESSAGES: "C",
				};
				delete env.LC_ALL;

				let argv: readonly string[];
				let confined: ConfinedArgv | undefined;
				try {
					if (opts.mode === "danger-full-access") {
						argv = rawArgv;
					} else {
						// Pre-guards such as the win32 bash refusal (Ruling 2) must run after the
						// danger-full-access early return. A throw is fail-closed (no spawn).
						opts.guard?.(opts.mode);
						confined = confine(
							rawArgv,
							opts.mode as ConfinedSandboxMode,
							opts.workspaceRoot,
							opts,
						);
						argv = confined.argv;
					}
				} catch (err) {
					reject(err); // SandboxUnavailableError / UnsupportedWindowsShellError: fail-closed, not spawned
					return;
				}

				const spawnFn = opts.spawnFn ?? (spawn as unknown as SpawnFn);
				const child = spawnFn(argv[0], argv.slice(1), {
					cwd,
					env,
					stdio: ["ignore", "pipe", "pipe"],
					detached: platform !== "win32", // I3: own process group so killTree can also kill grandchildren; win32 has no process groups
					windowsHide: true, // win32: do not pop a console window
				});

				let stdoutTail = "";
				let stderrTail = "";
				child.stdout?.on("data", (chunk: Buffer) => {
					execOpts.onData(chunk);
					stdoutTail = (stdoutTail + chunk.toString("utf-8")).slice(
						-OUTPUT_TAIL_CHARS,
					);
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					execOpts.onData(chunk);
					stderrTail = (stderrTail + chunk.toString("utf-8")).slice(
						-OUTPUT_TAIL_CHARS,
					);
				});

				let timer: NodeJS.Timeout | undefined;
				let timedOut = false;
				// Ruling 20: match pi local ops' `timeout > 0` guard (dist/core/tools/bash.js:60).
				// A timeout of 0 or negative means no timeout: do not arm a timer, and do not reject "timeout:0".
				if (execOpts.timeout !== undefined && execOpts.timeout > 0) {
					timer = setTimeout(() => {
						timedOut = true;
						killTree(child, "SIGKILL", platform);
					}, execOpts.timeout * 1000);
				}
				const onAbort = () => killTree(child, "SIGTERM", platform);
				execOpts.signal?.addEventListener("abort", onAbort, { once: true });

				const cleanup = () => {
					if (timer) clearTimeout(timer);
					execOpts.signal?.removeEventListener("abort", onAbort);
				};

				child.on("error", (err) => {
					cleanup();
					reject(err);
				});
				child.on("close", (code) => {
					cleanup();
					if (confined && typeof code === "number" && code !== 0) {
						const fatal = classifyRunnerFailure(
							code,
							stderrTail,
							confined.runnerFailureRules,
						);
						if (fatal !== undefined) {
							reject(
								new SandboxUnavailableError(
									opts.mode as ConfinedSandboxMode,
									fatal,
								),
							);
							return;
						}
						if (classifyDenial(code, stderrTail, confined.denialSignatures)) {
							opts.onDenial?.({
								exitCode: code,
								stdout: stdoutTail,
								stderr: stderrTail,
							});
							const customRunner = (opts.runnerCommand?.length ?? 0) > 0;
							const hint = denialFollowupHint({
								subject: "command",
								customRunner,
								...(customRunner
									? {}
									: grantDirectoryForDenial(extractAbsolutePaths(stderrTail))),
							});
							execOpts.onData(
								Buffer.from(`\n${sandboxDenialMarker(opts.mode)}\n${hint}\n`),
							);
						}
					}
					// I1: match pi local ops (dist bash.js: throw Error("aborted") / throw Error(`timeout:${timeout}`)).
					// Otherwise pi treats null as the success branch and returns a timed-out or aborted
					// command to the model as "completed normally, with truncated output".
					if (code === null) {
						if (timedOut) {
							reject(new Error(`timeout:${execOpts.timeout}`));
							return;
						}
						if (execOpts.signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
					}
					resolve({ exitCode: code }); // External kill (no timer, no abort): keep the null semantics
				});
			});
		},
	};
}
