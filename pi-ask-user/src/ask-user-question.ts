import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { type OpenQuestionnaire, registerAnswerChannel } from "./answer-channel.ts";
import {
	COLLAPSE_KEY_OFF,
	formatKeySpecForDisplay,
	loadConfig,
	warnConfig,
	type AskUserQuestionConfig,
} from "./config.ts";
import {
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserBlockedEventPayload,
	type AskUserPromptEventPayload,
} from "./events.ts";
import { DEFAULT_PROMPT_GUIDELINES, DEFAULT_PROMPT_SNIPPET, DEFAULT_TOOL_DESCRIPTION } from "./guidance.ts";
// Static import is fine — rpc-fallback pulls only types + the i18n bridge,
// none of the ~560ms TUI render graph that QuestionnaireSession lazy-loads.
import {
	mustYieldInlineSlot,
	type Presentation,
	resolvePresentation,
	rowBudgetForHost,
	STACKED_OVERLAY_PRESENTATION,
	YIELD_TO_OVERLAY,
} from "./presentation.ts";
import { type DialogUI, hasDialogUI, runRpcQuestionnaire } from "./rpc-fallback.ts";
import { createQuestionWait } from "./question-wait.ts";
import { displayLabel, t } from "./state/i18n-bridge.ts";
import { sentinelsToAppend } from "./state/row-intent.ts";
import { normalizeQuestionParams, prepareQuestionArguments } from "./tool/normalize-params.ts";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.ts";
import {
	type QuestionData,
	type QuestionnaireError,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./tool/types.ts";
import { validateQuestionnaire } from "./tool/validate-questionnaire.ts";
import type { WrappingSelectItem } from "./view/components/wrapping-select.ts";

function emitAskUserPromptEvent(pi: ExtensionAPI, params: QuestionParams, toolCallId: string): void {
	const payload: AskUserPromptEventPayload = {
		toolCallId,
		questions: params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			multiSelect: q.multiSelect ?? false,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				hasPreview: typeof o.preview === "string" && o.preview.length > 0,
			})),
		})),
	};
	pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
}

function emitAskUserBlockedEvent(pi: ExtensionAPI, active: boolean, toolCallId: string): void {
	const payload: AskUserBlockedEventPayload = { active, toolCallId };
	pi.events.emit(ASK_USER_BLOCKED_EVENT, payload);
}

/** Non-interactive host backstop (the reconciler normally strips the tool first). */
function rejectWithoutUi() {
	return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });
}

/** Sequential native-dialog walker for RPC hosts; brackets it with the blocked-event pair + terminal bell. */
async function runRpcPath(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	ui: DialogUI,
	typed: QuestionParams,
	toolCallId: string,
	config: AskUserQuestionConfig,
) {
	emitAskUserBlockedEvent(pi, true, toolCallId);
	const wait = createQuestionWait({
		timeoutMs: config.timeoutSeconds === null ? null : config.timeoutSeconds * 1000,
		ctx,
		onFire: () => undefined,
		onChange: () => undefined,
	});
	try {
		emitTerminalAttention();
		wait.begin();
		const result = await runRpcQuestionnaire(ui, typed, {
			signal: wait.signal,
			timeoutMs: () => wait.hostTimeoutMs(),
		});
		if (wait.signal.aborted) {
			return buildQuestionnaireResponse({ ...result, cancelled: false, timedOut: true }, typed);
		}
		return buildQuestionnaireResponse(result, typed);
	} finally {
		wait.dispose();
		emitAskUserBlockedEvent(pi, false, toolCallId);
	}
}

/** Canonical tool name — single source of truth shared with the reconcile module. */
export const ASK_USER_TOOL_NAME = "ask_user";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

const ERROR_NO_CUSTOM_UI =
	"Error: this client cannot render the questionnaire (custom UI is unavailable, e.g. RPC/ACP hosts such as Zed or Paseo). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.";

const ERROR_SESSION_LOAD_FAILED =
	"Error: the questionnaire UI failed to load — the host's installed dependencies were likely replaced or removed on disk while Pi was running (e.g. a package-manager install touched the store). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user that restoring this tool requires repairing the install if needed and restarting Pi.";

