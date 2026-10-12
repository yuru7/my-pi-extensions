import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AutoTitleSettings } from "../src/config.ts";
import {
	describeModel,
	planModelAttempts,
	resolveModel,
	resolveThinkingLevel,
	type SessionModelInfo,
} from "../src/model.ts";

function fakeModel(
	provider: string,
	id: string,
	reasoning = false,
): Model<Api> {
	return { provider, id, reasoning } as unknown as Model<Api>;
}

const settings: AutoTitleSettings = {
	enabled: true,
	model: "CURRENT",
	thinkingLevel: "CURRENT",
	fallbackToCurrentModel: true,
};

function fakeInfo(
	currentModel: Model<Api> | undefined,
	overrides: Partial<SessionModelInfo> = {},
): SessionModelInfo {
	return {
		currentModel,
		currentThinkingLevel: "off",
		findModel: () => undefined,
		hasAuth: () => true,
		...overrides,
	};
}

describe("resolveModel", () => {
	test("CURRENT selects the active session model", () => {
		const current = fakeModel("openai", "gpt-5.4");
		assert.deepEqual(resolveModel("CURRENT", fakeInfo(current)), {
			ok: true,
			model: current,
		});
	});

	test("CURRENT fails when the session has no model", () => {
		const result = resolveModel("CURRENT", fakeInfo(undefined));
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.reason : "", /no active model/);
	});

	test("an explicit provider/model-id is resolved through the registry", () => {
		const requested = fakeModel("anthropic", "claude-sonnet-4-5");
		const info = fakeInfo(fakeModel("openai", "gpt-5.4"), {
			findModel: (reference) =>
				reference === "anthropic/claude-sonnet-4-5" ? requested : undefined,
		});
		assert.deepEqual(resolveModel("anthropic/claude-sonnet-4-5", info), {
			ok: true,
			model: requested,
		});
	});

	test("the model id may contain slashes", () => {
		const requested = fakeModel("openrouter", "anthropic/claude-3.5");
		const info = fakeInfo(undefined, {
			findModel: (reference) => {
				assert.equal(reference, "openrouter/anthropic/claude-3.5");
				return requested;
			},
		});
		assert.deepEqual(resolveModel("openrouter/anthropic/claude-3.5", info), {
			ok: true,
			model: requested,
		});
	});

	test("an unknown model reference fails with a reason", () => {
		const result = resolveModel("anthropic/nope", fakeInfo(undefined));
		assert.equal(result.ok, false);
		assert.match(
			result.ok === false ? result.reason : "",
			/not in the model registry/,
		);
	});

	test("a model without credentials fails with a reason", () => {
		const requested = fakeModel("anthropic", "claude-sonnet-4-5");
		const info = fakeInfo(fakeModel("openai", "gpt-5.4"), {
			findModel: () => requested,
			hasAuth: () => false,
		});
		const result = resolveModel("anthropic/claude-sonnet-4-5", info);
		assert.equal(result.ok, false);
		assert.match(
			result.ok === false ? result.reason : "",
			/no credentials for anthropic\/claude-sonnet-4-5/,
		);
	});
});

describe("resolveThinkingLevel", () => {
	const thinkingModel = fakeModel("anthropic", "claude-sonnet-4-5", true);

	test("CURRENT resolves to the session thinking level", () => {
		assert.deepEqual(resolveThinkingLevel("CURRENT", thinkingModel, "high"), {
			level: "high",
		});
	});

	test("an explicit level is kept when the model supports it", () => {
		assert.deepEqual(resolveThinkingLevel("low", thinkingModel, "high"), {
			level: "low",
		});
		assert.deepEqual(resolveThinkingLevel("off", thinkingModel, "high"), {
			level: "off",
		});
	});

	test("an unsupported level is adjusted with Pi's rules and logged", () => {
		const result = resolveThinkingLevel("xhigh", thinkingModel, "off");
		assert.equal(result.level, "high");
		assert.match(result.log ?? "", /thinking level "xhigh" is not available/);
		assert.match(result.log ?? "", /using "high"/);
	});

	test("a model without thinking clamps to off", () => {
		const plainModel = fakeModel("openai", "gpt-5.4");
		const result = resolveThinkingLevel("CURRENT", plainModel, "medium");
		assert.equal(result.level, "off");
		assert.match(result.log ?? "", /using "off"/);
	});
});

