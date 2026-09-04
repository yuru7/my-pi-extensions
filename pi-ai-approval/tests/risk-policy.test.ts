import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RISK_ACTIONS } from "../src/config.ts";
import {
	applyRiskPolicy,
	resolveRiskAction,
} from "../src/risk-policy.ts";

function riskActionsFor(
	entries: Partial<Record<string, "allow" | "ask" | "deny">>,
) {
	return { ...DEFAULT_RISK_ACTIONS, ...entries };
}

function assessment(riskLevel: string) {
	return {
		risk_level: riskLevel as never,
		instruction_alignment: "direct" as const,
		action_summary: "Runs the planned operation.",
		rationale: "Justification for the risk level.",
	};
}

test("resolves every risk level from the configured riskActions", () => {
	const actions = riskActionsFor({
		very_low: "allow",
		low: "allow",
		medium: "ask",
		high: "ask",
		very_high: "deny",
		critical: "deny",
	});
	assert.equal(resolveRiskAction("very_low", actions), "allow");
	assert.equal(resolveRiskAction("low", actions), "allow");
	assert.equal(resolveRiskAction("medium", actions), "ask");
	assert.equal(resolveRiskAction("high", actions), "ask");
	assert.equal(resolveRiskAction("very_high", actions), "deny");
	assert.equal(resolveRiskAction("critical", actions), "deny");
});

test("every risk level can be set to allow, ask, or deny except very_high and critical", () => {
	for (const level of ["very_low", "low", "medium", "high"] as const) {
		for (const action of ["allow", "ask", "deny"] as const) {
			assert.equal(
				resolveRiskAction(level, riskActionsFor({ [level]: action })),
				action,
			);
		}
	}
	for (const level of ["very_high", "critical"] as const) {
		for (const action of ["ask", "deny"] as const) {
			assert.equal(
				resolveRiskAction(level, riskActionsFor({ [level]: action })),
				action,
			);
		}
	}
});

test("very_high and critical can never resolve to allow", () => {
	// Guards against a hand-built config bypassing the config parser.
	assert.equal(
		resolveRiskAction(
			"very_high",
			riskActionsFor({ very_high: "allow" }) as never,
		),
		"deny",
	);
	assert.equal(
		resolveRiskAction(
			"critical",
			riskActionsFor({ critical: "allow" }) as never,
		),
		"deny",
	);
});

test("applyRiskPolicy maps the classification to allow, ask, and deny", () => {
	assert.deepEqual(applyRiskPolicy(assessment("very_low"), DEFAULT_RISK_ACTIONS), {
		kind: "allow",
		assessment: assessment("very_low"),
	});
	assert.deepEqual(applyRiskPolicy(assessment("medium"), DEFAULT_RISK_ACTIONS), {
		kind: "ask",
		assessment: assessment("medium"),
	});
	assert.deepEqual(applyRiskPolicy(assessment("high"), DEFAULT_RISK_ACTIONS), {
		kind: "deny",
		assessment: assessment("high"),
	});
	assert.deepEqual(applyRiskPolicy(assessment("critical"), DEFAULT_RISK_ACTIONS), {
		kind: "deny",
		assessment: assessment("critical"),
	});
});
