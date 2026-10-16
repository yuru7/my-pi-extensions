import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canonicalModelKey, parseModelKey } from "../src/model-key.ts";

describe("model keys", () => {
	test("parses slash keys and legacy colon keys", () => {
		assert.deepEqual(parseModelKey("anthropic/claude-opus"), { provider: "anthropic", modelId: "claude-opus" });
		assert.deepEqual(parseModelKey("anthropic:claude-opus"), { provider: "anthropic", modelId: "claude-opus" });
		assert.deepEqual(parseModelKey("openai/org/model:fast"), { provider: "openai", modelId: "org/model:fast" });
		assert.equal(parseModelKey("nosep"), undefined);
		assert.equal(parseModelKey(""), undefined);
	});

	test("canonicalizes legacy keys to slash form", () => {
		assert.equal(canonicalModelKey("anthropic:claude-opus"), "anthropic/claude-opus");
		assert.equal(canonicalModelKey("already/slash"), "already/slash");
	});
});
