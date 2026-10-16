import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { filterItems, fuzzyScore, isBackspace, isPrintable } from "../src/fuzzy.ts";

describe("fuzzy picker", () => {
	test("scores contiguous and boundary matches above scattered ones", () => {
		const contiguous = fuzzyScore("op", "opus");
		const scattered = fuzzyScore("op", "x o y p");
		assert.ok(contiguous !== null && scattered !== null);
		assert.ok(contiguous > scattered);
		assert.equal(fuzzyScore("zzz", "opus"), null);
		assert.equal(fuzzyScore("", "opus"), 0);
	});

	test("filters by label and value, and keeps the original order for an empty query", () => {
		const items = [
			{ value: "anthropic/claude-opus", label: "Opus  (anthropic)" },
			{ value: "openai/gpt", label: "GPT  (openai)" },
		];
		assert.deepEqual(filterItems(items, ""), items);
		assert.deepEqual(
			filterItems(items, "opus").map((item) => item.value),
			["anthropic/claude-opus"],
		);
		assert.deepEqual(
			filterItems(items, "openai").map((item) => item.value),
			["openai/gpt"],
		);
	});

	test("classifies picker key input", () => {
		assert.equal(isBackspace("\u007f"), true);
		assert.equal(isBackspace("\b"), true);
		assert.equal(isPrintable("a"), true);
		assert.equal(isPrintable("\u001b"), false);
		assert.equal(isPrintable("up"), false);
	});
});
