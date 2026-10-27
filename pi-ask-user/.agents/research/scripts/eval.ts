// Tool-selection evaluation harness (wave-2 research, plan Milestone 4/5).
//
// Three guidance variants share the same tool name ("ask_user"), the same JSON
// schema, and the same system-prompt scaffold; only description / promptSnippet
// / promptGuidelines differ. The rpiv variant's texts have occurrences of its
// own tool name "ask_user_question" normalized to "ask_user" so the comparison
// is not contaminated by a tool name the harness never registers.
//
// Runtime: Groq (OpenAI-compatible); the model is the MODEL constant below.
//   - 429 responses: retried up to 6 times with exponential backoff.
//   - HTTP 400 "Tool call validation failed" (the provider rejected the model's
//     tool-call arguments): recorded as outcome "invalid_args" — an ask attempt
//     whose arguments never reached the harness. Counted separately, excluded
//     from the recall / false-call denominators.
//   - Other errors: recorded as outcome "error" with the message; also excluded
//     from the denominators and reported per variant.
// Calls that succeed are validated with the extension's own runtime validator
// (validateQuestionnaire) plus schema limits, over every tool call.
//
// Setup (one-time, in this directory): pnpm add gpt-tokenizer@4.1.0 (only needed by
// measure.ts); this script needs no dependency. Env: GROQ_API_KEY.
// Run (each run writes eval-results-<timestamp>.json next to this file):
//   node eval.ts [variant ...]   # default: all variants
import fs from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROMPT_GUIDELINES, DEFAULT_PROMPT_SNIPPET, DEFAULT_TOOL_DESCRIPTION } from "../../../src/guidance.ts";
import { normalizeQuestionParams, prepareQuestionArguments } from "../../../src/tool/normalize-params.ts";
import type { QuestionParams } from "../../../src/tool/types.ts";
import { QuestionParamsSchema } from "../../../src/tool/types.ts";
import { validateQuestionnaire } from "../../../src/tool/validate-questionnaire.ts";

// gpt-oss-120b produced the 2026-10-20 run-1 raw data but exhausted the key's
// daily token budget mid-run; qwen3.8-27b was the last model attempted before
// the same budget stopped every Groq model (see wave-2-evaluation.md §5).
const MODEL = "qwen/qwen3.8-27b";
const REPEATS = 1;
const TEMPERATURE = 0.7;
const CONCURRENCY = 1;
const MAX_RETRIES = 6;
const API = "https://api.groq.com/openai/v1/chat/completions";

// --- Variant guidance texts -------------------------------------------------
// rpiv constants copied verbatim from packages/rpiv-ask-user-question/ask-user-question.ts
// at comparison commit d3c6f0812140605a4e55e0a660eb83edc12abbc5, with template
// values resolved (MAX_QUESTIONS=4, MIN_OPTIONS=2, MAX_OPTIONS=4) and the tool
// name normalized to "ask_user".
const withCommonName = (text: string): string => text.replaceAll("ask_user_question", "ask_user");
const rpivSnippet = "Ask the user up to 4 structured questions (2-4 options each) when requirements are ambiguous";
const rpivGuidelines = [
	withCommonName(
		`Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to 4 questions per invocation.`,
	),
	withCommonName(
		`Each question MUST have 2-4 options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.`,
	),
	`Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. The "Type something." row is appended to every question; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.`,
	withCommonName("Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation."),
];
const rpivDescription = withCommonName(`Ask the user one or more structured questions during execution. Use when you need to:
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

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`);

// pi-ask-user guidance before the wave-2 change (git 5c0b0a3), templates resolved.
const oldSnippet = "Ask only when a decision is necessary and cannot be reasonably inferred. Batch related questions.";
const oldGuidelines: string[] = [];
const oldDescription = `Ask a structured question only when a decision is necessary and cannot be reasonably inferred. Batch related questions into one call (4 questions max, 2-4 options each). The user can pick, select several when multiSelect is true, or type their own answer. If you recommend an option, put it first and end its label with "(Recommended)". Do not author the reserved labels "Other", "Type something.", or "Next". Use options[].preview only on single-select questions that need a side-by-side comparison.`;

interface GuidanceVariant {
	snippet: string;
	guidelines: string[];
	description: string;
}

