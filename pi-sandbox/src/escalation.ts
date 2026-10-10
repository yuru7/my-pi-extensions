import type { SandboxMode } from "./policy";

/**
 * Strictly-wider table: the key is this call's effective mode, the value is the modes it may escalate to.
 * Checked at execution time against each call's effective mode (the schema enum is global to the registry;
 * the effective mode is the per-call truth—deepseek escalation.ts semantics).
 */
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
	"read-only": ["workspace-write", "danger-full-access"],
	"workspace-write": ["danger-full-access"],
};

/** Whether the requested mode is strictly wider (the denial-first gate and approveEscalation share this table). */
export function isStrictlyWider(
	effective: SandboxMode,
	requested: string,
): boolean {
	return (WIDER_MODES[effective] ?? []).includes(requested as SandboxMode);
}

/** Closed vocabulary of escalation targets (read-only is the floor and cannot be a target). */
export const ESCALATION_TARGETS = [
	"workspace-write",
	"danger-full-access",
] as const;

export const ESCALATION_OPTIONS = ["Allow once", "Deny"] as const;

/**
 * Error copy for malformed escalation arguments (paid for on demand: it enters context only when the model sent malformed arguments). All three parts are required—
 * (1) whether anything ran (nothing ran: the model otherwise misread this as "the sandbox denied me" and abused the maximum mode) (2) the cause (3) a self-correcting recipe.
 */
const MALFORMED_ESCALATION =
	"invalid escalation: this call was rejected before execution (nothing ran).";
const ESCALATION_FIX =
	'Fix: to run without escalation, omit BOTH fields or send JSON null for BOTH; to escalate, send sandbox_permissions ("workspace-write" | "danger-full-access") with a one-sentence justification.';

export function validateEscalationArgs(
	sandboxPermissions: string | undefined,
	justification: string | undefined,
): void {
	if (sandboxPermissions !== undefined && justification === undefined) {
		throw new Error(
			`${MALFORMED_ESCALATION} Cause: sandbox_permissions was sent without justification. ${ESCALATION_FIX}`,
		);
	}
	if (justification !== undefined && sandboxPermissions === undefined) {
		throw new Error(
			`${MALFORMED_ESCALATION} Cause: justification was sent without sandbox_permissions. ${ESCALATION_FIX}`,
		);
	}
	if (justification !== undefined && justification.trim().length === 0) {
		throw new Error(
			`${MALFORMED_ESCALATION} Cause: justification was empty. ${ESCALATION_FIX}`,
		);
	}
}

/**
 * Placeholder normalization for escalation arguments: `null` / `"null"` (trim, case-insensitive) / empty string / whitespace-only are not escalation requests; they mean "left blank".
 * After they become undefined the no-escalation path is taken: reporting MALFORMED makes the model misread this as "the sandbox denied me" and escalate for real to the maximum mode.
 *
 * Reachability differs by field (measured: **both pi 0.80.2 and 1.0.0 run `validateToolArguments`**, and the validated object is the declared schema
 * —0.80.2 has no strict wire-schema transform and no `normalizeOptionalNulls`; 1.0.0 has both;
 * the tool-side `prepareArguments` (`stripEscalationPlaceholders`) strips placeholder strings before validation):
 * - `justification`'s string arm is `Type.String()` (the field itself is `string | null`): string placeholders (`"null"` / `""`) are legal values,
 *   and on a call path that skips the hook they really do reach execute,
 *   so these branches are load-bearing (otherwise an ordinary call is misclassified as MALFORMED, and a real escalation would also carry
 *   `Reason: null` into the approval dialog);
 * - `sandbox_permissions` is a two-literal enum: a string placeholder that is not stripped is hard-rejected during pi's argument validation (execute does not run).
 *   Before the hook this was a hard error plus an error replay (the model treated its own `"null"` as a sample, and the noise reinforced itself);
 *   after the hook, placeholders are out before validation, and the only values that can reach execute are "omitted", the JSON `null` the schema declares explicitly,
 *   and the two legal modes—the non-string branches are load-bearing too (under 1.0.0 JSON `null` is delivered as-is; under 0.80.2
 *   `Value.Convert` turns it into `""`; both are normalized by this function; numbers/booleans are coerced to strings, and objects/arrays are rejected at validation).
 * Only placeholders are recognized; a real malformation (such as justification alone) is still reported by validateEscalationArgs.
 */
export function normalizeEscalationValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed.toLowerCase() === "null") return undefined;
	return trimmed;
}

/** Escalation field names (the same keys as `ESCALATION_PROPS` in `src/tools.ts`; tests/tools.test.ts pins the match). */
export const PLACEHOLDER_KEYS = [
	"sandbox_permissions",
	"justification",
] as const;

