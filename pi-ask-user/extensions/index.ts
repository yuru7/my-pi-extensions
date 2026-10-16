import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserQuestionTool } from "../src/ask-user-question.ts";
import { registerAskUserQuestionReconciler } from "../src/reconcile.ts";

export {
	ASK_USER_ANSWER_EVENT,
	ASK_USER_ANSWER_RESULT_EVENT,
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserAnswerEntry,
	type AskUserAnswerEventPayload,
	type AskUserAnswerRejectCode,
	type AskUserAnswerResultEventPayload,
	type AskUserBlockedEventPayload,
	type AskUserPromptEventPayload,
	type AskUserPromptOption,
	type AskUserPromptQuestion,
} from "../src/events.ts";

export default function (pi: ExtensionAPI) {
	registerAskUserQuestionTool(pi);
	registerAskUserQuestionReconciler(pi);
}
