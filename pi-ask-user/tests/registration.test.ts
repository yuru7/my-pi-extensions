import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserQuestionTool } from "../src/ask-user-question.ts";
import { DEFAULT_PROMPT_GUIDELINES, DEFAULT_PROMPT_SNIPPET, DEFAULT_TOOL_DESCRIPTION } from "../src/guidance.ts";
import { QuestionParamsSchema } from "../src/tool/types.ts";

interface RegisteredTool {
	name: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: unknown;
}

/** Minimal ExtensionAPI stub: captures registerTool, ignores everything else. */
function fakePi() {
	const registered: RegisteredTool[] = [];
	const pi = {
		registerTool: (definition: unknown) => registered.push(definition as RegisteredTool),
		registerCommand: () => {},
		events: { on: () => {}, emit: () => {} },
	};
	return { pi: pi as unknown as ExtensionAPI, registered };
}

/** Point PI_CODING_AGENT_DIR at a fresh temp dir for one test (loadConfig reads it per call). */
function withAgentDir<T>(files: Record<string, string>, run: () => T): T {
	const dir = mkdtempSync(join(tmpdir(), "pi-ask-user-test-"));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

test("tool registers with the default guidance and the shared schema", () => {
	withAgentDir({}, () => {
		const { pi, registered } = fakePi();
		registerAskUserQuestionTool(pi);
		assert.equal(registered.length, 1);
		const tool = registered[0];
		assert.equal(tool.name, "ask_user");
		assert.equal(tool.description, DEFAULT_TOOL_DESCRIPTION);
		assert.equal(tool.promptSnippet, DEFAULT_PROMPT_SNIPPET);
		assert.deepEqual(tool.promptGuidelines, DEFAULT_PROMPT_GUIDELINES);
		assert.equal(tool.parameters, QuestionParamsSchema);
	});
});

test("guidance.* config overrides replace the default guidance fields", () => {
	withAgentDir(
		{
			"pi-ask-user.json": JSON.stringify({
				guidance: {
					description: "Custom description.",
					promptSnippet: "Custom snippet.",
					promptGuidelines: ["Custom guideline."],
				},
			}),
		},
		() => {
			const { pi, registered } = fakePi();
			registerAskUserQuestionTool(pi);
			const tool = registered[0];
			assert.equal(tool.description, "Custom description.");
			assert.equal(tool.promptSnippet, "Custom snippet.");
			assert.deepEqual(tool.promptGuidelines, ["Custom guideline."]);
		},
	);
});

test("partial guidance overrides fall back to the defaults field by field", () => {
	withAgentDir(
		{ "pi-ask-user.json": JSON.stringify({ guidance: { promptSnippet: "Only the snippet." } }) },
		() => {
			const { pi, registered } = fakePi();
			registerAskUserQuestionTool(pi);
			const tool = registered[0];
			assert.equal(tool.description, DEFAULT_TOOL_DESCRIPTION);
			assert.equal(tool.promptSnippet, "Only the snippet.");
			assert.deepEqual(tool.promptGuidelines, DEFAULT_PROMPT_GUIDELINES);
		},
	);
});
