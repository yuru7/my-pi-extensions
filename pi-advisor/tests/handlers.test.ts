import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
	reconcileAdvisorTool,
	registerAdvisorBeforeAgentStart,
	registerModelSelectHandler,
	registerThinkingLevelSelectHandler,
} from "../src/handlers.ts";
import { ADVISOR_TOOL_NAME } from "../src/messages.ts";
import { setAdvisorEffort, setAdvisorModel } from "../src/state.ts";
import { createCtx, createHarness, fakeModel, resetRuntime } from "./helpers.ts";

describe("tool activation", { concurrency: false }, () => {
	afterEach(() => {
		resetRuntime();
	});

	test("removes only the advisor tool and does not add a duplicate", () => {
		const harness = createHarness();
		harness.active = ["read", ADVISOR_TOOL_NAME, "bash"];
		const ctx = createCtx();
		reconcileAdvisorTool(harness.pi, ctx, { blocked: true, notify: { disabled: "off", restored: "on" } });
		assert.deepEqual(harness.active, ["read", "bash"]);
		assert.deepEqual(ctx.notifications, [{ message: "off", level: "info" }]);

		reconcileAdvisorTool(harness.pi, ctx, { blocked: false, notify: { disabled: "off", restored: "on" } });
		assert.deepEqual(harness.active, ["read", "bash", ADVISOR_TOOL_NAME]);
		reconcileAdvisorTool(harness.pi, ctx, { blocked: false });
		assert.deepEqual(harness.active, ["read", "bash", ADVISOR_TOOL_NAME]);
	});

	test("strips the tool before a turn when no advisor model is selected", async () => {
		const harness = createHarness();
		harness.active = ["read", ADVISOR_TOOL_NAME];
		registerAdvisorBeforeAgentStart(harness.pi);
		const handler = harness.listeners.get("before_agent_start")?.[0];
		assert.ok(handler);
		await handler({} as never, createCtx());
		assert.deepEqual(harness.active, ["read"]);
	});

	test("follows executor model and thinking level, and ignores session restore", async () => {
		const harness = createHarness();
		const advisor = fakeModel({ provider: "openai", id: "advisor" });
		const executor = fakeModel({ provider: "anthropic", id: "executor" });
		setAdvisorModel(advisor);
		setAdvisorEffort("high");
		const { setDisabledForModels } = await import("../src/policy.ts");
		setDisabledForModels([{ model: "anthropic/executor", minEffort: "high" }]);

		registerModelSelectHandler(harness.pi);
		registerThinkingLevelSelectHandler(harness.pi);
		const onModel = harness.listeners.get("model_select")?.[0];
		const onThinking = harness.listeners.get("thinking_level_select")?.[0];
		assert.ok(onModel && onThinking);

		harness.active = ["read", ADVISOR_TOOL_NAME];
		const ctx = createCtx({ model: executor });
		await onModel({ source: "restore", model: executor } as never, ctx);
		assert.deepEqual(harness.active, ["read", ADVISOR_TOOL_NAME]);
		assert.equal(ctx.notifications.length, 0);

		harness.thinking = "high";
		await onModel({ source: "set", model: executor } as never, ctx);
		assert.deepEqual(harness.active, ["read"]);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /disabled for anthropic\/executor/);

		harness.thinking = "low";
		await onThinking({ level: "low" } as never, ctx);
		assert.deepEqual(harness.active, ["read", ADVISOR_TOOL_NAME]);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /Advisor restored: openai\/advisor, high/);
	});
});
