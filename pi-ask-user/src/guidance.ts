/**
 * One line in the system prompt. The tool-selection rule is "would the user's
 * answer materially change the result" — not "is progress blocked" — so the
 * model can also ask about preferences and design trade-offs it could otherwise
 * only guess. UI chrome stays out; constraints live in the JSON schema.
 */
export const DEFAULT_PROMPT_SNIPPET =
	"Ask about preferences, ambiguous requirements, implementation decisions, or alternative approaches when user input would materially affect the result. Not limited to blocked work. Skip trivial questions answerable from existing conventions. Batch related questions.";

/**
 * Empty by default. Constraints live in the JSON schema, and timeout behavior
 * is returned in the tool result instead of being explained up front.
 */
export const DEFAULT_PROMPT_GUIDELINES: string[] = [];

/**
 * Mirrors the snippet's selection rule and keeps only the usage points the
 * schema cannot carry fully: the recommended-option convention, the concrete
 * reserved labels (the schema warns about them but does not name them), and
 * the preview/multiSelect pairing ban (schema says "Single-select only." only
 * on the preview field). Counts and lengths stay in the schema.
 */
export const DEFAULT_TOOL_DESCRIPTION = `Ask structured questions to clarify ambiguous requirements, learn user preferences, get implementation decisions, or offer alternative approaches. Use when user input would materially affect the result, even if you could proceed with reasonable assumptions. Avoid trivial questions and batch related ones. If you recommend an option, put it first and end its label with "(Recommended)". Users can type a custom answer, so never author the reserved labels "Other", "Type something.", or "Next", and never pair a preview with multiSelect.`;