const ERROR_STALE_MODULE_CACHE =
	"Error: the questionnaire UI cannot load — the host's module cache went stale after an earlier failed load (typically dependencies replaced on disk mid-session). This is unrecoverable within the current Pi process. The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user to restart Pi to restore this tool.";

/** Standard terminal bell — same byte rpiv-warp exports as OSC_TERMINATOR. */
export const BEL = "\x07";

/**
 * Emit one portable terminal attention signal without touching redirected output.
 * Writes to stdout rather than rpiv-warp's `/dev/tty` transport: the `isTTY` gate
 * both proves an interactive terminal owns the coming wait and keeps the byte out
 * of piped RPC transports (VS Code pendant, Zed) — a `/dev/tty` write would ring
 * even when the questionnaire renders in a remote host's own UI.
 */
function emitTerminalAttention(): void {
	try {
		if (process.stdout.isTTY) process.stdout.write(BEL);
	} catch {
		// Terminal attention is best effort; the questionnaire must still proceed.
	}
}

/** Delay before the background session-graph pre-warm; mirrors rpiv-workflow's /wf prewarm. */
export const PREWARM_DELAY_MS = 2000;

type SessionModule = typeof import("./state/questionnaire-session.ts");

type SessionRef = { current: import("./state/questionnaire-session.ts").QuestionnaireSession | null };
type OverlayHandleRef = { current: OverlayHandle | undefined };

type SessionLoad =
	| { ok: true; module: SessionModule }
	| { ok: false; error: Extract<QuestionnaireError, "session_load_failed" | "stale_module_cache">; message: string };

/**
 * Lazy-load the ~560ms QuestionnaireSession view/TUI render graph, guarding
 * the two failure shapes of issue #107. Pi's jiti loader registers a module in
 * its graph cache BEFORE evaluating the body and does not evict it when
 * evaluation throws (jiti 2.7.0), so one failed load — e.g. `pnpm install
 * --force` replacing the store entry mid-session — leaves every later import
 * of this specifier resolving to a namespace without the class. That state is
 * unrecoverable in-process (cache-busting specifiers fail jiti resolution);
 * both branches therefore return an LLM-facing envelope that names the restart
 * requirement instead of leaking a bare "not a constructor" TypeError.
 */
export async function loadQuestionnaireSession(): Promise<SessionLoad> {
	let mod: SessionModule;
	try {
		mod = await import("./state/questionnaire-session.ts");
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		return { ok: false, error: "session_load_failed", message: `${ERROR_SESSION_LOAD_FAILED} (cause: ${cause})` };
	}
	if (typeof mod.QuestionnaireSession !== "function") {
		const keys = JSON.stringify(Object.keys(mod));
		return {
			ok: false,
			error: "stale_module_cache",
			message: `${ERROR_STALE_MODULE_CACHE} (resolved namespace keys: ${keys})`,
		};
	}
	return { ok: true, module: mod };
}

/**
 * Register the raw terminal listener that toggles collapse while the overlay is hidden.
 * Returns the remover, or undefined when the key is off / the host has no raw input hook —
 * callers derive `canReopenWhileHidden` from that.
 */
function registerCollapseKeyListener(
	ctx: ExtensionContext,
	collapseKey: string,
	sessionRef: SessionRef,
	overlayHandleRef: OverlayHandleRef,
): (() => void) | undefined {
	if (collapseKey === COLLAPSE_KEY_OFF || typeof ctx.ui.onTerminalInput !== "function") return undefined;
	let hasAnnouncedHide = false;
	return ctx.ui.onTerminalInput((data) => {
		const handle = overlayHandleRef.current;
		if (!handle) return undefined;
		// Only act while the questionnaire is hidden (its handleInput is
		// unreachable) or actually focused. When some other overlay is on
		// top (e.g. `/btw`), leave the keystroke to that overlay instead of
		// toggling the questionnaire from underneath it.
		if (!handle.isHidden() && !handle.isFocused()) return undefined;
		if (!matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])) return undefined;
		// Kitty-protocol terminals report press, repeat, and release separately.
		// Toggle only on the initial press so a tap does not immediately reopen
		// the overlay and a held key does not toggle it repeatedly.
		if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
		sessionRef.current?.toggleCollapsedExternal();
		if (handle.isHidden() && !hasAnnouncedHide) {
			hasAnnouncedHide = true;
			ctx.ui.notify?.(`ask_user hidden — press ${formatKeySpecForDisplay(collapseKey)} to reopen`, "info");
		}
		return { consume: true };
	});
}

