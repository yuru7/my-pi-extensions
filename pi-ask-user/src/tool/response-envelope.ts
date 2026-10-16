import { formatAnswerScalar } from "./format-answer.ts";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.ts";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";
export const TIMEOUT_PREFIX = "The questionnaire timed out before the user finished answering.";
export const TIMEOUT_GUIDANCE =
	"Continue with any partial answers below and otherwise make a reasonable, safe assumption. Do not immediately ask the same questions again. Do not treat the timeout as approval for destructive, irreversible, or security-sensitive actions.";

/**
 * Map a `QuestionnaireResult` (or null/cancelled) to the LLM-facing tool envelope.
 * Pure of `(result, params)`; cancelled and "no segments" both fall to `DECLINE_MESSAGE`
 * so the model sees a single canonical "didn't answer" signal regardless of why.
 * "No segments" means no answers AND no global note — the `global note:` segment is
 * pushed before the zero-segments check, so a note-bearing submit with zero answers
 * still yields the answered envelope. A partial submit names the questions left blank
 * in an `unanswered:` segment (and `details.unanswered`, their indexes) so the model can
 * tell "not decided yet" from "settled" (#291); it never counts as an answer, and a fully
 * answered result stays byte-identical.
 */
export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
	if (result?.timedOut) return buildTimeoutResponse(result, params);
	if (!result || result.cancelled) {
		// Decline text stays canonical even when a global note rides the cancelled result;
		// the note survives in `details` (like partial `answers`) for replay consumers.
		return buildToolResult(DECLINE_MESSAGE, {
			answers: result?.answers ?? [],
			cancelled: true,
			...(result?.globalNote && result.globalNote.length > 0 ? { globalNote: result.globalNote } : {}),
		});
	}
	const segments: string[] = [];
	const unanswered: number[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(buildAnswerSegment(a));
		else unanswered.push(i);
	}
	const hasGlobalNote = result.globalNote !== undefined && result.globalNote.length > 0;
	if (segments.length === 0 && !hasGlobalNote) {
		return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	}
	if (unanswered.length > 0) segments.push(buildUnansweredSegment(unanswered, params));
	// Global note rides after the per-question segments: raw multiline echo (no
	// reformatting), trailing period mirroring `buildAnswerSegment`'s shape.
	if (hasGlobalNote) segments.push(`global note: ${result.globalNote}.`);
	const details = unanswered.length > 0 ? { ...result, unanswered } : result;
	return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`, details);
}

/** Timeout keeps confirmed answers and names the questions left blank. */
export function buildTimeoutResponse(result: QuestionnaireResult, params: QuestionParams) {
	const segments: string[] = [];
	const unanswered: number[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const answer = result.answers.find((entry) => entry.questionIndex === i);
		if (answer) segments.push(buildAnswerSegment(answer));
		else unanswered.push(i);
	}
	const parts = [TIMEOUT_PREFIX];
	if (segments.length > 0) parts.push(`Partial answers: ${segments.join(" ")}`);
	else parts.push("No answers were submitted.");
	if (unanswered.length > 0) parts.push(buildUnansweredSegment(unanswered, params));
	if (result.globalNote && result.globalNote.length > 0) parts.push(`global note: ${result.globalNote}.`);
	parts.push(TIMEOUT_GUIDANCE);
	const details: QuestionnaireResult = {
		...result,
		cancelled: false,
		timedOut: true,
		...(unanswered.length > 0 ? { unanswered } : {}),
	};
	return buildToolResult(parts.join(" "), details);
}

/** `unanswered: "<question>", "<question>".` — the questions shown but left blank on a partial submit. */
export function buildUnansweredSegment(indexes: readonly number[], params: QuestionParams): string {
	return `unanswered: ${indexes.map((i) => `"${params.questions[i]?.question}"`).join(", ")}.`;
}

/**
 * Format a single answer segment for the envelope. Pure of `a`. The `"Q"="A"` shape and
 * the optional `selected preview:` / `user notes:` suffixes are pinned by envelope tests.
 */
export function buildAnswerSegment(a: QuestionAnswer): string {
	const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a, "envelope")}"`];
	if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
