import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	__resetConfigWarningsForTests,
	__setAdvisorConfigPathForTests,
	advisorConfigPath,
	loadAdvisorSettings,
	saveAdvisorSelection,
} from "../src/config.ts";
import { resetRuntime, useConfigDir } from "./helpers.ts";

describe("config", { concurrency: false }, () => {
	afterEach(() => {
		resetRuntime();
	});

	test("uses defaults when the file is missing", () => {
		useConfigDir();
		const settings = loadAdvisorSettings();
		assert.equal(settings.model, undefined);
		assert.equal(settings.effort, undefined);
		assert.equal(settings.promptMode, "standard");
		assert.deepEqual(settings.disabledForModels, []);
		assert.equal(settings.toolInventory, "full");
	});

	test("warns and falls back on invalid JSON", () => {
		useConfigDir();
		writeFileSync(advisorConfigPath(), "{", "utf8");
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message?: unknown) => {
			warnings.push(String(message));
		};
		try {
			__resetConfigWarningsForTests();
			const settings = loadAdvisorSettings();
			assert.equal(settings.model, undefined);
			assert.match(warnings.join("\n"), /invalid JSON/);
		} finally {
			console.warn = original;
		}
	});

	test("drops invalid fields and keeps the rest", () => {
		useConfigDir();
		writeFileSync(
			advisorConfigPath(),
			JSON.stringify({
				model: 12,
				effort: "huge",
				promptMode: "minimal",
				toolInventory: "brief",
				disabledForModels: ["anthropic/opus", { model: "openai/gpt", minEffort: "nope" }, { model: "" }, ""],
				guidance: { promptSnippet: "keep me" },
			}),
			"utf8",
		);
		const settings = loadAdvisorSettings();
		assert.equal(settings.model, undefined);
		assert.equal(settings.effort, undefined);
		assert.equal(settings.promptMode, "standard");
		assert.equal(settings.toolInventory, "full");
		assert.deepEqual(settings.disabledForModels, ["anthropic/opus"]);
		assert.deepEqual(settings.guidance, { promptSnippet: "keep me" });
	});

	test("preserves unknown keys and manual settings across a selection save", () => {
		useConfigDir();
		writeFileSync(
			advisorConfigPath(),
			JSON.stringify({
				extra: { keep: true },
				promptMode: "standard",
				toolInventory: "names",
				guidance: { promptSnippet: "custom" },
				disabledForModels: ["anthropic/claude-opus"],
			}),
			"utf8",
		);
		assert.equal(saveAdvisorSelection("openai/gpt-5", "high"), true);
		const saved = JSON.parse(readFileSync(advisorConfigPath(), "utf8")) as Record<string, unknown>;
		assert.equal(saved.model, "openai/gpt-5");
		assert.equal(saved.effort, "high");
		assert.deepEqual(saved.extra, { keep: true });
		assert.equal(saved.toolInventory, "names");
		assert.deepEqual(saved.guidance, { promptSnippet: "custom" });
		assert.deepEqual(saved.disabledForModels, ["anthropic/claude-opus"]);
		assert.equal(statSync(advisorConfigPath()).mode & 0o777, 0o600);
	});

	test("clearing the selection deletes only model and effort", () => {
		useConfigDir();
		writeFileSync(
			advisorConfigPath(),
			JSON.stringify({ model: "a/b", modelKey: "legacy/key", effort: "low", extra: 1 }),
			"utf8",
		);
		assert.equal(saveAdvisorSelection(undefined, undefined), true);
		const saved = JSON.parse(readFileSync(advisorConfigPath(), "utf8")) as Record<string, unknown>;
		assert.equal("model" in saved, false);
		assert.equal("modelKey" in saved, false);
		assert.equal("effort" in saved, false);
		assert.equal(saved.extra, 1);
	});

	test("does not report success when the write fails", () => {
		const dir = useConfigDir();
		const blocker = join(dir, "not-a-directory");
		writeFileSync(blocker, "x");
		__setAdvisorConfigPathForTests(join(blocker, "pi-advisor.json"));
		assert.equal(saveAdvisorSelection("a/b", "low"), false);
		assert.equal(readFileSync(blocker, "utf8"), "x");
	});
});
