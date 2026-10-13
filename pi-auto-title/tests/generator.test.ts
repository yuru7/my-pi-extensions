import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AutoTitleSettings } from "../src/config.ts";
import {
	assistantText,
	buildTitleContext,
	generateTitle,
	MAX_INPUT_CHARS,
} from "../src/generator.ts";
import type { SessionModelInfo } from "../src/model.ts";
import { assistant, fakeModel, recordingClient } from "./helpers.ts";

const settings: AutoTitleSettings = {
	enabled: true,
	model: "CURRENT",
	thinkingLevel: "CURRENT",
	fallbackToCurrentModel: true,
};

function fakeInfo(
	currentModel: ReturnType<typeof fakeModel> | undefined,
	overrides: Partial<SessionModelInfo> = {},
): SessionModelInfo {
	return {
		currentModel,
		currentThinkingLevel: "off",
		findModel: () => undefined,
		hasAuth: () => true,
		...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("assistantText", () => {
	test("concatenates text blocks and ignores other blocks", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "..." },
				{ type: "text", text: "フォーム" },
				{ type: "text", text: "API" },
			],
		} as unknown as AssistantMessage;
		assert.equal(assistantText(message), "フォームAPI");
	});
});

describe("buildTitleContext", () => {
	test("sends the title prompt and the first user message", () => {
		const context = buildTitleContext(
			"AWS Lambdaでフォーム公開APIを実装したい",
		);
		assert.match(context.systemPrompt ?? "", /30 characters/);
		assert.equal(context.messages.length, 1);
		assert.equal(context.messages[0].role, "user");
		assert.equal(
			context.messages[0].content,
			"AWS Lambdaでフォーム公開APIを実装したい",
		);
	});

	test("caps the input length", () => {
		const context = buildTitleContext("x".repeat(MAX_INPUT_CHARS + 100));
		assert.equal(context.messages[0].content, "x".repeat(MAX_INPUT_CHARS));
	});
});