/**
 * Build the `ctx.ui.custom` component factory: constructs the session (capturing it in
 * `sessionRef`) and exposes its component. `editInput` keeps its two dynamic imports —
 * they must stay lazy per-invocation.
 */
function makeSessionFactory(config: {
	ctx: ExtensionContext;
	typed: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	collapseKey: string;
	canReopenWhileHidden: boolean;
	presentation: Presentation;
	sessionRef: SessionRef;
	open: OpenQuestionnaire;
	Session: SessionModule["QuestionnaireSession"];
	getWaitPhase: () => { phase: import("./idle-deadline.ts").DeadlinePhase; remainingMs: number | null };
	onActivity: () => void;
	beginWait: (tui: TUI) => void;
}) {
	const {
		ctx,
		typed,
		itemsByTab,
		collapseKey,
		canReopenWhileHidden,
		presentation,
		sessionRef,
		open,
		Session,
		getWaitPhase,
		onActivity,
		beginWait,
	} = config;
	return (
		tui: TUI,
		theme: Theme,
		keybindings: import("./state/questionnaire-session.ts").QuestionnaireSessionConfig["keybindings"],
		done: (result: QuestionnaireResult) => void,
	): import("./state/questionnaire-session.ts").QuestionnaireSessionComponent => {
		// The factory runs at mount time — the first point the TUI is reachable — so this is
		// where an inline mount notices an overlay already on screen and gives the slot up.
		if (!presentation.overlay && mustYieldInlineSlot(tui)) {
			done(YIELD_TO_OVERLAY);
			return INERT_COMPONENT;
		}
		// Answered from outside before this mount (a host may mount late, e.g. a lane
		// console): close at once with that answer.
		if (open.settled) {
			done(open.settled);
			return INERT_COMPONENT;
		}
		open.attach(done);
		const session = new Session({
			tui,
			theme,
			params: typed,
			itemsByTab,
			// Through the first-answer-wins gate shared with inbound answers.
			done: (result) => open.settle(result),
			keybindings,
			editInput: async (value) => {
				try {
					const [{ SettingsManager }, { editWithExternalEditor }] = await Promise.all([
						import("@earendil-works/pi-coding-agent"),
						import("./state/external-editor.ts"),
					]);
					const editorCommand = SettingsManager.create(ctx.cwd, undefined, {
						projectTrusted: ctx.isProjectTrusted(),
					}).getExternalEditorCommand();
					if (!editorCommand) throw new Error("No external editor command is configured");
					return await editWithExternalEditor(tui, editorCommand, value);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`${t("editor.failed", "External editor failed")}: ${message}`, "error");
					return undefined;
				}
			},
			collapseKey,
			canReopenWhileHidden,
			rowBudget: rowBudgetForHost(tui.terminal, presentation.rowBudget),
			getWaitPhase,
			onActivity,
		});
		sessionRef.current = session;
		beginWait(tui);
		return session.component;
	};
}

/** Stand-in returned by a mount that resolved before mounting (Pi discards it unmounted). */
const INERT_COMPONENT: import("./state/questionnaire-session.ts").QuestionnaireSessionComponent = {
	render: () => [],
	invalidate: () => {},
	handleInput: () => {},
};

/**
 * One `ctx.ui.custom` mount under `presentation`. The overlay additionally gets its handle
 * captured (so collapse can `setHidden()`) and a raw terminal listener for the collapse key,
 * which stays reachable while the overlay is hidden (pi-tui routes no input to a hidden
 * overlay's `component.handleInput`). Inline has no handle to hide and keeps focus while
 * collapsed, so it needs no listener.
 */
