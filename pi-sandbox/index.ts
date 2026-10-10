import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { approvalStatusLine, getSandboxConfig } from "./src/config";
import { getDenialLedger } from "./src/denial-ledger";
import { getEscalationBroker } from "./src/escalation-broker";
import { createPiSandboxCommand } from "./src/init-command";
import {
	createPermissionCommand,
	processPermissionState,
} from "./src/permission";
import { canonicalPath } from "./src/policy";
import { selectRunner } from "./src/runners";
import { createSandboxTools } from "./src/tools";
import { aclSkillPaths } from "./src/win32/skill-paths";
import { getWritableGrants } from "./src/writable-grants";

/**
 * Channel names for the pi-subagents child-session lifecycle (a convention, not a compile-time contract; spec §4.1, §8).
 * This package does not import pi-subagents—the two packages do not depend on each other, and the channel names are declared independently here. If upstream drifts,
 * a missing link sends the child session back to fail-closed, which fails safe.
 */
const SUBAGENT_CHILD_SESSION_CREATED = "subagents:child:session-created";
const SUBAGENT_CHILD_DISPOSED = "subagents:child:disposed";

/**
 * Every member of ctx is a getter that calls assertActive() first: a read after session replacement / reload throws
 * "This extension ctx is stale…". Any read failure is treated as "no UI"—strictly fail-closed,
 * and the host's internal error must never bubble up as the error text of a subagent tool call (spec §6).
 */
function readHasUI(ctx: { hasUI: boolean }): boolean {
	try {
		return ctx.hasUI;
	} catch {
		return false;
	}
}

/**
 * Active-tool probe (prerequisite for Ruling 8): `getActiveTools` is a newer pi API and may be missing on older hosts;
 * the getter can also throw when ctx is stale / on reload. A `typeof` probe plus try/catch maps every failure to
 * "indeterminate" (undefined)—this file's contract is that the extension factory never throws (I2), so skipping the notice is preferable.
 */
function readActiveTools(pi: ExtensionAPI): string[] | undefined {
	try {
		if (typeof pi.getActiveTools !== "function") return undefined;
		const active = pi.getActiveTools();
		return Array.isArray(active) ? active : undefined;
	} catch {
		return undefined;
	}
}

/** Ruling 8 notice copy: it must name the fix and the failure direction (bash commands are refused until it is enabled).
 *  The direction gives only the **effective** half, `+powershell`: on win32 the unrestricted (sandbox-controlled) shell is this package's overriding registration of
 *  `powershell` (**extension tools activate automatically**; pi's built-in default activation list `["read","bash","edit","write"]`
 *  does not include it), while this package's bash is registered with `exposure: "hidden"` (D3 third revision: not declared to the model, and it cannot be
 *  activated by name)—`-bash` neither removes an extension-registered tool nor is the action needed here.
 *  T15 revision: add the host prerequisite `requires pi >= 1.0.0` (wording matches `UnsupportedWindowsShellError` in `src/confine.ts`)—
 *  hosts below 1.0.0 have no `powershell` tool,
 *  and sending the user to settings.json to enable a tool that does not exist is not actionable. */
const POWERSHELL_HINT_MESSAGE = [
	"pi-sandbox: on Windows the confined shell is PowerShell only. Enable it in ~/.pi/agent/settings.json (requires pi >= 1.0.0):",
	'  { "defaultTools": ["+powershell"] }',
	"Until then, bash commands are refused (fail-closed).",
].join("\n");

/**
 * Once-per-process notice flag: pi reinvokes the factory for every session (including child sessions); without the flag, every activate /
 * session_start would spam the notice again. The module-level variable is shared by every session in the same pi process.
 */
let powershellHintShown = false;

/**
 * Ruling 8: notify once when pwsh is inactive on win32 (`ctx.ui.notify` when a UI is present, stderr otherwise).
 * The ruling condition must be decidable: the host has `getActiveTools`, and `bash` is in the active list while `powershell` is not.
 * After the D3 third revision this package registers bash with `exposure: "hidden"`: `getActiveToolNames()` returns only **declared**
 * tools, and hidden never appears in the active list (nor can it be activated by name)—so this notice has no triggerable
 * normal path on pi ≥1.0.0. It is kept for **older hosts** (≤0.80.x: they do not understand `exposure`, extension tools always activate automatically, and that version
 * has no powershell tool at all)—exactly the case the `requires pi >= 1.0.0` premise in the copy is meant to catch.
 * Known boundary (undecided; recorded for now): on pi ≥1.0.0, when the user explicitly excludes powershell (`defaultTools: ["-powershell"]`
 * or `--exclude-tools powershell`), bash is not in the active list → this notice does not fire. If that state should also notify,
 * the trigger should be relaxed to "only powershell ∉ active" (that would tell ≤0.80.x hosts to upgrade on every run).
 * Any getter failure (stale ctx / old host / getter throw) stays silent—the notice is optional and must never block activation.
 */