const VARIANTS: Record<string, GuidanceVariant> = {
	A_rpiv: { snippet: rpivSnippet, guidelines: rpivGuidelines, description: rpivDescription },
	B_yuru7_old: { snippet: oldSnippet, guidelines: oldGuidelines, description: oldDescription },
	C_proposed: {
		snippet: DEFAULT_PROMPT_SNIPPET,
		guidelines: [...DEFAULT_PROMPT_GUIDELINES],
		description: DEFAULT_TOOL_DESCRIPTION,
	},
};

// Shared schema (the extension's QuestionParamsSchema) — identical across variants.
const schema = JSON.parse(JSON.stringify(QuestionParamsSchema));

// --- Evaluation cases ---------------------------------------------------------
interface Case {
	id: string;
	user: string;
	expect: "ask" | "no_ask" | "discretionary";
}
const CASES: Case[] = [
	{ id: "T01", user: "Create a dashboard page for our admin web app.", expect: "ask" },
	{
		id: "T02",
		user: "Implement the overtime approval rule for our HR system. Legal says it differs per situation, and I have not decided how ours should work.",
		expect: "ask",
	},
	{
		id: "T03",
		user: "Add a delete feature for user accounts in our SaaS admin service (PostgreSQL).",
		expect: "ask",
	},
	{
		id: "T04",
		user: "We are restructuring our growing frontend. I am torn between a modular monolith, micro-frontends, and islands architecture — help me decide which to adopt.",
		expect: "ask",
	},
	{
		id: "T05",
		user: "Task: add logging to the payment module. Our convention: all logs go through the logInfo/logError helpers in src/logger.ts.",
		expect: "no_ask",
	},
	{
		id: "T06",
		user: "Add a test for formatDate. Convention: tests live next to the source as <file>.test.ts and use describe/it blocks, like every other test in the repo.",
		expect: "no_ask",
	},
	{
		id: "T07",
		user: "Fix the API error message for invalid input: it currently returns 'Bad request', but our shared error helper already formats field names — just use it in that one handler.",
		expect: "no_ask",
	},
	{
		id: "T08",
		user: "We are starting a new system that stores customer PII. The authentication method has not been decided yet (OAuth provider, magic links, password+MFA are all on the table). Start building it.",
		expect: "ask",
	},
	{
		id: "T09",
		user: "Implement the user notification feature. Email vs in-app is undecided, delivery frequency is undecided, and whether we need a quiet-hours setting is undecided.",
		expect: "ask",
	},
	{
		id: "T10",
		user: "Implement fizzbuzz(n): return 'Fizz' for multiples of 3, 'Buzz' for multiples of 5, 'FizzBuzz' for both, otherwise the number as a string. TypeScript.",
		expect: "no_ask",
	},
	{
		id: "T11",
		user: "Do not ask me any questions. Implement a config loader with sane defaults and document the defaults in code comments.",
		expect: "no_ask",
	},
	{
		id: "T12",
		user: "Add auth-token persistence to our web app using localStorage — that is the standard default. Note: we do serve security-conscious enterprise customers.",
		expect: "discretionary",
	},
];

// --- Scaffold -----------------------------------------------------------------
function systemPrompt(v: GuidanceVariant): string {
	const guidelines = ["Be concise in your responses", ...v.guidelines]
		.map((g) => `- ${g}`)
		.join("\n");
	return `You are an expert coding assistant operating inside pi, a coding agent harness.

Available tools:
- ask_user: ${v.snippet}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Current working directory: /workspace/project`;
}

