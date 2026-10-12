import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerAutoTitle } from "../extensions/index.ts";
import {
	DEFAULT_CONFIG,
	defaultConfig,
	type AutoTitleConfig,
	type LoadConfigResult,
} from "../src/config.ts";
import {
	GenerationTracker,
	TITLE_ENTRY_TYPE,
	type SessionEntryLike,
} from "../src/session.ts";
import {
	assistant,
	fakeModel,
	flush,
	recordingClient,
	type Responder,
} from "./helpers.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface CommandOptions {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandOptions>();
	const appended: { customType: string; data: unknown }[] = [];
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
		registerCommand(name: string, options: CommandOptions) {
			commands.set(name, options);
		},
		appended,
		commands,
	};
}

type FakePi = ReturnType<typeof createFakePi>;

interface CtxOptions {
	cwd?: string;
	hasUI?: boolean;
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
	const state = {
		titles,
		notifications,
		confirmations,
		confirmResult: true,
		/** What the terminal currently displays, including writes from Pi itself. */
		terminalTitle: "",
		entries: options.entries ?? ([] as SessionEntryLike[]),
		sessionId: options.sessionId ?? "session-1",
	};
	const ctx = {
		mode: "tui",
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
	registerAutoTitle(pi as unknown as ExtensionAPI, {
		loadConfig: () => loaded,
		configPath: () => configPath,
		createClient: () => client.client,
		timeoutMs: options.timeoutMs ?? 5_000,
		setTimeout: scheduler.setTimeout,
		clearTimeout: scheduler.clearTimeout,
		log: (message) => logs.push(message),
	});
	const { ctx, state } = createCtx(options);
	return {
		pi,
		ctx,
		state,
		client,
		configPath,
		logs,
		runScheduled: scheduler.run,
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

	test("a failed generation keeps the directory name", async () => {
		const { pi, ctx, state, client } = setup({
			currentModel: fakeModel("openai", "gpt-5.4"),
			responders: [() => Promise.reject(new Error("provider down"))],
		});
		startSession(pi, ctx);
		firstUserPrompt(pi, ctx, "フォーム公開APIを改善して");
		await flush();
		assert.equal(client.calls.length, 1);
		assert.deepEqual(pi.appended, []);
		assert.equal(state.titles.at(-1), "Pi - web-app");
	});

	test("a fallback warns with a safe reason and still titles the tab", async () => {
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
		const warning = state.notifications.find(
			(entry) => entry.type === "warning",
		);
		assert.match(warning?.message ?? "", /anthropic\/claude-sonnet-4-5/);
		assert.match(warning?.message ?? "", /openai\/gpt-5.4/);
		assert.match(warning?.message ?? "", /呼び出し失敗/);
		assert.ok(!warning?.message.includes("rate limited"));
		assert.equal(ctx.model, current);
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

describe("/auto-title init", () => {
	test("creates the default configuration file", async () => {
		const { pi, ctx, state, configPath } = setup();
		startSession(pi, ctx);
		const command = pi.commands.get("auto-title");
		assert.ok(command);
		await command.handler("init", ctx);
		assert.ok(existsSync(configPath));
		const text = readFileSync(configPath, "utf8");
		assert.deepEqual(JSON.parse(text), DEFAULT_CONFIG);
		assert.ok(text.endsWith("}\n"));
		assert.match(state.notifications.at(-1)?.message ?? "", /作成/);
	});

	test("asks before resetting an existing file and honours a cancel", async () => {
		const { pi, ctx, state, configPath } = setup();
		startSession(pi, ctx);
		const command = pi.commands.get("auto-title");
		assert.ok(command);
		writeFileSync(configPath, '{"statusIndicator":{"idle":"[ok]"}}\n');

		state.confirmResult = false;
		await command.handler("init", ctx);
		assert.equal(state.confirmations.length, 1);
		assert.match(
			state.confirmations[0],
			/既存のpi-auto-title\.jsonをデフォルト設定で上書きしますか/,
		);
		assert.equal(
			readFileSync(configPath, "utf8"),
			'{"statusIndicator":{"idle":"[ok]"}}\n',
		);

		state.confirmResult = true;
		await command.handler("init", ctx);
		assert.equal(state.confirmations.length, 2);
		assert.deepEqual(
			JSON.parse(readFileSync(configPath, "utf8")),
			DEFAULT_CONFIG,
		);
		assert.match(state.notifications.at(-1)?.message ?? "", /リセット/);
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
		const command = pi.commands.get("auto-title");
		assert.ok(command);
		await command.handler("init", ctx);
		assert.equal(state.titles.at(-1), "✅ Pi - フォーム公開API改善");
	});

	test("unknown arguments show the available commands", async () => {
		const { pi, ctx, state, configPath } = setup();
		startSession(pi, ctx);
		const command = pi.commands.get("auto-title");
		assert.ok(command);
		await command.handler("", ctx);
		await command.handler("reset", ctx);
		assert.equal(existsSync(configPath), false);
		assert.match(
			state.notifications.at(-1)?.message ?? "",
			/\/auto-title init/,
		);
	});
});
