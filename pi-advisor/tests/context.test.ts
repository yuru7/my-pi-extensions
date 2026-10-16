import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { ensureUserTailForAdvisor, stripInflightAdvisorCall, stripToolDeclarations } from "../src/context.ts";
import { MSG_ADVISOR_NUDGE } from "../src/messages.ts";

function assistant(parts: AssistantMessage["content"]): Message {
	return {
		role: "assistant",
		content: parts,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

describe("conversation shaping", () => {
	test("removes only the in-flight advisor call and drops an empty tail", () => {
		const kept = assistant([
			{ type: "text", text: "note" },
			{ type: "toolCall", id: "other", name: "read", arguments: {} },
			{ type: "toolCall", id: "adv", name: "advisor", arguments: {} },
		]);
		const stripped = stripInflightAdvisorCall([kept]);
		assert.equal(stripped.length, 1);
		const content = (stripped[0] as AssistantMessage).content;
		assert.deepEqual(
			content.map((part) => (part.type === "toolCall" ? part.name : part.type)),
			["text", "read"],
		);

		const onlyAdvisor = assistant([{ type: "toolCall", id: "adv", name: "advisor", arguments: {} }]);
		assert.deepEqual(stripInflightAdvisorCall([onlyAdvisor]), []);
	});

	test("appends a user nudge when the tail is an assistant message", () => {
		const messages = ensureUserTailForAdvisor([assistant([{ type: "text", text: "thinking" }])]);
		const tail = messages[messages.length - 1];
		assert.equal(tail?.role, "user");
		assert.equal(
			tail &&
				tail.role === "user" &&
				Array.isArray(tail.content) &&
				tail.content[0]?.type === "text" &&
				tail.content[0].text,
			MSG_ADVISOR_NUDGE,
		);
	});

	test("drops executor tool declarations from system messages", () => {
		const system = {
			role: "system" as const,
			content: "prompt",
			toolsAdded: [{ name: "bash" }],
			toolsRemoved: [{ name: "read" }],
		};
		const stripped = stripToolDeclarations([system]);
		assert.equal("toolsAdded" in (stripped[0] ?? {}), false);
		assert.equal("toolsRemoved" in (stripped[0] ?? {}), false);
		assert.equal((stripped[0] as { content?: string }).content, "prompt");
		const unchanged = [{ role: "user" }];
		assert.equal(stripToolDeclarations(unchanged), unchanged);
	});
});