// --- Validation ---------------------------------------------------------------
/** Provider-arg validation + the extension's own runtime validator, per tool call. */
function validateToolCall(rawArguments: string): { questionCount: number; violations: string[] } {
	const violations: string[] = [];
	let parsedArgs: unknown;
	try {
		parsedArgs = JSON.parse(rawArguments);
	} catch {
		return { questionCount: 0, violations: ["shape:arguments_not_json"] };
	}
	let questionCount = 0;
	// Same un-do of double-encoded nested arguments the tool applies in pi (#244).
	// Malformed shapes must surface as violations, never as harness exceptions.
	try {
		const prepared = prepareQuestionArguments(parsedArgs);
		if (prepared && typeof prepared === "object" && Array.isArray((prepared as QuestionParams).questions)) {
			const typed = normalizeQuestionParams(prepared as QuestionParams);
			questionCount = typed.questions.length;
			const verdict = validateQuestionnaire(typed);
			if (!verdict.ok) violations.push(`runtime:${verdict.error}`);
			if (typed.questions.length < 1 || typed.questions.length > 4) violations.push("schema:questions_count");
			for (const q of typed.questions) {
				if (typeof q?.header !== "string" || q.header.length < 1 || q.header.length > 16) violations.push("schema:header_length");
				if (!Array.isArray(q?.options) || q.options.length < 2 || q.options.length > 4) {
					violations.push("schema:options_count");
					continue;
				}
				for (const o of q.options) {
					if (typeof o?.label !== "string" || o.label.length < 1 || o.label.length > 60) violations.push("schema:label_length");
					if (q.multiSelect === true && typeof o?.preview === "string") violations.push("schema:preview_with_multiSelect");
				}
			}
		} else {
			violations.push("shape:questions_not_an_array");
		}
	} catch {
		violations.push("shape:validation_threw");
	}
	return { questionCount, violations };
}

// --- Runner --------------------------------------------------------------------
interface Outcome {
	variant: string;
	caseId: string;
	run: number;
	/** true = model attempted an ask; false = answered without the tool; null = no result (error). */
	asked: boolean | null;
	outcome: "answered" | "asked" | "invalid_args" | "error";
	questionCount: number;
	violations: string[];
	error?: string;
	rawArguments?: string;
	finishReason?: string;
	content?: string;
}

async function callOnce(variant: string, guidance: GuidanceVariant, c: Case): Promise<Outcome> {
	const base: Outcome = { variant, caseId: c.id, run: -1, asked: null, outcome: "error", questionCount: 0, violations: [] };
	const body = {
		model: MODEL,
		temperature: TEMPERATURE,
		max_completion_tokens: 900,
		messages: [
			{ role: "system", content: systemPrompt(guidance) },
			{ role: "user", content: c.user },
		],
		tools: [
			{
				type: "function",
				function: {
					name: "ask_user",
					description: guidance.description,
					parameters: schema,
				},
			},
		],
	};
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		let res: Response;
		try {
			res = await fetch(API, {
				signal: AbortSignal.timeout(90_000),
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
				body: JSON.stringify(body),
			});
		} catch (e) {
			base.error = `network: ${String(e)}`;
			await new Promise((r) => setTimeout(r, 3000 * attempt));
			continue;
		}
		if (res.status === 429) {
			console.log(`  attempt ${attempt} 429, retry-after ${res.headers.get("retry-after")}`);
			const retryAfter = Number(res.headers.get("retry-after"));
			await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 15000 * attempt));
			continue;
		}
		if (res.status === 400) {
			// Provider rejected the model's tool-call arguments before we saw them.
			return { ...base, outcome: "invalid_args", asked: true, error: `HTTP 400: ${(await res.text()).slice(0, 300)}` };
		}
		if (!res.ok) {
			base.error = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
			await new Promise((r) => setTimeout(r, 3000 * attempt));
			continue;
		}
		const json: unknown = await res.json();
		const message = (json as { choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[]; content?: string } }[] })
			.choices?.[0]?.message;
		const calls = message?.tool_calls ?? [];
		const finishReason = (json as { choices?: { finish_reason?: string }[] }).choices?.[0]?.finish_reason;
		if (calls.length === 0) {
			return { ...base, outcome: "answered", asked: false, content: message?.content ?? "", finishReason };
		}
		// Validate every tool call, not just the first: multiple calls in one
		// response already break the batching contract.
		const validations = calls.map((c) => validateToolCall(c?.function?.arguments ?? ""));
		const violations = validations.flatMap((v) => v.violations);
		if (calls.length > 1) violations.push("batch:multiple_tool_calls");
		return {
			...base,
			outcome: "asked",
			asked: true,
			questionCount: Math.max(0, ...validations.map((v) => v.questionCount)),
			violations,
			rawArguments: calls.map((c) => c?.function?.arguments ?? "").join("\n"),
			finishReason,
		};
	}
	return base;
}