function maybeWarnMissingPowerShellTool(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	if (process.platform !== "win32" || powershellHintShown) return;
	const active = readActiveTools(pi);
	if (
		active === undefined ||
		active.includes("powershell") ||
		!active.includes("bash")
	)
		return;
	powershellHintShown = true;
	let notified = false;
	if (readHasUI(ctx)) {
		try {
			const notify = ctx.ui?.notify;
			if (typeof notify === "function") {
				notify(POWERSHELL_HINT_MESSAGE, "warning");
				notified = true;
			}
		} catch {
			notified = false; // ctx is stale (reload / session replacement): fall through to stderr
		}
	}
	if (!notified)
		console.warn(
			`sandbox: ${POWERSHELL_HINT_MESSAGE.replaceAll("\n", "\n  ")}`,
		);
}

/**
 * Ruling 8 `/permission` status line: on win32 the only confined shell is PowerShell (this package's overriding `powershell`
 * activates automatically as an extension tool; this package's bash is registered with `exposure: "hidden"` and never enters the active list).
 * When it can be determined that pwsh is not among the active tools, note that it is not yet activated—`/permission` is the user's first stop when investigating "why bash was refused".
 * When it cannot be determined (older hosts have no `getActiveTools`—on those hosts the pwsh tool does not exist at all—or the getter fails), note
 * `activation unknown`: do not assert an activation state, so a bare `shell: powershell only` is not read as "enabled" (T15 revision).
 */