describe("planModelAttempts", () => {
	const current = fakeModel("openai", "gpt-5.4");
	const requested = fakeModel("anthropic", "claude-sonnet-4-5");

	test("the configured model runs first with the session thinking level", () => {
		const reasoningModel = fakeModel("anthropic", "claude-sonnet-4-5", true);
		const info = fakeInfo(current, {
			findModel: () => reasoningModel,
			currentThinkingLevel: "high" as ModelThinkingLevel,
		});
		const plan = planModelAttempts(
			{
				...settings,
				model: "anthropic/claude-sonnet-4-5",
				fallbackToCurrentModel: false,
			},
			info,
		);
		assert.equal(plan.attempts.length, 1);
		assert.equal(plan.attempts[0].model, reasoningModel);
		assert.equal(plan.attempts[0].thinkingLevel, "high");
		assert.equal(plan.attempts[0].fallbackFrom, undefined);
		assert.equal(plan.failure, undefined);
	});

	test("the current model is the fallback when the configured model is unusable", () => {
		const info = fakeInfo(current);
		const plan = planModelAttempts(
			{ ...settings, model: "anthropic/missing" },
			info,
		);
		assert.equal(plan.attempts.length, 1);
		assert.equal(plan.attempts[0].model, current);
		assert.equal(plan.attempts[0].fallbackFrom, "anthropic/missing");
		assert.match(
			plan.attempts[0].fallbackReason ?? "",
			/not in the model registry/,
		);
		assert.equal(plan.failure, undefined);
	});

	test("the current model is the fallback when the configured model has no credentials", () => {
		const info = fakeInfo(current, {
			findModel: () => requested,
			hasAuth: () => false,
		});
		const plan = planModelAttempts(
			{ ...settings, model: "anthropic/claude-sonnet-4-5" },
			info,
		);
		assert.equal(plan.attempts.length, 1);
		assert.equal(plan.attempts[0].model, current);
		assert.match(
			plan.attempts[0].fallbackReason ?? "",
			/no credentials for anthropic\/claude-sonnet-4-5/,
		);
	});

	test("a usable primary still gets one fallback for call failures", () => {
		const info = fakeInfo(current, { findModel: () => requested });
		const plan = planModelAttempts(
			{ ...settings, model: "anthropic/claude-sonnet-4-5" },
			info,
		);
		assert.equal(plan.attempts.length, 2);
		assert.equal(plan.attempts[0].model, requested);
		assert.equal(plan.attempts[1].model, current);
		assert.equal(plan.attempts[1].fallbackFrom, "anthropic/claude-sonnet-4-5");
	});

	test("no fallback when it would repeat the primary model", () => {
		const info = fakeInfo(current, { findModel: () => current });
		const plan = planModelAttempts(
			{ ...settings, model: "openai/gpt-5.4" },
			info,
		);
		assert.equal(plan.attempts.length, 1);
		assert.equal(plan.attempts[0].model, current);
	});

	test("no fallback when fallbackToCurrentModel is off", () => {
		const info = fakeInfo(current);
		const plan = planModelAttempts(
			{
				...settings,
				model: "anthropic/missing",
				fallbackToCurrentModel: false,
			},
			info,
		);
		assert.equal(plan.attempts.length, 0);
		assert.match(plan.failure ?? "", /not in the model registry/);
		assert.match(plan.failure ?? "", /fallbackToCurrentModel is off/);
	});

	test("nothing is planned when there is no model at all", () => {
		const plan = planModelAttempts(settings, fakeInfo(undefined));
		assert.equal(plan.attempts.length, 0);
		assert.match(plan.failure ?? "", /no active model/);
	});

	test("the fallback attempt uses its own thinking level clamp", () => {
		const reasoningModel = fakeModel("anthropic", "claude-sonnet-4-5", true);
		const info = fakeInfo(current, {
			findModel: () => reasoningModel,
			currentThinkingLevel: "off",
		});
		const plan = planModelAttempts(
			{
				...settings,
				model: "anthropic/claude-sonnet-4-5",
				thinkingLevel: "xhigh",
			},
			info,
		);
		assert.equal(plan.attempts[0].thinkingLevel, "high");
		assert.equal(plan.attempts[1].thinkingLevel, "off");
	});

	test("describeModel labels models as provider/model-id", () => {
		assert.equal(describeModel(requested), "anthropic/claude-sonnet-4-5");
	});
});