// --- Aggregation -----------------------------------------------------------------
function aggregate(rows: Outcome[]) {
	const summary: Record<string, unknown> = {};
	const variants = [...new Set(rows.map((r) => r.variant))];
	for (const variant of variants) {
		const variantRows = rows.filter((r) => r.variant === variant);
		const valid = variantRows.filter((r) => r.outcome === "asked" || r.outcome === "answered");
		const invalidArgs = variantRows.filter((r) => r.outcome === "invalid_args");
		const errored = variantRows.filter((r) => r.outcome === "error");
		let askHit = 0;
		let askTotal = 0;
		let falseCalls = 0;
		let falseTotal = 0;
		const violations: string[] = [];
		const perCase: Record<string, unknown> = {};
		for (const c of CASES) {
			const caseValid = valid.filter((r) => r.caseId === c.id);
			const asked = caseValid.filter((r) => r.asked === true);
			const caseViolations = asked.flatMap((r) => r.violations);
			violations.push(...caseViolations);
			perCase[c.id] = {
				expect: c.expect,
				asked: `${asked.length}/${caseValid.length}`,
				questionCounts: asked.map((r) => r.questionCount),
				violations: [...new Set(caseViolations)],
				invalidArgs: invalidArgs.filter((r) => r.caseId === c.id).length,
				errors: errored.filter((r) => r.caseId === c.id).length,
			};
			if (c.expect === "ask") {
				askTotal += caseValid.length;
				askHit += asked.length;
			}
			if (c.expect === "no_ask") {
				falseTotal += caseValid.length;
				falseCalls += asked.length;
			}
		}
		const t09 = valid.filter((r) => r.caseId === "T09" && r.asked === true);
		summary[variant] = {
			askRecall: `${askHit}/${askTotal}`,
			falseCallsOnNoAsk: `${falseCalls}/${falseTotal}`,
			schemaViolations: violations.length,
			violationKinds: [...new Set(violations)],
			invalidArgsCalls: invalidArgs.length,
			erroredCalls: errored.length,
			T09_batched: `${t09.filter((r) => r.questionCount >= 2).length}/${t09.length}`,
			perCase,
		};
	}
	return summary;
}

