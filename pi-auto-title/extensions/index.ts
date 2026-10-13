/**
 * pi-auto-title: keep Pi's terminal tab title informative in parallel sessions.
 *
 * The tab title is `Pi - <title>` at startup and gains the status marker once
 * the agent first runs: `<status> Pi - <title>`. The title body is the
 * AI-generated session title once one exists, or the startup directory name
 * before (and instead of) it. The AI title is generated once per session from
 * the session's first user message, on a request of its own that never blocks
 * the agent, and persisted inside the session with `pi.appendEntry()`.
 *
 * Pi writes its own terminal title (`π - <dir>`) right after extensions bind,
 * so the title is re-asserted a moment after the events where that happens. On
 * a normal quit the title is restored to the empty string, because terminals
 * otherwise keep the last title forever. Pi writes its own title once more
 * while tearing down its UI, after `session_shutdown` has run, so the restore
 * is repeated at process exit, the last write before the process dies.
 */

import { existsSync, writeSync } from "node:fs";
import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	configPath as defaultConfigPath,
	defaultConfig,
	loadConfig,
	type AutoTitleConfig,
	type LoadConfigResult,
	writeDefaultConfig,
} from "../src/config.ts";
import {
	generateTitle,
	TITLE_GENERATION_TIMEOUT_MS,
	type AiClient,
} from "../src/generator.ts";
import type { SessionModelInfo } from "../src/model.ts";
import {
	findFirstUserText,
	findStoredTitle,
	GenerationTracker,
	SessionTitleManager,
	TITLE_ENTRY_TYPE,
	titleEntryData,
	warningEntryData,
	warningEntryMessage,
	WARNING_ENTRY_TYPE,
	type SessionEntryLike,
} from "../src/session.ts";
import { StallMonitor } from "../src/stall-monitor.ts";
import {
	FALLBACK_DIRECTORY_NAME,
	formatTitle,
	TitleDisplay,
	workspaceNameFromPath,
	type TitleStatus,
} from "../src/title.ts";

/** Handle returned by the injected scheduler. */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Delays before re-asserting the title after Pi writes its own. The first shot
 * covers the synchronous overwrite that follows extension binding; the later
 * shots cover slower startup paths that write the title after an await.
 */
const TITLE_ENFORCE_DELAYS_MS = [0, 250, 1_000];

/** Injectable dependencies for tests; production uses the defaults. */
export interface AutoTitleDeps {
	/** Configuration loader; defaults to reading the user config file. */
	loadConfig?: () => LoadConfigResult;
	/** Path written by `/auto-title init`; defaults to `~/.pi/agent/pi-auto-title.json`. */
	configPath?: () => string;
	/** Client factory for title requests; defaults to the session's model registry. */
	createClient?: (ctx: ExtensionContext) => AiClient;
	/** Deadline for one generation run. */
	timeoutMs?: number;
	/** One-shot scheduler for title re-assertion; defaults to `setTimeout`. */
	setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
	/** Cancels a handle from {@link AutoTitleDeps.setTimeout}; defaults to `clearTimeout`. */
	clearTimeout?: (handle: TimerHandle) => void;
	/** Registers a one-shot process-exit hook; defaults to `process.once("exit", ...)`. */
	onProcessExit?: (handler: () => void) => void;
	/** Synchronous empty-title write for the exit-time restore; defaults to {@link clearTerminalTitle}. */
	clearTitleAtExit?: () => void;
	/** Monotonic clock for stall detection; defaults to `performance.now`. */
	now?: () => number;
	/** One-shot scheduler for stall-deadline timers; defaults to `setTimeout`. */
	stallSetTimeout?: (callback: () => void, delayMs: number) => unknown;
	/** Cancels a handle from {@link AutoTitleDeps.stallSetTimeout}; defaults to `clearTimeout`. */
	stallClearTimeout?: (handle: unknown) => void;
	/** Diagnostic sink; silent by default — stderr lines surface in the TUI chat area. */
	log?: (message: string) => void;
}

