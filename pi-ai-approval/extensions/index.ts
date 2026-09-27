// pi-lens-ignore: find-import-file-without-extension
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { collectActionReasoning } from "../src/action-reasoning.ts";
import {
	collectReviewMessages,
	DIRECT_USER_INPUT_ENTRY_TYPE,
	DirectUserInputTracker,
} from "../src/authorization-provenance.ts";
import {
	ApprovalQueue,
	showApprovalPrompt,
	type SessionRuleSubmission,
} from "../src/approval-prompt.ts";
import {
	buildDefaultConfigFile,
	loadApprovalConfig,
	type ApprovalConfig,
} from "../src/config.ts";
import { DirectoryScanCache } from "../src/directory-scan-cache.ts";
import {
	DenialCircuitBreaker,
	ReviewBatchTracker,
	circuitOutcomeForReview,
	type ReviewDecisionResult,
	type ReviewResult,
} from "../src/gate.ts";
import {
	showApprovalConfiguration,
	syncReviewerRuntimeHealth,
} from "../src/reviewer-status.ts";
import {
	buildActionReviewSystemPrompt,
	buildReviewSystemPrompt,
} from "../src/policy.ts";
import {
	formatReviewResult,
	rejectionReason,
	reviewResultDiagnostic,
	riskLabel,
} from "../src/review-presentation.ts";
import {
	applySessionRulePolicy,
	sessionRuleRejectionMessage,
	SessionRuleStore,
	type SessionApprovalRule,
} from "../src/session-rules.ts";
import { manageSessionRules } from "../src/session-rules-command.ts";
import type { ReviewAction, ReviewMessage, RiskLevel } from "../src/review.ts";
import { shellActionContainsRtk } from "../src/rtk-detection.ts";
import {
	buildReviewerChannels,
	reviewerChannelIdentity,
	reviewerChannelLabel,
	runReviewWithFallbackChain,
	shouldFallbackReview,
	type ReviewerChannel,
} from "../src/reviewer-channels.ts";
import { ReviewerSessionController } from "../src/reviewer-session.ts";
import {
	actionFromToolCall,
	reviewerToolsForAction,
	shouldInvalidateDirectoryScanCache,
	toolCallBatchInfo,
} from "../src/tool-actions.ts";
import { lockAllowedToolInput } from "../src/tool-input-lock.ts";

export {
	applyRiskPolicy,
	resolveRiskAction,
} from "../src/risk-policy.ts";
export {
	reviewerHealth,
	runReviewWithFallbackChain,
	shouldFallbackReview,
	type ReviewerChannel,
} from "../src/reviewer-channels.ts";
export {
	actionFromToolCall,
	reviewerToolsForAction,
	shouldInvalidateDirectoryScanCache,
	toolCallBatchInfo,
} from "../src/tool-actions.ts";
export {
	lockAllowedToolInput,
	lockReviewedToolInput,
} from "../src/tool-input-lock.ts";

export interface AiApprovalOptions {
	directoryScanCache?: DirectoryScanCache;
}

/**
 * `/ai-approval init` asks a plain file-overwrite question, so it keeps its own
 * No/Yes wording instead of the approval prompt's Deny / Approve / Approve +
 * Add Rule choices.
 */
const OVERWRITE_CONFIRMATION_CHOICES = ["No", "Yes"] as const;

