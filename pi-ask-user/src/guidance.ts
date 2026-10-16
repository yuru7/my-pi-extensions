import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "./tool/types.ts";

/** One line in the system prompt. The decision rule stays; UI chrome does not. */
export const DEFAULT_PROMPT_SNIPPET = "Ask only when a decision is necessary and cannot be reasonably inferred. Batch related questions.";

/**
 * Empty by default. Constraints live in the JSON schema, and timeout behavior
 * is returned in the tool result instead of being explained up front.
 */
export const DEFAULT_PROMPT_GUIDELINES: string[] = [];

export const DEFAULT_TOOL_DESCRIPTION = `Ask a structured question only when a decision is necessary and cannot be reasonably inferred. Batch related questions into one call (${MAX_QUESTIONS} questions max, ${MIN_OPTIONS}-${MAX_OPTIONS} options each). The user can pick, select several when multiSelect is true, or type their own answer. If you recommend an option, put it first and end its label with "(Recommended)". Do not author the reserved labels "Other", "Type something.", or "Next". Use options[].preview only on single-select questions that need a side-by-side comparison.`;
