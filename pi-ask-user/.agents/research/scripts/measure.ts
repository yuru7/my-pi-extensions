// Token measurement for the pi-ask-user guidance variants (wave-2 research).
//
// Variants:
//   - rpiv  : juicesharp/rpiv-mono packages/rpiv-ask-user-question at commit
//             d3c6f0812140605a4e55e0a660eb83edc12abbc5 (see ./rpiv-schema.ts and
//             the DEFAULT_* constants below, copied verbatim with template
//             values resolved: MAX_QUESTIONS=4, MIN_OPTIONS=2, MAX_OPTIONS=4).
//   - old   : pi-ask-user before the wave-2 change (git show 5c0b0a3:pi-ask-user/src/guidance.ts).
//   - current: the working tree's ../../src/guidance.ts.
//
// What is measured (tokens via gpt-tokenizer o200k_base, plus raw chars):
//   1. System-prompt contribution: the "- <tool>: <snippet>" line pi's
//      buildSystemPrompt renders from promptSnippet, plus one "- <line>" per
//      promptGuidelines entry.
//   2. Tool-definition contribution: the { name, description, input_schema }
//      payload pi-ai sends for the Anthropic Messages API (schema descriptions
//      included). Provider-specific internal representations are NOT included;
//      these are o200k_base estimates, not provider-billed tokens.
//
// Setup (one-time, in this directory):
//   pnpm add gpt-tokenizer@4.1.0  # local node_modules/, gitignored
// Run:
//   node measure.ts
import { encode } from "gpt-tokenizer";
import { DEFAULT_PROMPT_GUIDELINES, DEFAULT_PROMPT_SNIPPET, DEFAULT_TOOL_DESCRIPTION } from "../../../src/guidance.ts";
import { QuestionParamsSchema } from "../../../src/tool/types.ts";
import { QuestionParamsSchema as RpivQuestionParamsSchema } from "./rpiv-schema.ts";

const tok = (s: string): number => encode(s).length;

/** Pi system-prompt contribution: one "Available tools" line + guideline lines. */
function systemPromptPart(toolName: string, snippet: string, guidelines: string[]) {
	const lines = [`- ${toolName}: ${snippet}`, ...guidelines.map((g) => `- ${g}`)];
	const text = lines.join("\n");
	return { chars: text.length, tokens: tok(text) };
}

/** Anthropic-style tool payload pi sends alongside the system prompt. */
function toolPayload(toolName: string, description: string, schema: { properties?: object; required?: string[] }) {
	const payload = {
		name: toolName,
		description,
		input_schema: { type: "object", properties: schema.properties ?? {}, required: schema.required ?? [] },
	};
	const text = JSON.stringify(payload);
	return { chars: text.length, tokens: tok(text) };
}

/** Token total of every `description` string in a TypeBox schema subtree. */
function schemaDescriptionTokens(schema: object): number {
	let total = 0;
	for (const [key, value] of Object.entries(schema)) {
		if (key === "description" && typeof value === "string") total += tok(value);
		if (value && typeof value === "object") total += schemaDescriptionTokens(value);
	}
	return total;
}

// --- rpiv guidance constants (verbatim from ask-user-question.ts at the pinned SHA) ---
const rpivSnippet = "Ask the user up to 4 structured questions (2-4 options each) when requirements are ambiguous";
const rpivGuidelines = [
	`Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to 4 questions per invocation.`,
	`Each question MUST have 2-4 options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.`,
	`Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. The "Type something." row is appended to every question; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.`,
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];
const rpivDescription = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. The "Type something." row is available on every question, including when options carry a \`preview\`; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;

// --- yuru7 guidance before the wave-2 change (5c0b0a3) ---
const oldSnippet = "Ask only when a decision is necessary and cannot be reasonably inferred. Batch related questions.";
const oldGuidelines: string[] = [];
const oldDescription = `Ask a structured question only when a decision is necessary and cannot be reasonably inferred. Batch related questions into one call (4 questions max, 2-4 options each). The user can pick, select several when multiSelect is true, or type their own answer. If you recommend an option, put it first and end its label with "(Recommended)". Do not author the reserved labels "Other", "Type something.", or "Next". Use options[].preview only on single-select questions that need a side-by-side comparison.`;

function report(label: string, toolName: string, snippet: string, guidelines: string[], description: string, schema: object) {
	const sys = systemPromptPart(toolName, snippet, guidelines);
	const tool = toolPayload(toolName, description, schema);
	const schemaOnly = toolPayload(toolName, "", schema);
	const schemaJson = JSON.stringify(schema);
	console.log(`\n=== ${label} ===`);
	console.log(`snippet line                     : ${tok(`- ${toolName}: ${snippet}`)} tokens`);
	guidelines.forEach((g, i) => {
		console.log(`guideline ${i + 1}                     : ${tok(`- ${g}`)} tokens`);
	});
	console.log(`system prompt total              : ${sys.tokens} tokens / ${sys.chars} chars`);
	console.log(`description                      : ${tok(description)} tokens / ${description.length} chars`);
	console.log(`schema description strings only  : ${schemaDescriptionTokens(schema)} tokens`);
	console.log(`schema JSON alone                : ${tok(schemaJson)} tokens / ${schemaJson.length} chars`);
	console.log(`tool payload whole (desc+schema) : ${tool.tokens} tokens / ${tool.chars} chars`);
	console.log(`tool payload without description : ${schemaOnly.tokens} tokens / ${schemaOnly.chars} chars`);
	console.log(`  (name + input_schema; differs from the schema JSON line by the wrapper keys)`);
	console.log(`REQUEST TOTAL (system + tool)    : ${sys.tokens + tool.tokens} tokens / ${sys.chars + tool.chars} chars`);
}

report("rpiv-ask-user-question (d3c6f08)", "ask_user_question", rpivSnippet, rpivGuidelines, rpivDescription, RpivQuestionParamsSchema);
report("pi-ask-user old (5c0b0a3)", "ask_user", oldSnippet, oldGuidelines, oldDescription, QuestionParamsSchema);
report("pi-ask-user current (wave-2)", "ask_user", DEFAULT_PROMPT_SNIPPET, DEFAULT_PROMPT_GUIDELINES, DEFAULT_TOOL_DESCRIPTION, QuestionParamsSchema);
