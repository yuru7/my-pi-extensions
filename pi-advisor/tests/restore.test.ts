import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import { advisorConfigPath } from "../src/config.ts";
import { ADVISOR_TOOL_NAME } from "../src/messages.ts";
import { restoreAdvisorState } from "../src/restore.ts";
import { getAdvisorEffort, getAdvisorModel } from "../src/state.ts";
import { createCtx, createHarness, fakeModel, resetRuntime, useConfigDir } from "./helpers.ts";

describe("session restore", { concurrency: false }, () => {
	afterEach(() => {
		resetRuntime();
	});

	test("clears a stale model and strips the tool when nothing is configured", () => {
		useConfigDir();
		const harness = createHarness();
		harness.active = ["read", ADVISOR_TOOL_NAME];
		const ctx = createCtx();
		restoreAdvisorState(ctx, harness.pi);
		assert.equal(getAdvisorModel(), undefined);
		assert.deepEqual(harness.active, ["read"]);
		assert.equal(ctx.notifications.length, 0);
	});

	test("warns once when the saved model is gone and does not repeat on the next session", () => {
		useConfigDir();
		writeFileSync(advisorConfigPath(), JSON.stringify({ model: "missing/model", effort: "high" }), "utf8");
		const harness = createHarness();
		harness.active = [ADVISOR_TOOL_NAME];
		const ctx = createCtx();
		restoreAdvisorState(ctx, harness.pi);
		restoreAdvisorState(ctx, harness.pi);
		assert.equal(getAdvisorModel(), undefined);
		assert.deepEqual(harness.active, []);
		assert.equal(ctx.notifications.length, 1);
		assert.equal(ctx.notifications[0]?.level, "warning");
	});

	test("restores the model and activates the tool once", () => {
		useConfigDir();
		const model = fakeModel();
		writeFileSync(advisorConfigPath(), JSON.stringify({ model: "anthropic/claude-opus", effort: "high" }), "utf8");
		const harness = createHarness();
		const ctx = createCtx({
			modelRegistry: { find: () => model },
		});
		restoreAdvisorState(ctx, harness.pi);
		restoreAdvisorState(ctx, harness.pi);
		assert.equal(getAdvisorModel(), model);
		assert.equal(getAdvisorEffort(), "high");
		assert.deepEqual(harness.active, ["read", "bash", ADVISOR_TOOL_NAME]);
		assert.equal(ctx.notifications.length, 1);
		assert.match(ctx.notifications[0]?.message ?? "", /Advisor restored: anthropic\/claude-opus, high/);
	});

	test("stays inactive when the executor is blocklisted", async () => {
		useConfigDir();
		const advisor = fakeModel({ provider: "openai", id: "advisor" });
		const executor = fakeModel();
		writeFileSync(
			advisorConfigPath(),
			JSON.stringify({ model: "openai/advisor", effort: "low", disabledForModels: ["anthropic/claude-opus"] }),
			"utf8",
		);
		const harness = createHarness();
		harness.active = ["read", ADVISOR_TOOL_NAME];
		const ctx = createCtx({
			model: executor,
			modelRegistry: {
				find: (provider: string) => (provider === "openai" ? advisor : undefined),
			},
		});
		restoreAdvisorState(ctx, harness.pi);
		assert.equal(getAdvisorModel(), advisor);
		assert.deepEqual(harness.active, ["read"]);
		assert.match(ctx.notifications[0]?.message ?? "", /inactive for current executor/);
	});
});
