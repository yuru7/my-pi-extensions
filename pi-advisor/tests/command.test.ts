import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	applyDisable,
	applyEnable,
	buildEffortItems,
	buildModelItems,
	registerAdvisorCommand,
} from "../src/command.ts";
import { __setAdvisorConfigPathForTests, advisorConfigPath } from "../src/config.ts";
import { ADVISOR_TOOL_NAME, MSG_EFFORT_NOT_SET, MSG_REQUIRES_INTERACTIVE, NO_ADVISOR_VALUE } from "../src/messages.ts";
import { getAdvisorEffort, getAdvisorModel } from "../src/state.ts";
import { createCtx, createHarness, fakeModel, resetRuntime, useConfigDir } from "./helpers.ts";

describe("/advisor command", { concurrency: false }, () => {
	afterEach(() => {
		resetRuntime();
	});

	test("lists models with the current selection and a No advisor row", () => {
		const current = fakeModel();
		const other = fakeModel({ provider: "openai", id: "gpt", name: "GPT" });
		const items = buildModelItems([other, current], "anthropic/claude-opus");
		assert.match(items[1]?.label ?? "", /Opus/);
		assert.match(items[1]?.label ?? "", /✓/);
		assert.equal(items.at(-1)?.value, NO_ADVISOR_VALUE);
		const efforts = buildEffortItems(current);
		assert.equal(efforts[0]?.value, "__off__");
		assert.match(efforts.find((item) => item.value === "high")?.label ?? "", /recommended/);
		assert.equal(
			efforts.some((item) => item.value === "off"),
			false,
		);
		assert.equal(
			efforts.some((item) => item.value === "xhigh"),
			false,
		);
	});

	test("refuses to run without interactive UI", async () => {
		const harness = createHarness();
		registerAdvisorCommand(harness.pi);
		const ctx = createCtx({ hasUI: false });
		await harness.commands.get("advisor")?.handler("", ctx as never);
		assert.equal(ctx.notifications[0]?.message, MSG_REQUIRES_INTERACTIVE);
	});

	test("keeps memory unchanged when saving fails", () => {
		const dir = useConfigDir();
		const blocker = join(dir, "blocked");
		writeFileSync(blocker, "x");
		__setAdvisorConfigPathForTests(join(blocker, "pi-advisor.json"));
		const harness = createHarness();
		const ctx = createCtx();
		applyEnable(harness.pi, ctx, fakeModel(), "high");
		assert.equal(getAdvisorModel(), undefined);
		assert.equal(ctx.notifications[0]?.level, "error");
		assert.deepEqual(harness.active, ["read", "bash"]);
	});

	test("persists a model, and cancelling effort still keeps that model", async () => {
		useConfigDir();
		const model = fakeModel();
		const harness = createHarness();
		registerAdvisorCommand(harness.pi);
		const ctx = createCtx({
			modelRegistry: { getAvailable: () => [model] },
			customResults: ["anthropic/claude-opus", null],
		});
		await harness.commands.get("advisor")?.handler("", ctx as never);
		assert.equal(getAdvisorModel()?.id, "claude-opus");
		assert.equal(getAdvisorEffort(), undefined);
		assert.equal(ctx.notifications[0]?.message, MSG_EFFORT_NOT_SET);
		assert.match(ctx.notifications[1]?.message ?? "", /Advisor: anthropic\/claude-opus$/);
		const saved = JSON.parse(readFileSync(advisorConfigPath(), "utf8")) as { model?: string; effort?: string };
		assert.equal(saved.model, "anthropic/claude-opus");
		assert.equal(saved.effort, undefined);
		assert.ok(harness.active.includes(ADVISOR_TOOL_NAME));
	});

	test("disabling removes the tool and the saved selection", () => {
		useConfigDir();
		const harness = createHarness();
		harness.active = ["read", ADVISOR_TOOL_NAME];
		const ctx = createCtx();
		applyDisable(harness.pi, ctx);
		assert.equal(getAdvisorModel(), undefined);
		assert.deepEqual(harness.active, ["read"]);
		const saved = JSON.parse(readFileSync(advisorConfigPath(), "utf8")) as Record<string, unknown>;
		assert.equal("model" in saved, false);
	});
});
