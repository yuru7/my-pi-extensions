import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CURRENT_MODEL_SETTING,
	DEFAULT_REVIEWER_THINKING_LEVEL,
	REVIEWER_THINKING_LEVELS,
	type ApprovalConfig,
	type ReviewerThinkingLevel,
	type ReviewerThinkingSetting,
} from "./config.ts";
import type { ReviewResult } from "./gate.ts";
import { parseModelSpec } from "./review.ts";
import {
	resolveReviewerModel,
	type ReviewerModel,
} from "./reviewer-session.ts";

export type ReviewerChannelRole =
	| "primary"
	| "secondary"
	| "current-model";

export interface ReviewerChannel {
	role: ReviewerChannelRole;
	modelSpec: string;
	model?: ReviewerModel;
	/** Raw thinking setting: a thinking level or "CURRENT". */
	thinkingLevelSetting: ReviewerThinkingSetting;
	/** Effective thinking level after resolving CURRENT. */
	thinkingLevel: ReviewerThinkingLevel;
}

export interface ReviewerHealth {
	ready: boolean;
	reason?: string;
	selectedFallback?: Exclude<ReviewerChannelRole, "primary">;
	fallbackUnavailable?: boolean;
}

export function isReviewerThinkingLevel(
	value: unknown,
): value is ReviewerThinkingLevel {
	return (
		typeof value === "string" &&
		(REVIEWER_THINKING_LEVELS as readonly string[]).includes(value)
	);
}

/**
 * Resolves a thinking setting to the effective level. CURRENT inherits the
 * current session's thinking level; when it is unavailable, the default
 * (low) applies so the reviewer still runs fail-closed elsewhere.
 */
export function resolveReviewerThinkingLevel(
	setting?: ReviewerThinkingSetting | string,
	sessionThinkingLevel?: string,
): ReviewerThinkingLevel {
	if (setting === CURRENT_MODEL_SETTING) {
		return isReviewerThinkingLevel(sessionThinkingLevel)
			? sessionThinkingLevel
			: DEFAULT_REVIEWER_THINKING_LEVEL;
	}
	return isReviewerThinkingLevel(setting)
		? setting
		: DEFAULT_REVIEWER_THINKING_LEVEL;
}

