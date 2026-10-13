import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerAutoTitle } from "../extensions/index.ts";
import {
	DEFAULT_CONFIG,
	defaultConfig,
	parseConfig,
	type AutoTitleConfig,
	type LoadConfigResult,
} from "../src/config.ts";
import {
	GenerationTracker,
	TITLE_ENTRY_TYPE,
	warningEntryMessage,
	WARNING_ENTRY_TYPE,
	type SessionEntryLike,
} from "../src/session.ts";
import {
	assistant,
	createStallClock,
	fakeModel,
	flush,
	recordingClient,
	type Responder,
	type StallClock,
} from "./helpers.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface CommandOptions {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
	getArgumentCompletions?: (argumentPrefix: string) => unknown;
}

function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandOptions>();
	const appended: { customType: string; data: unknown }[] = [];
	const entryRenderers = new Map<string, EntryRenderer>();
	return {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		emit(event: string, payload: unknown, ctx: ExtensionContext) {
			for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
		},
		registerEntryRenderer(customType: string, renderer: EntryRenderer) {
			entryRenderers.set(customType, renderer);
		},
		registerCommand(name: string, options: CommandOptions) {
			commands.set(name, options);
		},
		appended,
		commands,
		entryRenderers,
	};
}

type FakePi = ReturnType<typeof createFakePi>;

interface CtxOptions {
	cwd?: string;
	hasUI?: boolean;
	mode?: ExtensionContext["mode"];
	sessionId?: string;
	entries?: SessionEntryLike[];
	currentModel?: Model<Api>;
	thinkingLevel?: ModelThinkingLevel;
	registry?: Record<string, Model<Api>>;
	hasAuth?: (model: Model<Api>) => boolean;
}

function createCtx(options: CtxOptions) {
	const titles: string[] = [];
	const notifications: { message: string; type?: string }[] = [];
	const confirmations: string[] = [];
	const selections: { title: string; options: string[] }[] = [];
	const state = {
		titles,
		notifications,
		confirmations,
		confirmResult: true,
		selections,
		/** What ui.select answers; undefined simulates Esc. */
		selectResult: "Yes" as string | undefined,
		/** What the terminal currently displays, including writes from Pi itself. */
		terminalTitle: "",
		entries: options.entries ?? ([] as SessionEntryLike[]),
		sessionId: options.sessionId ?? "session-1",
	};
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? "/home/user/projects/web-app",
		model: options.currentModel,
		thinkingLevel: options.thinkingLevel ?? "off",
		ui: {
			setTitle: (title: string) => {
				titles.push(title);
				state.terminalTitle = title;
			},
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			confirm: async (_title: string, message: string) => {
				confirmations.push(message);
				return state.confirmResult;
			},
			select: async (title: string, options: string[]) => {
				selections.push({ title, options });
				return state.selectResult;
			},
		},
		sessionManager: {
			getSessionId: () => state.sessionId,
			getBranch: () => state.entries,
		},
		modelRegistry: {
			find: (provider: string, id: string) =>
				options.registry?.[`${provider}/${id}`],
			hasConfiguredAuth: (model: Model<Api>) =>
				(options.hasAuth ?? (() => true))(model),
		},
	} as unknown as ExtensionContext;
	return { ctx, state };
}

interface SetupOptions extends CtxOptions {
	responders?: Responder[];
	config?: AutoTitleConfig;
	timeoutMs?: number;
}

function withConfig(
	mutate: (config: AutoTitleConfig) => void,
): AutoTitleConfig {
	const config = defaultConfig();
	mutate(config);
	return config;
}

interface ScheduledTimer {
	callback: () => void;
	cancelled: boolean;
}

