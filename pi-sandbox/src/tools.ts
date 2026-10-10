import {
	constants,
	access as fsAccess,
	mkdir as fsMkdir,
	readFile as fsReadFile,
	writeFile as fsWriteFile,
} from "node:fs/promises";
// Namespace import used only for the version-gate probe (createPowerShellToolDefinition is an export that exists only on pi ≥1.0.0):
// pi is ESM, so a static named import of an export an old host does not have fails hard at **link time**; a property read is at worst undefined.
import * as piHost from "@earendil-works/pi-coding-agent";
import {
	type AgentToolResult,
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type ExtensionContext,
	type ToolDefinition,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import {
	formatAutoReviewNotice,
	type ReviewerModelRef,
	type ReviewerResponse,
	readRecentDialogue,
	reviewDirectoryGrant,
	reviewEscalation,
} from "./auto-review";
import { createSandboxBashOps, type SpawnFn } from "./bash-ops";
import {
	getSandboxConfig,
	readProjectTrusted,
	type SandboxConfig,
	selectApprovalSettings,
} from "./config";
import {
	type DenialRecord,
	getDenialLedger,
	operationFingerprint,
} from "./denial-ledger";
import {
	approveEscalation,
	DENIAL_REASON_PROMPT,
	type DenialReasonPrompt,
	ESCALATION_OPTIONS,
	type EscalationDecision,
	type EscalationUI,
	escalationAppliedMarker,
	escalationIgnoredMarker,
	isStrictlyWider,
	normalizeEscalationValue,
	sanitizeDenialReason,
	stripEscalationPlaceholders,
	validateEscalationArgs,
} from "./escalation";
import { getEscalationBroker } from "./escalation-broker";
import {
	assertWriteAllowed,
	canonicalizeTarget,
	FenceDenialError,
	type FencePolicy,
	isWithinRoots,
} from "./fence";
import {
	assertCanCreateDirectory,
	createMissingGrantDirectories,
	grantCoversDenial,
	grantTooWide,
	resolveGrantRequest,
} from "./grant-path";
import type { PermissionState } from "./permission";
import {
	canonicalPath,
	defaultTmpRoots,
	resolveEffectiveMode,
	type SandboxMode,
	writableRoots,
} from "./policy";
import { createSandboxPowerShellOps } from "./powershell-ops";
import { type RunnerHooks, selectRunner } from "./runners";
import { getWritableGrants } from "./writable-grants";

/**
 * Structural type of the host pwsh tool factory (pi ≥1.0.0 exports `createPowerShellToolDefinition(cwd, options)`).
 * This repo's pinned devDependency (0.80.2) does not have that export, so this file neither references its type nor statically name-imports it;
 * `ToolDefinition` itself exists on 0.80.2 and is safe to use as the return surface.
 */
type HostPowerShellToolDefinition = ToolDefinition<TSchema, unknown, unknown>;
type HostCreatePowerShellToolDefinition = (
	cwd: string,
	options?: { operations?: BashOperations },
) => HostPowerShellToolDefinition;

/**
 * Host probe (lazy + namespace + `typeof === "function"`): read the property once, and only when assembling on win32.
 * On an old host (<1.0.0, including this repo's devDependency 0.80.2) it is undefined—pi has no powershell
 * tool then, and the default is "do not register, do not error, do not block".
 */
function hostCreatePowerShellToolDefinition():
	| HostCreatePowerShellToolDefinition
	| undefined {
	const candidate = (piHost as unknown as Record<string, unknown>)
		.createPowerShellToolDefinition;
	return typeof candidate === "function"
		? (candidate as HostCreatePowerShellToolDefinition)
		: undefined;
}

/**
 * I2 fail-safe: if the host builder throws during **construction**, degrade to "no pwsh override" (undefined, the same path as an old host).
 * `createSandboxTools` must not throw because of this—pi would null out the whole extension, and bash/write/edit would then run unsandboxed
 * (fail-open, see I2 in index.ts). A builder throw during execute is a different matter: it affects only that one pwsh call,
 * and does not involve extension assembly.
 */
function buildHostPowerShellBase(
	builder: HostCreatePowerShellToolDefinition | undefined,
	cwd: string,
): HostPowerShellToolDefinition | undefined {
	if (builder === undefined) return undefined;
	try {
		return builder(cwd);
	} catch {
		return undefined;
	}
}

export interface SandboxToolDeps {
	cwd: string;
	/** For test injection; production defaults to getSandboxConfig(ctx.cwd) per call (C2). */
	getConfig?(): SandboxConfig;
	permission: PermissionState;
	hooks?: RunnerHooks;
	spawnFn?: SpawnFn;
	/** Pre-resolved runner injected by tests; production defaults to the selectRunner cache. */
	selected?: ReturnType<typeof selectRunner>;
	/** Host platform (default process.platform): decides whether the pwsh tool is registered and whether bash is marked inactive by default (win32),
	 *  and is passed through to shell ops—bash denial on win32 is implemented by the bash-ops guard (assertShellAllowed);
	 *  this file only delivers platform. */
	platform?: string;
	/** Test injection (testing.md "parameter injection"): replace the default createSandboxBashOps; production omits it. */
	_buildBashOps?: typeof createSandboxBashOps;
	/** Test injection (testing.md "parameter injection"): replace the host namespace probe result; production omits it.
	 *  It is needed because the host in this repo's devDependency (0.80.2) has no createPowerShellToolDefinition,
	 *  so the positive win32-registration path cannot be reached naturally in unit tests. The injected value uses the same `typeof === "function"` criterion as the probe;
	 *  a non-function (such as false) simulates "an old host with no such export"; undefined falls back to the real probe. */
	_hostCreatePowerShellToolDefinition?: unknown;
	/** Test injection (testing.md "parameter injection"): replace the default "/tmp" + os.tmpdir() tmp roots; production omits it. */
	_tmpRoots?: readonly string[];
}

const workspaceRootCache = new Map<string, string>();

/** C2 (spec §9): pi never chdirs, so the session cwd is reachable only via execute's ctx.cwd—
 *  the fence root is derived from it per call (module-level cache, shared in-process), and is no longer frozen to process.cwd() at activate time. */
function workspaceRootFor(rawCwd: string): string {
	let root = workspaceRootCache.get(rawCwd);
	if (root === undefined) {
		root = canonicalPath(rawCwd);
		workspaceRootCache.set(rawCwd, root);
	}
	return root;
}

/** Per-call config (C2): test injection wins; otherwise load lazily from the session cwd (getSandboxConfig caches on its own). */
function configForCall(
	deps: SandboxToolDeps,
	sessionCwd: string,
): SandboxConfig {
	return deps.getConfig?.() ?? getSandboxConfig(sessionCwd);
}

/** Escalation argument pair (shared by the three tools).
 *  `Type.Null()` is deliberate: a strict provider (pi's `constrainedSampling: {type:"json_schema"}` + `compat.supportsStrictMode`)
 *  stuffs every property into `required`, and wraps a field that "does not allow null" in `anyOf[X,{type:"null"}]`—so the model must supply a value.
 *  After null is declared explicitly, "do not escalate" has a value the schema accepts and the copy accepts, instead of the model guessing the string `"null"`;
 *  pi's strict transform also stops adding a wrapper (`schemaAllowsNull` recognizes it recursively), and JSON null is not stripped by
 *  `normalizeOptionalNulls` but is delivered as-is to execute's normalization. The last two are host behavior (pi ≥1.0.0):
 *  this repo's devDependency is 0.80.2 (no strict transform, no `normalizeOptionalNulls`, but it **does** have declared-schema argument validation
 *  —measured: the string `"null"` is hard-rejected on 0.80.2 too), so unit tests can only pin the declared schema—
 *  the reproducible host-path recipe and the measured record are in docs/superpowers/specs/2026-10-02-denial-first-escalation-design.md §4.3. */
export const ESCALATION_PROPS = {
	sandbox_permissions: Type.Optional(
		Type.Union([
			Type.Literal("workspace-write"),
			Type.Literal("danger-full-access"),
			Type.Null(),
		]),
	),
	justification: Type.Optional(Type.Union([Type.String(), Type.Null()])),
};

interface EscalationParams {
	/** JSON null = "do not escalate" (declared explicitly by the schema; a strict provider delivers it as-is). */
	sandbox_permissions?: string | null;
	justification?: string | null;
}

interface ToolCtxLike {
	hasUI: boolean;
	cwd?: string;
	ui: {
		select(
			title: string,
			options: string[],
			opts?: { signal?: AbortSignal },
		): Promise<string | undefined>;
		/** Optional: reason input after Deny (second step of the two-step flow). When missing, skip the reason follow-up once. */
		input?(
			title: string,
			placeholder?: string,
			opts?: { signal?: AbortSignal },
		): Promise<string | undefined>;
		notify?(message: string, type?: "info" | "warning" | "error"): void;
	};
	model?: ReviewerModelRef;
	thinkingLevel?: string;
	modelRegistry?: {
		find(provider: string, modelId: string): ReviewerModelRef | undefined;
		hasConfiguredAuth?(model: ReviewerModelRef): boolean;
		complete?(
			model: ReviewerModelRef,
			context: {
				systemPrompt?: string;
				messages: { role: "user"; content: string; timestamp: number }[];
			},
			options?: { reasoning?: string; signal?: AbortSignal },
		): Promise<{
			content?: { type?: string; text?: string }[];
			stopReason?: string;
			errorMessage?: string;
		}>;
	};
	isProjectTrusted?: () => boolean;
	/** Source of the child-session identity. Optional: both existing tests' narrow ctx and an abnormal host may lack it,
	 *  and a missing one is fail-closed as "cannot route"; it must never throw TypeError (Review Focus #1). */
	sessionManager?: {
		getSessionId(): string;
		buildSessionProjection?(): { messages?: unknown };
		getBranch?(): unknown;
	};
}

/** Defensive session-id read: missing, non-string, or a throw all count as "cannot route" (fail-closed). Shared by the parent and child sides. */
function readSessionId(ctx: ToolCtxLike): string | null {
	try {
		const sessionId = ctx.sessionManager?.getSessionId();
		return typeof sessionId === "string" && sessionId.trim().length > 0
			? sessionId.trim()
			: null;
	} catch {
		return null;
	}
}

/** セッションが読めない、または ctx が失効しているときは undefined（判定不能）。 */
function dialogueFor(ctx: ToolCtxLike) {
	try {
		return readRecentDialogue(ctx.sessionManager);
	} catch {
		return undefined;
	}
}

/**
 * Approval-channel resolution (spec 2026-09-30 §4.3):
 * - This session has a UI: prefer the channel it registered itself, and open the dialog on the broker's same FIFO lane (Ruling 17)—the host's
 *   dialog has a single slot and does not queue, so a second call leaves the previous dialog unable to receive keys and its promise orphaned.
 *   Fall back to a direct connection only when its own channel cannot be resolved (the host never sent session_start, or the session id cannot be read); the fallback matches the pre-change behavior verbatim.
 * - This session has no UI (a child session): strictly resolve the parent channel along the link (D3); if it cannot be resolved, return a dummy channel.
 * The dummy channel makes approveEscalation throw the existing fail-closed copy—no new error branch, and the validation order does not change.
 * ask on both channels is two-step (select → input for the reason on Deny): the direct path serially awaits, and the broker finishes both inside the same
 * FIFO task, so the reason input is not displaced by the next queued approval dialog. signal is forwarded on both paths (D6):
 * an interrupt can both close an in-flight dialog and keep a queued request from opening one at all.
 */
function approvalChannelFor(
	ctx: ToolCtxLike,
	signal: AbortSignal | undefined,
): EscalationUI {
	const opts = signal === undefined ? undefined : { signal };
	const broker = getEscalationBroker();
	const sessionId = readSessionId(ctx);
	// Two-step flow of the direct channel: select → input (on Deny), serially awaited on the same async chain, so it is atomic by construction.
	const directAsk = async (
		title: string,
		options: string[],
		denialReason?: DenialReasonPrompt,
	): Promise<EscalationDecision> => {
		const choice = await ctx.ui.select(title, options, opts);
		if (
			choice !== "Deny" ||
			denialReason === undefined ||
			typeof ctx.ui.input !== "function"
		)
			return { choice };
		try {
			const reason = await ctx.ui.input(
				denialReason.title,
				denialReason.placeholder,
				opts,
			);
			return { choice, reason };
		} catch {
			return { choice }; // a failure in the reason input does not change the denial (fail-closed)
		}
	};
	if (ctx.hasUI) {
		const own = sessionId === null ? null : broker.resolveOwnChannel(sessionId);
		if (own === null) {
			return { hasUI: true, ask: directAsk };
		}
		return {
			hasUI: true,
			ask: (title, options, denialReason) =>
				broker.request(own, title, options, signal, denialReason),
		};
	}
	const channel = sessionId === null ? null : broker.resolveChannel(sessionId);
	if (channel === null) {
		return { hasUI: false, ask: async () => ({ choice: undefined }) };
	}
	return {
		hasUI: true,
		ask: (title, options, denialReason) =>
			broker.request(channel, title, options, signal, denialReason),
	};
}

/**
 * Resolve the effective mode of one call (spec §4/§7):
 * malformed check → effective (/permission override > config) → an optional approved escalation.
 * escalated is true only when this call really escalated through approval (a requested mode == effective skips approval and is not an escalation).
 */
export interface ResolvedCall {
	mode: SandboxMode;
	escalated: boolean;
	/** The denial-first gate ignored this call's escalation arguments: run at the effective mode; this is not an escalation. */
	ignoredEscalation: boolean;
}

export async function resolveCall(
	params: EscalationParams,
	ctx: ToolCtxLike,
	deps: SandboxToolDeps,
	subject: "command" | "operation",
	summary: () => string,
	signal?: AbortSignal,
	tool: string = subject,
): Promise<ResolvedCall> {
	// Normalize placeholders before validation: null / "null" / whitespace means "left blank", not a malformed escalation (normalizeEscalationValue).
	// Reporting MALFORMED directly makes the model misread it as a sandbox denial and escalate for real to the maximum mode.
	const requested = normalizeEscalationValue(params.sandbox_permissions);
	const justification = normalizeEscalationValue(params.justification);
	validateEscalationArgs(requested, justification);
	const config = configForCall(deps, ctx.cwd ?? deps.cwd);
	const effective = resolveEffectiveMode(deps.permission.override, config.mode);
	if (requested === undefined)
		return { mode: effective, escalated: false, ignoredEscalation: false };
	// denial-first hard gate: a strictly wider request must hit an unconsumed denial for this session, the same tool, and the same operation.
	// A same-mode request and an illegal request do not enter the gate: the former skips approval, and the latter is reported by approveEscalation with the existing "not strictly wider".
	let denial: DenialRecord | undefined;
	if (isStrictlyWider(effective, requested)) {
		const sessionId = readSessionId(ctx);
		const cwd = ctx.cwd ?? deps.cwd;
		denial =
			sessionId === null
				? undefined
				: getDenialLedger().consume({
						sessionId,
						tool,
						fingerprint: operationFingerprint(
							params as Record<string, unknown>,
						),
						cwd,
					});
		if (denial === undefined)
			return { mode: effective, escalated: false, ignoredEscalation: true };
		if (signal?.aborted) {
			throw new Error(
				`approval for escalating to "${requested}" was cancelled — nothing was executed`,
			);
		}
		const approval = selectApprovalSettings(config, readProjectTrusted(ctx));
		if (approval.approvalInvalid) {
			throw new Error(
				`sandbox escalation to "${requested}" was denied because the approval config is invalid — nothing was executed. Fix approvalMode / autoReview.model / autoReview.thinkingLevel in pi-sandbox.json.`,
			);
		}
		if (approval.approvalMode === "allow-all") {
			return {
				mode: requested as SandboxMode,
				escalated: true,
				ignoredEscalation: false,
			};
		}
		if (approval.approvalMode === "auto-review") {
			const outcome = await reviewEscalation({
				settings: approval,
				activeModel: ctx.model,
				activeThinkingLevel: ctx.thinkingLevel,
				findModel: (provider, id) => ctx.modelRegistry?.find(provider, id),
				hasAuth:
					ctx.modelRegistry?.hasConfiguredAuth === undefined
						? undefined
						: (model) => ctx.modelRegistry?.hasConfiguredAuth?.(model) ?? false,
				complete: (model, request) => completeReview(ctx, model, request),
				warn: (message) => emitNotice(ctx, message, "warning"),
				signal,
				record: denial,
				requestedMode: requested,
				justification: justification as string,
				dialogue: dialogueFor(ctx),
			});
			emitNotice(
				ctx,
				formatAutoReviewNotice(outcome),
				outcome.decision === "ALLOW" ? "info" : "warning",
			);
			if (outcome.decision === "ALLOW") {
				return {
					mode: requested as SandboxMode,
					escalated: true,
					ignoredEscalation: false,
				};
			}
			// denialReason は画面通知だけ。ツールエラーに入れるとエージェントが読んでしまう。
			throw new Error(
				autoReviewDeniedMessage(subject, requested, outcome.cause),
			);
		}
	}
	const mode = await approveEscalation(
		{
			requestedMode: requested,
			justification: justification as string,
			effectiveMode: effective,
			subject,
			summary: summary().slice(0, 200),
		},
		approvalChannelFor(ctx, signal),
	);
	return { mode, escalated: mode !== effective, ignoredEscalation: false };
}

function autoReviewDeniedMessage(
	subject: "command" | "operation",
	requested: string,
	cause: string,
): string {
	if (cause === "deny") {
		return `the auto-reviewer rejected escalating this ${subject} to "${requested}"; it stays denied, so stop and explain instead of working around it — do not retry with a different mode or a rewritten command`;
	}
	if (cause === "aborted") {
		return `approval for escalating to "${requested}" was cancelled — nothing was executed`;
	}
	return `auto-review denied escalating this ${subject} to "${requested}" (${cause}) — nothing was executed. Stop and explain instead of working around it.`;
}

function emitNotice(
	ctx: ToolCtxLike,
	message: string,
	level: "info" | "warning",
): void {
	let notified = false;
	if (ctx.hasUI && typeof ctx.ui.notify === "function") {
		try {
			ctx.ui.notify(message, level);
			notified = true;
		} catch {
			notified = false;
		}
	}
	if (!notified) {
		try {
			console.warn(message);
		} catch {
			// 通知失敗でも判断は緩めない。
		}
	}
}

async function completeReview(
	ctx: ToolCtxLike,
	model: ReviewerModelRef,
	request: {
		systemPrompt: string;
		userText: string;
		thinkingLevel: string;
		signal: AbortSignal;
	},
): Promise<ReviewerResponse> {
	// メソッドを取り出して呼ぶと this が外れ、ModelRegistry.complete は即 TypeError になる。
	const registry = ctx.modelRegistry;
	if (registry === undefined || typeof registry.complete !== "function") {
		throw new Error("reviewer runtime is unavailable");
	}
	const message = await registry.complete(
		model,
		{
			systemPrompt: request.systemPrompt,
			messages: [
				{ role: "user", content: request.userText, timestamp: Date.now() },
			],
		},
		{
			reasoning:
				request.thinkingLevel === "off" ? undefined : request.thinkingLevel,
			signal: request.signal,
		},
	);
	const parts = message.content ?? [];
	return {
		text: parts
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join(""),
		hasNonTextContent: parts.some(
			(part) => part.type !== "text" && part.type !== "thinking",
		),
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
	};
}

/** Compatibility wrapper: existing callers and rulings assert the bare mode (one-shot escalation semantics unchanged, Review Focus #5). */
export async function resolveCallMode(
	params: EscalationParams,
	ctx: ToolCtxLike,
	deps: SandboxToolDeps,
	subject: "command" | "operation",
	summary: () => string,
	signal?: AbortSignal,
	tool?: string,
): Promise<SandboxMode> {
	return (await resolveCall(params, ctx, deps, subject, summary, signal, tool))
		.mode;
}

/** Ruling 15: object spread keeps the base schema's own options (such as additionalProperties:false on editSchema). */
function extendParams(base: TSchema): TSchema {
	const b = base as unknown as { properties: Record<string, unknown> };
	return {
		...base,
		properties: { ...b.properties, ...ESCALATION_PROPS },
	} as TSchema;
}

/**
 * `prepareArguments` chain: the base hook runs first, placeholder stripping after.
 * The base side must not be dropped—pi's built-in edit `prepareEditArguments` normalizes legacy `oldText`/`newText` → `edits`,
 * and writing our own `prepareArguments` directly would silently override it (a regression in legacy input compatibility); bash/write have no hook on the pi side yet,
 * and once it is a chain, a future base hook takes effect automatically.
 * Host contract (complements the stripEscalationPlaceholders comment in src/escalation.ts): pi's
 * `prepareToolCallArguments` runs before `validateToolArguments` (true on both 0.80.2 and 1.0.0), so stripping takes effect before validation.
 */
function withPlaceholderStripping<T>(
	base: ((args: unknown) => T) | undefined,
): (args: unknown) => T {
	return (args: unknown): T =>
		stripEscalationPlaceholders(base === undefined ? args : base(args)) as T;
}

/**
 * Prompt budget (β′, cost per request is bounded):
 * - `tool.description` and the parameter schema enter the request **per tool** → the same sentence written into bash/write/edit is paid for 3 times;
 * - `promptGuidelines` enter the system prompt's rules, and pi dedupes by string (`buildRules`'s seen set) → paid for once.
 * So: a cross-tool rule stays as one sentence (ESCALATION_GUIDELINE plus this one SANDBOX_NOTE), and protocol detail always lives on the on-demand surface
 * (denial hint / validation error / post-approval marker).
 */
const SANDBOX_NOTE =
	"Sandbox: confined to the current mode; workspace-write already allows the workspace and /tmp. Unless retrying a denial, omit these fields or send JSON null.";

function escalationDescription(base: string): string {
	return [base, "", SANDBOX_NOTE].join("\n");
}

/** Append one on-demand line of feedback after approval (every other field is kept as-is). */
function withEscalationNote<T>(
	result: AgentToolResult<T>,
	mode: SandboxMode,
): AgentToolResult<T> {
	return {
		...result,
		content: [
			...result.content,
			{ type: "text", text: escalationAppliedMarker(mode) },
		],
	};
}

/** On-demand feedback appended when the denial-first gate ignores an escalation (every other field is kept as-is).
 *  Known boundary: it is delivered only with a successful result—a non-zero bash exit throws (pi's error path does not go through execute's return value),
 *  and in that case the model can still retry correctly from the escalation hint delivered with the error (the real denial was recorded, so the retry opens a dialog). */
function withIgnoredEscalationNote<T>(
	result: AgentToolResult<T>,
	mode: SandboxMode,
): AgentToolResult<T> {
	return {
		...result,
		content: [
			...result.content,
			{ type: "text", text: escalationIgnoredMarker(mode) },
		],
	};
}

const DIRECTORY_GRANT_GUIDELINE =
	"Call sandbox_grant_write alone only when later calls in this request will write the directory named in the denial hint again. Pass that directory, not a parent of it, with a one-sentence justification, then retry. One use of the directory is not enough. If the hint names no directory, do not call it.";

const ESCALATION_GUIDELINE =
	'When the denied call uses a directory only once, or the denial hint names no single directory, retry the exact same call once with sandbox_permissions "danger-full-access" and a justification. Escalation is denial-first and one-shot: it must match that denied operation, and the configured approval mode (human, auto-review, or allow-all) decides it. Never send escalation fields before a denial — such requests are ignored and the call runs confined. If denied or unavailable, stop and explain instead of working around it.';

function sandboxGuidelines(base: readonly string[] | undefined): string[] {
	return [...(base ?? []), DIRECTORY_GRANT_GUIDELINE, ESCALATION_GUIDELINE];
}

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}