// Extension wiring intentionally coordinates lifecycle, UI, policy, and reviewer state.
// pi-lens-ignore: high-complexity, high-fan-out
export default function aiApproval(
	pi: ExtensionAPI,
	options: AiApprovalOptions = {},
) {
	type ApprovalCommandContext = Parameters<
		Parameters<typeof pi.registerCommand>[1]["handler"]
	>[1];

	let temporaryBypassActive = false;
	let configurationWarningKey: string | undefined;
	const reviewerSwitchNoticeKeys = new Set<string>();
	const controllers = new Map<string, ReviewerSessionController>();
	let controllerContextKey: string | undefined;
	const circuitBreaker = new DenialCircuitBreaker();
	const reviewBatches = new ReviewBatchTracker();
	const approvalQueue = new ApprovalQueue();
	const sessionRules = new SessionRuleStore();
	const directoryScanCache =
		options.directoryScanCache ?? new DirectoryScanCache();
	const directUserInputTracker = new DirectUserInputTracker();

	const showBypassWarning = (ctx: ExtensionContext) => {
		ctx.ui.setWidget(
			"ai-approval-bypass",
			[
				ctx.ui.theme.fg(
					"warning",
					"⚠ AI Approval is BYPASSED — run /ai-approval enable",
				),
			],
			{ placement: "belowEditor" },
		);
	};

	const clearBypassWarning = (ctx: ExtensionContext) => {
		ctx.ui.setWidget("ai-approval-bypass", undefined);
	};

	const disposeReviewerControllers = () => {
		for (const controller of controllers.values()) controller.dispose();
		controllers.clear();
		controllerContextKey = undefined;
	};

	const resetRuntime = () => {
		disposeReviewerControllers();
		temporaryBypassActive = false;
		configurationWarningKey = undefined;
		reviewerSwitchNoticeKeys.clear();
		circuitBreaker.reset();
		reviewBatches.reset();
		directoryScanCache.clear();
		directUserInputTracker.reset();
		// Session approval rules are memory-only and belong to this session.
		sessionRules.clear();
	};

	const syncConfigurationWarnings = (
		ctx: ExtensionContext,
		warnings: string[],
	) => {
		const nextKey = warnings.length > 0 ? warnings.join("\n") : undefined;
		if (!nextKey) {
			configurationWarningKey = undefined;
			return;
		}
		if (configurationWarningKey === nextKey) return;
		configurationWarningKey = nextKey;
		ctx.ui.notify(
			[
				"AI Approval configuration warning. Invalid entries were ignored; remaining valid settings and built-in defaults are active.",
				...warnings,
			].join("\n"),
			"warning",
		);
	};

	const notifyReviewerSwitch = (
		ctx: ExtensionContext,
		from: ReviewerChannel,
		to: ReviewerChannel,
	) => {
		const key = `${from.role}:${from.modelSpec}→${to.role}:${to.modelSpec}`;
		if (reviewerSwitchNoticeKeys.has(key)) return;
		reviewerSwitchNoticeKeys.add(key);
		ctx.ui.notify(
			to.role === "current-model"
				? `AI Approval · configured reviewer channels unavailable; using current session model ${to.modelSpec}.`
				: `AI Approval · primary reviewer unavailable; using configured fallback ${to.modelSpec}.`,
			"warning",
		);
	};

	const finishReviewBatch = (batchId: string, ctx: ExtensionContext) => {
		const adverse = reviewBatches.finish(batchId);
		if (adverse !== undefined && circuitBreaker.record(adverse)) ctx.abort();
	};

	const statusCallbacks = {
		syncConfigurationWarnings,
		notifyReviewerSwitch,
	};

	pi.on("session_start", (_event, ctx) => {
		const wasBypassed = temporaryBypassActive;
		resetRuntime();
		if (wasBypassed) clearBypassWarning(ctx);
		syncReviewerRuntimeHealth(ctx, statusCallbacks, true);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		resetRuntime();
		clearBypassWarning(ctx);
	});
	pi.on("input", (event) => {
		directUserInputTracker.observe(event);
	});
	pi.on("before_agent_start", (event) => {
		directUserInputTracker.confirmPrompt(event.prompt);
		// Temporary bypass is intentionally UI/control-plane state only. Do not
		// inject it into model context or treat it as additional authorization.
		circuitBreaker.reset();
		reviewBatches.reset();
		directoryScanCache.clear();
	});
	pi.on("message_start", (event) => {
		if (event.message.role !== "user") return;
		const record = directUserInputTracker.recordForMessage(event.message);
		if (record) pi.appendEntry(DIRECT_USER_INPUT_ENTRY_TYPE, record);
	});

	const setTemporaryBypass = async (
		nextActive: boolean,
		ctx: ApprovalCommandContext,
	): Promise<void> => {
		if (nextActive && ctx.mode !== "tui") {
			throw new Error(
				"Temporary AI Approval bypass requires interactive TUI mode so the persistent warning remains visible.",
			);
		}
		await ctx.waitForIdle();
		if (temporaryBypassActive === nextActive) {
			if (nextActive) showBypassWarning(ctx);
			else clearBypassWarning(ctx);
			ctx.ui.notify(
				nextActive
					? "AI Approval is already temporarily bypassed. Run /ai-approval enable to restore protection."
					: "AI Approval is already enabled.",
				nextActive ? "warning" : "info",
			);
			return;
		}

		disposeReviewerControllers();
		reviewerSwitchNoticeKeys.clear();
		circuitBreaker.reset();
		reviewBatches.reset();
		directoryScanCache.clear();
		if (nextActive) {
			temporaryBypassActive = true;
			showBypassWarning(ctx);
			ctx.ui.notify(
				[
					"AI Approval is temporarily BYPASSED.",
					"Covered agent tool calls will proceed without automated review until /ai-approval enable.",
					"This does not grant the agent additional authorization, and the bypass resets automatically when the Pi session runtime reloads or is replaced.",
				].join("\n"),
				"warning",
			);
			return;
		}

		temporaryBypassActive = false;
		clearBypassWarning(ctx);
		syncReviewerRuntimeHealth(ctx, statusCallbacks);
		ctx.ui.notify(
			"AI Approval is enabled again. Covered agent tool calls once again require review.",
			"info",
		);
	};

	/**
	 * Writes the documented default configuration via `/ai-approval init`.
	 * The destination is chosen interactively and an existing file is never
	 * overwritten without an explicit Yes (fail closed).
	 */
	const writeDefaultConfiguration = async (
		ctx: ApprovalCommandContext,
	): Promise<void> => {
		const config = loadApprovalConfig({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		});
		const destinations = [
			{
				project: true,
				path: config.projectPath,
				label: `Project: ${config.projectPath}${existsSync(config.projectPath) ? "  (exists)" : ""}`,
			},
			{
				project: false,
				path: config.globalPath,
				label: `Global: ${config.globalPath}${existsSync(config.globalPath) ? "  (exists)" : ""}`,
			},
		];
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(
				"Write the default configuration to:",
				destinations.map(({ label }) => label),
			);
		} catch (error) {
			ctx.ui.notify(
				`Could not show the destination chooser: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
			return;
		}
		if (choice === undefined) {
			ctx.ui.notify("Configuration setup cancelled.", "info");
			return;
		}
		const destination = destinations.find(({ label }) => label === choice);
		if (!destination) return;

		if (existsSync(destination.path)) {
			let overwrite: string | undefined;
			try {
				overwrite = await ctx.ui.select(
					`${destination.path} already exists. Overwrite?`,
					[...OVERWRITE_CONFIRMATION_CHOICES],
				);
			} catch (error) {
				ctx.ui.notify(
					`Could not show the overwrite confirmation: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
				return;
			}
			if (overwrite !== "Yes") {
				ctx.ui.notify("Configuration setup cancelled. The existing file was left unchanged.", "info");
				return;
			}
		}

		try {
			mkdirSync(dirname(destination.path), { recursive: true });
			writeFileSync(
				destination.path,
				`${JSON.stringify(buildDefaultConfigFile(), null, 2)}\n`,
			);
		} catch (error) {
			ctx.ui.notify(
				`Failed to write ${destination.path}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		ctx.ui.notify(
			[
				`Default configuration written to ${destination.path}.`,
				...(destination.project && !ctx.isProjectTrusted()
					? ["This project is currently untrusted, so the file applies once the project is trusted."]
					: []),
				"Run /ai-approval rules to check the effective settings.",
			].join("\n"),
			"info",
		);
	};

	const commandArguments = [
		{
			value: "session-rules",
			label: "session-rules",
			description: "View and manage session approval rules",
		},
		{
			value: "rules",
			label: "rules",
			description: "Show review levels and risk actions",
		},
		{
			value: "init",
			label: "init",
			description: "Write the default configuration file",
		},
		{
			value: "bypass",
			label: "bypass",
			description: "Temporarily disable review",
		},
		{
			value: "enable",
			label: "enable",
			description: "End the temporary bypass",
		},
	];

	pi.registerCommand("ai-approval", {
		description:
			"Show AI approval status/rules or temporarily bypass/enable review",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = commandArguments.filter(({ value }) =>
				value.startsWith(normalized),
			);
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			switch (args.trim().toLowerCase()) {
				case "bypass":
					await setTemporaryBypass(true, ctx);
					return;
				case "enable":
					await setTemporaryBypass(false, ctx);
					return;
				case "init":
					await writeDefaultConfiguration(ctx);
					return;
				case "session-rules":
					try {
						await manageSessionRules(sessionRules, ctx.ui);
					} catch (error) {
						ctx.ui.notify(
							`Could not open the session rule manager: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
					}
					return;
				default:
					await showApprovalConfiguration(
						args,
						ctx,
						temporaryBypassActive,
						statusCallbacks,
					);
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (temporaryBypassActive) return;
		const branch = ctx.sessionManager.getBranch();
		const batch = toolCallBatchInfo(event.toolCallId, branch);
		try {
			const config = loadApprovalConfig({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
			});
			syncConfigurationWarnings(ctx, config.warnings);
			const action = actionFromToolCall(
				event,
				ctx.cwd,
				config.review,
				directoryScanCache,
			);
			if (!action) return;

			if (circuitBreaker.isOpen()) {
				const result: ReviewResult = {
					kind: "circuit-open",
					message: "Repeated adverse review outcomes reached the per-turn limit.",
				};
				ctx.ui.notify(formatReviewResult(result, action), "error");
				return { block: true, reason: rejectionReason(result) };
			}

			const reviewed = await reviewAction(action, config, ctx, {
				messages: collectReviewMessages(branch),
				actionReasoning: collectActionReasoning(branch, event.toolCallId),
			});
			const decided = await decideAction(
				action,
				reviewed.result,
				config,
				ctx,
				reviewed.channel,
			);
			const result = lockAllowedToolInput(event, decided);
			const circuitOutcome = circuitOutcomeForReview(result);
			if (circuitOutcome !== undefined) {
				reviewBatches.record(batch.id, circuitOutcome);
			}
			if (result.kind === "allowed" || result.kind === "user-approved") {
				ctx.ui.notify(formatReviewResult(result, action), "info");
				return;
			}

			if (result.kind === "denied" || result.kind === "user-declined") {
				ctx.ui.notify(formatReviewResult(result, action), "error");
			} else {
				ctx.ui.notify(
					formatReviewResult(result, action),
					result.kind === "cancelled" ? "warning" : "error",
				);
			}
			return { block: true, reason: rejectionReason(result) };
		} finally {
			if (batch.isLast) finishReviewBatch(batch.id, ctx);
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (temporaryBypassActive) return;
		if (shouldInvalidateDirectoryScanCache(event.toolName)) {
			directoryScanCache.clear();
		}
		const batch = toolCallBatchInfo(
			event.toolCallId,
			ctx.sessionManager.getBranch(),
		);
		if (batch.isLast) finishReviewBatch(batch.id, ctx);
	});

	async function reviewAction(
		action: ReviewAction,
		config: ApprovalConfig,
		ctx: ExtensionContext,
		evidence: { messages: ReviewMessage[]; actionReasoning?: string },
	): Promise<{ result: ReviewResult; channel?: ReviewerChannel }> {
		try {
			const channels = buildReviewerChannels(
				config,
				ctx.modelRegistry,
				ctx.model,
				ctx.thinkingLevel,
			);
			const { result, finalChannel, attempts } = await runReviewWithFallbackChain(
				channels,
				(channel) =>
					reviewWithChannel(channel, config, action, ctx, evidence),
				(from, to) => notifyReviewerSwitch(ctx, from, to),
			);
			const usedFallback = attempts.length > 1;
			if (usedFallback && shouldFallbackReview(result)) {
				ctx.ui.notify(
					[
						"AI Approval · all attempted reviewer channels failed.",
						...attempts.map(
							({ channel, result: attemptResult }) =>
								`${reviewerChannelLabel(channel.role)} (${channel.modelSpec}): ${reviewResultDiagnostic(attemptResult)}`,
						),
					].join("\n"),
					"error",
				);
			}
			if (
				!usedFallback &&
				result.kind === "assessed"
			) {
				reviewerSwitchNoticeKeys.clear();
			}
			if (usedFallback && result.kind === "failure") {
				return {
					result: {
						kind: "failure",
						message: "Automatic approval review failed.",
					},
				};
			}
			if (usedFallback && result.kind === "timeout") {
				return {
					result: {
						kind: "timeout",
						message: "Automatic approval review timed out.",
					},
				};
			}
			return { result, channel: finalChannel };
		} catch (error) {
			return {
				result: {
					kind: "failure",
					message: `Automatic approval review failed: ${error instanceof Error ? error.message : String(error)}`,
				},
			};
		}
	}

	/**
	 * Stores a rule typed in the approval prompt. The rule is valid only for this
	 * session, so it is held in memory until the session runtime resets.
	 */
	const addSessionRule = (
		text: string,
		ctx: ExtensionContext,
	): SessionRuleSubmission => {
		const added = sessionRules.add(text);
		if (!added.ok) {
			return { ok: false, message: sessionRuleRejectionMessage(added.reason) };
		}
		ctx.ui.notify(
			[
				`AI Approval · session rule added · ${added.rule.id}: ${added.rule.text}`,
				"This rule applies to this session only and is cleared when the session ends.",
			].join("\n"),
			"info",
		);
		return { ok: true };
	};

	/**
	 * Reports a rule that lowered an `ask` classification, so an automatic allow
	 * always names the authorization that produced it.
	 */
	const notifySessionRuleApplied = (
		ctx: ExtensionContext,
		rule: SessionApprovalRule | undefined,
		loweredFrom: RiskLevel | undefined,
		effectiveLevel: RiskLevel,
	): void => {
		if (!rule || loweredFrom === undefined) return;
		ctx.ui.notify(
			[
				`AI Approval · session rule applied · ${rule.id}: ${rule.text}`,
				`Risk lowered from ${riskLabel(loweredFrom)} to ${riskLabel(effectiveLevel)}.`,
			].join("\n"),
			"info",
		);
	};

	/**
	 * Applies the local risk policy to the reviewer's classification. The
	 * reviewer never decides the outcome; this function and the user do. A
	 * session rule may lower an `ask` classification, and the live rule set is
	 * the only source of truth for whether a reported rule ID exists.
	 */
	async function decideAction(
		action: ReviewAction,
		reviewed: ReviewResult,
		config: ApprovalConfig,
		ctx: ExtensionContext,
		assessorChannel?: ReviewerChannel,
	): Promise<ReviewDecisionResult> {
		if (reviewed.kind !== "assessed") return reviewed;
		const matchedRule = reviewed.assessment.matched_rule_id
			? sessionRules.find(reviewed.assessment.matched_rule_id)
			: undefined;
		const decision = applySessionRulePolicy(
			reviewed.assessment,
			config.riskActions,
			matchedRule !== undefined,
		);
		if (decision.kind === "allow") {
			notifySessionRuleApplied(
				ctx,
				matchedRule,
				decision.loweredFrom,
				decision.assessment.risk_level,
			);
			return { kind: "allowed", assessment: decision.assessment };
		}
		if (decision.kind === "deny") {
			return { kind: "denied", assessment: decision.assessment };
		}
		const assessor = assessorChannel
			? `${reviewerChannelIdentity(assessorChannel)} (${reviewerChannelLabel(assessorChannel.role)})`
			: undefined;
		const ruleNote =
			matchedRule && decision.loweredFrom !== undefined
				? {
						id: matchedRule.id,
						text: matchedRule.text,
						loweredFrom: decision.loweredFrom,
					}
				: undefined;
		// Serialize approval dialogs: one tool call, one prompt, no overlap.
		const approval = await approvalQueue.runExclusive(() =>
			showApprovalPrompt(action, decision.assessment, assessor, ctx, {
				submitSessionRule: (text) => addSessionRule(text, ctx),
				...(ruleNote ? { sessionRule: ruleNote } : {}),
			}),
		);
		if (approval.kind === "approved" || approval.kind === "approved-with-rule") {
			return { kind: "user-approved", assessment: decision.assessment };
		}
		return {
			kind: "user-declined",
			assessment: decision.assessment,
			...(approval.detail ? { detail: approval.detail } : {}),
		};
	}

	async function reviewWithChannel(
		channel: ReviewerChannel,
		config: ApprovalConfig,
		action: ReviewAction,
		ctx: ExtensionContext,
		evidence: { messages: ReviewMessage[]; actionReasoning?: string },
	): Promise<ReviewResult> {
		try {
			const model = channel.model;
			if (!model) {
				return {
					kind: "failure",
					message: `Reviewer model not found: ${channel.modelSpec}.`,
				};
			}
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				return {
					kind: "failure",
					message: `Reviewer authentication is unavailable for ${model.provider}.`,
				};
			}

			const privateDataReview = action.payload.private_data_read === true;
			const containsRtk = shellActionContainsRtk(action);
			const baseSystemPrompt = buildReviewSystemPrompt(
				config.policy,
				config.assessmentLanguage,
			);
			const systemPrompt = buildActionReviewSystemPrompt(baseSystemPrompt, {
				privateDataReview,
				containsRtk,
				sessionRules: sessionRules.list(),
			});
			const reviewerTools = reviewerToolsForAction(action);
			// The context key tracks configuration only, not the live session
			// thinking level: fixed-thinking controllers stay reusable across
			// session thinking changes, while CURRENT channels resolve anew per
			// review and land on a distinct per-channel key below (bounded by
			// the small thinking-level vocabulary, so stale entries do not grow).
			const nextContextKey = JSON.stringify({
				cwd: ctx.cwd,
				primaryModel: config.primaryModel,
				secondaryModel: config.secondaryModel,
				primaryThinkingLevel: config.primaryThinkingLevel,
				secondaryThinkingLevel: config.secondaryThinkingLevel,
				timeoutMs: config.timeoutMs,
				baseSystemPrompt,
				// Rules are part of the reviewer's system prompt, so a changed rule
				// set must never reuse a session that still holds the old one.
				sessionRules: sessionRules
					.list()
					.map((rule) => `${rule.id}:${rule.text}`),
			});
			if (controllerContextKey !== nextContextKey) {
				for (const existing of controllers.values()) existing.dispose();
				controllers.clear();
				controllerContextKey = nextContextKey;
			}
			const key = JSON.stringify({
				channel: channel.role,
				modelSpec: channel.modelSpec,
				model: `${model.provider}/${model.id}`,
				thinkingLevel: channel.thinkingLevel,
				privateDataReview,
				containsRtk,
			});
			let controller = controllers.get(key);
			if (!controller) {
				controller = new ReviewerSessionController({
					model,
					modelRegistry: ctx.modelRegistry,
					cwd: ctx.cwd,
					systemPrompt,
					timeoutMs: config.timeoutMs,
					tools: reviewerTools,
					thinkingLevel: channel.thinkingLevel,
				});
				controllers.set(key, controller);
			}
			return controller.review(action, evidence.messages, ctx.signal, {
				actionReasoning: evidence.actionReasoning,
			});
		} catch (error) {
			return {
				kind: "failure",
				message: `Automatic approval review failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
}
