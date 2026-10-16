/**
 * Executor prompt text for `standard` mode, plus the rpiv-advisor 2.13.8
 * baseline used only for token comparison.
 *
 * The advisor's own system prompt is loaded separately and is never added to
 * the executor prompt. `promptMode` selects the built-in text; a `guidance`
 * override replaces the snippet and guidelines without forking the package.
 * Additional modes can be added in {@link builtinGuidance}.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADVISOR_TOOL_NAME } from "./messages.ts";

export const ADVISOR_SYSTEM_PROMPT = readFileSync(
	fileURLToPath(new URL("./prompts/advisor-system.txt", import.meta.url)),
	"utf8",
).trimEnd();

export const STANDARD_DESCRIPTION =
	"Consult a stronger model for guidance. The conversation, including every tool call and result, is forwarded automatically; call advisor with no arguments, then resume the task with the advice.";

export const STANDARD_SNIPPET =
	"Consult a stronger model before substantive work, when stuck, or before declaring done";

export const STANDARD_GUIDELINES: readonly string[] = [
	"Call `advisor` before substantive work or major decisions — writing, editing, committing to an interpretation, or building on an assumption; routine orientation (finding files, reading a source) does not require a call.",
	"Call `advisor` before declaring completion, after the deliverable is durable (file written, result saved, or change committed). If the session ends during the call, only a durable result survives.",
	"Consult when stuck — repeated failures, approach not converging, or results that do not fit — or when considering a different approach.",
	"For multi-step tasks, consult before committing to an approach and before finishing. Most value is the first call, before the approach crystallizes; skip when tool output you just read dictates the next action.",
	"Give advice serious weight unless empirical results or primary evidence contradict it. A passing self-test shows the test missed what the advice checks, not that the advice is wrong.",
	'If advice conflicts with evidence already gathered, consult again ("I found X; you suggest Y; which constraint breaks the tie?") rather than switching silently; that is cheaper than the wrong branch.',
	"Quote or paraphrase each advisor result's key guidance (plan, correction, or stop) in the next visible user-facing reply before continuing. Collapsed tool output is not a substitute.",
];

/**
 * Verbatim executor prompt from `@juicesharp/rpiv-advisor` 2.13.8
 * (commit 1ffa165c224b5489fb5774a6652ef2e1c3bc6b2a). Comparison baseline only.
 */
export const BASELINE_DESCRIPTION =
	"Escalate to a stronger reviewer model for guidance. When you need " +
	"stronger judgment — a complex decision, an ambiguous failure, a problem " +
	"you're circling without progress — escalate to the advisor model for " +
	"guidance, then resume. Takes NO parameters — when you call advisor(), " +
	"your entire conversation history is automatically forwarded. The advisor " +
	"sees the task, every tool call you've made, every result you've seen.";

export const BASELINE_SNIPPET =
	"Escalate to a stronger reviewer model for guidance when stuck, before substantive work, or before declaring done";

export const BASELINE_GUIDELINES: readonly string[] = [
	"Call `advisor` BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. Orientation (finding files, fetching a source, seeing what's there) is not substantive work; writing, editing, and declaring an answer are.",
	"Also call `advisor` when you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.",
	"Also call `advisor` when stuck — errors recurring, approach not converging, results that don't fit — or when considering a change of approach.",
	"On tasks longer than a few steps, call `advisor` at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.",
	"Give the advisor's advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt — a passing self-test is not evidence the advice is wrong, it's evidence your test doesn't check what the advice is checking.",
	"If you've already retrieved data pointing one way and the advisor points another, don't silently switch — surface the conflict in one more `advisor` call (\"I found X, you suggest Y, which constraint breaks the tie?\"). A reconcile call is cheaper than committing to the wrong branch.",
	"After each `advisor` result, put the advisor's key guidance into your next visible reply to the user before continuing — quote or paraphrase the plan, correction, or stop signal. The user often cannot see collapsed tool results; do not keep the advisor's words only in silent tool context.",
];

export interface GuidanceOverride {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export interface ResolvedGuidance {
	promptSnippet: string;
	promptGuidelines: string[];
}

export function builtinGuidance(mode: string | undefined): ResolvedGuidance {
	// Only `standard` is implemented. Unknown modes fall back here; config warns.
	void mode;
	return { promptSnippet: STANDARD_SNIPPET, promptGuidelines: [...STANDARD_GUIDELINES] };
}

export function resolveGuidance(raw: unknown, mode: string | undefined): ResolvedGuidance {
	const builtin = builtinGuidance(mode);
	if (raw === undefined) return builtin;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return builtin;
	const record = raw as Record<string, unknown>;
	const snippet = record.promptSnippet;
	const guidelines = record.promptGuidelines;
	return {
		promptSnippet: typeof snippet === "string" && snippet.trim().length > 0 ? snippet : builtin.promptSnippet,
		promptGuidelines:
			Array.isArray(guidelines) &&
			guidelines.length > 0 &&
			guidelines.every((entry) => typeof entry === "string" && entry.trim().length > 0)
				? [...guidelines]
				: builtin.promptGuidelines,
	};
}

/** Lines Pi inserts into the system prompt for an active advisor tool. */
export function executorPromptLines(snippet: string, guidelines: readonly string[]): string[] {
	const lines = [`- ${ADVISOR_TOOL_NAME}: ${snippet}`];
	for (const guideline of guidelines) {
		const trimmed = guideline.trim();
		if (trimmed.length > 0) lines.push(`- ${trimmed}`);
	}
	return lines;
}