/** One-shot scheduler the tests run by hand, so title timing stays deterministic. */
function createScheduler() {
	const timers: ScheduledTimer[] = [];
	return {
		setTimeout: (callback: () => void): ReturnType<typeof setTimeout> => {
			const timer: ScheduledTimer = { callback, cancelled: false };
			timers.push(timer);
			return timer as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: (handle: ReturnType<typeof setTimeout>): void => {
			(handle as unknown as ScheduledTimer).cancelled = true;
		},
		run(): void {
			for (const timer of timers.splice(0)) {
				if (!timer.cancelled) timer.callback();
			}
		},
	};
}

function setup(options: SetupOptions = {}) {
	const pi = createFakePi();
	const client = recordingClient(options.responders ?? []);
	const scheduler = createScheduler();
	const configPath = join(
		mkdtempSync(join(tmpdir(), "pi-auto-title-")),
		"pi-auto-title.json",
	);
	const logs: string[] = [];
	const loaded: LoadConfigResult = {
		config: options.config ?? defaultConfig(),
	};
	const { ctx, state } = createCtx(options);
	const exitHooks: (() => void)[] = [];
	const stallClock = createStallClock();
	registerAutoTitle(pi as unknown as ExtensionAPI, {
		// テストの init が書き込んだファイルを実効設定として読み直せるよう、
		// 実在するファイルを優先して読む (本物の loadConfig と同じ挙動)。
		loadConfig: () => {
			if (!existsSync(configPath)) return loaded;
			try {
				return {
					config: parseConfig(JSON.parse(readFileSync(configPath, "utf8")))
						.config,
				};
			} catch {
				return loaded;
			}
		},
		configPath: () => configPath,
		createClient: () => client.client,
		timeoutMs: options.timeoutMs ?? 5_000,
		setTimeout: scheduler.setTimeout,
		clearTimeout: scheduler.clearTimeout,
		now: stallClock.now,
		stallSetTimeout: stallClock.setTimeout,
		stallClearTimeout: stallClock.clearTimeout,
		onProcessExit: (handler) => {
			exitHooks.push(handler);
		},
		clearTitleAtExit: () => {
			state.titles.push("");
			state.terminalTitle = "";
		},
		log: (message) => logs.push(message),
	});
	return {
		pi,
		ctx,
		state,
		client,
		configPath,
		logs,
		runScheduled: scheduler.run,
		exitHooks,
		stallClock,
		runProcessExit(): void {
			for (const handler of exitHooks.splice(0)) handler();
		},
	};
}

function startSession(
	pi: FakePi,
	ctx: ExtensionContext,
	reason = "startup",
): void {
	pi.emit("session_start", { type: "session_start", reason }, ctx);
}

function firstUserPrompt(
	pi: FakePi,
	ctx: ExtensionContext,
	prompt: string,
): void {
	pi.emit("before_agent_start", { type: "before_agent_start", prompt }, ctx);
}

function userEntry(text: string): SessionEntryLike {
	return { type: "message", message: { role: "user", content: text } };
}

function titleEntry(title: string): SessionEntryLike {
	return { type: "custom", customType: TITLE_ENTRY_TYPE, data: { title } };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function toolEvent(
	pi: FakePi,
	ctx: ExtensionContext,
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end",
	toolCallId: string,
	toolName = "bash",
): void {
	pi.emit(
		type,
		{ type, toolCallId, toolName, args: {}, partialResult: null },
		ctx,
	);
}

describe("tab title", () => {
	test("the startup title shows the directory name without a status icon", () => {
		const { pi, ctx, state } = setup();
		startSession(pi, ctx);
		assert.deepEqual(state.titles, ["Pi - web-app"]);
	});

	test("the title is re-asserted after another writer replaces it", () => {
		const { pi, ctx, state, runScheduled } = setup();
		startSession(pi, ctx);
		assert.equal(state.terminalTitle, "Pi - web-app");
		// Pi's own `π - web-app` write hides the extension title.
		state.terminalTitle = "π - web-app";
		runScheduled();
		assert.equal(state.terminalTitle, "Pi - web-app");
	});

	test("the re-assertion uses the latest title", async () => {
		const { pi, ctx, state, runScheduled } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			responders: [() => assistant("Lambdaフォーム公開API")],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "AWS Lambdaでフォーム公開APIを実装したい");
		await flush();
		assert.equal(state.terminalTitle, "Pi - Lambdaフォーム公開API");
		state.terminalTitle = "π - web-app";
		runScheduled();
		assert.equal(state.terminalTitle, "Pi - Lambdaフォーム公開API");
	});

	test("the re-assertion uses the latest title and status", async () => {
		const pending = deferred<ReturnType<typeof assistant>>();
		const { pi, ctx, state, runScheduled } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			responders: [() => pending.promise],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		pending.resolve(assistant("フォーム公開API改善"));
		await flush();
		pi.emit(
			"agent_settled",
			{
				type: "agent_settled",
				aborted: false,
			},
			ctx,
		);
		assert.equal(state.terminalTitle, "✅ Pi - フォーム公開API改善");
		state.terminalTitle = "π - web-app";
		runScheduled();
		assert.equal(state.terminalTitle, "✅ Pi - フォーム公開API改善");
	});

	test("rapid re-assertion triggers keep a single batch", () => {
		const { pi, ctx, state, runScheduled } = setup();
		startSession(pi, ctx);
		state.titles.length = 0;
		pi.emit(
			"session_info_changed",
			{ type: "session_info_changed", name: "first" },
			ctx,
		);
		pi.emit(
			"session_info_changed",
			{ type: "session_info_changed", name: "second" },
			ctx,
		);
		runScheduled();
		assert.deepEqual(state.titles, [
			"Pi - web-app",
			"Pi - web-app",
			"Pi - web-app",
		]);
	});

	test("the next prompt input heals a late title write", () => {
		const { pi, ctx, state } = setup();
		startSession(pi, ctx);
		state.terminalTitle = "π - web-app";
		pi.emit(
			"input",
			{ type: "input", text: "hello", source: "interactive" },
			ctx,
		);
		assert.equal(state.terminalTitle, "Pi - web-app");
	});

	test("session name changes and tree navigation re-assert the title", () => {
		const { pi, ctx, state, runScheduled } = setup({
			entries: [userEntry("フォーム公開APIを改善して")],
		});
		startSession(pi, ctx);
		state.terminalTitle = "π - web-app";
		runScheduled();
		assert.equal(state.terminalTitle, "Pi - web-app");

		pi.emit(
			"session_info_changed",
			{ type: "session_info_changed", name: "renamed" },
			ctx,
		);
		state.terminalTitle = "π - renamed";
		runScheduled();
		assert.equal(state.terminalTitle, "Pi - web-app");

		state.entries = [
			userEntry("フォーム公開APIを改善して"),
			titleEntry("別ブランチのタイトル"),
		];
		pi.emit("session_tree", { type: "session_tree" }, ctx);
		state.terminalTitle = "π - web-app";
		runScheduled();
		assert.equal(state.terminalTitle, "Pi - 別ブランチのタイトル");
	});

	test("no re-assertion runs after a quit", () => {
		const { pi, ctx, state, runScheduled } = setup();
		startSession(pi, ctx);
		pi.emit(
			"session_shutdown",
			{
				type: "session_shutdown",
				reason: "quit",
			},
			ctx,
		);
		assert.equal(state.terminalTitle, "");
		state.titles.length = 0;
		runScheduled();
		assert.deepEqual(state.titles, []);
	});

	test("the status marker appears only after the agent first runs", () => {
		const { pi, ctx, state } = setup();
		startSession(pi, ctx);
		assert.equal(state.titles.at(-1), "Pi - web-app");
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
		pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
		assert.equal(state.titles.at(-1), "✅ Pi - web-app");
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
		pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
		assert.equal(state.titles.at(-1), "✅ Pi - web-app");
	});

	test("running and idle markers follow the agent", () => {
		const { pi, ctx, state } = setup();
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
		pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
		assert.equal(state.titles.at(-1), "✅ Pi - web-app");
	});

	test("an aborted run settles back to idle", () => {
		const { pi, ctx, state } = setup();
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		pi.emit("agent_settled", { type: "agent_settled", aborted: true }, ctx);
		assert.equal(state.titles.at(-1), "✅ Pi - web-app");
	});

	test("continuations and repeats do not flicker or repeat setTitle", () => {
		const { pi, ctx, state } = setup();
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
		pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
		assert.deepEqual(state.titles, [
			"Pi - web-app",
			"⏳ Pi - web-app",
			"✅ Pi - web-app",
		]);
	});

	test("a disabled status indicator omits the marker", () => {
		const { pi, ctx, state } = setup({
			config: withConfig((config) => {
				config.statusIndicator.enabled = false;
			}),
		});
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		assert.equal(state.titles.at(-1), "Pi - web-app");
	});

	test("custom markers are used verbatim", () => {
		const { pi, ctx, state } = setup({
			config: withConfig((config) => {
				config.statusIndicator.running = "[run]";
				config.statusIndicator.idle = "[ok]";
			}),
		});
		startSession(pi, ctx);
		assert.equal(state.titles.at(-1), "Pi - web-app");
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		assert.equal(state.titles.at(-1), "[run] Pi - web-app");
		pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
		assert.equal(state.titles.at(-1), "[ok] Pi - web-app");
	});

	test("a session without UI renders no title", () => {
		const { pi, ctx, state } = setup({ hasUI: false });
		startSession(pi, ctx);
		assert.deepEqual(state.titles, []);
	});
});

describe("AI title generation", () => {
	test("the first user message generates and persists the title", async () => {
		const { pi, ctx, state, client } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			responders: [() => assistant("Lambdaフォーム公開API")],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "AWS Lambdaでフォーム公開APIを実装したい");
		await flush();
		assert.equal(client.calls.length, 1);
		assert.deepEqual(pi.appended, [
			{
				customType: TITLE_ENTRY_TYPE,
				data: { title: "Lambdaフォーム公開API" },
			},
		]);
		assert.equal(state.titles.at(-1), "Pi - Lambdaフォーム公開API");
	});

	test("a session generates its title only once", async () => {
		const { pi, ctx, client } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			responders: [() => assistant("フォーム公開API改善")],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		firstUserPrompt(pi, ctx, "テストも追加して");
		await flush();
		assert.equal(client.calls.length, 1);
	});

	test("a disabled generator makes no AI request", async () => {
		const { pi, ctx, state, client } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			config: withConfig((config) => {
				config.autoTitle.enabled = false;
			}),
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		await flush();
		assert.equal(client.calls.length, 0);
		assert.equal(state.titles.at(-1), "Pi - web-app");
	});

	test("an unrelated config error cannot turn a disabled generator back on", async () => {
		// enabled: false and an invalid sibling in the same file: the per-field
		// fallback must keep generation off (fail-safe, not fail-open).
		const { pi, ctx, client, configPath } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
		});
		writeFileSync(
			configPath,
			JSON.stringify({ autoTitle: { enabled: false, model: 42 } }),
		);
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		await flush();
		assert.equal(client.calls.length, 0);
	});

	test("a failed generation warns in the history and keeps the directory name", async () => {
		const { pi, ctx, state, client } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			responders: [() => Promise.reject(new Error("provider down"))],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		await flush();
		assert.equal(client.calls.length, 1);
		const warning = pi.appended.find(
			(entry) => entry.customType === WARNING_ENTRY_TYPE,
		);
		assert.ok(warning);
		const message = warningEntryMessage(warning.data) ?? "";
		assert.match(message, /title generation failed/);
		// The provider error text never reaches the screen; fixed categories only.
		assert.ok(!message.includes("provider down"));
		assert.equal(state.titles.at(-1), "Pi - web-app");
	});

	test("a fallback warns in the conversation history and still titles the tab", async () => {
		const current = fakeModel("openai", "gpt-5.4");
		const requested = fakeModel("anthropic", "claude-sonnet-4-5");
		const { pi, ctx, state, client } = setup({
			currentModel: current,
			registry: { "anthropic/claude-sonnet-4-5": requested },
			config: withConfig((config) => {
				config.autoTitle.model = "anthropic/claude-sonnet-4-5";
			}),
			responders: [
				() => Promise.reject(new Error("rate limited")),
				() => assistant("フォーム公開API改善"),
			],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		await flush();
		assert.equal(client.calls.length, 2);
		assert.equal(client.calls[0].model, requested);
		assert.equal(client.calls[1].model, current);
		assert.equal(state.titles.at(-1), "Pi - フォーム公開API改善");
		// The warning is a custom entry in the history, not a toast, and never
		// reaches the agent (custom entries are outside the LLM context).
		const warning = pi.appended.find(
			(entry) => entry.customType === WARNING_ENTRY_TYPE,
		);
		assert.ok(warning);
		const message = warningEntryMessage(warning.data);
		assert.ok(message);
		assert.match(message, /anthropic\/claude-sonnet-4-5/);
		assert.match(message, /openai\/gpt-5.4/);
		assert.match(message, /call failed/);
		assert.ok(!message.includes("rate limited"));
		assert.equal(
			state.notifications.filter((entry) => entry.type === "warning").length,
			0,
		);
		assert.equal(ctx.model, current);
	});

	test("a thinking-level adjustment shows up in the history", async () => {
		const { pi, ctx, state } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			config: withConfig((config) => {
				config.autoTitle.thinkingLevel = "max";
			}),
			responders: [() => assistant("フォーム公開API改善")],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		await flush();
		// The model has no reasoning support, so "max" clamps to "off" and the
		// adjustment is announced in the history.
		const warning = pi.appended.find(
			(entry) => entry.customType === WARNING_ENTRY_TYPE,
		);
		assert.ok(warning);
		assert.match(
			warningEntryMessage(warning.data) ?? "",
			/thinking level "max".*using "off"/,
		);
		assert.equal(state.titles.at(-1), "Pi - フォーム公開API改善");
	});

	test("the warning entry renders in the history and skips broken data", () => {
		const { pi } = setup();
		const renderer = pi.entryRenderers.get(WARNING_ENTRY_TYPE);
		assert.ok(renderer);
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const component = renderer(
			{
				type: "custom",
				customType: WARNING_ENTRY_TYPE,
				data: { message: "boom" },
			} as Parameters<typeof renderer>[0],
			{ expanded: false },
			theme as unknown as Parameters<typeof renderer>[2],
		);
		assert.ok(component);
		assert.equal(
			renderer(
				{
					type: "custom",
					customType: WARNING_ENTRY_TYPE,
					data: {},
				} as Parameters<typeof renderer>[0],
				{ expanded: false },
				theme as unknown as Parameters<typeof renderer>[2],
			),
			undefined,
		);
	});

	test("the running marker is kept while an arriving title lands", async () => {
		const pending = deferred<ReturnType<typeof assistant>>();
		const { pi, ctx, state, client } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			responders: [() => pending.promise],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
		pending.resolve(assistant("フォーム公開API改善"));
		await flush();
		assert.equal(client.calls.length, 1);
		assert.equal(state.titles.at(-1), "⏳ Pi - フォーム公開API改善");
		pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
		assert.equal(state.titles.at(-1), "✅ Pi - フォーム公開API改善");
	});

	test("a result from a previous session is discarded", async () => {
		const pending = deferred<ReturnType<typeof assistant>>();
		const { pi, ctx, state, client } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			responders: [() => pending.promise, () => assistant("新しいタイトル")],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		pi.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "new" },
			ctx,
		);

		state.sessionId = "session-2";
		state.entries = [userEntry("別の作業をやって")];
		startSession(pi, ctx, "new");
		await flush();

		pending.resolve(assistant("古いタイトル"));
		await flush();
		assert.equal(client.calls.length, 2);
		assert.deepEqual(pi.appended, [
			{ customType: TITLE_ENTRY_TYPE, data: { title: "新しいタイトル" } },
		]);
		assert.equal(state.titles.at(-1), "Pi - 新しいタイトル");
		assert.ok(!state.titles.some((title) => title.includes("古いタイトル")));
	});

	test("a session shutdown cancels the request and skips the fallback", async () => {
		const pending = deferred<ReturnType<typeof assistant>>();
		const { pi, ctx, state, client } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			registry: {
				"anthropic/claude-sonnet-4-5": fakeModel(
					"anthropic",
					"claude-sonnet-4-5",
				),
			},
			config: withConfig((config) => {
				config.autoTitle.model = "anthropic/claude-sonnet-4-5";
			}),
			responders: [() => pending.promise],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		assert.equal(client.calls.length, 1);
		pi.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit" },
			ctx,
		);
		await flush();
		assert.equal(client.calls[0].options.signal.aborted, true);
		assert.equal(client.calls.length, 1);
		assert.deepEqual(pi.appended, []);
		assert.deepEqual(state.notifications, []);
		assert.ok(
			!state.titles.some((title) => title.includes("Pi - フォーム公開API改善")),
		);
	});

	test("tree navigation cancels the request and drops its result", async () => {
		const pending = deferred<ReturnType<typeof assistant>>();
		const { pi, ctx, state, client } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			responders: [() => pending.promise],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		assert.equal(client.calls.length, 1);
		state.entries = [
			userEntry("フォーム公開APIを改善して"),
			titleEntry("別ブランチのタイトル"),
		];
		pi.emit("session_tree", { type: "session_tree" }, ctx);
		assert.equal(client.calls[0].options.signal.aborted, true);
		pending.resolve(assistant("古いタイトル"));
		await flush();
		assert.deepEqual(pi.appended, []);
		assert.equal(state.titles.at(-1), "Pi - 別ブランチのタイトル");
	});

	test("a session re-init without shutdown cancels the old request", async () => {
		const pending = deferred<ReturnType<typeof assistant>>();
		const { pi, ctx, state, client } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			responders: [() => pending.promise],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		assert.equal(client.calls.length, 1);

		state.sessionId = "session-2";
		state.entries = [];
		startSession(pi, ctx, "new");
		assert.equal(client.calls[0].options.signal.aborted, true);

		pending.resolve(assistant("古いタイトル"));
		await flush();
		assert.deepEqual(pi.appended, []);
		assert.ok(!state.titles.some((title) => title.includes("古いタイトル")));
	});

	test("the deadline stops the whole run, fallback included", async () => {
		const current = fakeModel("openai", "gpt-5.4");
		const { pi, ctx, client } = setup({
			currentModel: current,
			registry: {
				"anthropic/claude-sonnet-4-5": fakeModel(
					"anthropic",
					"claude-sonnet-4-5",
				),
			},
			config: withConfig((config) => {
				config.autoTitle.model = "anthropic/claude-sonnet-4-5";
			}),
			responders: [() => new Promise<ReturnType<typeof assistant>>(() => {})],
			timeoutMs: 20,
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(client.calls.length, 1);
		assert.equal(client.calls[0].options.signal.aborted, true);
	});
});

