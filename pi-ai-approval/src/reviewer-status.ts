import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CURRENT_MODEL_SETTING,
	DEFAULT_REVIEWER_THINKING_LEVEL,
	loadApprovalConfig,
	RISK_LEVEL_KEYS,
} from "./config.ts";
import { formatDuration, riskLabel } from "./review-presentation.ts";
import {
	buildReviewerChannels,
	currentReviewerChannel,
	isReviewerThinkingLevel,
	modelSpecFor,
	reviewerChannelForSetting,
	reviewerChannelIdentity,
	reviewerChannelLabel,
	reviewerHealth,
	type ReviewerChannel,
} from "./reviewer-channels.ts";
import type { RiskLevel } from "./review.ts";

/** Shows the configured setting plus the model it resolved to for CURRENT. */
function modelSettingDisplay(
	setting: string,
	channel: ReviewerChannel,
): string {
	if (setting !== CURRENT_MODEL_SETTING) return setting;
	return channel.model
		? `CURRENT (${modelSpecFor(channel.model)})`
		: "CURRENT (no current session model)";
}

/** Shows the thinking setting; CURRENT expands to the effective level. */
function thinkingSettingDisplay(
	setting: string,
	channel: ReviewerChannel,
	sessionThinkingLevel?: string,
): string {
	const effective = channel.thinkingLevel;
	if (setting !== CURRENT_MODEL_SETTING) return setting;
	if (isReviewerThinkingLevel(sessionThinkingLevel))
		return `CURRENT (${effective} from current session)`;
	return `CURRENT (${effective} default; no session thinking level)`;
}

export interface ReviewerStatusCallbacks {
	syncConfigurationWarnings: (
		ctx: ExtensionContext,
		warnings: string[],
	) => void;
	notifyReviewerSwitch: (
		ctx: ExtensionContext,
		from: ReviewerChannel,
		to: ReviewerChannel,
	) => void;
}

export function syncReviewerRuntimeHealth(
	ctx: ExtensionContext,
	callbacks: ReviewerStatusCallbacks,
): void {
	const config = loadApprovalConfig({
		cwd: ctx.cwd,
		projectTrusted: ctx.isProjectTrusted(),
	});
	callbacks.syncConfigurationWarnings(ctx, config.warnings);
	const channels = buildReviewerChannels(
		config,
		ctx.modelRegistry,
		ctx.model,
		ctx.thinkingLevel,
	);
	const health = reviewerHealth(
		config,
		ctx.modelRegistry,
		ctx.model,
		ctx.thinkingLevel,
	);
	if (health.selectedFallback) {
		const selected = channels.find(
			(channel) => channel.role === health.selectedFallback,
		);
		if (selected) callbacks.notifyReviewerSwitch(ctx, channels[0], selected);
	}
	if (!health.selectedFallback && health.reason) {
		ctx.ui.notify(health.reason, "warning");
	}
}