async function mountQuestionnaire(config: {
	ctx: ExtensionContext;
	typed: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	collapseKey: string;
	presentation: Presentation;
	open: OpenQuestionnaire;
	Session: SessionModule["QuestionnaireSession"];
	getWaitPhase: () => { phase: import("./idle-deadline.ts").DeadlinePhase; remainingMs: number | null };
	onActivity: () => void;
	beginWait: (tui: TUI) => void;
	sessionRef: SessionRef;
}): Promise<QuestionnaireResult | undefined> {
	const { ctx, collapseKey, presentation, sessionRef } = config;
	const overlayHandleRef: OverlayHandleRef = { current: undefined };
	const removeOverlayInputListener = presentation.hideOnCollapse
		? registerCollapseKeyListener(ctx, collapseKey, sessionRef, overlayHandleRef)
		: undefined;
	// Hiding the overlay is only reversible through the raw listener above, so the session
	// may emit `setHidden` only when it was actually registered; otherwise collapse falls
	// back to the visible one-line row.
	const canReopenWhileHidden = removeOverlayInputListener !== undefined;
	try {
		return await ctx.ui.custom<QuestionnaireResult>(
			makeSessionFactory({ ...config, canReopenWhileHidden, sessionRef }),
			presentation.overlay
				? {
						overlay: true,
						overlayOptions: {
							anchor: "bottom-center",
							width: "100%",
							maxHeight: "100%",
							margin: { left: 0, right: 0, bottom: 0 },
						},
						onHandle: (handle) => {
							overlayHandleRef.current = handle;
							sessionRef.current?.setOverlayHandle(handle);
						},
					}
				: { overlay: false },
		);
	} finally {
		removeOverlayInputListener?.();
	}
}

/**
 * The terminal dialog: inline in Pi's editor slot, or an overlay (see presentation.ts).
 * Each mount races `open.answeredEarly`, so an inbound answer accepted before any dialog
 * took it ends the call — a host that mounts later closes the dialog on sight (factory).
 */
async function runTuiPath(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	typed: QuestionParams,
	open: OpenQuestionnaire,
	config: AskUserQuestionConfig,
) {
	const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));
	let presentation: Presentation | undefined;
	const sessionRef: SessionRef = { current: null };
	const wait = createQuestionWait({
		timeoutMs: config.timeoutSeconds === null ? null : config.timeoutSeconds * 1000,
		ctx,
		onFire: () => {
			const result = sessionRef.current?.snapshotTimedOut() ?? { answers: [], cancelled: false, timedOut: true };
			open.settle(result);
		},
		onChange: () => sessionRef.current?.refresh(),
	});
	const waitBindings = {
		getWaitPhase: () => wait.phase(),
		onActivity: () => wait.lift(),
		beginWait: (tui: TUI) => wait.begin(tui),
	};

	// Bracketed from before the load: every prompt event is followed by exactly one
	// `{ active: false }` for its tool call, however the call ends — a remote mirror
	// dismisses on it.
	emitAskUserBlockedEvent(pi, true, open.toolCallId);
	try {
		// Lazy — QuestionnaireSession pulls the ~560ms view/TUI render graph;
		// load it only when the tool runs, not at extension registration.
		const sessionLoad = await loadQuestionnaireSession();
		// Answered during the load: the answer needs no dialog.
		if (open.settled) return buildQuestionnaireResponse(open.settled, typed);
		if (!sessionLoad.ok) {
			return buildToolResult(sessionLoad.message, { answers: [], cancelled: true, error: sessionLoad.error });
		}
		const { QuestionnaireSession } = sessionLoad.module;
		const collapseKey = config.collapseKey;
		const mount = (p: Presentation) =>
			Promise.race([
				mountQuestionnaire({
					ctx,
					typed,
					itemsByTab,
					collapseKey,
					presentation: p,
					open,
					Session: QuestionnaireSession,
					sessionRef,
					...waitBindings,
				}),
				open.answeredEarly,
			]);

		// Pi's editor slot (#253); the overlay only while another questionnaire holds the slot,
		// or stacked when another overlay is already on screen (see below).
		presentation = resolvePresentation();
		emitTerminalAttention();
		let result = await mount(presentation);
		if (result === YIELD_TO_OVERLAY) {
			// Another overlay was on screen: stack on top of it instead (see mustYieldInlineSlot).
			presentation.release?.();
			presentation = STACKED_OVERLAY_PRESENTATION;
			result = await mount(presentation);
		}

		if (result === undefined) {
			// The RPC walker takes over; its prompts cannot be answered from outside.
			open.host = "rpc";
			if (!hasDialogUI(ctx.ui)) {
				return buildToolResult(ERROR_NO_CUSTOM_UI, { answers: [], cancelled: true, error: "no_custom_ui" });
			}
			wait.begin();
			const rpcResult = await runRpcQuestionnaire(ctx.ui, typed, {
				signal: wait.signal,
				timeoutMs: () => wait.hostTimeoutMs(),
			});
			if (wait.signal.aborted) {
				return buildQuestionnaireResponse({ ...rpcResult, cancelled: false, timedOut: true }, typed);
			}
			return buildQuestionnaireResponse(rpcResult, typed);
		}

		return buildQuestionnaireResponse(result, typed);
	} finally {
		wait.dispose();
		presentation?.release?.();
		emitAskUserBlockedEvent(pi, false, open.toolCallId);
	}
}

