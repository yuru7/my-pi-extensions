import { type Static, Type } from "typebox";
import { LABELS_BY_KIND, ROW_INTENT_META } from "../state/row-intent.ts";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

/**
 * User-facing labels for the three runtime sentinel rows, keyed by their
 * `WrappingSelectItem.kind` discriminator. Sourced from
 * `ROW_INTENT_META` via `LABELS_BY_KIND` (`row-intent.ts`) — single source of
 * truth. Adding a new sentinel requires extending the `WrappingSelectItem`
 * union AND adding an entry to `ROW_INTENT_META`; this map then auto-extends.
 */
export const SENTINEL_LABELS = LABELS_BY_KIND;

export type SentinelKind = keyof typeof SENTINEL_LABELS;
export type SentinelLabel = (typeof SENTINEL_LABELS)[SentinelKind];

/**
 * Labels reserved for Pi-internal sentinels — authoring an option with any
 * of these labels triggers the `reserved_label` runtime guard. Two of the
 * three come from `ROW_INTENT_META` (the runtime kinds); `"Other"` is
 * reserved for CC parity only (the model is conditioned to reach for
 * "Other" in CC; we reject it so the runtime sentinel is the single source
 * of truth) and has no runtime kind.
 *
 * Reserved unconditionally — every question mode rejects these labels, even
 * when a given runtime sentinel is not appended in that mode.
 *
 * Order is pinned by `types.test.ts:292` — keep the explicit
 * `["Other", other, next]` literal so consumers using
 * `RESERVED_LABELS[i]` indexing or `Set` membership see no behavior change.
 */
export const RESERVED_LABELS = ["Other", ROW_INTENT_META.other.label, ROW_INTENT_META.next.label] as const;
export type ReservedLabel = (typeof RESERVED_LABELS)[number];

export const OptionSchema = Type.Object({
	label: Type.String({
		maxLength: MAX_LABEL_LENGTH,
		description: "Short option label, 1-5 words.",
	}),
	description: Type.String({
		description: "What this choice means or costs.",
	}),
	preview: Type.Optional(
		Type.String({
			description: "Markdown compared beside this option. Single-select only.",
		}),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({
		description: "The question, ending with a question mark.",
	}),
	header: Type.String({
		maxLength: MAX_HEADER_LENGTH,
		description: "Short chip shown beside the question.",
	}),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: "Distinct choices. Do not include reserved labels.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			default: false,
			description: "Allow more than one choice.",
		}),
	),
});

export const QuestionsSchema = Type.Array(QuestionSchema, {
	minItems: 1,
	maxItems: MAX_QUESTIONS,
	description: "1-4 related questions, asked together.",
});

export const QuestionParamsSchema = Type.Object({
	questions: QuestionsSchema,
});

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

/**
 * Answer-intent discriminated union. `kind` is the single discriminator —
 * pre-1.0.3 boolean flags have been removed (see `banned-flags.test.ts`).
 * Mirrors the row-side `WrappingSelectItem.kind` vocabulary where possible;
 * `multi` is the multi-select variant (no row-side analog).
 *
 * Variant semantics:
 * - `option`: user picked one of the author-defined options. `answer` is the option's label.
 * - `custom`: user typed free-text on a single-select question. `answer` is the typed text or null.
 * - `multi`: user committed a multi-select question. `selected` carries chosen labels and `answer`
 *   carries optional custom text.
 */
export interface QuestionAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	/**
	 * Markdown text from the matched option's `preview` field, populated only
	 * when the user lands on a single-select option carrying a `preview`.
	 * Used by `buildQuestionnaireResponse` to echo `selected preview: <preview>`
	 * into the LLM-facing envelope. Undefined for multi-select and custom-text
	 * (`kind: "custom"`) answers.
	 */
	preview?: string;
}

export type QuestionnaireError =
	| "no_ui"
	| "no_custom_ui"
	| "no_questions"
	| "empty_options"
	| "too_many_questions"
	| "duplicate_question"
	| "duplicate_option_label"
	| "reserved_label"
	| "session_load_failed"
	| "stale_module_cache";

export interface QuestionnaireResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
	/**
	 * Global note authored on the Submit tab: `n` opens the shared notes editor there,
	 * and the committed text lives at the `notesByTab[questions.length]` pseudo-index
	 * (a slot no question tab can occupy) until `doneFor` lifts it onto the result —
	 * attached on both submit and cancel, like per-question `answers[].notes`.
	 * Conditional-spread contract, mirroring `QuestionAnswer.notes`: the key appears
	 * only via conditional spread of a non-empty string — never assigned `undefined`,
	 * never kept for an empty/whitespace-only draft — so note-free results stay
	 * byte-identical (`!("globalNote" in result)` holds).
	 */
	globalNote?: string;
	/**
	 * Indexes of the questions left blank on a partial submit (#291), set only by the
	 * envelope builder on an answered result — never present when every question is
	 * answered or the result is a decline, so those stay byte-identical.
	 */
	unanswered?: number[];
	/**
	 * Set only when the idle deadline expired. Confirmed answers stay in
	 * `answers`; questions the user never committed stay unanswered. This is
	 * not a cancel and not an implicit choice.
	 */
	timedOut?: boolean;
	error?: QuestionnaireError;
}

export function isQuestionnaireResult(value: unknown): value is QuestionnaireResult {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.answers) && typeof v.cancelled === "boolean";
}
