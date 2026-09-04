import type { RiskActions, RiskAction } from "./config.ts";
import type { RiskAssessment, RiskLevel } from "./review.ts";

/**
 * Maps a reviewer risk classification to the local allow/ask/deny policy.
 * This layer is pure: no AI calls, no UI, no side effects.
 */
export function resolveRiskAction(
	riskLevel: RiskLevel,
	riskActions: RiskActions,
): RiskAction {
	const action: RiskAction = riskActions[riskLevel];
	// The config parser already rejects "allow" for very_high/critical; this
	// guard keeps the invariant even if a hand-built config bypasses parsing.
	if (
		action === "allow" &&
		(riskLevel === "very_high" || riskLevel === "critical")
	) {
		return "deny";
	}
	return action;
}

export type RiskPolicyDecision =
	| { kind: "allow"; assessment: RiskAssessment }
	| { kind: "ask"; assessment: RiskAssessment }
	| { kind: "deny"; assessment: RiskAssessment };

/** Applies the configured risk policy to one reviewer assessment. */
export function applyRiskPolicy(
	assessment: RiskAssessment,
	riskActions: RiskActions,
): RiskPolicyDecision {
	const action = resolveRiskAction(assessment.risk_level, riskActions);
	if (action === "allow") return { kind: "allow", assessment };
	if (action === "ask") return { kind: "ask", assessment };
	return { kind: "deny", assessment };
}