describe("session titles", () => {
	test("a resumed session restores its stored title without an AI request", async () => {
		const { pi, ctx, state, client } = setup({
			entries: [
				userEntry("フォーム公開APIを改善して"),
				titleEntry("フォーム公開API改善"),
			],
		});
		startSession(pi, ctx, "resume");
		assert.equal(state.titles.at(-1), "Pi - フォーム公開API改善");
		firstUserPrompt(pi, ctx, "テストも追加して");
		await flush();
		assert.equal(client.calls.length, 0);
		assert.deepEqual(pi.appended, []);
	});

	test("a resumed session without a stored title generates one from history", async () => {
		const { pi, ctx, client } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			entries: [userEntry("CircleCIの設定移行をレビューして")],
			responders: [() => assistant("CircleCI設定移行レビュー")],
		});
		startSession(pi, ctx, "resume");
		await flush();
		assert.equal(client.calls.length, 1);
		assert.equal(
			client.calls[0].context.messages[0].content,
			"CircleCIの設定移行をレビューして",
		);
		assert.deepEqual(pi.appended, [
			{
				customType: TITLE_ENTRY_TYPE,
				data: { title: "CircleCI設定移行レビュー" },
			},
		]);
	});

	test("a stored title is normalized and limited like a generated one", () => {
		const { pi, ctx, state } = setup({
			entries: [userEntry("作業"), titleEntry(`"**${"あ".repeat(50)}**"`)],
		});
		startSession(pi, ctx, "resume");
		assert.equal(state.titles.at(-1), `Pi - ${"あ".repeat(30)}`);
	});

	test("a corrupt stored title keeps the directory name", () => {
		for (const stored of ["", "   ", "\u0000\u0001", '""']) {
			const { pi, ctx, state } = setup({
				entries: [userEntry("作業"), titleEntry(stored)],
			});
			startSession(pi, ctx, "resume");
			assert.equal(state.titles.at(-1), "Pi - web-app");
		}
	});

	test("tree navigation rebuilds the title from the branch", () => {
		const { pi, ctx, state } = setup({
			entries: [userEntry("フォーム公開APIを改善して")],
		});
		startSession(pi, ctx);
		state.entries = [
			userEntry("フォーム公開APIを改善して"),
			titleEntry("別ブランチのタイトル"),
		];
		pi.emit("session_tree", { type: "session_tree" }, ctx);
		assert.equal(state.titles.at(-1), "Pi - 別ブランチのタイトル");
	});
});

