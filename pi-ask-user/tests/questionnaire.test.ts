import assert from "node:assert/strict";
import test from "node:test";
import { OpenQuestionnaire } from "../src/answer-channel.ts";
import { DEFAULT_PROMPT_GUIDELINES, DEFAULT_PROMPT_SNIPPET, DEFAULT_TOOL_DESCRIPTION } from "../src/guidance.ts";
import { DECLINE_MESSAGE, buildQuestionnaireResponse } from "../src/tool/response-envelope.ts";
import type { QuestionParams } from "../src/tool/types.ts";
import { validateQuestionnaire } from "../src/tool/validate-questionnaire.ts";

const REFERENCE_PROMPT_CHARS = 2944;

const params: QuestionParams = {
	questions: [
		{
			question: "Which approach?",
			header: "Approach",
			options: [
				{ label: "Patch", description: "Smallest change" },
				{ label: "Rewrite", description: "Start over" },
			],
		},
		{
			question: "Which tests?",
			header: "Tests",
			options: [
				{ label: "Unit", description: "Fast" },
				{ label: "E2E", description: "Slow" },
			],
		},
	],
};

test("prompt text is shorter than rpiv-ask-user-question 2.13.8 and guidelines stay empty", () => {
	const size = DEFAULT_TOOL_DESCRIPTION.length + DEFAULT_PROMPT_SNIPPET.length + DEFAULT_PROMPT_GUIDELINES.join("").length;
	assert.ok(size < REFERENCE_PROMPT_CHARS, `${size} is not below ${REFERENCE_PROMPT_CHARS}`);
	assert.deepEqual(DEFAULT_PROMPT_GUIDELINES, []);
	assert.match(DEFAULT_PROMPT_SNIPPET, /cannot be reasonably inferred/);
	assert.match(DEFAULT_TOOL_DESCRIPTION, /Batch related questions/);
	assert.match(DEFAULT_TOOL_DESCRIPTION, /end its label with "\(Recommended\)"/);
});

test("answers, cancel, and timeout are distinct and timeout keeps partial answers", () => {
	const answered = buildQuestionnaireResponse(
		{
			answers: [
				{
					questionIndex: 0,
					question: "Which approach?",
					kind: "option",
					answer: "Patch",
				},
			],
			cancelled: false,
		},
		params,
	);
	assert.match(answered.content[0].text, /User has answered your questions/);
	assert.equal(answered.details.timedOut, undefined);

	const cancelled = buildQuestionnaireResponse({ answers: [], cancelled: true }, params);
	assert.equal(cancelled.content[0].text, DECLINE_MESSAGE);
	assert.equal(cancelled.details.cancelled, true);
	assert.equal(cancelled.details.timedOut, undefined);

	const timedOut = buildQuestionnaireResponse(
		{
			answers: [
				{
					questionIndex: 0,
					question: "Which approach?",
					kind: "option",
					answer: "Patch",
				},
			],
			cancelled: false,
			timedOut: true,
		},
		params,
	);
	assert.equal(timedOut.details.timedOut, true);
	assert.equal(timedOut.details.cancelled, false);
	assert.equal(timedOut.details.answers[0]?.answer, "Patch");
	assert.deepEqual(timedOut.details.unanswered, [1]);
	assert.match(timedOut.content[0].text, /timed out/);
	assert.match(timedOut.content[0].text, /Do not immediately ask the same questions again/);
	assert.match(timedOut.content[0].text, /Which tests\?/);
	assert.doesNotMatch(timedOut.content[0].text, /User declined/);
});

test("reserved labels and too many questions are rejected", () => {
	const reserved = validateQuestionnaire({
		questions: [
			{
				question: "Which one?",
				header: "Choice",
				options: [
					{ label: "Other", description: "no" },
					{ label: "This", description: "yes" },
				],
			},
		],
	});
	assert.equal(reserved.ok, false);
	if (!reserved.ok) assert.equal(reserved.error, "reserved_label");

	const tooMany = validateQuestionnaire({
		questions: Array.from({ length: 5 }, (_, index) => ({
			question: `Question ${index}?`,
			header: `Q${index}`,
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		})),
	});
	assert.equal(tooMany.ok, false);
});

test("the first settle wins and a later one is ignored", () => {
	const open = new OpenQuestionnaire("call-1", params.questions, "tui");
	assert.equal(open.settle({ answers: [], cancelled: true }), true);
	assert.equal(open.settle({ answers: [], cancelled: false, timedOut: true }), false);
	assert.equal(open.settled?.cancelled, true);
	assert.equal(open.settled?.timedOut, undefined);
});
