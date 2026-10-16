import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { executeAdvisor } from "../src/execute.ts";
import { __resetInventoryCacheForTests } from "../src/inventory.ts";
import { ERR_EMPTY_RESPONSE, ERR_NO_MODEL } from "../src/messages.ts";
import { __setCompleteSimpleForTests, type CompleteSimpleFn } from "../src/pi-compat.ts";
import { ADVISOR_SYSTEM_PROMPT } from "../src/prompt.ts";
import { setAdvisorEffort, setAdvisorModel } from "../src/state.ts";
import {
	assistantMessage,
	createCtx,
	createHarness,
	emptyUsage,
	fakeModel,
	resetRuntime,
	useConfigDir,
} from "./helpers.ts";

interface Call {
	context: Context;
	options: SimpleStreamOptions | undefined;
}

describe("advisor execution", { concurrency: false }, () => {
	afterEach(() => {
		resetRuntime();
	});

	test("returns a tool error when no model is selected", async () => {
		const harness = createHarness();
		const result = await executeAdvisor(createCtx(), harness.pi, undefined, undefined);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.equal(text, ERR_NO_MODEL);
		assert.equal(result.details?.errorMessage, "no advisor model selected");
	});

	test("forwards the current branch, strips the in-flight call, and sends no tools", async () => {
		useConfigDir();
		__resetInventoryCacheForTests();
		const model = fakeModel();
		setAdvisorModel(model);
		setAdvisorEffort("high");
		const calls: Call[] = [];
		const complete: CompleteSimpleFn = async (_model, context, options) => {
			calls.push({ context, options });
			return assistantMessage("Do the parser first.");
		};
		__setCompleteSimpleForTests(complete);

		const session = SessionManager.inMemory("/tmp/pi-advisor-exec");
		session.appendMessage({ role: "user", content: "OLD_SECRET_TASK", timestamp: 1 });
		session.appendCompaction("COMPACTED_SUMMARY", "missing-id", 10);
		session.appendMessage({ role: "user", content: "NEW_TASK", timestamp: 2 });
		session.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "I should ask." },
				{ type: "toolCall", id: "call-1", name: "advisor", arguments: {} },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "executor",
			usage: emptyUsage(),
			stopReason: "toolUse",
			timestamp: 3,
		});

		const harness = createHarness();
		harness.allTools = [
			{ name: "read", description: "read files", parameters: { type: "object" } } as unknown as ToolInfo,
		];
		const updates: string[] = [];
		const ctx = createCtx({
			sessionManager: session,
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret-key" }) },
		});
		const result = await executeAdvisor(ctx, harness.pi, undefined, (update) => {
			const text = update.content?.[0];
			if (text && text.type === "text") updates.push(text.text);
		});

		assert.equal(result.details?.errorMessage, undefined);
		assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "Do the parser first.");
		assert.equal(result.details?.advisorModel, "anthropic:claude-opus");
		assert.equal(result.details?.effort, "high");
		assert.equal(result.details?.stopReason, "stop");
		assert.match(updates[0] ?? "", /Consulting advisor/);
		assert.equal(calls.length, 1);
		const request = calls[0];
		assert.ok(request);
		assert.deepEqual(request.context.tools, []);
		assert.equal(request.context.systemPrompt, ADVISOR_SYSTEM_PROMPT);
		assert.equal(request.options?.reasoning, "high");
		assert.equal(request.options?.apiKey, "secret-key");
		const serialized = JSON.stringify(request.context.messages);
		assert.match(serialized, /COMPACTED_SUMMARY/);
		assert.match(serialized, /NEW_TASK/);
		assert.doesNotMatch(serialized, /OLD_SECRET_TASK/);
		assert.doesNotMatch(serialized, /"name":"advisor"/);
		assert.match(serialized, /### read/);
	});

	test("keeps only the selected branch", async () => {
		useConfigDir();
		setAdvisorModel(fakeModel());
		const calls: Context[] = [];
		__setCompleteSimpleForTests(async (_model, context) => {
			calls.push(context);
			return assistantMessage("ok");
		});
		const user = { role: "user", content: "shared", timestamp: 1 };
		const left = assistantMessage("LEFT_BRANCH");
		const right = assistantMessage("RIGHT_BRANCH");
		const ctx = createCtx({
			sessionManager: {
				getEntries: () => [
					{ type: "message", id: "u", parentId: null, message: user },
					{ type: "message", id: "left", parentId: "u", message: left },
					{ type: "message", id: "right", parentId: "u", message: right },
				],
				getLeafId: () => "right",
			},
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
		});
		await executeAdvisor(ctx, createHarness().pi, undefined, undefined);
		const serialized = JSON.stringify(calls[0]?.messages);
		assert.match(serialized, /RIGHT_BRANCH/);
		assert.doesNotMatch(serialized, /LEFT_BRANCH/);
	});

	test("retries one empty response and does not retry abort or error", async () => {
		useConfigDir();
		setAdvisorModel(fakeModel());
		const script = [assistantMessage(""), assistantMessage("recovered")];
		let calls = 0;
		__setCompleteSimpleForTests(async () => {
			calls += 1;
			return script.shift() ?? assistantMessage("extra");
		});
		const ctx = createCtx({ modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) } });
		const recovered = await executeAdvisor(ctx, createHarness().pi, undefined, undefined);
		assert.equal(calls, 2);
		assert.equal(recovered.content[0]?.type === "text" ? recovered.content[0].text : "", "recovered");

		calls = 0;
		__setCompleteSimpleForTests(async () => {
			calls += 1;
			return assistantMessage("", "aborted");
		});
		const aborted = await executeAdvisor(ctx, createHarness().pi, undefined, undefined);
		assert.equal(calls, 1);
		assert.equal(aborted.details?.stopReason, "aborted");

		calls = 0;
		__setCompleteSimpleForTests(async () => {
			calls += 1;
			return assistantMessage("", "error");
		});
		const failed = await executeAdvisor(ctx, createHarness().pi, undefined, undefined);
		assert.equal(calls, 1);
		assert.match(failed.content[0]?.type === "text" ? failed.content[0].text : "", /provider failed/);
	});

	test("surfaces a second empty response and a thrown error as tool results", async () => {
		useConfigDir();
		setAdvisorModel(fakeModel());
		__setCompleteSimpleForTests(async () => assistantMessage(""));
		const ctx = createCtx({ modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) } });
		const empty = await executeAdvisor(ctx, createHarness().pi, undefined, undefined);
		assert.equal(empty.content[0]?.type === "text" ? empty.content[0].text : "", ERR_EMPTY_RESPONSE);
		assert.equal(empty.details?.errorMessage, "empty response");

		__setCompleteSimpleForTests(async () => {
			throw new Error("socket closed");
		});
		const thrown = await executeAdvisor(ctx, createHarness().pi, undefined, undefined);
		assert.match(thrown.content[0]?.type === "text" ? thrown.content[0].text : "", /socket closed/);
		assert.equal(thrown.details?.errorMessage, "socket closed");
	});

	test("uses the runtime facade for OAuth models and does not pass the preflight key", async () => {
		useConfigDir();
		setAdvisorModel(fakeModel({ provider: "github-copilot", id: "gpt-4" }));
		const seen: { apiKey?: string; bound: string }[] = [];
		const runtime = {
			label: "runtime",
			completeSimple(this: { label: string }, _model: Model<never>, _context: Context, options?: SimpleStreamOptions) {
				seen.push({ apiKey: options?.apiKey, bound: this.label });
				return Promise.resolve(assistantMessage("oauth advice"));
			},
		};
		const ctx = createCtx({
			modelRegistry: {
				runtime,
				getApiKeyAndHeaders: async () => ({ ok: true }),
			},
		});
		const result = await executeAdvisor(ctx, createHarness().pi, undefined, undefined);
		assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "oauth advice");
		assert.equal(seen[0]?.bound, "runtime");
		assert.equal(seen[0]?.apiKey, undefined);
	});

	test("reports missing credentials when no runtime facade is available", async () => {
		useConfigDir();
		setAdvisorModel(fakeModel());
		const ctx = createCtx({
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
		});
		const result = await executeAdvisor(ctx, createHarness().pi, undefined, undefined);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /no API key/);
	});

	test("reports registry auth failures without throwing", async () => {
		useConfigDir();
		setAdvisorModel(fakeModel());
		const ctx = createCtx({
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "bad config" }) },
		});
		const result = await executeAdvisor(ctx, createHarness().pi, undefined, undefined);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /bad config/);
		assert.equal(result.details?.errorMessage, "bad config");
	});
});
