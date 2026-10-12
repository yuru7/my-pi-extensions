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
 * otherwise keep the last title forever.
 */

import { existsSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
	type SessionEntryLike,
} from "../src/session.ts";
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
	/** Log sink; defaults to `console.error`. */
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

/** Register the title management handlers on a Pi extension API. */
export function registerAutoTitle(
	pi: ExtensionAPI,
	deps: AutoTitleDeps = {},
): void {
	const configPath = deps.configPath ?? defaultConfigPath;
	const load = deps.loadConfig ?? (() => loadConfig(configPath()));
	const log = deps.log ?? ((message: string) => console.error(message));
	const timeoutMs = deps.timeoutMs ?? TITLE_GENERATION_TIMEOUT_MS;
	const createClient = deps.createClient ?? registryClient;
	const schedule = deps.setTimeout ?? setTimeout;
	const cancelTimer = deps.clearTimeout ?? clearTimeout;

	let config: AutoTitleConfig = defaultConfig();
	/** Startup directory name, fixed on the first `session_start` of this runtime. */
	let directoryTitle: string | undefined;
	let manager: SessionTitleManager | undefined;
	let status: TitleStatus = "idle";
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
				idle: config.statusIndicator.idle,
				status,
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
		try {
			const result = await generateTitle({
				settings: config.autoTitle,
				info: sessionModelInfo(ctx),
				client: createClient(ctx),
				firstUserText,
				timeoutMs,
				log,
				signal: controller.signal,
				onFallback: (warning) => {
					if (!disposed && manager === current) {
						ctx.ui.notify(warning, "warning");
					}
				},
			});
			if (disposed || manager !== current) return;
			const title = result.title;
			if (title === undefined || controller.signal.aborted) return;
			if (current.acceptGeneration(ticket, title)) {
				pi.appendEntry(TITLE_ENTRY_TYPE, titleEntryData(title));
				renderTitle();
			}
		} catch (error) {
			log(`pi-auto-title: title generation failed: ${errorMessage(error)}`);
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

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		disposed = false;
		ctxRef = ctx;
		const loaded = load();
		config = loaded.config;
		if (loaded.warning !== undefined && !warningShown) {
			warningShown = true;
			ctx.ui.notify(loaded.warning, "warning");
		}
		directoryTitle ??= workspaceNameFromPath(ctx.cwd);
		status = "idle";
		agentStarted = false;
		clearEnforceTimers();
		cancelGeneration();
		generationAttempted = false;
		const entries: readonly SessionEntryLike[] = ctx.sessionManager.getBranch();
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
	});

	// Pi rewrites the terminal title when the session name changes; reclaim it.
	pi.on("session_info_changed", (_event, ctx: ExtensionContext) => {
		ctxRef = ctx;
		scheduleTitleEnforce();
	});

	// A late Pi title write (for example a Windows package check) can outlive the
	// re-assertion shots; the next prompt input heals the title deterministically.
	pi.on("input", (_event, ctx: ExtensionContext) => {
		ctxRef = ctx;
		renderTitle(true);
	});

	// The first user message of a new session is the generation trigger. History
	// wins over the prompt text so steered or resumed runs see the same input.
	pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
		ctxRef = ctx;
		const firstUserText =
			findFirstUserText(ctx.sessionManager.getBranch()) ?? event.prompt.trim();
		if (firstUserText === "") return;
		void startGeneration(ctx, firstUserText);
	});

	pi.on("agent_start", (_event, ctx: ExtensionContext) => {
		ctxRef = ctx;
		agentStarted = true;
		status = "running";
		renderTitle();
	});

	// `agent_settled` is the boundary where Pi will not continue on its own, so
	// queued continuations and tool loops stay "running" until it fires. It also
	// covers aborts and errors, which cannot leave a running marker behind.
	pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
		ctxRef = ctx;
		status = "idle";
		renderTitle();
	});

	// Tree navigation changes the branch, so the stored title and any in-flight
	// generation for the old branch are rebuilt here.
	pi.on("session_tree", (_event, ctx: ExtensionContext) => {
		ctxRef = ctx;
		const current = manager;
		if (current === undefined) return;
		cancelGeneration();
		manager = new SessionTitleManager(
			current.sessionId,
			directoryTitle ?? FALLBACK_DIRECTORY_NAME,
			findStoredTitle(ctx.sessionManager.getBranch()),
		);
		renderTitle();
		scheduleTitleEnforce();
	});

	pi.on("session_shutdown", (event, ctx: ExtensionContext) => {
		disposed = true;
		clearEnforceTimers();
		cancelGeneration();
		manager?.invalidate();
		manager = undefined;
		// Pi leaves its terminal title behind on quit. Clearing the title is the
		// closest public restore: terminals then show their own default again, or
		// an empty title when they keep the last value. Session replacement keeps
		// the window open and must not clear it.
		if (event.reason === "quit" && ctx.hasUI) {
			ctx.ui.setTitle("");
		}
		ctxRef = undefined;
	});

	async function runInit(ctx: ExtensionContext): Promise<void> {
		const path = configPath();
		let existed = false;
		try {
			existed = existsSync(path);
			if (existed) {
				const confirmed = await ctx.ui.confirm(
					"pi-auto-title",
					"既存のpi-auto-title.jsonをデフォルト設定で上書きしますか？",
				);
				if (!confirmed) return;
			}
			writeDefaultConfig(path);
		} catch (error) {
			ctx.ui.notify(
				`pi-auto-title: 設定ファイルを書き込めませんでした: ${errorMessage(error)}`,
				"error",
			);
			return;
		}
		config = defaultConfig();
		ctxRef = ctx;
		renderTitle();
		ctx.ui.notify(
			`pi-auto-title: ${path} を${existed ? "デフォルト設定にリセット" : "作成"}しました`,
			"info",
		);
	}

	pi.registerCommand("auto-title", {
		description: "Manage pi-auto-title settings (/auto-title init)",
		handler: async (args, ctx) => {
			if (args.trim() !== "init") {
				ctx.ui.notify(
					"pi-auto-title: 利用可能なコマンド:\n  /auto-title init デフォルト設定ファイルを生成します（既存ファイルは確認のうえリセット）",
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