describe("generateTitle", () => {
	const current = fakeModel("openai", "gpt-5.4");
	const requested = fakeModel("anthropic", "claude-sonnet-4-5");

	test("disabled settings never call the model", async () => {
		const { client, calls } = recordingClient([]);
		const result = await generateTitle({
			settings: { ...settings, enabled: false },
			info: fakeInfo(current),
			client,
			firstUserText: "hello",
		});
		assert.equal(result.title, undefined);
		assert.equal(result.reason, "title generation is disabled");
		assert.equal(calls.length, 0);
	});

	test("a successful request returns the normalized title", async () => {
		const { client, calls } = recordingClient([
			() => assistant('"Lambdaフォーム公開API"'),
		]);
		const warnings: string[] = [];
		const result = await generateTitle({
			settings,
			info: fakeInfo(current),
			client,
			firstUserText: "AWS Lambdaでフォーム公開APIを実装したい",
			onFallback: (warning) => warnings.push(warning),
		});
		assert.equal(result.title, "Lambdaフォーム公開API");
		assert.deepEqual(warnings, []);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].model, current);
		assert.equal(calls[0].options.reasoning, undefined);
	});

	test("the configured thinking level is requested", async () => {
		const { client, calls } = recordingClient([() => assistant("タイトル")]);
		await generateTitle({
			settings: { ...settings, thinkingLevel: "high" },
			info: fakeInfo(fakeModel("anthropic", "claude-sonnet-4-5", true)),
			client,
			firstUserText: "hello",
		});
		assert.equal(calls[0].options.reasoning, "high");
	});

	test("a failed request falls back and warns before the fallback runs", async () => {
		const { client, calls } = recordingClient([
			() => Promise.reject(new Error("rate limited")),
			() => assistant("フォーム公開API改善"),
		]);
		const warnings: string[] = [];
		const result = await generateTitle({
			settings: { ...settings, model: "anthropic/claude-sonnet-4-5" },
			info: fakeInfo(current, { findModel: () => requested }),
			client,
			firstUserText: "hello",
			onFallback: (warning) => {
				assert.equal(calls.length, 1);
				warnings.push(warning);
			},
		});
		assert.equal(result.title, "フォーム公開API改善");
		assert.equal(calls.length, 2);
		assert.equal(calls[0].model, requested);
		assert.equal(calls[1].model, current);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /anthropic\/claude-sonnet-4-5/);
		assert.match(warnings[0], /openai\/gpt-5.4/);
		assert.match(warnings[0], /call failed/);
	});

	test("the fallback warning carries no provider error text", async () => {
		const { client } = recordingClient([
			() => Promise.reject(new Error("401 unauthorized sk-abcdef1234567890")),
			() => assistant("タイトル"),
		]);
		const warnings: string[] = [];
		const logged: string[] = [];
		const result = await generateTitle({
			settings: { ...settings, model: "anthropic/claude-sonnet-4-5" },
			info: fakeInfo(current, { findModel: () => requested }),
			client,
			firstUserText: "hello",
			onFallback: (warning) => warnings.push(warning),
			log: (message) => logged.push(message),
		});
		assert.equal(result.title, "タイトル");
		assert.equal(warnings.length, 1);
		assert.ok(!warnings[0].includes("401"));
		assert.ok(!warnings[0].includes("sk-abcdef1234567890"));
		assert.ok(logged.join("\n").includes("[redacted]"));
		assert.ok(!logged.join("\n").includes("sk-abcdef1234567890"));
	});

	test("an unusable configured model falls back before any request", async () => {
		const { client, calls } = recordingClient([
			() => assistant("フォーム公開API改善"),
		]);
		const warnings: string[] = [];
		const result = await generateTitle({
			settings: { ...settings, model: "anthropic/missing" },
			info: fakeInfo(current),
			client,
			firstUserText: "hello",
			onFallback: (warning) => warnings.push(warning),
		});
		assert.equal(result.title, "フォーム公開API改善");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].model, current);
		assert.match(warnings[0], /model not registered/);
	});

	test("a model without credentials warns with the credentials category", async () => {
		const { client, calls } = recordingClient([
			() => assistant("フォーム公開API改善"),
		]);
		const warnings: string[] = [];
		await generateTitle({
			settings: { ...settings, model: "anthropic/claude-sonnet-4-5" },
			info: fakeInfo(current, {
				findModel: () => requested,
				hasAuth: () => false,
			}),
			client,
			firstUserText: "hello",
			onFallback: (warning) => warnings.push(warning),
		});
		assert.equal(calls.length, 1);
		assert.match(warnings[0], /no credentials/);
	});

	test("a timeout failure warns with the timeout category", async () => {
		const { client } = recordingClient([
			() =>
				Promise.reject(
					Object.assign(new Error("connect ETIMEDOUT"), {
						name: "TimeoutError",
					}),
				),
			() => assistant("フォーム公開API改善"),
		]);
		const warnings: string[] = [];
		const result = await generateTitle({
			settings: { ...settings, model: "anthropic/claude-sonnet-4-5" },
			info: fakeInfo(current, { findModel: () => requested }),
			client,
			firstUserText: "hello",
			onFallback: (warning) => warnings.push(warning),
		});
		assert.equal(result.title, "フォーム公開API改善");
		assert.match(warnings[0], /timed out/);
		assert.ok(!warnings[0].includes("ETIMEDOUT"));
	});

	test("no fallback when it is disabled", async () => {
		const { client, calls } = recordingClient([
			() => Promise.reject(new Error("rate limited")),
		]);
		const warnings: string[] = [];
		const result = await generateTitle({
			settings: {
				...settings,
				model: "anthropic/claude-sonnet-4-5",
				fallbackToCurrentModel: false,
			},
			info: fakeInfo(current, { findModel: () => requested }),
			client,
			firstUserText: "hello",
			onFallback: (warning) => warnings.push(warning),
		});
		assert.equal(result.title, undefined);
		assert.equal(calls.length, 1);
		assert.match(result.reason ?? "", /rate limited/);
		assert.deepEqual(warnings, []);
	});

	test("gives up when the fallback fails too, keeping its warning", async () => {
		const { client, calls } = recordingClient([
			() =>
				Promise.reject(new Error("rate limited AIzaSyFAKE0123456789abcdef")),
			() =>
				({
					role: "assistant",
					content: [],
					stopReason: "error",
					// Not credential-shaped, so redactSecrets would not catch it.
					errorMessage: "upstream exploded, contact admin@example.com",
				}) as unknown as AssistantMessage,
		]);
		const warnings: string[] = [];
		const issues: string[] = [];
		const result = await generateTitle({
			settings: { ...settings, model: "anthropic/claude-sonnet-4-5" },
			info: fakeInfo(current, { findModel: () => requested }),
			client,
			firstUserText: "hello",
			onFallback: (warning) => warnings.push(warning),
			onIssue: (issue) => issues.push(issue),
		});
		assert.equal(result.title, undefined);
		assert.equal(calls.length, 2);
		// The detailed reason (log-only) keeps the text; the screen issue does not.
		assert.match(result.reason ?? "", /admin@example\.com/);
		assert.equal(warnings.length, 1);
		// The give-up issue names the fixed category only; neither the thrown
		// error text nor the assistant errorMessage reaches the screen.
		assert.equal(issues.length, 1);
		assert.equal(
			issues[0],
			"pi-auto-title: title generation failed: call failed",
		);
		assert.ok(!issues[0].includes("rate limited"));
		assert.ok(!issues[0].includes("AIzaSyFAKE"));
		assert.ok(!issues[0].includes("admin@example.com"));
	});

	test("empty model output counts as a failed request", async () => {
		const { client, calls } = recordingClient([
			() => assistant("   "),
			() => assistant("フォーム公開API改善"),
		]);
		const result = await generateTitle({
			settings: { ...settings, model: "anthropic/claude-sonnet-4-5" },
			info: fakeInfo(current, { findModel: () => requested }),
			client,
			firstUserText: "hello",
		});
		assert.equal(result.title, "フォーム公開API改善");
		assert.equal(calls.length, 2);
	});

	test("the deadline covers the whole run and stops the fallback", async () => {
		const { client, calls } = recordingClient([
			() => new Promise<AssistantMessage>(() => {}),
		]);
		const warnings: string[] = [];
		const result = await generateTitle({
			settings: { ...settings, model: "anthropic/claude-sonnet-4-5" },
			info: fakeInfo(current, { findModel: () => requested }),
			client,
			firstUserText: "hello",
			onFallback: (warning) => warnings.push(warning),
			timeoutMs: 20,
		});
		assert.equal(result.title, undefined);
		assert.equal(result.reason, "timed out after 20ms");
		assert.equal(calls.length, 1);
		assert.deepEqual(warnings, []);
		assert.equal(calls[0].options.signal.aborted, true);
		assert.equal(calls[0].options.timeoutMs, 20);
	});

	test("cancelling aborts the request and skips the fallback", async () => {
		const controller = new AbortController();
		const { client, calls } = recordingClient([
			() => new Promise<AssistantMessage>(() => {}),
		]);
		const warnings: string[] = [];
		const running = generateTitle({
			settings: { ...settings, model: "anthropic/claude-sonnet-4-5" },
			info: fakeInfo(current, { findModel: () => requested }),
			client,
			firstUserText: "hello",
			signal: controller.signal,
			onFallback: (warning) => warnings.push(warning),
			timeoutMs: 5_000,
		});
		assert.equal(calls.length, 1);
		controller.abort();
		const result = await running;
		assert.equal(result.title, undefined);
		assert.equal(result.reason, "the generation was cancelled");
		assert.equal(calls.length, 1);
		assert.deepEqual(warnings, []);
		assert.equal(calls[0].options.signal.aborted, true);
	});

	test("a slow failure leaves no fresh deadline for the fallback", async () => {
		const { client, calls } = recordingClient([
			() =>
				new Promise<AssistantMessage>((_resolve, reject) => {
					setTimeout(() => reject(new Error("rate limited")), 250);
				}),
			() => new Promise<AssistantMessage>(() => {}),
		]);
		const started = Date.now();
		const result = await generateTitle({
			settings: { ...settings, model: "anthropic/claude-sonnet-4-5" },
			info: fakeInfo(current, { findModel: () => requested }),
			client,
			firstUserText: "hello",
			timeoutMs: 300,
		});
		const elapsed = Date.now() - started;
		assert.equal(result.reason, "timed out after 300ms");
		assert.equal(calls.length, 2);
		assert.ok(
			elapsed < 450,
			`expected the original deadline, took ${elapsed}ms`,
		);
	});

	test("a title resolving at the moment of cancellation is discarded", async () => {
		const controller = new AbortController();
		const pending = deferred<AssistantMessage>();
		const { client } = recordingClient([() => pending.promise]);
		const running = generateTitle({
			settings: { ...settings, model: "anthropic/claude-sonnet-4-5" },
			info: fakeInfo(current, { findModel: () => requested }),
			client,
			firstUserText: "hello",
			signal: controller.signal,
			timeoutMs: 5_000,
		});
		pending.resolve(assistant("フォーム公開API改善"));
		controller.abort();
		const result = await running;
		assert.equal(result.title, undefined);
		assert.equal(result.reason, "the generation was cancelled");
	});

	test("an already cancelled run makes no request at all", async () => {
		const controller = new AbortController();
		controller.abort();
		const { client, calls } = recordingClient([]);
		const result = await generateTitle({
			settings,
			info: fakeInfo(current),
			client,
			firstUserText: "hello",
			signal: controller.signal,
		});
		assert.equal(result.reason, "the generation was cancelled");
		assert.equal(calls.length, 0);
	});
});
