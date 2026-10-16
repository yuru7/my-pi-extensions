import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isExecutorBlocked, isModelBlocked, setDisabledForModels } from "../src/policy.ts";
import { fakeModel } from "./helpers.ts";

describe("disabledForModels", { concurrency: false }, () => {
	test("blocks a string entry at any effort, including legacy colon keys", () => {
		const model = fakeModel();
		setDisabledForModels(["anthropic:claude-opus"]);
		assert.equal(isModelBlocked(model, "low"), true);
		assert.equal(isModelBlocked(model, undefined), true);
		assert.equal(isModelBlocked(undefined, "high"), false);
	});

	test("blocks an object entry at or above minEffort", () => {
		const model = fakeModel({ provider: "openai", id: "gpt" });
		setDisabledForModels([{ model: "openai/gpt", minEffort: "high" }]);
		assert.equal(isModelBlocked(model, "medium"), false);
		assert.equal(isModelBlocked(model, "high"), true);
		assert.equal(isModelBlocked(model, "xhigh"), true);
		assert.equal(isModelBlocked(model, "off"), false);
		assert.equal(isModelBlocked(model, undefined), false);
		assert.equal(isModelBlocked(model, "mystery"), false);
	});

	test("an object entry without minEffort always blocks", () => {
		const model = fakeModel();
		setDisabledForModels([{ model: "anthropic/claude-opus" }]);
		assert.equal(isExecutorBlocked({ model } as ExtensionContext, "minimal"), true);
	});
});