export async function showApprovalConfiguration(
	args: string,
	ctx: ExtensionCommandContext,
	temporaryBypassActive: boolean,
	callbacks: ReviewerStatusCallbacks,
): Promise<void> {
	const projectTrusted = ctx.isProjectTrusted();
	const config = loadApprovalConfig({ cwd: ctx.cwd, projectTrusted });
	callbacks.syncConfigurationWarnings(ctx, config.warnings);
	const primaryChannel = reviewerChannelForSetting(
		"primary",
		config.primaryModel,
		ctx.modelRegistry,
		ctx.model,
		config.primaryThinkingLevel ?? DEFAULT_REVIEWER_THINKING_LEVEL,
		ctx.thinkingLevel,
	);
	const secondaryChannel = reviewerChannelForSetting(
		"secondary",
		config.secondaryModel,
		ctx.modelRegistry,
		ctx.model,
		config.secondaryThinkingLevel ?? DEFAULT_REVIEWER_THINKING_LEVEL,
		ctx.thinkingLevel,
	);
	const currentChannel = currentReviewerChannel(ctx.model, ctx.thinkingLevel);
	const channels = buildReviewerChannels(
		config,
		ctx.modelRegistry,
		ctx.model,
		ctx.thinkingLevel,
	);
	const checkChannel = async (
		channel: ReviewerChannel,
	): Promise<string | undefined> => {
		if (!channel.model) {
			return channel.modelSpec === CURRENT_MODEL_SETTING
				? "Current session model is unavailable."
				: `Reviewer model not found: ${channel.modelSpec}.`;
		}
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(channel.model);
			return !auth.ok || !auth.apiKey
				? `Reviewer authentication is unavailable for ${channel.model.provider}.`
				: undefined;
		} catch (error) {
			return `Reviewer authentication check failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	};
	const issues = new Map<string, string | undefined>();
	let issue: string | undefined;
	for (const channel of channels) {
		issues.set(reviewerChannelIdentity(channel), await checkChannel(channel));
	}
	const selectedIndex = channels.findIndex(
		(channel) => !issues.get(reviewerChannelIdentity(channel)),
	);
	if (selectedIndex < 0) {
		issue = channels
			.map(
				(channel) =>
					`${reviewerChannelLabel(channel.role)} unavailable: ${issues.get(reviewerChannelIdentity(channel))}`,
			)
			.join(" ");
	}
	const ready = selectedIndex >= 0 && issue === undefined;
	const selectedChannel = ready ? channels[selectedIndex] : undefined;
	const degradedFallback =
		ready &&
		selectedIndex === 0 &&
		channels.length > 1 &&
		channels
			.slice(1)
			.every((channel) => issues.get(reviewerChannelIdentity(channel)));
	const operationalLabel = !ready
		? "needs attention"
		: selectedChannel?.role === "current-model"
			? "ready via current model"
			: selectedChannel?.role === "secondary"
				? "ready via secondary"
				: degradedFallback
					? "ready · secondary unavailable"
					: "ready";
	const summaryLabel = `${
		temporaryBypassActive
			? `BYPASSED · underlying ${operationalLabel}`
			: operationalLabel
	}${config.warnings.length > 0 ? " · config warnings" : ""}`;
	const channelStatus = (channelIssue: string | undefined) =>
		channelIssue ? "unavailable" : "ready";
	const primaryIdentity = reviewerChannelIdentity(primaryChannel);
	const secondaryIdentity = reviewerChannelIdentity(secondaryChannel);
	const secondaryStatus =
		secondaryIdentity === primaryIdentity
			? "same as primary (no separate channel)"
			: channelStatus(issues.get(secondaryIdentity));
	const currentIdentity = currentChannel
		? reviewerChannelIdentity(currentChannel)
		: undefined;
	const currentFallbackStatus = !currentChannel
		? "unavailable (no current session model)"
		: currentIdentity === primaryIdentity
			? "same as primary (no separate channel)"
			: currentIdentity === secondaryIdentity
				? "same as secondary (no separate channel)"
				: channelStatus(issues.get(currentIdentity as string));
	const projectConfigStatus = !config.projectConfigPresent
		? "absent"
		: projectTrusted
			? "present · trusted"
			: "present · skipped (project untrusted)";
	if (selectedChannel && selectedIndex > 0 && !temporaryBypassActive) {
		callbacks.notifyReviewerSwitch(
			ctx,
			channels[selectedIndex - 1],
			selectedChannel,
		);
	}
	const riskActionLines = RISK_LEVEL_KEYS.map(
		(level: RiskLevel) => `${level} → ${config.riskActions[level]}`,
	);
	const details =
		args.trim() === "rules"
			? [
					"Review rules (tool.parameter → reviewer scope):",
					...Object.entries(config.review)
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([key, level]) => `${key} → ${level}`),
					"Unconfigured tools with a top-level string path parameter default to private-only.",
					"Risk actions (risk level → local decision):",
					...riskActionLines,
					"very_high and critical cannot be configured to allow.",
					"allow runs without confirmation; ask shows a No/Yes prompt (No is preselected); deny blocks.",
				]
			: [
					"Reviews configured shell, private-read/search, and sensitive/out-of-project mutation actions before execution.",
					"The reviewer classifies risk into six levels; riskActions config decides allow/ask/deny.",
					"Run /ai-approval rules for the review matrix and risk actions.",
				];
	const unavailableBeforeSelected =
		selectedIndex > 0
			? channels.slice(0, selectedIndex).map(
					(channel) =>
						`${reviewerChannelLabel(channel.role)} unavailable: ${issues.get(reviewerChannelIdentity(channel))}`,
				)
			: [];
	const unavailableBackups = degradedFallback
		? channels.slice(1).map(
				(channel) =>
					`${reviewerChannelLabel(channel.role)} unavailable: ${issues.get(reviewerChannelIdentity(channel))}`,
			)
		: [];
	ctx.ui.notify(
		[
			`AI Approval · ${summaryLabel} · ${temporaryBypassActive ? "reviews disabled" : "fail-closed"}`,
			temporaryBypassActive
				? "Temporary bypass: active; covered agent tool calls are not being reviewed. Run /ai-approval enable to restore protection."
				: "Temporary bypass: inactive",
			`Primary: ${modelSettingDisplay(config.primaryModel, primaryChannel)} (${config.primaryModelSource}) · thinking ${thinkingSettingDisplay(config.primaryThinkingLevel ?? DEFAULT_REVIEWER_THINKING_LEVEL, primaryChannel, ctx.thinkingLevel)} (${config.primaryThinkingLevelSource ?? "default"}) · ${channelStatus(issues.get(primaryIdentity))}`,
			`Secondary: ${modelSettingDisplay(config.secondaryModel, secondaryChannel)} (${config.secondaryModelSource}) · thinking ${thinkingSettingDisplay(config.secondaryThinkingLevel ?? DEFAULT_REVIEWER_THINKING_LEVEL, secondaryChannel, ctx.thinkingLevel)} (${config.secondaryThinkingLevelSource ?? "default"}) · ${secondaryStatus}`,
			`Current-model fallback: ${currentChannel?.modelSpec ?? "unavailable"} · thinking ${currentChannel ? thinkingSettingDisplay(CURRENT_MODEL_SETTING, currentChannel, ctx.thinkingLevel) : "unavailable"} · ${currentFallbackStatus}`,
			`${formatDuration(config.timeoutMs)} deadline (${config.timeoutSource}) · up to 3 attempts per distinct reviewer channel`,
			`Assessment language: ${config.assessmentLanguage} (${config.assessmentLanguageSource})`,
			`Policy: ${config.policy ? `customized (${config.policySources.join(" + ")})` : "default"}`,
			`Global config: ${config.globalConfigPresent ? "present" : "absent"} · ${config.globalPath}`,
			`Project config: ${projectConfigStatus} · ${config.projectPath}`,
			config.warnings.length > 0
				? `Configuration: ${config.warnings.length} warning(s); invalid entries ignored, remaining valid settings and defaults active.`
				: "Configuration: valid",
			...details,
			...unavailableBeforeSelected,
			...unavailableBackups,
			...config.warnings.map((warning) => `Configuration warning: ${warning}`),
			...(issue ? [issue] : []),
		].join("\n"),
		temporaryBypassActive ||
			!ready ||
			degradedFallback ||
			config.warnings.length > 0
			? "warning"
			: "info",
	);
}