/**
 * Body of pi's `prepareArguments` hook (wired in `withPlaceholderStripping` in `src/tools.ts`):
 * before pi's argument validation (`validateToolArguments`, present on both pi 0.80.2 and 1.0.0), strip placeholder strings the model wrote by mistake
 * (`"null"` / `""` / whitespace-only, classified by reusing `normalizeEscalationValue`) off the escalation fields.
 *
 * Why it is needed: under a strict provider (for example deepseek-flash, `compat.supportsStrictMode`) pi stuffs every property
 * into `required`, so the model cannot omit these two fields at the protocol level; and in the schema text `null` appears only as the quoted `{"type":"null"}`
 * (a JSON Schema type name is a string), so the model often writes the string `"null"`. On `sandbox_permissions`'s
 * two-literal enum that is hard-rejected at validation time (execute does not run, **measured the same on 0.80.2 and 1.0.0**), and the error message replays the original argument JSON into context,
 * which becomes the strongest sample to imitate on the next turn—stripping before validation both lets an ordinary call run and cuts off that self-reinforcing loop.
 *
 * This hook depends on two host contracts (deleting it falls back to the error-replay loop):
 * (1) `prepareToolCallArguments` runs **before** `validateToolArguments` (true on both 0.80.2 and 1.0.0);
 * (2) validation uses the **declared schema**, not the strict wire schema sent to the model—if a future host validates against the strict wire
 * schema, this hook's "delete the key" would make ordinary calls fail (under strict, required contains everything), and the design would have to change with it.
 *
 * Only placeholder strings are stripped:
 * - JSON `null` and "omitted" pass through unchanged (`Type.Null()`'s legal value is still normalized by `resolveCall`; this hook does not change that path);
 * - a real escalation (a legal mode plus a non-empty reason) must not be stripped by mistake;
 * - illegal values (an illegal mode, a number, an object, and so on) are kept as-is and left for pi's validation / `validateEscalationArgs` to reject—
 *   the hook is "zeroing noise", not correcting the model at validation time.
 * Non-object input is returned as-is; when there is no placeholder the same reference is returned (pi's `prepareToolCallArguments` skips replacement on that basis, zero disturbance);
 * the input object is not mutated (the session log and the UI keep the model's original output).
 * The generic assertion `as T` is safe: this can only delete the two optional keys in the declared schema; every other key and value stays as-is.
 */
export function stripEscalationPlaceholders<T>(args: T): T {
	if (typeof args !== "object" || args === null || Array.isArray(args))
		return args;
	const record = args as Record<string, unknown>;
	let stripped: Record<string, unknown> | undefined;
	for (const key of PLACEHOLDER_KEYS) {
		if (!(key in record)) continue;
		const value = record[key];
		if (
			typeof value !== "string" ||
			normalizeEscalationValue(value) !== undefined
		)
			continue;
		stripped ??= { ...record };
		delete stripped[key];
	}
	return (stripped ?? args) as T;
}

/** Model-visible denial marker (shared by the fs fence and bash denial classification; do not change the wording). */
export function sandboxDenialMarker(mode: SandboxMode): string {
	return `[sandbox: file access denied under ${mode} mode]`;
}

/**
 * The next step at the moment of denial. The caller has already classified the path into: one directory that can be granted, too wide,
 * paths spread across several directories, a missing path, or a custom runner. This only writes the sentence the model sees.
 */
export function denialFollowupHint(args: {
	subject: "command" | "operation";
	customRunner?: boolean;
	grantDirectory?: string;
	refusedDirectory?: string;
	split?: boolean;
	targetPath?: string;
}): string {
	const subject = args.subject;
	if (args.customRunner) {
		return `[sandbox: a custom runnerCommand cannot accept a directory grant. Retry this exact ${subject} once with sandbox_permissions "danger-full-access" and a justification.]`;
	}
	if (
		args.grantDirectory !== undefined &&
		subject === "operation" &&
		args.targetPath !== undefined
	) {
		return `[sandbox: to change only ${args.targetPath}, retry this exact call once with sandbox_permissions "danger-full-access" and a justification. If later calls in this request will write in ${args.grantDirectory} again, call sandbox_grant_write alone with that directory and a one-sentence justification, then retry. Do not grant a wider directory.]`;
	}
	if (args.grantDirectory !== undefined) {
		return `[sandbox: if this command writes in ${args.grantDirectory} only once, retry this exact command once with sandbox_permissions "danger-full-access" and a justification. If later calls in this request will write there again, call sandbox_grant_write alone with that directory and a one-sentence justification, then retry. Do not grant a wider directory.]`;
	}
	if (args.refusedDirectory !== undefined) {
		return `[sandbox: sandbox_grant_write refuses ${args.refusedDirectory} because it is /, the home directory, or an ancestor of home. Retry this exact ${subject} once with sandbox_permissions "danger-full-access" and a justification.]`;
	}
	if (args.split) {
		return `[sandbox: the denied paths are not in one directory. Retry this exact ${subject} once with sandbox_permissions "danger-full-access" and a justification. Do not grant a wider directory.]`;
	}
	return `[sandbox: this denial names no directory. Writable here: the workspace and /tmp. Otherwise retry this exact ${subject} once with sandbox_permissions "danger-full-access" and a justification.]`;
}

/**
 * Notice delivered with the result after approval: a one-shot escalation expires on the next call. Without this sentence the model treats "it was approved"
 * as "the mode stays widened", and then attaches the same escalation arguments to every later command (even a read-only ls).
 */