function grantDeniedMessage(directory: string, cause: string): string {
	if (cause === "deny") {
		return `the auto-reviewer rejected the directory grant for "${directory}"; nothing was granted, so stop and explain instead of working around it — do not retry with a broader directory`;
	}
	if (cause === "aborted")
		return "approval for the directory grant was cancelled — nothing was granted";
	return `auto-review denied the directory grant for "${directory}" (${cause}) — nothing was granted. Stop and explain instead of working around it.`;
}

/** The same approval modes as mode escalation (human / auto-review / allow-all). A bad config is a denial, not a drop to allow-all. */
async function approveDirectoryGrant(args: {
	ctx: ToolCtxLike;
	deps: SandboxToolDeps;
	signal: AbortSignal | undefined;
	directory: string;
	justification: string;
	mode: SandboxMode;
	workspace: string;
	backend: string;
	writablePaths: readonly string[];
	denials: readonly DenialRecord[];
}): Promise<void> {
	const approval = selectApprovalSettings(
		configForCall(args.deps, args.ctx.cwd ?? args.deps.cwd),
		readProjectTrusted(args.ctx),
	);
	if (approval.approvalInvalid) {
		throw new Error(
			"sandbox_grant_write was denied because the approval config is invalid — nothing was granted. Fix approvalMode / autoReview.model / autoReview.thinkingLevel in pi-sandbox.json.",
		);
	}
	if (approval.approvalMode === "allow-all") return;
	if (approval.approvalMode === "auto-review") {
		const outcome = await reviewDirectoryGrant({
			settings: approval,
			activeModel: args.ctx.model,
			activeThinkingLevel: args.ctx.thinkingLevel,
			findModel: (provider, id) => args.ctx.modelRegistry?.find(provider, id),
			hasAuth:
				args.ctx.modelRegistry?.hasConfiguredAuth === undefined
					? undefined
					: (model) =>
							args.ctx.modelRegistry?.hasConfiguredAuth?.(model) ?? false,
			complete: (model, request) => completeReview(args.ctx, model, request),
			warn: (message) => emitNotice(args.ctx, message, "warning"),
			signal: args.signal,
			dialogue: dialogueFor(args.ctx),
			grant: {
				backend: args.backend,
				mode: args.mode,
				workspace: args.workspace,
				writablePaths: args.writablePaths,
				directory: args.directory,
				justification: args.justification,
				denials: args.denials,
			},
		});
		emitNotice(
			args.ctx,
			formatAutoReviewNotice(outcome),
			outcome.decision === "ALLOW" ? "info" : "warning",
		);
		if (outcome.decision === "ALLOW") return;
		throw new Error(grantDeniedMessage(args.directory, outcome.cause));
	}
	const decision = await approvalChannelFor(args.ctx, args.signal).ask(
		[
			"Sandbox directory grant: allow writes under this directory until this request ends?",
			"",
			`Directory: ${args.directory}`,
			`Reason: ${args.justification}`,
			"Every later tool call in this run can write this directory. The grant is cleared when this request ends or the next user message starts.",
		].join("\n"),
		[...ESCALATION_OPTIONS],
		DENIAL_REASON_PROMPT,
	);
	if (decision.choice === undefined) {
		throw new Error(
			"approval for the directory grant was cancelled — nothing was granted",
		);
	}
	if (decision.choice === "Deny") {
		const reason = sanitizeDenialReason(decision.reason);
		const suffix = reason === undefined ? "" : `. The user's reason: ${reason}`;
		throw new Error(
			`the user rejected the directory grant for "${args.directory}"; nothing was granted, so stop and explain instead of working around it — do not retry with a broader directory${suffix}`,
		);
	}
}