/**
 * Pre-warm the lazy session graph once startup settles (#107). A graph
 * evaluated while the paths Pi resolved at boot still exist stays in memory
 * for the process lifetime, so later on-disk dependency churn (e.g. `pnpm
 * install --force` replacing the store mid-session) can no longer poison
 * jiti's graph cache. Swallowed failure is safe: the first real call
 * re-imports and surfaces it through loadQuestionnaireSession's structured
 * envelope. unref keeps the timer from holding a non-TUI embedder's process
 * open.
 */
function prewarmSessionGraph(): void {
	const timer = setTimeout(() => void loadQuestionnaireSession().catch(() => undefined), PREWARM_DELAY_MS);
	timer.unref?.();
}

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

export { DEFAULT_PROMPT_GUIDELINES, DEFAULT_PROMPT_SNIPPET, DEFAULT_TOOL_DESCRIPTION };

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	const registered = loadConfig();
	warnConfig(registered);
	const guidance = registered.config.guidance;
	const answers = registerAnswerChannel(pi);
	pi.registerTool({
		name: ASK_USER_TOOL_NAME,
		label: "Ask User",
		description: guidance.description ?? DEFAULT_TOOL_DESCRIPTION,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,
		// Undo double-encoded nested arguments before Pi validates them (#244).
		prepareArguments: prepareQuestionArguments,

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			// Line-terminator normalization runs once here, ahead of validation, so
			// every downstream consumer — validator, TUI, RPC walker, envelope, prompt
			// event — sees the same clean text (#192).
			const typed = normalizeQuestionParams(params as unknown as QuestionParams);
			if (!ctx.hasUI) return rejectWithoutUi();

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			// RPC hosts (VSCode pendant, ACP clients like Zed/Paseo — issue #78):
			// ui.custom() cannot render there, but the select/input dialog
			// sub-protocol works. Hosts that advertise ctx.mode (pi ≥0.79) route to
			// the sequential dialog walker up front, skipping the TUI render-graph
			// import entirely; RPC builds that predate ctx.mode are caught by the
			// custom()-resolved-undefined backstop below. See ./rpc-fallback.ts.
			const questionConfig = loadConfig();
			warnConfig(questionConfig);
			const viaRpc = (ctx as { mode?: string }).mode === "rpc" && hasDialogUI(ctx.ui);
			// Open for inbound answers before the prompt goes out: an emitter may answer
			// straight from its prompt listener.
			const open = answers.open(toolCallId, typed.questions, viaRpc ? "rpc" : "tui");
			try {
				// Emit event for external listeners (e.g., notification plugins)
				emitAskUserPromptEvent(pi, typed, toolCallId);
				if (viaRpc) return await runRpcPath(pi, ctx, ctx.ui, typed, toolCallId, questionConfig.config);
				return await runTuiPath(pi, ctx, typed, open, questionConfig.config);
			} finally {
				answers.close(open);
			}
		},
	});

	prewarmSessionGraph();
}

export { buildQuestionnaireResponse, buildToolResult };
