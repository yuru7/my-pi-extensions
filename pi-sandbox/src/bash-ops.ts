import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { assertShellAllowed } from "./confine";
import { createSandboxShellOps, type ShellOpsOptions } from "./shell-ops";

/**
 * Confined ops for bash. The shared execution path is shell-ops (behavior matches 1.3.x).
 * Confined mode on win32 supports only pwsh (Ruling 2); the guard rejects bash before any spawn.
 */
export function createSandboxBashOps(opts: SandboxBashOpts): BashOperations {
	return createSandboxShellOps({
		...opts,
		shell: (command) => ["bash", "-c", command],
		guard: (mode) => assertShellAllowed("bash", opts.platform ?? process.platform, mode),
	});
}

/** Constructor options for bash ops. Shell translation and the win32 guard are fixed by this module. */
export type SandboxBashOpts = Omit<ShellOpsOptions, "shell" | "guard">;

export type { SpawnFn } from "./shell-ops";