/** Client backed by Pi's model registry, so auth comes from Pi's own storage. */
function registryClient(ctx: ExtensionContext): AiClient {
	return {
		complete: (model, context, options) =>
			ctx.modelRegistry
				.streamSimple(model, context, {
					reasoning: options.reasoning,
					signal: options.signal,
					timeoutMs: options.timeoutMs,
				})
				.result(),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** OSC 0 sequence setting the terminal title, with an empty title. */
const EMPTY_TITLE_SEQUENCE = "\x1b]0;\x07";

/**
 * Clear the terminal title by writing the OSC sequence to stdout.
 *
 * `ctx.ui.setTitle()` ends in `process.stdout.write`, which Windows terminals
 * handle asynchronously and can drop when the process exits right after. The
 * exit-time restore therefore writes the same bytes Pi's TUI writes, with
 * `writeSync`. Writing to an already dead terminal throws, and nothing can
 * report an error while the process is exiting, so the failure is swallowed.
 */
function clearTerminalTitle(): void {
	try {
		writeSync(1, EMPTY_TITLE_SEQUENCE);
	} catch {
		// The terminal is gone; nothing left to restore the title on.
	}
}

/** Register the title management handlers on a Pi extension API. */
export function registerAutoTitle(
	pi: ExtensionAPI,
	deps: AutoTitleDeps = {},
): void {
	const configPath = deps.configPath ?? defaultConfigPath;
	const load = deps.loadConfig ?? (() => loadConfig(configPath()));
	// Diagnostics (thinking-level adjustments, request failures) are silent by
	// default: anything written to stderr lands in the TUI chat area. User-facing
	// problems surface as history entries (fallback) or notifications instead.
	const log = deps.log ?? (() => {});
	const timeoutMs = deps.timeoutMs ?? TITLE_GENERATION_TIMEOUT_MS;
	const createClient = deps.createClient ?? registryClient;
	const schedule = deps.setTimeout ?? setTimeout;
	const cancelTimer = deps.clearTimeout ?? clearTimeout;
	const onProcessExit =
		deps.onProcessExit ??
		((handler: () => void) => {
			process.once("exit", handler);
		});
	const clearTitleAtExit = deps.clearTitleAtExit ?? clearTerminalTitle;

	let config: AutoTitleConfig = defaultConfig();
	/** Startup directory name, fixed on the first `session_start` of this runtime. */
	let directoryTitle: string | undefined;
	let manager: SessionTitleManager | undefined;
	/** Whether the agent loop is currently executing; the display flag is `agentStarted`. */
	let agentRunning = false;
	/** The status marker appears once the agent has run at least once. */
	let agentStarted = false;
	let ctxRef: ExtensionContext | undefined;
	let disposed = false;
	/** Once per session: the first user message has already been used. */
	let generationAttempted = false;
	const tracker = new GenerationTracker();
	let generationController: AbortController | undefined;
	const enforceTimers = new Set<TimerHandle>();
	let warningShown = false;
	/** The process-exit restore is registered at most once. */
	let exitRestoreRegistered = false;
	/** Session the watches belong to; tool events from another one are ignored. */
	let sessionId: string | undefined;

	/** The stall-deadline timers use their own injectable pair, independent of the enforce scheduler. */
	const stallSchedule =
		deps.stallSetTimeout ??
		((callback: () => void, delayMs: number) => schedule(callback, delayMs));
	const stallCancel =
		deps.stallClearTimeout ??
		((handle: unknown) => cancelTimer(handle as TimerHandle));

	/** Stall watches for the current agent run; the map is empty while idle. */
	const stallMonitor = new StallMonitor({
		thresholdMs: () =>
			config.statusIndicator.stallDetection.thresholdSeconds * 1_000,
		now: deps.now,
		setTimeout: stallSchedule,
		clearTimeout: stallCancel,
		onStalledChange: () => renderTitle(),
	});

	/**
	 * Status derived from the run state, so no transition can leave a stale
	 * marker behind: a cleared monitor or an ended run falls back to idle (or
	 * plain running) on the next render by itself.
	 */
	function currentStatus(): TitleStatus {
		if (!agentRunning) return "idle";
		return stallMonitor.stalled ? "stalled" : "running";
	}

	/** Disposers for every event handler, so the whole extension can switch itself off. */
	const disposers: (() => void)[] = [];

	/**
	 * One-way switch for modes without UI (JSON, print): dispose every handler
	 * so the extension goes fully inert — no timers, no title writes, no AI
	 * requests. The mode is fixed per process, so one decision at the first
	 * `session_start` holds for the whole runtime.
	 */
	let deactivated = false;
	function deactivate(): void {
		if (deactivated) return;
		deactivated = true;
		disposed = true;
		clearEnforceTimers();
		stallMonitor.clear();
		cancelGeneration();
		for (const dispose of disposers.splice(0)) dispose();
	}

	const display = new TitleDisplay((title) => {
		ctxRef?.ui.setTitle(title);
	});

	function renderTitle(force = false): void {
		const ctx = ctxRef;
		if (ctx === undefined || disposed || !ctx.hasUI) return;
		display.show(
			formatTitle({
				statusEnabled: config.statusIndicator.enabled && agentStarted,
				running: config.statusIndicator.running,
				stalled: config.statusIndicator.stalled,
				idle: config.statusIndicator.idle,
				status: currentStatus(),
				title: manager?.title ?? directoryTitle ?? FALLBACK_DIRECTORY_NAME,
			}),
			force,
		);
	}

	/**
	 * Re-assert the title after events where Pi writes its own terminal title
	 * (`π - <dir>`). Without this, Pi's write hides the extension's title until
	 * the next status change.
	 *
	 * There is no event for Pi's write, so this is best effort: the shots cover
	 * the usual timing, and the next prompt input is the final safety net. Rapid
	 * triggers replace the pending batch instead of stacking new ones.
	 */
	function scheduleTitleEnforce(): void {
		const ctx = ctxRef;
		if (ctx === undefined || disposed || !ctx.hasUI) return;
		clearEnforceTimers();
		for (const delayMs of TITLE_ENFORCE_DELAYS_MS) {
			const handle = schedule(() => {
				enforceTimers.delete(handle);
				renderTitle(true);
			}, delayMs);
			enforceTimers.add(handle);
		}
	}

	function clearEnforceTimers(): void {
		for (const handle of enforceTimers) cancelTimer(handle);
		enforceTimers.clear();
	}

	/** Cancel the in-flight generation and forget its state. */
	function cancelGeneration(): void {
		generationController?.abort();
		generationController = undefined;
		tracker.reset();
	}

	function sessionModelInfo(ctx: ExtensionContext): SessionModelInfo {
		return {
			currentModel: ctx.model,
			currentThinkingLevel: ctx.thinkingLevel ?? "off",
			findModel: (reference) => {
				const slash = reference.indexOf("/");
				if (slash <= 0 || slash === reference.length - 1) return undefined;
				return ctx.modelRegistry.find(
					reference.slice(0, slash),
					reference.slice(slash + 1),
				);
			},
			hasAuth: (model) => ctx.modelRegistry.hasConfiguredAuth(model),
		};
	}

	/**
	 * Generate the AI title for the session's first user message.
	 *
	 * The request is cancellable and its result is applied only while its session
	 * and generation are still current, and then persisted before the title is
	 * rendered. Only the run that started the state clears it again.
	 */
	async function startGeneration(
		ctx: ExtensionContext,
		firstUserText: string,
	): Promise<void> {
		const current = manager;
		if (!config.autoTitle.enabled || !ctx.hasUI) return;
		if (
			current === undefined ||
			current.aiTitle !== undefined ||
			generationAttempted
		) {
			return;
		}
		const runToken = tracker.start();
		if (runToken === undefined) return;
		generationAttempted = true;

		const controller = new AbortController();
		generationController = controller;
		const ticket = current.startGeneration();
		/**
		 * Warnings and issues go into the conversation history as custom entries:
		 * they stay visible without scrolling away like a toast, and custom
		 * entries never enter the LLM context, so the agent cannot see them.
		 */
		const showRunWarning = (message: string) => {
			if (!disposed && manager === current) {
				pi.appendEntry(WARNING_ENTRY_TYPE, warningEntryData(message));
			}
		};
		try {
			const result = await generateTitle({
				settings: config.autoTitle,
				info: sessionModelInfo(ctx),
				client: createClient(ctx),
				firstUserText,
				timeoutMs,
				log,
				signal: controller.signal,
				onFallback: showRunWarning,
				onIssue: showRunWarning,
			});
			if (disposed || manager !== current) return;
			const title = result.title;
			if (title === undefined || controller.signal.aborted) return;
			if (current.acceptGeneration(ticket, title)) {
				pi.appendEntry(TITLE_ENTRY_TYPE, titleEntryData(title));
				renderTitle();
			}
		} catch (error) {
			// Unexpected internal errors, not provider responses. The history gets
			// fixed wording only; the detail stays in the log, since an arbitrary
			// error message cannot be trusted to be free of secrets or personal data.
			log(`pi-auto-title: title generation failed: ${errorMessage(error)}`);
			showRunWarning("pi-auto-title: title generation failed: internal error");
		} finally {
			tracker.finish(runToken);
			if (generationController === controller) generationController = undefined;
		}
	}

	function maybeGenerateFromHistory(
		ctx: ExtensionContext,
		entries: readonly SessionEntryLike[],
	): void {
		const firstUserText = findFirstUserText(entries);
		if (firstUserText === undefined) return;
		void startGeneration(ctx, firstUserText);
	}

	disposers.push(
		pi.on("session_start", (_event, ctx: ExtensionContext) => {
			// Modes without UI (JSON, print) get nothing at all: no title writes,
			// no AI requests, no stall watches. `session_start` always precedes
			// any agent activity, so the whole extension stops before doing work.
			if (!ctx.hasUI) {
				deactivate();
				return;
			}
			disposed = false;
			ctxRef = ctx;
			sessionId = ctx.sessionManager.getSessionId();
			const loaded = load();
			config = loaded.config;
			if (loaded.warning !== undefined && !warningShown) {
				warningShown = true;
				ctx.ui.notify(loaded.warning, "warning");
			}
			directoryTitle ??= workspaceNameFromPath(ctx.cwd);
			agentRunning = false;
			agentStarted = false;
			clearEnforceTimers();
			stallMonitor.clear();
			cancelGeneration();
			generationAttempted = false;
			const entries: readonly SessionEntryLike[] =
				ctx.sessionManager.getBranch();
			const restored = findStoredTitle(entries);
			manager = new SessionTitleManager(
				ctx.sessionManager.getSessionId(),
				directoryTitle,
				restored,
			);
			renderTitle();
			scheduleTitleEnforce();
			// Resuming a session that already has a stored title keeps it; one without
			// gets a title generated from its first user message.
			if (restored === undefined) maybeGenerateFromHistory(ctx, entries);
		}),
	);

	// Pi rewrites the terminal title when the session name changes; reclaim it.
	disposers.push(
		pi.on("session_info_changed", (_event, ctx: ExtensionContext) => {
			ctxRef = ctx;
			scheduleTitleEnforce();
		}),
	);

	// A late Pi title write (for example a Windows package check) can outlive the
	// re-assertion shots; the next prompt input heals the title deterministically.
	disposers.push(
		pi.on("input", (_event, ctx: ExtensionContext) => {
			ctxRef = ctx;
			renderTitle(true);
		}),
	);

	// The first user message of a new session is the generation trigger. History
	// wins over the prompt text so steered or resumed runs see the same input.
	disposers.push(
		pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
			ctxRef = ctx;
			const firstUserText =
				findFirstUserText(ctx.sessionManager.getBranch()) ??
				event.prompt.trim();
			if (firstUserText === "") return;
			void startGeneration(ctx, firstUserText);
		}),
	);

	disposers.push(
		pi.on("agent_start", (_event, ctx: ExtensionContext) => {
			ctxRef = ctx;
			agentStarted = true;
			agentRunning = true;
			// Watches from a previous run (an aborted one, say) must not bleed in.
			stallMonitor.clear();
			renderTitle();
		}),
	);

	// `agent_settled` is the boundary where Pi will not continue on its own, so
	// queued continuations and tool loops stay "running" until it fires. It also
	// covers aborts and errors, which cannot leave a running marker behind.
	disposers.push(
		pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
			ctxRef = ctx;
			agentRunning = false;
			stallMonitor.clear();
			renderTitle();
		}),
	);

	// Every tool execution is watched the same way, whatever kind of tool it
	// is; the monitor's map ignores events for ids it does not know. Events are
	// accepted only while this session's agent run is active: tool events are
	// emitted from the agent loop (agent-session.js `_emitExtensionEvent`), but
	// late arrivals around a settle or session switch must not open watches.
	function acceptsToolEvents(ctx: ExtensionContext): boolean {
		if (disposed || !agentRunning) return false;
		if (!config.statusIndicator.stallDetection.enabled) return false;
		return ctx.sessionManager.getSessionId() === sessionId;
	}

	disposers.push(
		pi.on("tool_execution_start", (event, ctx: ExtensionContext) => {
			ctxRef = ctx;
			if (!acceptsToolEvents(ctx)) return;
			stallMonitor.start(event.toolCallId, event.toolName);
		}),
	);

	disposers.push(
		pi.on("tool_execution_update", (event, ctx: ExtensionContext) => {
			ctxRef = ctx;
			if (!acceptsToolEvents(ctx)) return;
			stallMonitor.update(event.toolCallId);
		}),
	);

	disposers.push(
		pi.on("tool_execution_end", (event, ctx: ExtensionContext) => {
			ctxRef = ctx;
			if (!acceptsToolEvents(ctx)) return;
			stallMonitor.end(event.toolCallId);
		}),
	);

	// Tree navigation changes the branch, so the stored title and any in-flight
	// generation for the old branch are rebuilt here.
	disposers.push(
		pi.on("session_tree", (_event, ctx: ExtensionContext) => {
			ctxRef = ctx;
			const current = manager;
			if (current === undefined) return;
			cancelGeneration();
			stallMonitor.clear();
			manager = new SessionTitleManager(
				current.sessionId,
				directoryTitle ?? FALLBACK_DIRECTORY_NAME,
				findStoredTitle(ctx.sessionManager.getBranch()),
			);
			renderTitle();
			scheduleTitleEnforce();
		}),
	);

	disposers.push(
		pi.on("session_shutdown", (event, ctx: ExtensionContext) => {
			disposed = true;
			clearEnforceTimers();
			stallMonitor.clear();
			cancelGeneration();
			manager?.invalidate();
			manager = undefined;
			// Pi leaves its terminal title behind on quit. Clearing the title is the
			// closest public restore: terminals then show their own default again, or
			// an empty title when they keep the last value. Session replacement keeps
			// the window open and must not clear it.
			if (event.reason === "quit" && ctx.hasUI) {
				ctx.ui.setTitle("");
				// Pi writes `π - <dir>` once more while tearing down its UI, right after
				// this handler, which undoes the restore above. Clearing at process exit
				// runs after that write and is the last one before the process dies. Raw
				// bytes go to a TUI only: an RPC client owns its terminal and already got
				// the `setTitle` call above.
				if (ctx.mode === "tui" && !exitRestoreRegistered) {
					exitRestoreRegistered = true;
					onProcessExit(clearTitleAtExit);
				}
			}
			ctxRef = undefined;
		}),
	);

	/** The overwrite confirmation lists No first, so a plain Enter cannot overwrite. */
	const OVERWRITE_CHOICES = ["No", "Yes"] as const;

	async function runInit(ctx: ExtensionContext): Promise<void> {
		const path = configPath();
		let existed = false;
		try {
			existed = existsSync(path);
			if (existed) {
				const choice = await ctx.ui.select(
					`${path} already exists. Overwrite it with the default settings?`,
					[...OVERWRITE_CHOICES],
				);
				if (choice === undefined) {
					ctx.ui.notify("pi-auto-title: cancelled", "info");
					return;
				}
				if (choice !== "Yes") {
					ctx.ui.notify(
						"pi-auto-title: cancelled. The existing file was left unchanged",
						"info",
					);
					return;
				}
			}
			writeDefaultConfig(path);
		} catch (error) {
			ctx.ui.notify(
				`pi-auto-title: could not write the configuration file: ${errorMessage(error)}`,
				"error",
			);
			return;
		}
		// Reload what was written as the effective settings instead of assigning
		// the defaults directly.
		config = load().config;
		ctxRef = ctx;
		// The new defaults may change the threshold; re-evaluate the watches so
		// no timer armed for the old one survives.
		stallMonitor.refresh();
		renderTitle();
		ctx.ui.notify(
			`pi-auto-title: ${path} ${existed ? "reset to the defaults" : "created"}`,
			"info",
		);
	}

	/**
	 * Warnings (model fallback and friends) render inline in the conversation
	 * history. Custom entries never enter the LLM context, so the agent cannot
	 * see them; the box styling follows pi-undo's custom-entry pattern.
	 */
	const renderWarningEntry: EntryRenderer = (entry, _options, theme) => {
		const message = warningEntryMessage(entry.data);
		if (message === undefined) return undefined;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("warning", `⚠ ${message}`), 0, 0));
		return box;
	};
	pi.registerEntryRenderer(WARNING_ENTRY_TYPE, renderWarningEntry);

	pi.registerCommand("pi-auto-title", {
		description: "Manage pi-auto-title settings (/pi-auto-title init)",
		getArgumentCompletions: (argumentPrefix) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			if (!"init".startsWith(prefix)) return [];
			return [
				{
					value: "init",
					label: "init",
					description:
						"Write the default configuration file (asks before overwriting)",
				},
			];
		},
		handler: async (args, ctx) => {
			// Unreachable in the deactivated modes (commands need an input line),
			// but a deactivated extension must not act if one ever arrives.
			if (deactivated) return;
			if (args.trim() !== "init") {
				ctx.ui.notify(
					"pi-auto-title: available command:\n  /pi-auto-title init — write the default configuration file (asks before overwriting)",
					"info",
				);
				return;
			}
			await runInit(ctx);
		},
	});
}

export default function (pi: ExtensionAPI): void {
	registerAutoTitle(pi);
}
