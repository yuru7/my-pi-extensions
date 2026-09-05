import assert from "node:assert/strict";
import test from "node:test";
import { loadApprovalConfig } from "../src/config.ts";
import {
	buildReviewerChannels,
	currentReviewerChannel,
	resolveReviewerThinkingLevel,
	reviewerChannelForSetting,
	reviewerChannelIdentity,
} from "../src/reviewer-channels.ts";

function registryFor(model: unknown) {
	return {
		find: () => model,
		hasConfiguredAuth: () => true,
	} as never;
}

test("resolves fixed thinking levels per channel", () => {
	const model = { provider: "openai", id: "reviewer" };
	const registry = registryFor(model);
	const primary = reviewerChannelForSetting(
		"primary",
		"openai/reviewer",
		registry,
		undefined,
		"high",
		"low",
	);
	assert.equal(primary.thinkingLevelSetting, "high");
	assert.equal(primary.thinkingLevel, "high");
	const secondary = reviewerChannelForSetting(
		"secondary",
		"openai/reviewer",
		registry,
		undefined,
		"minimal",
		"low",
	);
	assert.equal(secondary.thinkingLevel, "minimal");
});

test("resolves CURRENT thinking from the session level", () => {
	const model = { provider: "openai", id: "reviewer" };
	const registry = registryFor(model);
	const channel = reviewerChannelForSetting(
		"primary",
		"openai/reviewer",
		registry,
		undefined,
		"CURRENT",
		"medium",
	);
	assert.equal(channel.thinkingLevelSetting, "CURRENT");
	assert.equal(channel.thinkingLevel, "medium");
});

test("falls back to low when CURRENT has no session level", () => {
	assert.equal(resolveReviewerThinkingLevel("CURRENT", undefined), "low");
	assert.equal(resolveReviewerThinkingLevel("CURRENT", "bogus"), "low");
	assert.equal(resolveReviewerThinkingLevel(undefined, "high"), "low");
	assert.equal(resolveReviewerThinkingLevel("high", undefined), "high");
});

test("current-model channel always inherits the session thinking level", () => {
	const current = { provider: "anthropic", id: "current-model" };
	const channel = currentReviewerChannel(current as never, "xhigh");
	assert.equal(channel?.thinkingLevelSetting, "CURRENT");
	assert.equal(channel?.thinkingLevel, "xhigh");
	const fallback = currentReviewerChannel(current as never, undefined);
	assert.equal(fallback?.thinkingLevel, "low");
});

test("skips a duplicate model even when thinking levels differ", () => {
	const model = { provider: "openai", id: "shared" };
	const registry = registryFor(model);
	const config = loadApprovalConfig({
		cwd: "/repo/project",
		projectTrusted: false,
		agentDir: "/missing-agent-dir",
		env: {
			PI_AI_APPROVAL_PRIMARY_MODEL: "openai/shared",
			PI_AI_APPROVAL_SECONDARY_MODEL: "openai/shared",
			PI_AI_APPROVAL_PRIMARY_THINKING_LEVEL: "low",
			PI_AI_APPROVAL_SECONDARY_THINKING_LEVEL: "high",
		},
	});
	const channels = buildReviewerChannels(config, registry);
	assert.deepEqual(
		channels.map((c) => c.role),
		["primary"],
	);
	assert.equal(channels[0].thinkingLevel, "low");
	// Identity stays model-only.
	assert.equal(
		reviewerChannelIdentity({
			role: "primary",
			modelSpec: "openai/shared",
			model: model as never,
			thinkingLevelSetting: "low",
			thinkingLevel: "low",
		}),
		reviewerChannelIdentity({
			role: "secondary",
			modelSpec: "openai/shared",
			model: model as never,
			thinkingLevelSetting: "high",
			thinkingLevel: "high",
		}),
	);
});

test("keeps distinct models with their own thinking levels", () => {
	const primary = { provider: "openai", id: "primary" };
	const secondary = { provider: "openai", id: "secondary" };
	const registry = {
		find: (provider: string, id: string) =>
			id === "primary" ? primary : id === "secondary" ? secondary : undefined,
		hasConfiguredAuth: () => true,
	} as never;
	const config = loadApprovalConfig({
		cwd: "/repo/project",
		projectTrusted: false,
		agentDir: "/missing-agent-dir",
		env: {
			PI_AI_APPROVAL_PRIMARY_MODEL: "openai/primary",
			PI_AI_APPROVAL_SECONDARY_MODEL: "openai/secondary",
			PI_AI_APPROVAL_PRIMARY_THINKING_LEVEL: "minimal",
			PI_AI_APPROVAL_SECONDARY_THINKING_LEVEL: "max",
		},
	});
	const channels = buildReviewerChannels(config, registry);
	assert.deepEqual(
		channels.map((c) => c.role),
		["primary", "secondary"],
	);
	assert.equal(channels[0].thinkingLevel, "minimal");
	assert.equal(channels[1].thinkingLevel, "max");
});