export function escalationAppliedMarker(mode: SandboxMode): string {
	return `[sandbox: this call ran with a one-shot escalation to "${mode}"; the approval covered this call only — later calls are confined again]`;
}

/**
 * Ignore marker for the denial-first gate: the escalation arguments were not accepted (this session has no prior denial record), and the call runs at the current mode.
 * Feedback in place for the model—otherwise it misreads "the arguments had no effect" as the sandbox silently allowing the call, and keeps attaching the arguments to later calls.
 */
export function escalationIgnoredMarker(mode: SandboxMode): string {
	return `[sandbox: escalation fields were ignored — no sandbox denial was recorded for this session, so this call ran under "${mode}" mode. Send escalation fields only when retrying a call that just returned a denial marker.]`;
}

/** Optional reason follow-up after Deny (second step of the two-step flow: select → input). */
export interface DenialReasonPrompt {
	title: string;
	placeholder: string;
}

/** Outcome of one approval dialog: choice undefined means cancelled / no channel; reason is the optional reason on Deny. */
export interface EscalationDecision {
	choice: string | undefined;
	reason?: string;
}

/**
 * Minimal structural shape of an approval channel (no dependency on pi types, so tests can inject one). ask is one complete approval dialog:
 * a direct channel does select → input (on Deny); a broker channel puts both steps in the same FIFO task (the host has only
 * one dialog slot, and no other dialog may be inserted between select and input).
 * Note: pi's noOpUIContext.select silently returns undefined—hasUI must be checked explicitly before the call,
 * or "no channel" is misread as "the user cancelled" (spec §9).
 */
export interface EscalationUI {
	hasUI: boolean;
	ask(
		title: string,
		options: string[],
		denialReason?: DenialReasonPrompt,
	): Promise<EscalationDecision>;
}

export interface EscalationRequest {
	requestedMode: string;
	justification: string;
	effectiveMode: SandboxMode;
	subject: "command" | "operation";
	/** Command/path summary shown in the dialog (the caller is responsible for truncating to ~200 characters). */
	summary: string;
}

/** Optional reason input after Deny (second step of the two-step flow). */
export const DENIAL_REASON_PROMPT: DenialReasonPrompt = {
	title: "Why deny? (optional — the model will see it)",
	placeholder: "e.g. never touch files outside the workspace",
};

/**
 * Reason normalization: collapse whitespace, trim, and truncate to 500 characters. Empty / placeholder → undefined (the denial copy falls back to the original wording, verbatim).
 * The reason enters context with the tool error, so one input must not blow the prompt budget.
 */
export function sanitizeDenialReason(
	raw: string | undefined,
): string | undefined {
	if (typeof raw !== "string") return undefined;
	const collapsed = raw.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return undefined;
	return collapsed.length > 500 ? `${collapsed.slice(0, 500)}…` : collapsed;
}

function denialReasonSuffix(raw: string | undefined): string {
	const reason = sanitizeDenialReason(raw);
	return reason === undefined ? "" : `. The user's reason: ${reason}`;
}

/**
 * Resolve one escalation request before execution (order is priority, and every step is fail-closed):
 * same mode skips approval → strictly-wider check → explicit hasUI check → ask for approval (on Deny, follow up for an optional reason).
 * The return value applies only to the call that started it (one-shot, not persisted).
 */
export async function approveEscalation(
	request: EscalationRequest,
	ui: EscalationUI,
): Promise<SandboxMode> {
	const { requestedMode, justification, effectiveMode, subject, summary } =
		request;
	if (requestedMode === effectiveMode) return effectiveMode;
	if (
		!(WIDER_MODES[effectiveMode] ?? []).includes(requestedMode as SandboxMode)
	) {
		throw new Error(
			`sandbox escalation to "${requestedMode}" is not strictly wider than this call's current "${effectiveMode}" mode — nothing was executed. Run the call as-is, or escalate to "danger-full-access".`,
		);
	}
	if (!ui.hasUI) {
		throw new Error(
			`sandbox escalation to "${requestedMode}" requires approval, but no approval channel is available — nothing was executed. This happens in headless and cross-process subagents: do the work inside the writable roots, or ask the user to run /permission ${requestedMode} in their main session and retry.`,
		);
	}
	const decision = await ui.ask(
		[
			`Sandbox escalation: allow this ${subject} under "${requestedMode}"?`,
			"",
			`Reason: ${justification}`,
			`${subject === "command" ? "Command" : "Path"}: ${summary}`,
		].join("\n"),
		[...ESCALATION_OPTIONS],
		DENIAL_REASON_PROMPT,
	);
	if (decision.choice === undefined) {
		throw new Error(
			`approval for escalating to "${requestedMode}" was cancelled — nothing was executed`,
		);
	}
	if (decision.choice === "Deny") {
		throw new Error(
			`the user rejected escalating this ${subject} to "${requestedMode}"; it stays denied, so stop and explain instead of working around it — do not retry with a different mode or a rewritten command${denialReasonSuffix(decision.reason)}`,
		);
	}
	return requestedMode as SandboxMode;
}
