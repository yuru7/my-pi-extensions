import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import extension from "../extensions/index.ts";
import { advisorConfigPath } from "../src/config.ts";
import { ADVISOR_TOOL_NAME } from "../src/messages.ts";
import { STANDARD_GUIDELINES, STANDARD_SNIPPET } from "../src/prompt.ts";
import { getAdvisorModel } from "../src/state.ts";
import { createCtx, createHarness, fakeModel, resetRuntime, useConfigDir } from "./helpers.ts";

describe("extension wiring", { concurrency: false }, () => {
	afterEach(() => {
		resetRuntime();
	});

	test("leaves other tools in place and omits advisor guidance until a model is restored", async () => {
		useConfigDir();
		const harness = createHarness();
		harness.active = ["read", "bash", "other-extension"];
		extension(harness.pi);
		assert.equal(harness.tools.length, 1);
		assert.equal(harness.commands.has("pi-advisor"), true);
		const tool = harness.tools[0] as { promptSnippet?: string; promptGuidelines?: string[] };
		assert.equal(tool.promptSnippet, STANDARD_SNIPPET);
		assert.deepEqual(tool.promptGuidelines, [...STANDARD_GUIDELINES]);

		const start = harness.listeners.get("session_start")?.[0];
		assert.ok(start);
		await start({} as never, createCtx());
		assert.deepEqual(harness.active, ["read", "bash", "other-extension"]);
		assert.equal(harness.active.includes(ADVISOR_TOOL_NAME), false);
	});

	test("restores a configured model without dropping another extension's tool", async () => {
		useConfigDir();
		const model = fakeModel();
		writeFileSync(advisorConfigPath(), JSON.stringify({ model: "anthropic/claude-opus", effort: "low" }), "utf8");
		const harness = createHarness();
		harness.active = ["read", "other-extension"];
		extension(harness.pi);
		const start = harness.listeners.get("session_start")?.[0];
		assert.ok(start);
		await start({} as never, createCtx({ modelRegistry: { find: () => model, getAvailable: () => [model] } }));
		assert.equal(getAdvisorModel()?.id, "claude-opus");
		assert.deepEqual(harness.active, ["read", "other-extension", ADVISOR_TOOL_NAME]);
	});

	test("applies a guidance override from disk at registration", () => {
		useConfigDir();
		writeFileSync(
			advisorConfigPath(),
			JSON.stringify({ guidance: { promptSnippet: "override", promptGuidelines: ["one rule"] } }),
			"utf8",
		);
		const harness = createHarness();
		extension(harness.pi);
		const tool = harness.tools[0] as { promptSnippet?: string; promptGuidelines?: string[] };
		assert.equal(tool.promptSnippet, "override");
		assert.deepEqual(tool.promptGuidelines, ["one rule"]);
	});
});