test("passes the resolved thinking level to new controllers when session thinking changes", async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { default: aiApproval } = await import("../extensions/index.ts");
	const { ReviewerSessionController } = await import("../src/reviewer-session.ts");

	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	aiApproval({
		on: (name: string, handler: (event: unknown, ctx: never) => unknown) => {
			handlers.set(name, handler);
		},
		registerCommand: () => undefined,
	} as never);
	const originalReview = ReviewerSessionController.prototype.review;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousPrimary = process.env.PI_AI_APPROVAL_PRIMARY_MODEL;
	const previousPrimaryThinking =
		process.env.PI_AI_APPROVAL_PRIMARY_THINKING_LEVEL;
	const previousSecondary = process.env.PI_AI_APPROVAL_SECONDARY_MODEL;
	const previousSecondaryThinking =
		process.env.PI_AI_APPROVAL_SECONDARY_THINKING_LEVEL;
	const root = mkdtempSync(join(tmpdir(), "ai-approval-thinking-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_AI_APPROVAL_PRIMARY_MODEL = "custom/reviewer";
	process.env.PI_AI_APPROVAL_PRIMARY_THINKING_LEVEL = "CURRENT";
	process.env.PI_AI_APPROVAL_SECONDARY_MODEL = "custom/reviewer";
	process.env.PI_AI_APPROVAL_SECONDARY_THINKING_LEVEL = "low";
	const seen: Array<{ thinking?: unknown; instance: object }> = [];
	ReviewerSessionController.prototype.review = async function (
		this: unknown,
	) {
		const options = (this as unknown as { options: { thinkingLevel?: unknown } })
			.options;
		seen.push({ thinking: options.thinkingLevel, instance: this as object });
		return {
			kind: "assessed",
			assessment: {
				risk_level: "low",
				instruction_alignment: "direct",
				action_summary: "Runs a benign echo command.",
				rationale: "No state change or data exposure.",
			},
		};
	} as typeof originalReview;

	const model = { provider: "custom", id: "reviewer" };
	let branch: unknown[] = [];
	const baseCtx = {
		cwd: join(root, "project"),
		isProjectTrusted: () => false,
		model,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "custom" && id === "reviewer" ? model : undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
			hasConfiguredAuth: () => true,
		},
		sessionManager: { getBranch: () => branch },
		signal: undefined,
		abort: () => undefined,
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: () => undefined,
		},
	} as never;

	const runToolCall = async (toolCallId: string, thinkingLevel: string) => {
		branch = [
			{ type: "message", message: { role: "user", content: "Run it." } },
			{
				type: "message",
				id: `batch-${toolCallId}`,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: toolCallId }],
				},
			},
		];
		const event = {
			toolName: "bash",
			input: { command: "echo safe" },
			toolCallId,
		} as never;
		const handler = handlers.get("tool_call") as (
			event: unknown,
			ctx: unknown,
		) => unknown;
		return await handler(event, { ...(baseCtx as object), thinkingLevel });
	};

	try {
		assert.equal(await runToolCall("call-1", "medium"), undefined);
		assert.equal(await runToolCall("call-2", "high"), undefined);
		assert.deepEqual(
			seen.map((entry) => entry.thinking),
			["medium", "high"],
		);
		assert.notEqual(seen[0].instance, seen[1].instance);
	} finally {
		ReviewerSessionController.prototype.review = originalReview;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousPrimary === undefined)
			delete process.env.PI_AI_APPROVAL_PRIMARY_MODEL;
		else process.env.PI_AI_APPROVAL_PRIMARY_MODEL = previousPrimary;
		if (previousPrimaryThinking === undefined)
			delete process.env.PI_AI_APPROVAL_PRIMARY_THINKING_LEVEL;
		else
			process.env.PI_AI_APPROVAL_PRIMARY_THINKING_LEVEL =
				previousPrimaryThinking;
		if (previousSecondary === undefined)
			delete process.env.PI_AI_APPROVAL_SECONDARY_MODEL;
		else process.env.PI_AI_APPROVAL_SECONDARY_MODEL = previousSecondary;
		if (previousSecondaryThinking === undefined)
			delete process.env.PI_AI_APPROVAL_SECONDARY_THINKING_LEVEL;
		else
			process.env.PI_AI_APPROVAL_SECONDARY_THINKING_LEVEL =
				previousSecondaryThinking;
	}
});