function stripEscalation(params: Record<string, unknown>) {
	const { sandbox_permissions: _sp, justification: _just, ...rest } = params;
	return rest;
}

/** The fence moved to the ops layer (Ruling 14): pi's execute resolves with resolveToCwd and passes absolutePath to ops,
 *  and the fence checks that same string that will be written—constructively the same as the write, so a ~/ , @/ , or file:// parse disagreement cannot bypass it.
 *  readFile/access are reads and have no fence (every mode allows all reads). */
function createFencedWriteOps(
	policy: FencePolicy,
	onDenial?: (details: { path: string; message: string }) => void,
	filePath?: () => string | null,
): WriteOperations {
	const guard = (path: string, asDirectory = false): void => {
		try {
			assertWriteAllowed(path, policy, asDirectory);
		} catch (error) {
			if (error instanceof FenceDenialError)
				onDenial?.({ path, message: error.message });
			throw error;
		}
	};
	return {
		writeFile: async (path, content) => {
			guard(path);
			await fsWriteFile(path, content, "utf-8");
		},
		// pi's write mkdir's dirname(file) first. When that step is denied, the model and the reviewer must still see the file,
		// or "create the parent directory for the file" is treated as "change the directory itself" and denied.
		mkdir: async (dir) => {
			try {
				assertWriteAllowed(dir, policy, true);
			} catch (error) {
				if (!(error instanceof FenceDenialError)) throw error;
				const reported = filePath?.() ?? dir;
				const fileError =
					reported === dir
						? error
						: new FenceDenialError(
								reported,
								policy.mode,
								policy.customRunner === true,
								false,
							);
				onDenial?.({ path: reported, message: fileError.message });
				throw fileError;
			}
			await fsMkdir(dir, { recursive: true });
		},
	};
}