describe("title restore on quit", () => {
	test("a quit restores the title to the empty string", () => {
		const { pi, ctx, state } = setup();
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		state.titles.length = 0;
		pi.emit(
			"session_shutdown",
			{
				type: "session_shutdown",
				reason: "quit",
			},
			ctx,
		);
		assert.deepEqual(state.titles, [""]);
	});

	test("a quit clears the title again at process exit, after Pi rewrites it", () => {
		const { pi, ctx, state, runProcessExit } = setup();
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		pi.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit" },
			ctx,
		);
		assert.equal(state.terminalTitle, "");
		// Pi writes `π - <dir>` again while tearing down its UI, after the event.
		state.terminalTitle = "π - web-app";
		state.titles.length = 0;
		runProcessExit();
		assert.deepEqual(state.titles, [""]);
		assert.equal(state.terminalTitle, "");
	});

	test("the exit restore is registered at most once per process", () => {
		const { pi, ctx, exitHooks } = setup();
		startSession(pi, ctx);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			pi.emit(
				"session_shutdown",
				{ type: "session_shutdown", reason: "quit" },
				ctx,
			);
		}
		assert.equal(exitHooks.length, 1);
	});

	test("an RPC quit clears the title once and registers no exit restore", () => {
		const { pi, ctx, state, exitHooks, runProcessExit } = setup({
			mode: "rpc",
		});
		startSession(pi, ctx);
		state.titles.length = 0;
		pi.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit" },
			ctx,
		);
		assert.deepEqual(state.titles, [""]);
		assert.deepEqual(exitHooks, []);
		runProcessExit();
		assert.deepEqual(state.titles, [""]);
	});

	test("session replacement and headless runs register no exit restore", () => {
		for (const reason of ["reload", "new", "resume", "fork"]) {
			const { pi, ctx, state, exitHooks, runProcessExit } = setup();
			startSession(pi, ctx);
			state.titles.length = 0;
			pi.emit("session_shutdown", { type: "session_shutdown", reason }, ctx);
			assert.deepEqual(exitHooks, []);
			runProcessExit();
			assert.deepEqual(state.titles, []);
		}
		const { pi, ctx, state, exitHooks, runProcessExit } = setup({
			hasUI: false,
		});
		startSession(pi, ctx);
		pi.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit" },
			ctx,
		);
		assert.deepEqual(exitHooks, []);
		runProcessExit();
		assert.deepEqual(state.titles, []);
	});

	test("session replacement and reload keep the title", () => {
		for (const reason of ["reload", "new", "resume", "fork"]) {
			const { pi, ctx, state } = setup();
			startSession(pi, ctx);
			state.titles.length = 0;
			pi.emit("session_shutdown", { type: "session_shutdown", reason }, ctx);
			assert.deepEqual(state.titles, []);
		}
	});

	test("a late generation result never re-sets the restored title", async () => {
		const pending = deferred<ReturnType<typeof assistant>>();
		const { pi, ctx, state, runScheduled } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			responders: [() => pending.promise],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		state.titles.length = 0;
		pi.emit(
			"session_shutdown",
			{
				type: "session_shutdown",
				reason: "quit",
			},
			ctx,
		);
		pending.resolve(assistant("フォーム公開API改善"));
		runScheduled();
		await flush();
		assert.deepEqual(state.titles, [""]);
		assert.deepEqual(pi.appended, []);
	});
});

