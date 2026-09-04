import type {
	ReviewAction,
	RiskAssessment,
	RiskLevel,
} from "./review.ts";
import type { ReviewResult } from "./gate.ts";

const REJECTION_DETAIL_CHARS = 4_000;
const COMMAND_PREVIEW_CHARS = 300;
const PREVIEW_CHARS = 160;

const RISK_LABELS: Record<RiskLevel, string> = {
	very_low: "Very Low",
	low: "Low",
	medium: "Medium",
	high: "High",
	very_high: "Very High",
	critical: "Critical",
};

export function riskLabel(level: RiskLevel): string {
	return RISK_LABELS[level];
}

export function rejectionReason(
	result: Exclude<
		ReviewResult,
		{ kind: "allowed" | "user-approved" | "assessed" }
	>,
): string {
	switch (result.kind) {
		case "denied":
			return [
				"This action was rejected due to unacceptable risk.",
				`Reason: ${boundedRejectionDetail(result.assessment.rationale)}`,
				"Do not attempt the same outcome through a workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative or after the user explicitly approves the exact action after being informed of the risk.",
			].join("\n");
		case "user-declined":
			return [
				"The user declined this exact action.",
				"Do not retry the same action through an equivalent command or workaround.",
				"Choose a materially safer alternative or ask the user in conversation.",
			].join("\n");
		case "timeout":
			return "Automatic permission review reached its deadline without approval. Do not assume approval; retry later or ask the user for guidance.";
		case "failure":
			return `Automatic permission review failed closed, so approval was not granted. ${boundedRejectionDetail(result.message)}`;
		case "cancelled":
			return "Automatic permission review was cancelled, so approval was not granted.";
		case "circuit-open":
			return "Repeated adverse automatic-review outcomes reached the per-turn safety limit. Stop trying alternate commands and ask the user for guidance.";
		default:
			return "Automatic permission review failed closed with an unknown result.";
	}
}

export function formatReviewResult(
	result: ReviewResult,
	action: ReviewAction,
): string {
	const target = formatActionPreview(action);
	switch (result.kind) {
		case "allowed":
			return assessmentSummary("allowed", result.assessment);
		case "user-approved":
			return assessmentSummary("approved by user", result.assessment);
		case "denied":
			return [
				assessmentSummary("blocked", result.assessment),
				truncate(singleLine(result.assessment.rationale), 240),
				target,
			].join("\n");
		case "user-declined":
			return [
				assessmentSummary("declined by user", result.assessment),
				...(result.detail ? [truncate(singleLine(result.detail), 240)] : []),
				target,
			].join("\n");
		case "timeout":
			return `AI Approval · timed out · blocked\n${target}`;
		case "failure":
			return `AI Approval · review failed · blocked\n${truncate(singleLine(result.message), 240)}\n${target}`;
		case "cancelled":
			return `AI Approval · cancelled · blocked\n${target}`;
		case "circuit-open":
			return `AI Approval · circuit open · blocked\n${target}`;
		default:
			return `AI Approval · unknown result · blocked\n${target}`;
	}
}

function assessmentSummary(
	verdict: "allowed" | "approved by user" | "blocked" | "declined by user",
	assessment: RiskAssessment,
): string {
	return `AI Approval · ${verdict} · ${riskLabel(assessment.risk_level)} risk`;
}

/** One-line, size-bounded description of the planned action for UI display. */
export function formatActionPreview(action: ReviewAction): string {
	const path = () => singleLine(String(action.payload.path ?? ""));
	switch (action.tool) {
		case "bash":
			return `$ ${truncatePreview(
				singleLine(String(action.payload.command ?? "")),
				COMMAND_PREVIEW_CHARS,
			)}`;
		case "write":
			return truncatePreview(`write ${path()}`, PREVIEW_CHARS);
		case "edit": {
			const edits = Array.isArray(action.payload.edits)
				? action.payload.edits.length
				: 0;
			return truncatePreview(
				`edit ${path()} (${edits} ${edits === 1 ? "edit" : "edits"})`,
				PREVIEW_CHARS,
			);
		}
		case "read":
			return truncatePreview(`read ${path()}`, PREVIEW_CHARS);
		case "grep":
		case "find": {
			const pattern = singleLine(String(action.payload.pattern ?? ""));
			const scope = path() || ".";
			return truncatePreview(
				`${action.tool} ${scope}${pattern ? ` pattern ${pattern}` : ""}`,
				PREVIEW_CHARS,
			);
		}
		case "ls":
			return truncatePreview(`ls ${path()}`, PREVIEW_CHARS);
		default: {
			const fallback = path();
			return truncatePreview(
				fallback ? `${action.tool} ${fallback}` : action.tool,
				PREVIEW_CHARS,
			);
		}
	}
}

export function reviewResultDiagnostic(result: ReviewResult): string {
	if (result.kind === "failure" || result.kind === "timeout") {
		return singleLine(result.message);
	}
	return result.kind;
}

export function formatDuration(timeoutMs: number): string {
	return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
}

function boundedRejectionDetail(value: string): string {
	return truncate(singleLine(value), REJECTION_DETAIL_CHARS);
}

function singleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
	return value.length > maxLength
		? `${value.slice(0, Math.max(0, maxLength - 1))}…`
		: value;
}

function truncatePreview(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}… [truncated]`;
}