function createFencedEditOps(
	policy: FencePolicy,
	onDenial?: (details: { path: string; message: string }) => void,
): EditOperations {
	const guard = (path: string): void => {
		try {
			assertWriteAllowed(path, policy);
		} catch (error) {
			if (error instanceof FenceDenialError)
				onDenial?.({ path, message: error.message });
			throw error;
		}
	};
	return {
		readFile: (path) => fsReadFile(path),
		access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
		writeFile: async (path, content) => {
			guard(path);
			await fsWriteFile(path, content, "utf-8");
		},
	};
}

export function createSandboxTools(deps: SandboxToolDeps) {
	// Resolve the host platform once: the pwsh registration gate and the platform injected into shell ops share this value.
	const platform = deps.platform ?? process.platform;
	// Test injection wins; production defaults to the real createSandboxBashOps.
	const buildBashOps = deps._buildBashOps ?? createSandboxBashOps;
	// pwsh override (spec §4.8): assemble only on win32 and only when the host actually exports the factory; otherwise undefined.
	let createHostPowerShell: HostCreatePowerShellToolDefinition | undefined;
	if (platform === "win32") {
		const candidate =
			deps._hostCreatePowerShellToolDefinition ??
			hostCreatePowerShellToolDefinition();
		if (typeof candidate === "function")
			createHostPowerShell = candidate as HostCreatePowerShellToolDefinition;
	}
	// Ruling 15: the definition factory is the base—it brings promptSnippet/promptGuidelines,
	// execute's 5th argument ctx is correctly typed (ExtensionContext), and registration after the spread does not drop system-prompt metadata.
	const baseBash = createBashToolDefinition(deps.cwd);
	const baseWrite = createWriteToolDefinition(deps.cwd);
	const baseEdit = createEditToolDefinition(deps.cwd);
	// pwsh's base is used only for metadata (label/description/schema/prepareArguments); execute is replaced by the wrapper below;
	// as with bash, the builder reassembles confined ops for the current mode at execute time.
	// I2 fail-safe: a throw during construction degrades to "no pwsh override" and must never bubble out of createSandboxTools (the fail-open guard).
	const basePowerShell = buildHostPowerShellBase(
		createHostPowerShell,
		deps.cwd,
	);

	const extraRootsFor = (sessionId: string | null): readonly string[] =>
		sessionId === null ? [] : getWritableGrants().list(sessionId);
	const recordDenial = (
		entry: Omit<DenialRecord, "recordedAt" | "writablePaths">,
	): void => {
		const paths = writableRoots(
			entry.sandboxMode,
			entry.workspace,
			deps._tmpRoots ?? defaultTmpRoots(),
			extraRootsFor(entry.sessionId),
		);
		getDenialLedger().record({
			...entry,
			writablePaths: paths,
			recordedAt: Date.now(),
		});
	};
	const backendName = (mode: SandboxMode, config: SandboxConfig): string => {
		if (mode === "danger-full-access") return "bypassed";
		if ((config.runnerCommand?.length ?? 0) > 0) return "custom";
		return (deps.selected ?? selectRunner(config.probeTimeoutMs, deps.hooks))
			.runner;
	};

	// Windows tool assembly (spec D3 third revision, confirmed against pi 1.0.0 source): on win32 bash must be "registered but unreachable by the model".
	// Two generations of lessons about the mechanism:
	//   (1) `defaultActive: false` is **ineffective** (falsified on a real machine): pi 1.0.0's _buildRuntime hardcodes the default active names as
	//      ["read","bash","edit","write"] (agent-session.js:2889-2893), and _refreshToolRegistry activates the same-named tool from the registry **by name**;
	//      the meaning of `defaultActive:false` is exactly "activate when named"
	//      (_isActivatedOnRegistration, types.d.ts:471-475)—the same-named bash this package registers still enters the active set.
	//   (2) The correct fix is `exposure: "hidden"`: _applyToolLoadout **drops** hidden when building the declared set
	//      (agent-session.js:1124), and _isDeclarable returns false for hidden → neither automatic activation nor activation by name
	//      (defaultTools / --tools / setActiveTools) takes effect; pi's docs: hidden = registered but unreachable.
	// It is also **never** acceptable to "not register bash on win32": an extension tool overrides the built-in definition by name (registry.set), and not registering would expose
	// pi's built-in unrestricted bash, so an explicit enable is fail-open. Registering plus hidden hides the name and keeps it unreachable by the model, with no fail-open path.
	// Off win32 the key is not set: bash must stay active by default (existing behavior unchanged).
	const bash = {
		...baseBash,
		...(platform === "win32" ? { exposure: "hidden" as const } : {}),
		label: `${baseBash.label} (sandboxed)`,
		description: escalationDescription(baseBash.description),
		promptGuidelines: sandboxGuidelines(baseBash.promptGuidelines),
		parameters: extendParams(baseBash.parameters),
		prepareArguments: withPlaceholderStripping(baseBash.prepareArguments),
		async execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const sessionCwd = (ctx as { cwd?: string }).cwd ?? deps.cwd;
			const workspaceRoot = workspaceRootFor(sessionCwd);
			const config = configForCall(deps, sessionCwd);
			const sessionId = readSessionId(ctx);
			const extraRoots = extraRootsFor(sessionId);
			const { mode, escalated, ignoredEscalation } = await resolveCall(
				params as EscalationParams,
				ctx,
				deps,
				"command",
				() => String(params.command ?? ""),
				signal,
				"bash",
			);
			// M3: when a custom runnerCommand is configured, skip chain probing (confine uses runnerCommand directly).
			const selected =
				mode === "danger-full-access" || (config.runnerCommand?.length ?? 0) > 0
					? undefined
					: (deps.selected ?? selectRunner(config.probeTimeoutMs, deps.hooks));
			const tool = createBashToolDefinition(sessionCwd, {
				operations: buildBashOps({
					mode,
					workspaceRoot,
					selected,
					platform,
					runnerCommand: config.runnerCommand,
					runnerFailureSignatures: config.runnerFailureSignatures,
					probeTimeoutMs: config.probeTimeoutMs,
					hooks: deps.hooks,
					spawnFn: deps.spawnFn,
					extraRoots,
					onDenial:
						sessionId === null
							? undefined
							: (details) =>
									recordDenial({
										sessionId,
										tool: "bash",
										fingerprint: operationFingerprint(params),
										cwd: sessionCwd,
										workspace: workspaceRoot,
										sandboxMode: mode,
										backend: backendName(mode, config),
										target: String(params.command ?? ""),
										exitCode: details.exitCode,
										stdout: details.stdout,
										stderr: details.stderr,
									}),
				}),
			});
			const result = await tool.execute(
				toolCallId,
				stripEscalation(params) as never,
				signal,
				onUpdate as never,
				ctx as never,
			);
			if (ignoredEscalation) return withIgnoredEscalationNote(result, mode);
			return escalated ? withEscalationNote(result, mode) : result;
		},
	};

	const write = {
		...baseWrite,
		label: `${baseWrite.label} (sandboxed)`,
		description: escalationDescription(baseWrite.description),
		promptGuidelines: sandboxGuidelines(baseWrite.promptGuidelines),
		parameters: extendParams(baseWrite.parameters),
		prepareArguments: withPlaceholderStripping(baseWrite.prepareArguments),
		async execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const sessionCwd = (ctx as { cwd?: string }).cwd ?? deps.cwd;
			const workspaceRoot = workspaceRootFor(sessionCwd);
			const sessionId = readSessionId(ctx);
			const extraRoots = extraRootsFor(sessionId);
			const { mode, escalated, ignoredEscalation } = await resolveCall(
				params as EscalationParams,
				ctx,
				deps,
				"operation",
				() => String(params.path ?? ""),
				signal,
				"write",
			);
			// Do not catch a fence denial: FenceDenialError is thrown from ops and rethrown as-is through pi's execute
			// (withFileMutationQueue does not swallow errors)—pi's agent loop turns it into an error result.
			const config = configForCall(deps, sessionCwd);
			const tool = createWriteToolDefinition(sessionCwd, {
				operations: createFencedWriteOps(
					{
						mode,
						workspaceRoot,
						_tmpRoots: deps._tmpRoots,
						extraRoots,
						customRunner: (config.runnerCommand?.length ?? 0) > 0,
					},
					sessionId === null
						? undefined
						: (details) =>
								recordDenial({
									sessionId,
									tool: "write",
									fingerprint: operationFingerprint(params),
									cwd: sessionCwd,
									workspace: workspaceRoot,
									sandboxMode: mode,
									backend: backendName(mode, config),
									target: details.path,
									error: details.message,
								}),
					() => {
						const raw = typeof params.path === "string" ? params.path : "";
						if (raw.trim().length === 0) return null;
						return resolveGrantRequest(raw, sessionCwd);
					},
				),
			});
			const result = await tool.execute(
				toolCallId,
				stripEscalation(params) as never,
				signal,
				onUpdate as never,
				ctx as never,
			);
			if (ignoredEscalation) return withIgnoredEscalationNote(result, mode);
			return escalated ? withEscalationNote(result, mode) : result;
		},
	};

	const edit = {
		...baseEdit,
		label: `${baseEdit.label} (sandboxed)`,
		description: escalationDescription(baseEdit.description),
		promptGuidelines: sandboxGuidelines(baseEdit.promptGuidelines),
		parameters: extendParams(baseEdit.parameters),
		prepareArguments: withPlaceholderStripping(baseEdit.prepareArguments),
		async execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const sessionCwd = (ctx as { cwd?: string }).cwd ?? deps.cwd;
			const workspaceRoot = workspaceRootFor(sessionCwd);
			const sessionId = readSessionId(ctx);
			const extraRoots = extraRootsFor(sessionId);
			const { mode, escalated, ignoredEscalation } = await resolveCall(
				params as EscalationParams,
				ctx,
				deps,
				"operation",
				() => String(params.path ?? ""),
				signal,
				"edit",
			);
			const config = configForCall(deps, sessionCwd);
			const tool = createEditToolDefinition(sessionCwd, {
				operations: createFencedEditOps(
					{
						mode,
						workspaceRoot,
						_tmpRoots: deps._tmpRoots,
						extraRoots,
						customRunner: (config.runnerCommand?.length ?? 0) > 0,
					},
					sessionId === null
						? undefined
						: (details) =>
								recordDenial({
									sessionId,
									tool: "edit",
									fingerprint: operationFingerprint(params),
									cwd: sessionCwd,
									workspace: workspaceRoot,
									sandboxMode: mode,
									backend: backendName(mode, config),
									target: details.path,
									error: details.message,
								}),
				),
			});
			const result = await tool.execute(
				toolCallId,
				stripEscalation(params) as never,
				signal,
				onUpdate as never,
				ctx as never,
			);
			if (ignoredEscalation) return withIgnoredEscalationNote(result, mode);
			return escalated ? withEscalationNote(result, mode) : result;
		},
	};

	const powershellBuilder = createHostPowerShell;
	const powershell =
		basePowerShell === undefined || powershellBuilder === undefined
			? undefined
			: {
					...basePowerShell,
					label: `${basePowerShell.label} (sandboxed)`,
					description: escalationDescription(basePowerShell.description),
					promptGuidelines: sandboxGuidelines(basePowerShell.promptGuidelines),
					parameters: extendParams(basePowerShell.parameters),
					prepareArguments: withPlaceholderStripping(
						basePowerShell.prepareArguments,
					),
					async execute(
						toolCallId: string,
						params: Record<string, unknown>,
						signal: AbortSignal | undefined,
						onUpdate: unknown,
						ctx: ExtensionContext,
					) {
						// The same path as bash: the same sessionCwd resolution, the same resolveCall (subject is command), the same ledger recording,
						// and the same prepareArguments / argument stripping and same-mode escalation marker.
						const sessionCwd = (ctx as { cwd?: string }).cwd ?? deps.cwd;
						const workspaceRoot = workspaceRootFor(sessionCwd);
						const config = configForCall(deps, sessionCwd);
						const sessionId = readSessionId(ctx);
						const extraRoots = extraRootsFor(sessionId);
						const { mode, escalated, ignoredEscalation } = await resolveCall(
							params as EscalationParams,
							ctx,
							deps,
							"command",
							() => String(params.command ?? ""),
							signal,
							"powershell",
						);
						const selected =
							mode === "danger-full-access" ||
							(config.runnerCommand?.length ?? 0) > 0
								? undefined
								: (deps.selected ??
									selectRunner(config.probeTimeoutMs, deps.hooks));
						const tool = powershellBuilder(sessionCwd, {
							operations: createSandboxPowerShellOps({
								mode,
								workspaceRoot,
								selected,
								platform,
								runnerCommand: config.runnerCommand,
								runnerFailureSignatures: config.runnerFailureSignatures,
								probeTimeoutMs: config.probeTimeoutMs,
								hooks: deps.hooks,
								spawnFn: deps.spawnFn,
								extraRoots,
								onDenial:
									sessionId === null
										? undefined
										: (details) =>
												recordDenial({
													sessionId,
													tool: "powershell",
													fingerprint: operationFingerprint(params),
													cwd: sessionCwd,
													workspace: workspaceRoot,
													sandboxMode: mode,
													backend: backendName(mode, config),
													target: String(params.command ?? ""),
													exitCode: details.exitCode,
													stdout: details.stdout,
													stderr: details.stderr,
												}),
							}),
						});
						const result = await tool.execute(
							toolCallId,
							stripEscalation(params) as never,
							signal,
							onUpdate as never,
							ctx as never,
						);
						if (ignoredEscalation)
							return withIgnoredEscalationNote(result, mode);
						return escalated ? withEscalationNote(result, mode) : result;
					},
				};

	const grantWrite = {
		name: "sandbox_grant_write",
		label: "Grant directory write",
		description: [
			"Make one directory writable for the rest of this user request.",
			"Call it alone, only after a sandbox denial named a path inside that directory, and only when later calls in this request will write there again. One use should retry the denied call with sandbox_permissions instead. Do not send it in parallel with the denied command.",
			"After it succeeds, retry the denied operation. Later tool calls in this run can write the directory. The grant is cleared when this request ends or the next user message starts.",
			"/, the home directory, and ancestors of home are rejected. A custom runner cannot accept extra directories.",
		].join("\n"),
		promptSnippet:
			"Grant write access to one directory until this request ends",
		promptGuidelines: sandboxGuidelines(undefined),
		executionMode: "sequential" as const,
		parameters: Type.Object({
			path: Type.String({
				description:
					"Directory to make writable. Not /, the home directory, or an ancestor of home.",
			}),
			justification: Type.String({
				description:
					"One sentence: why this directory must be writable to carry out the user's request.",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: { path?: string; justification?: string },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const sessionCwd = (ctx as { cwd?: string }).cwd ?? deps.cwd;
			const workspaceRoot = workspaceRootFor(sessionCwd);
			const config = configForCall(deps, sessionCwd);
			const sessionId = readSessionId(ctx);
			const effective = resolveEffectiveMode(
				deps.permission.override,
				config.mode,
			);
			if (effective === "danger-full-access") {
				return textResult(
					"sandbox_grant_write: the current mode is danger-full-access, which already allows this write. Nothing was added.",
				);
			}
			if ((config.runnerCommand?.length ?? 0) > 0) {
				throw new Error(
					"sandbox_grant_write cannot add a directory because a custom runnerCommand is configured — nothing was granted. Escalate the denied call with sandbox_permissions, or unset runnerCommand.",
				);
			}
			if (sessionId === null)
				throw new Error(
					"sandbox_grant_write requires a session id — nothing was granted.",
				);
			const rawPath = typeof params.path === "string" ? params.path : "";
			const justification =
				typeof params.justification === "string"
					? params.justification.trim()
					: "";
			if (rawPath.trim().length === 0)
				throw new Error(
					"sandbox_grant_write requires a directory path — nothing was granted.",
				);
			if (justification.length === 0)
				throw new Error(
					"sandbox_grant_write requires a one-sentence justification — nothing was granted.",
				);
			const requested = canonicalizeTarget(
				resolveGrantRequest(rawPath, sessionCwd),
			);
			assertCanCreateDirectory(requested);
			if (grantTooWide(requested)) {
				throw new Error(
					`sandbox_grant_write refuses ${requested} because it is /, the home directory, or an ancestor of home — nothing was granted. Escalate the denied call with sandbox_permissions "danger-full-access" and a justification.`,
				);
			}
			const roots = writableRoots(
				effective,
				workspaceRoot,
				deps._tmpRoots ?? defaultTmpRoots(),
				extraRootsFor(sessionId),
			);
			if (isWithinRoots(requested, roots)) {
				return textResult(
					`Directory ${requested} is already writable under the current sandbox. Nothing new was granted.`,
				);
			}
			const matching = getDenialLedger()
				.list(sessionId)
				.filter((record) => grantCoversDenial(requested, record));
			if (matching.length === 0) {
				throw new Error(
					`sandbox_grant_write was not approved — no sandbox denial in this session names a path inside ${requested}. Nothing was granted. Retry the write so the denial names the path, or escalate that call with sandbox_permissions.`,
				);
			}
			if (signal?.aborted)
				throw new Error(
					"approval for the directory grant was cancelled — nothing was granted",
				);
			await approveDirectoryGrant({
				ctx,
				deps,
				signal,
				directory: requested,
				justification,
				mode: effective,
				workspace: workspaceRoot,
				backend: backendName(effective, config),
				writablePaths: roots,
				denials: matching,
			});
			const created = createMissingGrantDirectories(requested);
			const real = canonicalPath(requested);
			getWritableGrants().grant(sessionId, real, created);
			return textResult(
				`Granted write access to ${real} until this request ends. Later tool calls in this run can write this directory. Retry the denied operation as its own call. The grant is cleared when this request ends or the next user message starts.`,
			);
		},
	};

	return { bash, write, edit, powershell, grantWrite };
}