export function modelSpecFor(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Resolves one configured model setting to a reviewer channel. The special
 * `CURRENT` setting resolves to the current session model. The thinking
 * setting is resolved separately; channel identity stays model-only so a
 * duplicate model is skipped even when thinking levels differ.
 */
export function reviewerChannelForSetting(
	role: ReviewerChannelRole,
	setting: string,
	registry: ExtensionContext["modelRegistry"],
	currentModel?: ExtensionContext["model"],
	thinkingSetting?: ReviewerThinkingSetting | string,
	sessionThinkingLevel?: string,
): ReviewerChannel {
	const thinkingLevelSetting: ReviewerThinkingSetting =
		(thinkingSetting as ReviewerThinkingSetting | undefined) ??
		DEFAULT_REVIEWER_THINKING_LEVEL;
	const thinkingLevel = resolveReviewerThinkingLevel(
		thinkingLevelSetting,
		sessionThinkingLevel,
	);
	if (setting === CURRENT_MODEL_SETTING) {
		return {
			role,
			modelSpec: CURRENT_MODEL_SETTING,
			model: currentModel ? (currentModel as ReviewerModel) : undefined,
			thinkingLevelSetting,
			thinkingLevel,
		};
	}
	const parsed = parseModelSpec(setting);
	const resolved = parsed
		? resolveReviewerModel(registry, parsed.provider, parsed.model)
		: undefined;
	const model =
		currentModel && modelSpecFor(currentModel) === setting
			? (currentModel as ReviewerModel)
			: resolved;
	return {
		role,
		modelSpec: setting,
		model,
		thinkingLevelSetting,
		thinkingLevel,
	};
}

export function currentReviewerChannel(
	currentModel: ExtensionContext["model"],
	sessionThinkingLevel?: string,
): ReviewerChannel | undefined {
	return currentModel
		? {
				role: "current-model",
				modelSpec: modelSpecFor(currentModel),
				model: currentModel as ReviewerModel,
				thinkingLevelSetting: CURRENT_MODEL_SETTING,
				thinkingLevel: resolveReviewerThinkingLevel(
					CURRENT_MODEL_SETTING,
					sessionThinkingLevel,
				),
			}
		: undefined;
}

export function reviewerChannelIdentity(channel: ReviewerChannel): string {
	return channel.model ? modelSpecFor(channel.model) : channel.modelSpec;
}

export function buildReviewerChannels(
	config: ApprovalConfig,
	registry: ExtensionContext["modelRegistry"],
	currentModel?: ExtensionContext["model"],
	sessionThinkingLevel?: string,
): ReviewerChannel[] {
	const candidates = [
		reviewerChannelForSetting(
			"primary",
			config.primaryModel,
			registry,
			currentModel,
			config.primaryThinkingLevel ?? DEFAULT_REVIEWER_THINKING_LEVEL,
			sessionThinkingLevel,
		),
		reviewerChannelForSetting(
			"secondary",
			config.secondaryModel,
			registry,
			currentModel,
			config.secondaryThinkingLevel ?? DEFAULT_REVIEWER_THINKING_LEVEL,
			sessionThinkingLevel,
		),
		currentReviewerChannel(currentModel, sessionThinkingLevel),
	].filter((channel): channel is ReviewerChannel => channel !== undefined);
	// A model appearing more than once in the chain is tried only once: the
	// first channel that resolves to it owns the attempt, later duplicates are
	// skipped so an unavailable model is never requested repeatedly.
	// Identity is model-only; thinking levels never create a separate channel.
	const seen = new Set<string>();
	return candidates.filter((channel) => {
		const identity = reviewerChannelIdentity(channel);
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
}

export function reviewerChannelLabel(role: ReviewerChannelRole): string {
	switch (role) {
		case "primary":
			return "Primary";
		case "secondary":
			return "Secondary";
		case "current-model":
			return "Current session model";
	}
}

function reviewerChannelIssue(
	channel: ReviewerChannel,
	registry: ExtensionContext["modelRegistry"],
): string | undefined {
	return !channel.model
		? channel.modelSpec === CURRENT_MODEL_SETTING
			? "Current session model is unavailable."
			: `Reviewer model not found: ${channel.modelSpec}.`
		: !registry.hasConfiguredAuth(channel.model)
			? `Reviewer authentication is unavailable for ${channel.model.provider}.`
			: undefined;
}

export function reviewerHealth(
	config: ApprovalConfig,
	registry: ExtensionContext["modelRegistry"],
	currentModel?: ExtensionContext["model"],
	sessionThinkingLevel?: string,
): ReviewerHealth {
	const channels = buildReviewerChannels(
		config,
		registry,
		currentModel,
		sessionThinkingLevel,
	);
	const issues = channels.map((channel) =>
		reviewerChannelIssue(channel, registry),
	);
	const primaryIssue = issues[0];
	const backups = channels.slice(1);
	const backupIssues = issues.slice(1);
	if (!primaryIssue) {
		return backups.length > 0 && backupIssues.every(Boolean)
			? {
					ready: true,
					reason: backupIssues
						.map(
							(issue, index) =>
								`${reviewerChannelLabel(backups[index].role)} unavailable: ${issue}`,
						)
						.join(" "),
					fallbackUnavailable: true,
				}
			: { ready: true };
	}
	const readyFallbackIndex = backupIssues.findIndex((issue) => !issue);
	if (readyFallbackIndex >= 0) {
		const selected = backups[readyFallbackIndex];
		return {
			ready: true,
			reason: channels
				.slice(0, readyFallbackIndex + 1)
				.map(
					(channel, index) =>
						`${reviewerChannelLabel(channel.role)} unavailable: ${issues[index]}`,
				)
				.join(" "),
			selectedFallback: selected.role as Exclude<
				ReviewerChannelRole,
				"primary"
			>,
		};
	}
	return {
		ready: false,
		reason: channels
			.map(
				(channel, index) =>
					`${reviewerChannelLabel(channel.role)} unavailable: ${issues[index]}`,
			)
			.join(" "),
	};
}

/**
 * Reviewer failures and timeouts move down the channel chain (secondary, then
 * the current session model). A cancelled review must not trigger a fallback;
 * it fails closed.
 */
export function shouldFallbackReview(result: ReviewResult): boolean {
	return result.kind === "failure" || result.kind === "timeout";
}

export async function runReviewWithFallbackChain(
	channels: ReviewerChannel[],
	review: (channel: ReviewerChannel) => Promise<ReviewResult>,
	onFallback: (from: ReviewerChannel, to: ReviewerChannel) => void,
): Promise<{
	result: ReviewResult;
	finalChannel: ReviewerChannel;
	attempts: Array<{ channel: ReviewerChannel; result: ReviewResult }>;
}> {
	const seen = new Set<string>();
	const distinctChannels = channels.filter((channel) => {
		const identity = reviewerChannelIdentity(channel);
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
	if (distinctChannels.length === 0)
		throw new Error("No reviewer channels are configured.");
	const attempts: Array<{
		channel: ReviewerChannel;
		result: ReviewResult;
	}> = [];
	for (let index = 0; index < distinctChannels.length; index++) {
		const channel = distinctChannels[index];
		if (index > 0) onFallback(distinctChannels[index - 1], channel);
		const result = await review(channel);
		attempts.push({ channel, result });
		if (
			!shouldFallbackReview(result) ||
			index === distinctChannels.length - 1
		) {
			return { result, finalChannel: channel, attempts };
		}
	}
	throw new Error("Reviewer chain ended unexpectedly.");
}
