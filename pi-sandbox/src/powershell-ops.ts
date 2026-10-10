import type { BashOperations } from "@earendil-works/pi-coding-agent";
import * as piHost from "@earendil-works/pi-coding-agent";
import { createSandboxShellOps, type ShellOpsOptions } from "./shell-ops";

/** Match pi's local powershell ops: make pwsh emit UTF-8 (otherwise non-ASCII output is garbled). */
export const POWERSHELL_UTF8_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

/**
 * Host probe (namespace import + `typeof === "function"`): pi < 1.0.0 has no
 * `getPowerShellConfig`. A static named import fails at link time (ESM); a namespace
 * property read is at worst undefined. The probe runs once at module load. Resolution
 * (calling the function) happens on every exec, because the host config can change.
 */
const host = piHost as unknown as Record<string, unknown>;
const hostGetPowerShellConfig = typeof host.getPowerShellConfig === "function"
	? (host.getPowerShellConfig as () => { shell: string; args: string[] })
	: undefined;

export interface SandboxPowerShellOpts extends Omit<ShellOpsOptions, "shell"> {
	/** Test injection: host resolution result (production uses getPowerShellConfig). */
	powerShellConfig?: () => { shell: string; args: string[] };
}

/**
 * Confined ops for pwsh. argv comes from the host's getPowerShellConfig, the command
 * string is prefixed with the UTF-8 preamble, and the rest (guard/confine/spawn/timeout/
 * abort/denial accounting) reuses the shell-ops factory. If resolution fails (the host
 * has no such export / the tool is unavailable) the error is thrown inside the Promise
 * executor, so the call rejects and does not spawn (fail-closed).
 *
 * Returns `BashOperations`: the local host types are 0.80.2 and have no
 * `PowerShellOperations`. pi >= 1.0.0 is structurally the same (same exec shape); callers
 * narrow the type when they need to.
 */
export function createSandboxPowerShellOps(opts: SandboxPowerShellOpts): BashOperations {
	const resolve = opts.powerShellConfig ?? hostGetPowerShellConfig
		?? (() => {
			throw new Error("pi-sandbox: the powershell tool requires pi >= 1.0.0 (getPowerShellConfig is unavailable)");
		});
	return createSandboxShellOps({
		...opts,
		cwdErrorMessage: opts.cwdErrorMessage ?? "Cannot execute PowerShell commands.",
		shell: (command) => {
			const { shell, args } = resolve();
			return [shell, ...args, `${POWERSHELL_UTF8_PREFIX}${command}`];
		},
	});
}