describe("GenerationTracker", () => {
	test("a run owns the busy state until it finishes", () => {
		const tracker = new GenerationTracker();
		assert.equal(tracker.busy, false);
		const first = tracker.start();
		assert.ok(first !== undefined);
		assert.equal(tracker.busy, true);
		assert.equal(tracker.start(), undefined);
		tracker.finish(first);
		assert.equal(tracker.busy, false);
	});

	test("an older run cannot free a newer run's state", () => {
		const tracker = new GenerationTracker();
		const first = tracker.start();
		tracker.reset();
		const second = tracker.start();
		assert.ok(first !== undefined && second !== undefined);
		tracker.finish(first);
		assert.equal(tracker.busy, true);
		assert.equal(tracker.start(), undefined);
		tracker.finish(second);
		assert.equal(tracker.busy, false);
	});

	test("reset drops the active run", () => {
		const tracker = new GenerationTracker();
		const token = tracker.start();
		assert.ok(token !== undefined);
		tracker.reset();
		assert.equal(tracker.busy, false);
		tracker.finish(token);
		assert.equal(tracker.busy, false);
	});
});

describe("non-UI modes", () => {
	test("a mode without UI keeps the extension fully inert", async () => {
		const { pi, ctx, state, stallClock, client } = setup({
			hasUI: false,
			currentModel: fakeModel("openai", "gpt-5.4"),
			responders: [() => assistant("停滞せず")],
		});
		startSession(pi, ctx);
		assert.equal(state.titles.length, 0);
		// Agent activity and tool events produce neither titles nor watches.
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		stallClock.advance(300_000);
		assert.equal(state.titles.length, 0);
		assert.equal(stallClock.pendingCount(), 0);
		// No AI request is sent for the title either.
		firstUserPrompt(pi, ctx, "タイトル生成は不要");
		await flush();
		assert.equal(client.calls.length, 0);
		// Shutdown (and anything after it) stays harmless.
		pi.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit" },
			ctx,
		);
		assert.equal(state.titles.length, 0);
	});
});

