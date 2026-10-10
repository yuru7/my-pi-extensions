import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ReviewAction, RiskAssessment, RiskLevel } from "./review.ts";
import {
	showApprovalDialog,
	type ApprovalExpansion,
} from "./approval-dialog.ts";
import {
	APPROVAL_TIMEOUT_DETAIL,
	formatActionPreview,
	riskLabel,
	shellCommandPreview,
} from "./review-presentation.ts";

/**
 * Choices are fixed and ordered so the initial cursor rests on "Deny":
 * pressing Enter immediately keeps the action blocked (fail closed). The third
 * choice approves the call while adding a session-scoped approval rule.
 */
export const APPROVAL_CHOICES = [
	"Deny",
	"Approve",
	"Approve + Add Rule",
] as const;

/** Choice that approves the call and opens the session-rule text input. */
export const ADD_SESSION_RULE_CHOICE = APPROVAL_CHOICES[2];

/** Title of the session-rule text input opened by the third choice. */
export const SESSION_RULE_INPUT_TITLE = "Session approval rule";

const SESSION_RULE_INPUT_PLACEHOLDER =
	"Describe the operation this session may run without asking";

const FIELD_CHARS = 400;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/**
 * The same ranges, but line feeds survive. A multi-line command is only
 * readable while its own line breaks are intact.
 */
const CONTROL_CHARS_KEEPING_NEWLINES =
	/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
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
	| { kind: "approved-with-rule" }
	| { kind: "declined"; detail?: string };

/**
 * Outcome of submitting typed rule text. A rejection keeps the text input open
 * with its message, so an unusable rule can never approve the action.
 */
export type SessionRuleSubmission =
	| { ok: true }
	| { ok: false; message: string };

export type SessionRuleSubmitter = (text: string) => SessionRuleSubmission;

/** Session rule that lowered the current ask, for transparency in the prompt. */
export interface SessionRuleNote {
	id: string;
	text: string;
	/** Level the reviewer classified before the rule lowered it. */
	loweredFrom: RiskLevel;
}

/**
 * Title of the approval prompt. Non-TUI selectors get it as the first line of
 * the document; the TUI dialog embeds it in the rule above the body.
 */
export const APPROVAL_PROMPT_TITLE = "Approval Required";

/**
 * Stands in for an Operation preview that was cut short, and names the way to
 * see the rest. The dialog receives the same text as its click target, so the
 * constant is shared instead of spelled out twice.
 */
export const EXPANSION_HINT = "(truncated, ctrl+o to expand)";

/** The approval prompt: title, Markdown body, and its emphasis target. */
export interface ApprovalPrompt {
	/** Prompt title. Where it is rendered is up to the renderer. */
	title: string;
	/** The prompt body. Every renderer uses this same document. */
	markdown: string;
	/**
	 * Line that carries risk-level emphasis. The dialog colors it so the level
	 * stays visible on terminals that do not render bold.
	 */
	emphasis?: { text: string; color: ThemeColor };
	/**
	 * Present when the Operation block was cut short and can be shown in full,
	 * which only the TUI dialog can do.
	 */
	expansion?: ApprovalExpansion;
}

