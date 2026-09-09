import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewAction, RiskAssessment } from "./review.ts";
import { formatActionPreview, riskLabel } from "./review-presentation.ts";

/**
 * Choices are fixed and ordered so the initial cursor rests on "No": pressing
 * Enter immediately keeps the action blocked (fail closed).
 */
export const APPROVAL_CHOICES = ["No", "Yes"] as const;

const SUMMARY_CHARS = 400;

export type ApprovalDecision =
	| { kind: "approved" }
	| { kind: "declined"; detail?: string };

/** Minimal writable used for the terminal bell (defaults to `process.stdout`). */
export interface BellOutput {
	isTTY?: boolean;
	write(data: string): unknown;
}

export function ringTerminalBell(
	mode: ExtensionContext["mode"],
	output: BellOutput = process.stdout,
): void {
	if (mode !== "tui" || !output.isTTY) return;
	try {
		output.write("\x07");
	} catch {
		// Bell failure must not prevent the approval prompt.
	}
}

export function buildApprovalPrompt(
	action: ReviewAction,
	assessment: RiskAssessment,
	assessor?: string,
): string {
	return [
		"Approval Required",
		"",
		...(assessor ? ["Risk Assessor: " + assessor, ""] : []),
		`Risk: ${riskLabel(assessment.risk_level)}`,
		`Instruction alignment: ${assessment.instruction_alignment}`,
		"",
		"Operation:",
		formatActionPreview(action),
		"",
		"Action Summary:",
		bound(assessment.action_summary),
		"",
		"Reason:",
		bound(assessment.rationale),
		"",
		"Proceed?",
	].join("\n");
}

export async function showApprovalPrompt(
	action: ReviewAction,
	assessment: RiskAssessment,
	assessor: string | undefined,
	ctx: ExtensionContext,
): Promise<ApprovalDecision> {
	if (ctx.signal?.aborted) {
		return {
			kind: "declined",
			detail: "Approval prompt was cancelled before it could be shown.",
		};
	}
	try {
		ringTerminalBell(ctx.mode);
		const choice = await ctx.ui.select(
			buildApprovalPrompt(action, assessment, assessor),
			[...APPROVAL_CHOICES],
			ctx.signal ? { signal: ctx.signal } : undefined,
		);
		return choice === "Yes"
			? { kind: "approved" }
			: { kind: "declined" };
	} catch (error) {
		return {
			kind: "declined",
			detail: `Approval UI unavailable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Serializes approval dialogs so concurrent "ask" outcomes never show
 * overlapping prompts; each tool call is approved on its own.
 */
export class ApprovalQueue {
	private tail: Promise<void> = Promise.resolve();

	runExclusive<T>(task: () => Promise<T>): Promise<T> {
		const run = this.tail.then(task);
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

function bound(value: string): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length > SUMMARY_CHARS
		? `${line.slice(0, SUMMARY_CHARS)}… [truncated]`
		: line;
}
