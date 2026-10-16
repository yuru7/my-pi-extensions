import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { __resetInventoryCacheForTests, getInventoryMessage, stableStringify } from "../src/inventory.ts";

function tool(name: string, description: string, parameters: Record<string, unknown>): ToolInfo {
	return { name, description, parameters, sourceInfo: { path: `/install/${name}` } } as unknown as ToolInfo;
}

function textOf(message: { content: unknown }): string {
	const content = message.content;
	assert.ok(Array.isArray(content));
	const first = content[0] as { text?: string };
	return first.text ?? "";
}

describe("tool inventory", { concurrency: false }, () => {
	test("stableStringify sorts keys and matches JSON for arrays", () => {
		assert.equal(stableStringify({ b: 1, a: { d: true, c: undefined } }), '{"a":{"d":true},"b":1}');
		assert.equal(stableStringify([undefined, 1]), "[null,1]");
	});

	test("full mode includes descriptions and schemas in a stable order", () => {
		__resetInventoryCacheForTests();
		const message = getInventoryMessage(
			[tool("zeta", "last", { b: 1, a: 2 }), tool("alpha", "first", { z: true })],
			"full",
		);
		assert.ok(message);
		const text = textOf(message);
		assert.ok(text.indexOf("### alpha") < text.indexOf("### zeta"));
		assert.match(text, /Parameters: \{"a":2,"b":1\}/);
		assert.doesNotMatch(text, /\/install\//);
	});

	test("reuses the message until a description or schema changes", () => {
		__resetInventoryCacheForTests();
		const first = getInventoryMessage([tool("read", "read files", { path: { type: "string" } })], "full");
		const second = getInventoryMessage([tool("read", "read files", { path: { type: "string" } })], "full");
		assert.equal(first, second);
		const changed = getInventoryMessage([tool("read", "read files carefully", { path: { type: "string" } })], "full");
		assert.notEqual(first, changed);
	});

	test("names mode lists names only and active mode can be a subset", () => {
		__resetInventoryCacheForTests();
		const names = getInventoryMessage([tool("bash", "run", {}), tool("read", "read", {})], "names");
		assert.ok(names);
		assert.match(textOf(names), /- bash\n- read/);
		assert.doesNotMatch(textOf(names), /Parameters/);
		const active = getInventoryMessage([tool("read", "read", { path: "string" })], "active");
		assert.ok(active);
		assert.match(textOf(active), /### read/);
		assert.doesNotMatch(textOf(active), /bash/);
	});

	test("returns undefined for an empty registry", () => {
		assert.equal(getInventoryMessage([], "full"), undefined);
	});
});
