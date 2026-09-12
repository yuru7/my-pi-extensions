import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ReviewAction, RiskAssessment, RiskLevel } from "./review.ts";
import { showApprovalDialog } from "./approval-dialog.ts";
import { formatActionPreview, riskLabel } from "./review-presentation.ts";

/**
 * Choices are fixed and ordered so the initial cursor rests on "No": pressing
 * Enter immediately keeps the action blocked (fail closed).
 */
export const APPROVAL_CHOICES = ["No", "Yes"] as const;

const FIELD_CHARS = 400;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/**
 * Risk levels worth coloring. Bold alone is invisible on terminals that do not
 * render bold, so elevated risk also gets a theme color.
 */
const RISK_EMPHASIS: Partial<Record<RiskLevel, ThemeColor>> = {
	medium: "warning",
	high: "warning",
	very_high: "error",
	critical: "error",
};
/**
 * Syntax labels for shell tools, so the operation is highlighted as the shell it
 * will run in. Anything else still gets a code block, just without a label.
 */
const SHELL_LANGUAGES: Record<string, string> = {
	bash: "bash",
	powershell: "powershell",
};

export type ApprovalDecision =
	| { kind: "approved" }
	| { kind: "declined"; detail?: string };

/** The approval prompt as one Markdown document plus its emphasis target. */
export interface ApprovalPrompt {
	/** The whole prompt. Every renderer uses this same document. */
	markdown: string;
	/**
	 * Line that carries risk-level emphasis. The dialog colors it so the level
	 * stays visible on terminals that do not render bold.
	 */
	emphasis?: { text: string; color: ThemeColor };
}

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

/**
 * Normalizes one interpolated value: strips control characters (including ANSI
 * escapes) so untrusted reviewer output cannot emit terminal sequences, folds it
 * onto a single line, and bounds its length. Truncation is display-only; the
 * risk decision never reads this value.
 */
export function sanitizePromptField(
	value: string,
	maxChars: number = FIELD_CHARS,
): string {
	const line = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
	return line.length > maxChars
		? `${line.slice(0, maxChars)}… [truncated]`
		: line;
}

/**
 * Wraps a value in a fenced code block. The fence is longer than any backtick
 * run in the value, so a value containing backticks cannot close it early.
 */
export function fencedCode(value: string, language?: string): string {
	const longestRun = Math.max(
		0,
		...[...value.matchAll(/`+/g)].map((match) => match[0].length),
	);
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	return `${fence}${language ?? ""}\n${value}\n${fence}`;
}

/**
 * The single definition of the approval prompt: one Markdown document that every
 * renderer receives as-is (the TUI renders it, other modes hand it to their own
 * selector). Reviewer output and the operation preview go through the same
 * Markdown path; control characters are stripped and values are bounded first.
 */
export function buildApprovalPrompt(
	action: ReviewAction,
	assessment: RiskAssessment,
	assessor?: string,
): ApprovalPrompt {
	const riskText = `Risk: ${riskLabel(assessment.risk_level)}`;
	const bullets = assessor
		? [
				`- Risk Assessor: ${sanitizePromptField(assessor)}`,
				`- Instruction Alignment: ${sanitizePromptField(assessment.instruction_alignment)}`,
			]
		: [
				`- Instruction Alignment: ${sanitizePromptField(assessment.instruction_alignment)}`,
			];
	const blocks = [
		"Approval Required",
		`**${riskText}**`,
		["Review Information:", ...bullets].join("\n"),
		[
			"Operation:",
			fencedCode(
				sanitizePromptField(formatActionPreview(action)),
				SHELL_LANGUAGES[action.tool],
			),
		].join("\n\n"),
		`Action Summary:\n${sanitizePromptField(assessment.action_summary)}`,
		`Reason:\n${sanitizePromptField(assessment.rationale)}`,
	];
	const color = RISK_EMPHASIS[assessment.risk_level];
	return {
		markdown: blocks.join("\n\n"),
		...(color === undefined ? {} : { emphasis: { text: riskText, color } }),
	};
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
		const prompt = buildApprovalPrompt(action, assessment, assessor);
		// TUI gets the scrollable dialog; every other mode hands the same
		// document to its own selector (custom components are unsupported
		// outside the TUI).
		const choice =
			ctx.mode === "tui"
				? await showApprovalDialog(
						{
							markdown: prompt.markdown,
							emphasis: prompt.emphasis,
							choices: APPROVAL_CHOICES,
						},
						ctx,
					)
				: await ctx.ui.select(
						prompt.markdown,
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