function win32ShellStatusLine(pi: ExtensionAPI): string | null {
	if (process.platform !== "win32") return null;
	const active = readActiveTools(pi);
	if (active === undefined)
		return "shell: powershell only (activation unknown)";
	return active.includes("powershell")
		? "shell: powershell only"
		: "shell: powershell only (not activated)";
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	// I2 fail-safe: a bad config warns here and falls back to DEFAULT (still constrained workspace-write),
	// and must never throw—a throw makes pi null out the whole extension, and the three base tools then run unsandboxed (fail-open).
	getSandboxConfig(cwd);

	// C1: /permission overrides use a process-level module singleton (spec §9)—pi reinvokes this factory for every session (including subagent child sessions),
	// and the activate closure is not shared across sessions; only a module singleton covers every parent and child session.
	const tools = createSandboxTools({ cwd, permission: processPermissionState });
	// On win32, bash is an override that is "registered but unreachable by the model" (tools.ts adds exposure: "hidden" per platform): it is neither on the model's
	// tool list nor activatable by name, and the name bash still hits this package's denial shell rather than pi's built-in unrestricted bash.
	pi.registerTool(tools.bash as never);
	pi.registerTool(tools.write as never);
	pi.registerTool(tools.edit as never);
	if (tools.grantWrite !== undefined)
		pi.registerTool(tools.grantWrite as never);
	// Ruling 9: skills are **appended** per platform (pi's side is mergePaths merge semantics). Return only this package's skill paths,
	// or an empty array = add nothing (zero directory entries off win32); never return a "complete set" that wipes other sources.
	pi.on("resources_discover", () => ({ skillPaths: aclSkillPaths() }));
	// Older hosts (including this repo's devDependency 0.80.2) have no createPowerShellToolDefinition → tools.powershell
	// is undefined: skip registration and do not error (those hosts have no powershell tool to override anyway).
	if (tools.powershell !== undefined)
		pi.registerTool(tools.powershell as never);

	pi.registerCommand(
		"permission",
		createPermissionCommand({
			state: processPermissionState,
			// C2: pi never chdirs; the session cwd is reachable only via the command's ctx.cwd. An empty string falls back to the cwd at activate time.
			describeStatus: (statusCwd, projectTrusted = null) => {
				const effectiveCwd = statusCwd || cwd;
				const cfg = getSandboxConfig(effectiveCwd);
				const effective = processPermissionState.override ?? cfg.mode;
				const source =
					processPermissionState.override !== null
						? "/permission override"
						: "config default";
				let runnerText: string;
				// Ruling 19: danger-full-access is decided first—when a custom runner is configured but the mode is full access,
				// the runner line must show bypassed (the runner does not take part in execution in that mode).
				if (effective === "danger-full-access") {
					runnerText = "bypassed (danger-full-access)";
				} else if (cfg.runnerCommand !== null && cfg.runnerCommand.length > 0) {
					runnerText = `custom command (${cfg.runnerCommand.join(" ")})`;
				} else {
					const selected = selectRunner(cfg.probeTimeoutMs);
					runnerText =
						selected.runner === "unavailable"
							? "unavailable (fail-closed: confined commands will be refused)"
							: `${selected.runner} (${selected.enforcement} enforcement)`;
				}
				const lines = [
					`sandbox mode: ${effective} (${source})`,
					approvalStatusLine(cfg, projectTrusted),
					`runner: ${runnerText}`,
					`workspace: ${canonicalPath(effectiveCwd)}`,
				];
				const shellLine = win32ShellStatusLine(pi);
				if (shellLine !== null) lines.push(shellLine);
				return lines.join("\n");
			},
		}),
	);

	// /pi-sandbox init writes the default pi-sandbox.json (global or project; confirm before overwrite).
	pi.registerCommand("pi-sandbox", createPiSandboxCommand());

	// Escalation approval forwarding (spec 2026-09-30 §4.5): a child session has hasUI=false, and its escalation requests are routed through the broker to the parent session's dialog.
	// The broker is stored on globalThis—parent and child are separate jiti instances, so module singletons are not shared.
	const broker = getEscalationBroker();
	// Capture the session id registered by this activate: session_shutdown's ctx may already be stale (pi throws on a stale ctx),
	// so unregistering with the captured value is more reliable. The factory is reinvoked per session, so this variable is naturally session-scoped.
	let registeredSessionId: string | null = null;
	// On every /reload the host reuses the same event bus and reinvokes this factory: without unsubscribing, listeners accumulate without bound
	// (past Node's default maxListeners it prints MaxListenersExceededWarning and pollutes the user's terminal).
	const unsubscribeCreated = pi.events.on(
		SUBAGENT_CHILD_SESSION_CREATED,
		(data) => {
			const event = data as { sessionId?: unknown; parentSessionId?: unknown };
			if (typeof event.sessionId !== "string") return; // contract drift → no link → the child session stays fail-closed
			broker.linkChild(
				event.sessionId,
				typeof event.parentSessionId === "string"
					? event.parentSessionId
					: undefined,
			);
		},
	);
	const unsubscribeDisposed = pi.events.on(SUBAGENT_CHILD_DISPOSED, (data) => {
		const event = data as { sessionId?: unknown };
		if (typeof event.sessionId !== "string") return;
		broker.unlinkChild(event.sessionId);
		getDenialLedger().forget(event.sessionId); // child session disposed: drop unconsumed denial records (prevent a Map leak)
		getWritableGrants().clear(event.sessionId);
	});
	const clearGrants = (ctx: {
		sessionManager?: { getSessionId(): string };
	}): void => {
		try {
			const sessionId = ctx.sessionManager?.getSessionId();
			if (typeof sessionId === "string" && sessionId.length > 0)
				getWritableGrants().clear(sessionId);
		} catch {
			// Stale ctx: if it cannot be cleared, leave it until the next event that yields an id. Do not let the host's internal error bubble up.
		}
	};
	// At the start of a new user prompt, clear the previous turn's directory grants. Steering / follow-up do not pass through before_agent_start;
	// they enter the same turn as user messages, so message_start clears as well. agent_settled is when this turn actually ends
	// (retries and compaction are not finished yet, so do not clear on agent_end). clear deletes directories created this time that are still empty.
	pi.on("before_agent_start", (_event, ctx) => {
		clearGrants(ctx);
	});
	pi.on("message_start", (event, ctx) => {
		const message = (event as { message?: { role?: string } }).message;
		if (message?.role !== "user") return;
		clearGrants(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		clearGrants(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		// The Ruling 8 notice does not depend on a UI or a session identity (it goes to stderr when there is no UI), so it must run **before** the hasUI
		// guard below—the path after the guard registers the approval channel and has nothing to do with the notice.
		maybeWarnMissingPowerShellTool(pi, ctx);
		if (!readHasUI(ctx)) return; // headless / child session / stale ctx: none of these is an approval endpoint
		let sessionId: string;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			return; // do not register without a session identity (strictly fail-closed; do not guess)
		}
		if (registeredSessionId !== null && registeredSessionId !== sessionId) {
			// A second session_start in the same activate that switched sessions: detach the old channel first so it does not linger in the registry
			broker.unregisterParent(registeredSessionId);
		}
		registeredSessionId = sessionId;
		broker.registerParent({
			sessionId,
			// hasUI is checked live, not snapshotted: after registration the parent session may lose its UI because of reload / session replacement, or ctx may go stale
			hasUI: () => readHasUI(ctx),
			select: (title, options, opts) => ctx.ui.select(title, options, opts),
			// Second step of the two-step flow: the optional reason after Deny. Older hosts / a bad ctx may have no input—when it is missing the broker skips the follow-up.
			input:
				typeof ctx.ui.input === "function"
					? (title, placeholder, opts) => ctx.ui.input(title, placeholder, opts)
					: undefined,
		});
	});
	pi.on("session_shutdown", () => {
		unsubscribeCreated();
		unsubscribeDisposed();
		if (registeredSessionId === null) return;
		broker.unregisterParent(registeredSessionId);
		getDenialLedger().forget(registeredSessionId); // session disposed: drop unconsumed denial records (prevent a Map leak)
		getWritableGrants().clear(registeredSessionId);
		registeredSessionId = null;
	});
}