// --- Main -----------------------------------------------------------------------
async function main() {
	const only = process.argv.slice(2);
	const variantNames = Object.keys(VARIANTS).filter((v) => only.length === 0 || only.includes(v));
	const queue: { variant: string; c: Case; run: number }[] = [];
	for (const variant of variantNames) {
		for (const c of CASES) {
			for (let run = 0; run < REPEATS; run++) queue.push({ variant, c, run });
		}
	}

	const rows: Outcome[] = [];
	const total = queue.length;
	const partialFile = join(import.meta.dirname ?? ".", `eval-partial-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
	let done = 0;
	const workers = Array.from({ length: CONCURRENCY }, async () => {
		while (queue.length > 0) {
			const item = queue.shift();
			if (!item) break;
			const outcome = await callOnce(item.variant, VARIANTS[item.variant], item.c);
			await new Promise((r) => setTimeout(r, 15000)); // stay under Groq TPM (8k tokens/min)
			rows.push({ ...outcome, run: item.run });
			done++;
			console.log(`progress: ${done}/${total} ${outcome.variant}/${outcome.caseId} -> ${outcome.outcome}`);
			fs.appendFileSync(partialFile, `${JSON.stringify(rows[rows.length - 1])}\n`);
		}
	});
	await Promise.all(workers);

	const summary = aggregate(rows);
	const outFile = join(import.meta.dirname ?? ".", `eval-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	fs.writeFileSync(outFile, JSON.stringify({ model: MODEL, repeats: REPEATS, temperature: TEMPERATURE, summary, rows }, null, 2));
	console.log(`\nwrote ${outFile}\n`);
	for (const [variant, agg] of Object.entries(summary) as [string, Record<string, unknown>][]) {
		console.log(`=== ${variant} ===`);
		console.log(`ask recall (should ask): ${agg.askRecall} | false calls (should not): ${agg.falseCallsOnNoAsk}`);
		console.log(`schema violations: ${agg.schemaViolations} (${JSON.stringify(agg.violationKinds)}) | invalid_args: ${agg.invalidArgsCalls} | errors: ${agg.erroredCalls}`);
		console.log(`T09 batched (>=2 questions/call): ${agg.T09_batched}`);
		for (const [id, d] of Object.entries(agg.perCase as Record<string, Record<string, unknown>>)) {
			console.log(`  ${id} (${d.expect}): asked ${d.asked}, q=${JSON.stringify(d.questionCounts)}, invalidArgs=${d.invalidArgs}, errors=${d.errors}${d.violations && (d.violations as string[]).length > 0 ? `, VIOL: ${(d.violations as string[]).join(",")}` : ""}`);
		}
	}
}

// API-free sanity check of the validator and aggregator over fixture rows.
// Run: node eval.ts --selftest  (asserts; exits non-zero on failure)
function selftest() {
	const assert = (cond: boolean, label: string) => {
		if (!cond) {
			console.error(`SELFTEST FAIL: ${label}`);
			process.exit(1);
		}
		console.log(`ok: ${label}`);
	};
	const validArgs = JSON.stringify({
		questions: [
			{
				question: "Go or lib?",
				header: "Stack",
				options: [
					{ label: "Go", description: "fast" },
					{ label: "Lib", description: "slow" },
				],
			},
		],
	});
	assert(validateToolCall(validArgs).questionCount === 1, "valid args parse with 1 question");
	assert(validateToolCall(validArgs).violations.length === 0, "valid args produce no violations");
	assert(
		validateToolCall("not-json").violations.includes("shape:arguments_not_json"),
		"invalid JSON is reported as a shape violation",
	);
	assert(
		validateToolCall(JSON.stringify({ questions: 42 })).violations.includes("shape:questions_not_an_array"),
		"non-array questions is reported as a shape violation",
	);
	assert(
		validateToolCall(JSON.stringify({ questions: [{ question: "?", header: "H", options: [1, 2] }] })).violations.some((v) =>
			v.startsWith("schema:") || v.startsWith("runtime:") || v.startsWith("shape:"),
		),
		"malformed option entries surface as violations instead of throwing",
	);
	const reserved = validateToolCall(
		JSON.stringify({
			questions: [
				{
					question: "Which?",
					header: "H",
					options: [
						{ label: "Other", description: "x" },
						{ label: "A", description: "y" },
					],
				},
			],
		}),
	);
	assert(reserved.violations.includes("runtime:reserved_label"), "reserved label is caught by the runtime validator");

	const fixtures: Outcome[] = [
		{ variant: "X", caseId: "T01", run: 0, asked: true, outcome: "asked", questionCount: 2, violations: [] },
		{
			variant: "X",
			caseId: "T05",
			run: 0,
			asked: true,
			outcome: "asked",
			questionCount: 1,
			violations: ["runtime:reserved_label"],
		},
		{ variant: "X", caseId: "T05", run: 1, asked: false, outcome: "answered", questionCount: 0, violations: [] },
		{ variant: "X", caseId: "T05", run: 2, asked: null, outcome: "error", questionCount: 0, violations: [], error: "429" },
		{ variant: "X", caseId: "T09", run: 0, asked: true, outcome: "asked", questionCount: 3, violations: [] },
	];
	const agg = aggregate(fixtures) as Record<string, Record<string, unknown>>;
	const x = agg.X as Record<string, unknown>;
	assert(x.askRecall === "2/2", "errored calls are excluded from the ask-recall denominator");
	assert(x.falseCallsOnNoAsk === "1/2", "errored calls are excluded from the false-call denominator");
	assert(x.schemaViolations === 1, "violations are counted once per flagged call");
	assert(x.erroredCalls === 1, "errored calls are reported separately");

	// Result serialization (what main() writes) round-trips.
	const payload = JSON.stringify({ model: MODEL, repeats: REPEATS, temperature: TEMPERATURE, summary: agg, rows: fixtures });
	assert(JSON.parse(payload).summary.X.askRecall === "2/2", "result payload JSON round-trips");
	console.log("selftest passed");
}

// Run main() only when executed directly, so --selftest and fixture imports stay side-effect free.
const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	if (process.argv.includes("--selftest")) {
		selftest();
	} else {
		main();
	}
}
