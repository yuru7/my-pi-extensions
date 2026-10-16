import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { Type } from "typebox";
import { stableStringify } from "../src/inventory.ts";
import {
	BASELINE_DESCRIPTION,
	BASELINE_GUIDELINES,
	BASELINE_SNIPPET,
	executorPromptLines,
	resolveGuidance,
	STANDARD_DESCRIPTION,
	STANDARD_GUIDELINES,
	STANDARD_SNIPPET,
} from "../src/prompt.ts";

function countTokens(text: string): number {
	return encode(text).length;
}

async function buildSystemPrompt(options: {
	cwd: string;
	selectedTools: string[];
	toolSnippets: Record<string, string>;
	promptGuidelines?: string[];
}): Promise<string> {
	const href = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url)
		.href;
	const mod = (await import(href)) as {
		buildSystemPrompt: (input: typeof options) => string;
	};
	return mod.buildSystemPrompt(options);
}

function toolDefinition(description: string): string {
	return stableStringify({
		name: "advisor",
		description,
		parameters: Type.Object({}),
	});
}

function guidanceText(snippet: string, guidelines: readonly string[]): string {
	return executorPromptLines(snippet, guidelines).join("\n");
}

async function measurePrompt(description: string, snippet: string, guidelines: readonly string[]) {
	const definition = toolDefinition(description);
	const guidance = guidanceText(snippet, guidelines);
	const withAdvisor = await buildSystemPrompt({
		cwd: "/work",
		selectedTools: ["read", "bash", "advisor"],
		toolSnippets: { read: "Read a file", bash: "Run a command", advisor: snippet },
		promptGuidelines: [...guidelines],
	});
	const withoutAdvisor = await buildSystemPrompt({
		cwd: "/work",
		selectedTools: ["read", "bash"],
		toolSnippets: { read: "Read a file", bash: "Run a command" },
	});
	for (const line of executorPromptLines(snippet, guidelines)) {
		assert.ok(withAdvisor.includes(line), `missing prompt line: ${line}`);
		assert.equal(withoutAdvisor.includes(line), false);
	}
	return {
		toolDefinition: countTokens(definition),
		guidance: countTokens(guidance),
		total: countTokens(definition) + countTokens(guidance),
		systemPromptDelta: countTokens(withAdvisor) - countTokens(withoutAdvisor),
	};
}

const scenarios: { name: string; marker: string }[] = [
	{ name: "routine lookup does not require a call", marker: "routine orientation" },
	{ name: "file orientation does not require a call", marker: "finding files" },
	{ name: "substantive work requires a call", marker: "before substantive work or major decisions" },
	{ name: "architecture choice is a major decision", marker: "major decisions" },
	{ name: "ambiguous work is substantive", marker: "before substantive work or major decisions" },
	{ name: "repeated failures require a call", marker: "repeated failures" },
	{ name: "a change of approach requires a call", marker: "different approach" },
	{ name: "a serious decision requires a call", marker: "major decisions" },
	{ name: "an obvious next step does not require another call", marker: "tool output you just read" },
	{ name: "completion requires a call after the result is durable", marker: "before declaring completion" },
	{ name: "a conflict with evidence requires another call", marker: "consult again" },
	{ name: "the next reply must share the advice", marker: "next visible user-facing reply" },
];

describe("standard prompt", () => {
	test("keeps every call-decision condition from the baseline", () => {
		const text = [STANDARD_SNIPPET, ...STANDARD_GUIDELINES].join("\n");
		for (const scenario of scenarios) {
			assert.match(text, new RegExp(scenario.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), scenario.name);
		}
		assert.match(STANDARD_DESCRIPTION, /no arguments/);
		assert.match(STANDARD_DESCRIPTION, /every tool call and result/);
		assert.match(STANDARD_DESCRIPTION, /forwarded automatically/);
		assert.match(STANDARD_DESCRIPTION, /resume the task/);
		assert.match(text, /committing to an interpretation/);
		assert.match(text, /building on an assumption/);
		assert.match(text, /file written/);
		assert.match(text, /change committed/);
		assert.match(text, /not converging/);
		assert.match(text, /results that do not fit/);
		assert.match(text, /approach crystallizes/);
		assert.match(text, /passing self-test/);
		assert.match(text, /missed what the advice checks/);
		assert.match(text, /I found X/);
		assert.match(text, /cheaper than the wrong branch/);
		assert.match(text, /Quote or paraphrase/);
	});

	test("uses a guidance override when one is configured", () => {
		const resolved = resolveGuidance(
			{ promptSnippet: "custom snippet", promptGuidelines: ["custom rule"] },
			"standard",
		);
		assert.equal(resolved.promptSnippet, "custom snippet");
		assert.deepEqual(resolved.promptGuidelines, ["custom rule"]);
		const fallback = resolveGuidance({ promptSnippet: "  ", promptGuidelines: [""] }, "nope");
		assert.equal(fallback.promptSnippet, STANDARD_SNIPPET);
		assert.deepEqual(fallback.promptGuidelines, [...STANDARD_GUIDELINES]);
	});

	test("uses fewer executor tokens than the rpiv-advisor 2.13.8 baseline", async () => {
		const baseline = await measurePrompt(BASELINE_DESCRIPTION, BASELINE_SNIPPET, BASELINE_GUIDELINES);
		const standard = await measurePrompt(STANDARD_DESCRIPTION, STANDARD_SNIPPET, STANDARD_GUIDELINES);
		assert.ok(standard.toolDefinition < baseline.toolDefinition);
		assert.ok(standard.guidance < baseline.guidance);
		assert.ok(standard.systemPromptDelta < baseline.systemPromptDelta);
		assert.ok(standard.total < baseline.total);
		assert.deepEqual(baseline, {
			toolDefinition: 95,
			guidance: 412,
			total: 507,
			systemPromptDelta: 412,
		});
		assert.deepEqual(standard, {
			toolDefinition: 52,
			guidance: 282,
			total: 334,
			systemPromptDelta: 282,
		});
	});
});
