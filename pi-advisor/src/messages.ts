/**
 * User-facing strings and the graded effort scale.
 *
 * Advisor "effort", Pi's thinking level, and pi-ai's `reasoning` option are the
 * same scale. "off" is not part of the scale: choosing it omits `reasoning`.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";

export const ADVISOR_TOOL_NAME = "advisor";
export const TOOL_LABEL = "Advisor";

export const NO_ADVISOR_VALUE = "__no_advisor__";
export const OFF_VALUE = "__off__";

export type GradedEffort = Exclude<ThinkingLevel, "off">;
export const EFFORT_ORDINAL: readonly GradedEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const DEFAULT_EFFORT: GradedEffort = "high";
export const RECOMMENDED_EFFORT_SUFFIX = "  (recommended)";

export const CHECKMARK = " ✓";

export const MSG_ADVISOR_DISABLED = "Advisor disabled";
export const MSG_REQUIRES_INTERACTIVE = "/advisor requires interactive mode";
export const MSG_ADVISOR_NUDGE = "Please advise on the executor's situation above.";
export const MSG_EFFORT_NOT_SET = "Effort not set — advisor uses the model default";
export const MSG_PERSIST_FAILED = "Failed to save advisor selection — selection not persisted";

export const ERR_NO_MODEL = "No advisor model is configured. The user can enable one with the /advisor command.";
export const ERR_CALL_ABORTED = "Advisor call was cancelled before it completed.";
export const ERR_EMPTY_RESPONSE = "Advisor returned no text content.";
export const ERR_NO_MODEL_SELECTED = "no advisor model selected";
export const ERR_EMPTY_RESPONSE_DETAIL = "empty response";
export const ERR_ABORTED_DETAIL = "aborted";
export const ERR_UNKNOWN = "unknown error";

export const errMisconfigured = (label: string, err: string): string => `Advisor (${label}) is misconfigured: ${err}`;
export const errNoApiKey = (label: string): string => `Advisor (${label}) has no API key available.`;
export const errNoApiKeyDetail = (provider: string): string => `no API key for ${provider}`;
export const errCallFailed = (err: string | undefined): string => `Advisor call failed: ${err ?? ERR_UNKNOWN}`;
export const errCallThrew = (msg: string): string => `Advisor call threw: ${msg}`;
export const errSelectionNotFound = (choice: string): string => `Advisor selection not found: ${choice}`;
export const errModelUnavailable = (key: string): string =>
	`Previously configured advisor model ${key} is no longer available`;
export const msgAdvisorEnabled = (label: string, effort: ThinkingLevel | undefined): string =>
	`Advisor: ${label}${effort ? `, ${effort}` : ""}`;
export const msgAdvisorRestored = (label: string, effort: ThinkingLevel | undefined): string =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""}`;
export const msgAdvisorRestoredInactive = (label: string, effort: ThinkingLevel | undefined): string =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
export const msgAdvisorEnabledInactive = (label: string, effort: ThinkingLevel | undefined): string =>
	`Advisor: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
export const msgConsulting = (label: string, effort: ThinkingLevel | undefined): string =>
	`Consulting advisor (${label}${effort ? `, ${effort}` : ""})…`;

export function isGradedEffort(value: unknown): value is GradedEffort {
	return typeof value === "string" && EFFORT_ORDINAL.includes(value as GradedEffort);
}