describe("stall detection", () => {
	test("a silent tool switches the running marker to the stalled one", () => {
		const { pi, ctx, state, stallClock } = setup();
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		stallClock.advance(29_999);
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
		stallClock.advance(1);
		assert.equal(state.titles.at(-1), "⏸️ Pi - web-app");
	});

	test("a tool update restores the running marker and re-arms the deadline", () => {
		const { pi, ctx, state, stallClock } = setup();
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		stallClock.advance(30_000);
		assert.equal(state.titles.at(-1), "⏸️ Pi - web-app");
		toolEvent(pi, ctx, "tool_execution_update", "t1");
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
		stallClock.advance(29_999);
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
		stallClock.advance(1);
		assert.equal(state.titles.at(-1), "⏸️ Pi - web-app");
	});

	test("a tool end returns to running and leaves no timer behind", () => {
		const { pi, ctx, state, stallClock } = setup();
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		toolEvent(pi, ctx, "tool_execution_end", "t1");
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
		// The armed deadline was cancelled through the stall timer pair.
		assert.equal(stallClock.pendingCount(), 0);
		assert.ok(stallClock.cancelCount() > 0);
		stallClock.advance(120_000);
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
	});

	test("tool events while idle open no watches", () => {
		const { pi, ctx, state, stallClock } = setup();
		startSession(pi, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		stallClock.advance(300_000);
		assert.equal(state.titles.at(-1), "Pi - web-app");
		assert.equal(stallClock.pendingCount(), 0);
	});

	test("tool events after the run settled open no watches", () => {
		const { pi, ctx, state, stallClock } = setup();
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		stallClock.advance(30_000);
		assert.equal(state.titles.at(-1), "⏸️ Pi - web-app");
		pi.emit("agent_settled", { type: "agent_settled", aborted: true }, ctx);
		// A late start and a late end for the aborted run change nothing.
		toolEvent(pi, ctx, "tool_execution_start", "t2");
		toolEvent(pi, ctx, "tool_execution_end", "t1");
		stallClock.advance(300_000);
		assert.equal(state.titles.at(-1), "✅ Pi - web-app");
		assert.equal(stallClock.pendingCount(), 0);
	});

	test("one stalled tool keeps the title stalled while a parallel tool runs", () => {
		const { pi, ctx, state, stallClock } = setup();
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "a", "bash");
		stallClock.advance(10_000);
		toolEvent(pi, ctx, "tool_execution_start", "b", "read");
		stallClock.advance(20_000);
		assert.equal(state.titles.at(-1), "⏸️ Pi - web-app");
		// b's update does not clear a's stalled state.
		toolEvent(pi, ctx, "tool_execution_update", "b", "read");
		assert.equal(state.titles.at(-1), "⏸️ Pi - web-app");
		toolEvent(pi, ctx, "tool_execution_end", "a", "bash");
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
	});

	test("an AI title update keeps the current status marker", async () => {
		const pending = deferred<ReturnType<typeof assistant>>();
		const { pi, ctx, state, stallClock } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			responders: [() => pending.promise],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "Lambdaフォーム公開APIを実装して");
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		stallClock.advance(30_000);
		assert.equal(state.titles.at(-1), "⏸️ Pi - web-app");
		pending.resolve(assistant("Lambdaフォーム公開API"));
		await flush();
		assert.equal(state.titles.at(-1), "⏸️ Pi - Lambdaフォーム公開API");
	});

	test("agent_settled resets to idle and late deadlines change nothing", () => {
		const { pi, ctx, state, stallClock } = setup();
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		stallClock.advance(30_000);
		assert.equal(state.titles.at(-1), "⏸️ Pi - web-app");
		pi.emit("agent_settled", { type: "agent_settled", aborted: true }, ctx);
		assert.equal(state.titles.at(-1), "✅ Pi - web-app");
		stallClock.advance(300_000);
		assert.equal(state.titles.at(-1), "✅ Pi - web-app");
		assert.equal(stallClock.pendingCount(), 0);
	});

	test("a session restart clears the stalled state", () => {
		const { pi, ctx, state, stallClock } = setup();
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		stallClock.advance(30_000);
		assert.equal(state.titles.at(-1), "⏸️ Pi - web-app");
		startSession(pi, ctx, "resume");
		assert.equal(state.titles.at(-1), "Pi - web-app");
		stallClock.advance(300_000);
		assert.equal(state.titles.at(-1), "Pi - web-app");
	});

	test("a disabled stall detection never shows the stalled marker", () => {
		const { pi, ctx, state, stallClock } = setup({
			config: withConfig((config) => {
				config.statusIndicator.stallDetection.enabled = false;
			}),
		});
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		stallClock.advance(300_000);
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
		assert.equal(stallClock.pendingCount(), 0);
	});

	test("a disabled status indicator shows a plain title even while stalled", () => {
		const { pi, ctx, state, stallClock } = setup({
			config: withConfig((config) => {
				config.statusIndicator.enabled = false;
			}),
		});
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		stallClock.advance(30_000);
		assert.equal(state.titles.at(-1), "Pi - web-app");
	});

	test("a custom threshold is used for the deadline", () => {
		const { pi, ctx, state, stallClock } = setup({
			config: withConfig((config) => {
				config.statusIndicator.stallDetection.thresholdSeconds = 5;
			}),
		});
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		stallClock.advance(4_999);
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
		stallClock.advance(1);
		assert.equal(state.titles.at(-1), "⏸️ Pi - web-app");
	});

	test("/pi-auto-title init re-arms watches for the restored threshold", async () => {
		const { pi, ctx, state, stallClock, configPath } = setup({
			config: withConfig((config) => {
				config.statusIndicator.stallDetection.thresholdSeconds = 5;
			}),
		});
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		await pi.commands.get("pi-auto-title")?.handler("init", ctx);
		// The 5s timer was dropped; the new 30s deadline applies.
		stallClock.advance(5_000);
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
		stallClock.advance(25_000);
		assert.equal(state.titles.at(-1), "⏸️ Pi - web-app");
		assert.match(readFileSync(configPath, "utf8"), /"thresholdSeconds": 30/);
	});

	test("/pi-auto-title init recovers a tool stalled under the smaller threshold", async () => {
		const { pi, ctx, state, stallClock } = setup({
			config: withConfig((config) => {
				config.statusIndicator.stallDetection.thresholdSeconds = 5;
			}),
		});
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		toolEvent(pi, ctx, "tool_execution_start", "t1");
		stallClock.advance(5_000);
		assert.equal(state.titles.at(-1), "⏸️ Pi - web-app");
		await pi.commands.get("pi-auto-title")?.handler("init", ctx);
		// The same silence is well under the restored 30s threshold.
		assert.equal(state.titles.at(-1), "⏳ Pi - web-app");
		stallClock.advance(25_000);
		assert.equal(state.titles.at(-1), "⏸️ Pi - web-app");
	});
});

