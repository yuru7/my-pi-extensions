import type { RiskActions } from "./config.ts";
import { applyRiskPolicy } from "./risk-policy.ts";
import type { RiskAssessment, RiskLevel } from "./review.ts";

/**
 * Session approval rules: user-authored authorizations that let one `ask` or
 * `deny` classification fall by one risk level for the rest of the Pi session.
 * They live in memory only — nothing is persisted, and a new session starts
 * empty.
 */
export const SESSION_RULE_MAX_CHARS = 500;
export const SESSION_RULE_MAX_COUNT = 20;

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export interface SessionApprovalRule {
	/** Stable identifier the reviewer uses to report a cover match. */
	id: string;
	/** Sanitized single-line rule text. */
	text: string;
	/** Creation time, kept for ordering and display. */
	createdAt: number;
}

export type SessionRuleRejection =
	| "empty"
	| "too_long"
	| "capacity"
	| "not_found";

export type SessionRuleMutation =
	| { ok: true; rule: SessionApprovalRule }
	| { ok: false; reason: SessionRuleRejection };

export type SessionRuleRemoval =
	| { ok: true; rule: SessionApprovalRule }
	| { ok: false; reason: "not_found" };

/**
 * Collapses a rule to one sanitized line: control characters (including ANSI
 * escapes) are stripped so the text cannot forge prompt structure, and any
 * whitespace run becomes a single space. Truncation is deliberately absent: a
 * cut rule would mean something else, so over-long text is rejected instead.
 */
export function sanitizeSessionRuleText(value: string): string {
	return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/**
 * In-memory rule set for one Pi session. Every mutation validates first so an
 * invalid rule can never reach the reviewer or the risk decision.
 */
export class SessionRuleStore {
	private rules: SessionApprovalRule[] = [];
	private nextId = 1;

	/** Snapshot of the current rules, in creation order. */
	list(): readonly SessionApprovalRule[] {
		return [...this.rules];
	}

	find(id: string): SessionApprovalRule | undefined {
		return this.rules.find((rule) => rule.id === id);
	}

	add(text: string, now: number = Date.now()): SessionRuleMutation {
		const normalized = sanitizeSessionRuleText(text);
		if (!normalized) return { ok: false, reason: "empty" };
		if (normalized.length > SESSION_RULE_MAX_CHARS) {
			return { ok: false, reason: "too_long" };
		}
		if (this.rules.length >= SESSION_RULE_MAX_COUNT) {
			return { ok: false, reason: "capacity" };
		}
		const rule: SessionApprovalRule = {
			id: `rule-${this.nextId++}`,
			text: normalized,
			createdAt: now,
		};
		this.rules.push(rule);
		return { ok: true, rule };
	}

	update(id: string, text: string): SessionRuleMutation {
		const index = this.rules.findIndex((rule) => rule.id === id);
		if (index < 0) return { ok: false, reason: "not_found" };
		const normalized = sanitizeSessionRuleText(text);
		if (!normalized) return { ok: false, reason: "empty" };
		if (normalized.length > SESSION_RULE_MAX_CHARS) {
			return { ok: false, reason: "too_long" };
		}
		const rule: SessionApprovalRule = {
			...this.rules[index],
			text: normalized,
		};
		this.rules[index] = rule;
		return { ok: true, rule };
	}

	remove(id: string): SessionRuleRemoval {
		const index = this.rules.findIndex((rule) => rule.id === id);
		if (index < 0) return { ok: false, reason: "not_found" };
		const [rule] = this.rules.splice(index, 1);
		return { ok: true, rule };
	}

	/** Drops every rule, so the next session also starts its IDs from one. */
	clear(): void {
		this.rules = [];
		this.nextId = 1;
	}
}

/** User-facing explanation for a rejected rule read or write. */
export function sessionRuleRejectionMessage(
	reason: SessionRuleRejection,
): string {
	switch (reason) {
		case "empty":
			return "Rule text cannot be empty.";
		case "too_long":
			return `Rule text cannot be longer than ${SESSION_RULE_MAX_CHARS} characters.`;
		case "capacity":
			return `At most ${SESSION_RULE_MAX_COUNT} session rules can be active.`;
		case "not_found":
			return "The session rule no longer exists.";
	}
}

const LOWER_LEVEL: Record<RiskLevel, RiskLevel> = {
	critical: "very_high",
	very_high: "high",
	high: "medium",
	medium: "low",
	low: "very_low",
	very_low: "very_low",
};

/** Lowers one assessed level by a single step; `very_low` is the floor. */
export function lowerRiskLevel(level: RiskLevel): RiskLevel {
	return LOWER_LEVEL[level];
}

export type SessionRulePolicyDecision =
	| { kind: "allow"; assessment: RiskAssessment; loweredFrom?: RiskLevel }
	| { kind: "ask"; assessment: RiskAssessment; loweredFrom?: RiskLevel }
	| { kind: "deny"; assessment: RiskAssessment };

/**
 * Applies the configured risk policy with a matched session rule taken into
 * account. The rule lowers an `ask` or `deny` classification by one level and
 * the lowered level is re-evaluated against the policy; an `allow` outcome is
 * already permissive, so the rule changes nothing there. A rule never
 * strengthens an outcome: when the lowered level is mapped to `deny` (or the
 * level cannot fall further), the original decision stands.
 */
export function applySessionRulePolicy(
	assessment: RiskAssessment,
	riskActions: RiskActions,
	sessionRuleMatched: boolean,
): SessionRulePolicyDecision {
	const decision = applyRiskPolicy(assessment, riskActions);
	if (decision.kind === "allow" || !sessionRuleMatched) return decision;
	const loweredLevel = lowerRiskLevel(assessment.risk_level);
	if (loweredLevel === assessment.risk_level) return decision;
	const loweredAssessment: RiskAssessment = {
		...assessment,
		risk_level: loweredLevel,
	};
	const loweredDecision = applyRiskPolicy(loweredAssessment, riskActions);
	if (loweredDecision.kind === "allow") {
		return {
			kind: "allow",
			assessment: loweredAssessment,
			loweredFrom: assessment.risk_level,
		};
	}
	if (loweredDecision.kind === "ask") {
		return {
			kind: "ask",
			assessment: loweredAssessment,
			loweredFrom: assessment.risk_level,
		};
	}
	// The lowered level is still denied (for example very_high -> high under the
	// default policy): keep the original decision rather than the lower display
	// level, because the rule did not change the outcome.
	return decision;
}