/** How `buildApprovalPrompt` adapts the document to its renderer. */
export interface ApprovalPromptOptions {
	/**
	 * Attach the expanded document and mark the collapsed Operation block. Only
	 * the TUI dialog can expand it; selectors in the other modes cannot, so they
	 * keep the plain `… [truncated]` marker instead of promising a key that does
	 * nothing there.
	 */
	expandable?: boolean;
	/** Session rule that lowered this ask, shown in Review Information. */
	sessionRule?: SessionRuleNote;
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
 * Sanitizes the expanded Operation block: the same control-character and ANSI
 * removal as every other interpolated value, except that line feeds survive so a
 * multi-line command stays readable. Nothing else is altered — no trimming and no
 * length cap — because the user asked to see the whole command, and the block is
 * rendered only after ctrl+o or a click. The result is always handed to
 * `fencedCode`, whose fence is sized to the value, so no line of the command can
 * escape the block.
 */
export function sanitizeExpandedCommand(value: string): string {
	return value.replace(CONTROL_CHARS_KEEPING_NEWLINES, " ");
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
 * The single definition of the approval prompt: a title plus one Markdown
 * document that every renderer receives as-is (the TUI renders it under a rule
 * carrying the title, other modes hand the document to their own selector).
 * Reviewer output and the operation preview go through the same Markdown path;
 * control characters are stripped and values are bounded first. A cut-short
 * command is the exception: an expandable prompt also carries the same document
 * with that one block in full, which is what the dialog shows after ctrl+o.
 */
export function buildApprovalPrompt(
	action: ReviewAction,
	assessment: RiskAssessment,
	assessor?: string,
	options: ApprovalPromptOptions = {},
): ApprovalPrompt {
	const riskText = `Risk: ${riskLabel(assessment.risk_level)}`;
	const ruleBullet = options.sessionRule
		? [
				`- Session Rule: ${sanitizePromptField(options.sessionRule.id)}: ${sanitizePromptField(options.sessionRule.text)} (lowered from ${riskLabel(options.sessionRule.loweredFrom)})`,
			]
		: [];
	const bullets = [
		...(assessor
			? [`- Risk Assessor: ${sanitizePromptField(assessor)}`]
			: []),
		`- Instruction Alignment: ${sanitizePromptField(assessment.instruction_alignment)}`,
		...ruleBullet,
	];
	const language = SHELL_LANGUAGES[action.tool];
	const document = (operation: string) =>
		[
			`**${riskText}**`,
			["Review Information:", ...bullets].join("\n"),
			[
				`Operation (tool: ${sanitizePromptField(action.tool)}):`,
				fencedCode(operation, language),
			].join("\n\n"),
			`Operation Summary:\n${sanitizePromptField(assessment.action_summary)}`,
			`Reason:\n${sanitizePromptField(assessment.rationale)}`,
		].join("\n\n");
	const shell = shellCommandPreview(action);
	const expandable = options.expandable === true && shell?.truncated === true;
	const color = RISK_EMPHASIS[assessment.risk_level];
	const prompt: ApprovalPrompt = {
		title: APPROVAL_PROMPT_TITLE,
		markdown: document(
			sanitizePromptField(
				shell && expandable
					? `${shell.collapsed} ... ${EXPANSION_HINT}`
					: formatActionPreview(action),
			),
		),
		...(color === undefined ? {} : { emphasis: { text: riskText, color } }),
	};
	if (!(shell && expandable)) return prompt;
	return {
		...prompt,
		expansion: {
			markdown: document(sanitizeExpandedCommand(shell.expanded)),
			marker: EXPANSION_HINT,
		},
	};
}

/** Per-call extras: rule submission and the note for a lowered ask. */
export interface ApprovalPromptRequest {
	/**
	 * Validates and stores the typed rule from the third choice. The third choice
	 * approves only when this returns `ok`; a rejection keeps the input open with
	 * its message.
	 */
	submitSessionRule?: SessionRuleSubmitter;
	/** Session rule that lowered this ask, rendered in the prompt document. */
	sessionRule?: SessionRuleNote;
	/**
	 * How long this ask waits, in seconds. Null, omitted, or a number <= 0
	 * waits until the user answers. A positive number counts down on the prompt
	 * and then declines.
	 */
	timeoutSeconds?: number | null;
	/** Clock for the deadline. Defaults to `Date.now`. */
	now?: () => number;
}

export async function showApprovalPrompt(
	action: ReviewAction,
	assessment: RiskAssessment,
	assessor: string | undefined,
	ctx: ExtensionContext,
	request: ApprovalPromptRequest = {},
): Promise<ApprovalDecision> {
	if (ctx.signal?.aborted) {
		return {
			kind: "declined",
			detail: "Approval prompt was cancelled before it could be shown.",
		};
	}
	const clock = startAskTimeout(
		request.timeoutSeconds,
		ctx.signal,
		request.now ?? Date.now,
	);
	try {
		ringTerminalBell(ctx.mode);
		// Only the TUI dialog can expand the Operation block, so only that path is
		// told about it; a selector would show a hint it cannot honour.
		const prompt = buildApprovalPrompt(action, assessment, assessor, {
			expandable: ctx.mode === "tui",
			sessionRule: request.sessionRule,
		});
		for (;;) {
			if (clock.expired()) return timeoutDecline();
			const choice = await selectApprovalChoice(prompt, ctx, clock);
			// A choice that arrives after the deadline never approves, including
			// one typed into the session-rule input below.
			if (clock.expired()) return timeoutDecline();
			if (choice === "Approve") return { kind: "approved" };
			if (choice !== ADD_SESSION_RULE_CHOICE) return { kind: "declined" };
			if (!request.submitSessionRule) {
				return {
					kind: "declined",
					detail: "Session approval rules are unavailable.",
				};
			}
			let rejection: string | undefined;
			for (;;) {
				if (clock.expired()) return timeoutDecline();
				const text = await ctx.ui.input(
					rejection
						? `${SESSION_RULE_INPUT_TITLE} — ${rejection}`
						: SESSION_RULE_INPUT_TITLE,
					SESSION_RULE_INPUT_PLACEHOLDER,
					clock.uiOptions(),
				);
				if (clock.expired()) return timeoutDecline();
				// Esc leaves the rule input and brings the choices back: a cancelled
				// input must never approve the action.
				if (text === undefined) break;
				const result = request.submitSessionRule(text);
				if (result.ok) return { kind: "approved-with-rule" };
				rejection = result.message;
			}
			if (ctx.signal?.aborted) return { kind: "declined" };
		}
	} catch (error) {
		return {
			kind: "declined",
			detail: `Approval UI unavailable: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		clock.dispose();
	}
}

/**
 * One approval choice: the TUI gets the scrollable dialog with the title in its
 * rule; every other mode hands the same document (title first) to its own
 * selector, because custom components are unsupported outside the TUI.
 */
async function selectApprovalChoice(
	prompt: ApprovalPrompt,
	ctx: ExtensionContext,
	clock: AskTimeout,
): Promise<string | undefined> {
	const timeoutMs = clock.timeoutMs();
	if (ctx.mode === "tui") {
		return showApprovalDialog(
			{
				title: prompt.title,
				markdown: prompt.markdown,
				emphasis: prompt.emphasis,
				expansion: prompt.expansion,
				choices: APPROVAL_CHOICES,
				...(timeoutMs !== undefined ? { timeoutMs, now: clock.now } : {}),
				...(clock.signal ? { signal: clock.signal } : {}),
			},
			ctx,
		);
	}
	return ctx.ui.select(
		`${prompt.title}\n\n${prompt.markdown}`,
		[...APPROVAL_CHOICES],
		clock.uiOptions(),
	);
}

function timeoutDecline(): ApprovalDecision {
	return { kind: "declined", detail: APPROVAL_TIMEOUT_DETAIL };
}

/** Node's setTimeout delay is a 32-bit signed integer. Longer waits are sliced. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface AskTimeout {
	now: () => number;
	/** Child of the turn signal; aborted when the ask deadline passes. */
	signal?: AbortSignal;
	/** Milliseconds still left, or undefined when this ask does not time out. */
	timeoutMs(): number | undefined;
	/** Options for `ui.select` / `ui.input`. Undefined when neither signal nor timeout applies. */
	uiOptions(): { signal?: AbortSignal; timeout?: number } | undefined;
	expired(): boolean;
	dispose(): void;
}

/**
 * One deadline for the choice dialog and the session-rule input that follows
 * it. Null, omitted, and numbers <= 0 never expire.
 */
function startAskTimeout(
	seconds: number | null | undefined,
	parent: AbortSignal | undefined,
	now: () => number,
): AskTimeout {
	if (seconds == null || !(seconds > 0) || !Number.isFinite(seconds)) {
		return {
			now,
			signal: parent,
			timeoutMs: () => undefined,
			uiOptions: () => (parent ? { signal: parent } : undefined),
			expired: () => false,
			dispose: () => {},
		};
	}
	const deadline = now() + seconds * 1000;
	const controller = new AbortController();
	let timedOut = false;
	const onParent = () => controller.abort();
	if (parent?.aborted) controller.abort();
	else parent?.addEventListener("abort", onParent, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const arm = () => {
		if (disposed) return;
		const left = deadline - now();
		if (left <= 0) {
			timedOut = true;
			controller.abort();
			return;
		}
		timer = setTimeout(arm, Math.min(left, MAX_TIMER_DELAY_MS));
		timer.unref?.();
	};
	arm();
	const expired = () => timedOut || now() >= deadline;
	const timeoutMs = () => {
		const left = deadline - now();
		return left > 0 ? left : 0;
	};
	return {
		now,
		signal: controller.signal,
		timeoutMs,
		uiOptions: () => {
			const left = timeoutMs();
			return {
				signal: controller.signal,
				...(left > 0 ? { timeout: left } : {}),
			};
		},
		expired,
		dispose: () => {
			disposed = true;
			if (timer) clearTimeout(timer);
			parent?.removeEventListener("abort", onParent);
		},
	};
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