describe("/pi-auto-title init", () => {
	test("creates the default configuration file", async () => {
		const { pi, ctx, state, configPath } = setup();
		startSession(pi, ctx);
		const command = pi.commands.get("pi-auto-title");
		assert.ok(command);
		await command.handler("init", ctx);
		assert.ok(existsSync(configPath));
		const text = readFileSync(configPath, "utf8");
		assert.deepEqual(JSON.parse(text), DEFAULT_CONFIG);
		assert.ok(text.endsWith("}\n"));
		assert.match(state.notifications.at(-1)?.message ?? "", / created$/);
	});

	test("asks before resetting an existing file and honours the answer", async () => {
		const { pi, ctx, state, configPath } = setup();
		startSession(pi, ctx);
		const command = pi.commands.get("pi-auto-title");
		assert.ok(command);
		writeFileSync(configPath, '{"statusIndicator":{"idle":"[ok]"}}\n');

		// "No" is offered first, so a plain Enter does not overwrite.
		state.selectResult = "No";
		await command.handler("init", ctx);
		assert.equal(state.selections.length, 1);
		assert.match(state.selections[0].title, /already exists\. Overwrite/);
		assert.deepEqual(state.selections[0].options, ["No", "Yes"]);
		assert.match(state.notifications.at(-1)?.message ?? "", /left unchanged/);
		assert.equal(
			readFileSync(configPath, "utf8"),
			'{"statusIndicator":{"idle":"[ok]"}}\n',
		);

		// Esc cancels as well.
		state.selectResult = undefined;
		await command.handler("init", ctx);
		assert.equal(state.selections.length, 2);
		assert.match(state.notifications.at(-1)?.message ?? "", /cancelled/);
		assert.notEqual(
			readFileSync(configPath, "utf8"),
			`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`,
		);

		state.selectResult = "Yes";
		await command.handler("init", ctx);
		assert.equal(state.selections.length, 3);
		assert.deepEqual(
			JSON.parse(readFileSync(configPath, "utf8")),
			DEFAULT_CONFIG,
		);
		assert.match(
			state.notifications.at(-1)?.message ?? "",
			/reset to the defaults/,
		);
	});

	test("init is suggested as the argument", async () => {
		const { pi } = setup();
		const command = pi.commands.get("pi-auto-title");
		assert.ok(command);
		assert.ok(command.getArgumentCompletions);
		const items = command.getArgumentCompletions("");
		assert.ok(Array.isArray(items));
		assert.deepEqual(
			(items as { value: string }[]).map((item) => item.value),
			["init"],
		);
		const partial = command.getArgumentCompletions("in");
		assert.deepEqual(
			(partial as { value: string }[]).map((item) => item.value),
			["init"],
		);
		assert.equal(
			(command.getArgumentCompletions("reset") as unknown[] | null)?.length ??
				0,
			0,
		);
	});

	test("applies the new defaults to the running session", async () => {
		const { pi, ctx, state } = setup({
			entries: [
				userEntry("フォーム公開APIを改善して"),
				titleEntry("フォーム公開API改善"),
			],
			config: withConfig((config) => {
				config.statusIndicator.enabled = false;
			}),
		});
		startSession(pi, ctx);
		pi.emit("agent_start", { type: "agent_start" }, ctx);
		pi.emit(
			"agent_settled",
			{
				type: "agent_settled",
				aborted: false,
			},
			ctx,
		);
		assert.equal(state.titles.at(-1), "Pi - フォーム公開API改善");
		const command = pi.commands.get("pi-auto-title");
		assert.ok(command);
		await command.handler("init", ctx);
		assert.equal(state.titles.at(-1), "✅ Pi - フォーム公開API改善");
	});

	test("unknown arguments show the available commands", async () => {
		const { pi, ctx, state, configPath } = setup();
		startSession(pi, ctx);
		const command = pi.commands.get("pi-auto-title");
		assert.ok(command);
		await command.handler("", ctx);
		await command.handler("reset", ctx);
		assert.equal(existsSync(configPath), false);
		assert.match(
			state.notifications.at(-1)?.message ?? "",
			/\/pi-auto-title init/,
		);
	});
});
