import { readProjectTrusted } from "./config";
import { isSandboxMode, SANDBOX_MODES, type SandboxMode } from "./policy";

/**
 * Process-wide user override (spec §8/§9). One pi process has one human user, so an
 * override set by /permission takes effect on the next tool call in the parent session
 * and every child session. This is the only persistent lever for a stuck child agent
 * (child sessions have hasUI=false, so escalation is always fail-closed).
 */
export interface PermissionState {
	override: SandboxMode | null;
}

export function createPermissionState(): PermissionState {
	return { override: null };
}

/** Process-global slot key, prefixed with the package name so it does not collide with other extensions' globalThis use. */
const PERMISSION_STATE_KEY = Symbol.for("@yuru7/pi-sandbox:permission-state");

function getOrCreatePermissionState(): PermissionState {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[PERMISSION_STATE_KEY] as PermissionState | undefined;
	if (existing !== undefined) return existing;
	const state = createPermissionState();
	store[PERMISSION_STATE_KEY] = state;
	return state;
}

/**
 * Process-wide singleton (spec §9). It must live on **globalThis**, not in a module-level
 * variable. The host's extension module cache is keyed by (cwd, generation)
 * (`useExtensionCacheCwd` / `loadExtensionModule` in `dist/core/extensions/loader.js`).
 * When the token changes, `clearExtensionCache()` + `createJiti({ moduleCache: false })`
 * re-import the whole extension. A pi-subagents child session cwd is
 * `params.cwd ?? snapshot.cwd` (it may differ from the parent), and `/reload` also clears
 * the cache. A module-level variable is reinitialized to `{ override: null }` in those
 * cases, so a `/permission` override set in the parent is invisible to a child session
 * (or to the new instance after reload): "I widened it, and it is still denied."
 * The globalThis slot is shared by every module instance in the process, so the same
 * state is visible whether it was set before or after, and whether the cwd matches.
 */
export const processPermissionState: PermissionState = getOrCreatePermissionState();

/** Test-only reset of the global slot (production code must not call this). */
export function resetPermissionStateForTests(): void {
	delete (globalThis as Record<symbol, unknown>)[PERMISSION_STATE_KEY];
}

export interface PermissionCommandDeps {
	state: PermissionState;
	/** Build the status block: effective mode and its source, selected runner and enforcement, workspace root.
	 *  cwd is the session cwd of the command (C2: pi never chdirs; it is reachable only via ctx.cwd); an empty string means unknown.
	 *  projectTrusted is true/false/null (cannot be confirmed). */
	describeStatus: (cwd: string, projectTrusted?: boolean | null) => string;
}

interface NotifyUI {
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export function createPermissionCommand(deps: PermissionCommandDeps) {
	return {
		description: "Show or switch the sandbox permission mode (read-only | workspace-write | danger-full-access), process-wide",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim();
			return SANDBOX_MODES.filter((m) => m.startsWith(prefix)).map((m) => ({ value: m, label: m }));
		},
		handler: async (args: string, ctx: { ui: NotifyUI; cwd?: string; isProjectTrusted?: () => boolean }) => {
			const arg = args.trim();
			if (!arg) {
				ctx.ui.notify(deps.describeStatus(ctx.cwd ?? "", readProjectTrusted(ctx)), "info");
				return;
			}
			if (!isSandboxMode(arg)) {
				ctx.ui.notify(`sandbox: unknown mode "${arg}". Available: ${SANDBOX_MODES.join(", ")}`, "error");
				return;
			}
			deps.state.override = arg;
			ctx.ui.notify(`sandbox: permission mode set to ${arg} (process-wide, effective on the next tool call)`, "info");
		},
	};
}
