import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RISK_ACTIONS } from "../src/config.ts";
import { applyRiskPolicy } from "../src/risk-policy.ts";
import {
	SESSION_RULE_MAX_CHARS,
	SESSION_RULE_MAX_COUNT,
	SessionRuleStore,
	applySessionRulePolicy,
	lowerRiskLevel,
	sanitizeSessionRuleText,
	type SessionApprovalRule,
} from "../src/session-rules.ts";

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

test("sanitizeSessionRuleText strips control characters and collapses whitespace", () => {
	assert.equal(
		sanitizeSessionRuleText("  allow\n git\tcommit  "),
		"allow git commit",
	);
	const ansi = sanitizeSessionRuleText("allow \u001b[31mred\u001b[0m text");
	assert.equal(ansi.includes("\u001b"), false);
	assert.equal(ansi.includes("\n"), false);
	assert.equal(ansi, "allow [31mred [0m text");
	assert.equal(sanitizeSessionRuleText("\u0000 \u007f"), "");
});

test("store assigns stable sequential ids and keeps creation order", () => {
	const store = new SessionRuleStore();
	const first = store.add("Allow pnpm test in this repository", 1_000);
	const second = store.add("Allow git status in this repository", 2_000);
	assert.deepEqual(first, {
		ok: true,
		rule: {
			id: "rule-1",
			text: "Allow pnpm test in this repository",
			createdAt: 1_000,
		},
	});
	assert.deepEqual(second, {
		ok: true,
		rule: {
			id: "rule-2",
			text: "Allow git status in this repository",
			createdAt: 2_000,
		},
	});
	assert.deepEqual(
		store.list().map((rule) => rule.id),
		["rule-1", "rule-2"],
	);
	assert.equal(store.find("rule-2")?.text, "Allow git status in this repository");
	assert.equal(store.find("rule-9"), undefined);
});

test("store rejects empty and over-long rules without changing state", () => {
	const store = new SessionRuleStore();
	assert.deepEqual(store.add("   \u0000 "), { ok: false, reason: "empty" });
	assert.deepEqual(store.add("x".repeat(SESSION_RULE_MAX_CHARS + 1)), {
		ok: false,
		reason: "too_long",
	});
	assert.equal(store.list().length, 0);

	const accepted = store.add("y".repeat(SESSION_RULE_MAX_CHARS));
	assert.equal(accepted.ok, true);
	assert.equal(store.list().length, 1);
});

test("store enforces the rule count limit and accepts again after a removal", () => {
	const store = new SessionRuleStore();
	for (let index = 0; index < SESSION_RULE_MAX_COUNT; index++) {
		assert.equal(store.add(`rule number ${index}`).ok, true);
	}
	assert.deepEqual(store.add("one rule too many"), {
		ok: false,
		reason: "capacity",
	});
	assert.equal(store.list().length, SESSION_RULE_MAX_COUNT);
	assert.equal(store.remove("rule-1").ok, true);
	assert.equal(store.add("replacement rule").ok, true);
	assert.equal(store.list().length, SESSION_RULE_MAX_COUNT);
});

test("store update replaces the text and keeps id and creation time", () => {
	const store = new SessionRuleStore();
	store.add("Allow pnpm test", 1_000);
	const updated = store.update("rule-1", "  Allow\npnpm test  ");
	assert.deepEqual(updated, {
		ok: true,
		rule: { id: "rule-1", text: "Allow pnpm test", createdAt: 1_000 },
	});
	assert.deepEqual(store.update("rule-9", "Allow pnpm test"), {
		ok: false,
		reason: "not_found",
	});
	assert.deepEqual(store.update("rule-1", "  "), { ok: false, reason: "empty" });
	assert.deepEqual(store.update("rule-1", "x".repeat(SESSION_RULE_MAX_CHARS + 1)), {
		ok: false,
		reason: "too_long",
	});
	assert.equal(store.find("rule-1")?.text, "Allow pnpm test");
});

test("store remove returns the removed rule and clear resets everything", () => {
	const store = new SessionRuleStore();
	store.add("Allow pnpm test");
	store.add("Allow git status");
	const removed = store.remove("rule-2");
	assert.equal(removed.ok, true);
	assert.equal(removed.ok ? removed.rule.id : undefined, "rule-2");
	assert.equal(removed.ok ? removed.rule.text : undefined, "Allow git status");
	assert.equal(store.find("rule-2"), undefined);
	assert.deepEqual(store.remove("rule-2"), { ok: false, reason: "not_found" });

	store.clear();
	assert.deepEqual(store.list(), []);
	const fresh = store.add("fresh rule");
	assert.equal(fresh.ok, true);
	assert.equal(fresh.ok ? fresh.rule.id : undefined, "rule-1");
	assert.equal(fresh.ok ? fresh.rule.text : undefined, "fresh rule");
});

test("store list returns a snapshot that cannot mutate the store", () => {
	const store = new SessionRuleStore();
	store.add("Allow pnpm test");
	const snapshot = store.list();
	(snapshot as SessionApprovalRule[]).push({
		id: "rule-99",
		text: "injected",
		createdAt: 0,
	});
	assert.equal(store.list().length, 1);
	assert.equal(store.find("rule-99"), undefined);
});

test("lowerRiskLevel moves exactly one step and stops at very_low", () => {
	assert.equal(lowerRiskLevel("critical"), "very_high");
	assert.equal(lowerRiskLevel("very_high"), "high");
	assert.equal(lowerRiskLevel("high"), "medium");
	assert.equal(lowerRiskLevel("medium"), "low");
	assert.equal(lowerRiskLevel("low"), "very_low");
	assert.equal(lowerRiskLevel("very_low"), "very_low");
});

test("applySessionRulePolicy without a matched rule equals the plain policy", () => {
	const medium = assessment("medium");
	const denied = assessment("high");
	assert.deepEqual(
		applySessionRulePolicy(medium, DEFAULT_RISK_ACTIONS, false),
		applyRiskPolicy(medium, DEFAULT_RISK_ACTIONS),
	);
	assert.deepEqual(
		applySessionRulePolicy(denied, DEFAULT_RISK_ACTIONS, false),
		applyRiskPolicy(denied, DEFAULT_RISK_ACTIONS),
	);
});

test("a matched rule lowers an ask classification by one level and re-applies the policy", () => {
	const original = assessment("medium");
	const decision = applySessionRulePolicy(original, DEFAULT_RISK_ACTIONS, true);
	if (decision.kind === "deny") assert.fail("a matched rule must not deny");
	assert.equal(decision.kind, "allow");
	assert.equal(decision.assessment.risk_level, "low");
	assert.equal(decision.loweredFrom, "medium");
	// The reviewer's assessment is never mutated in place.
	assert.equal(original.risk_level, "medium");
});

test("a matched rule keeps an ask outcome when the lowered level still asks", () => {
	const actions = riskActionsFor({ low: "ask", very_low: "ask" });
	const decision = applySessionRulePolicy(assessment("low"), actions, true);
	if (decision.kind === "deny") assert.fail("a matched rule must not deny");
	assert.equal(decision.kind, "ask");
	assert.equal(decision.assessment.risk_level, "very_low");
	assert.equal(decision.loweredFrom, "low");
});

test("a matched rule lowers a deny classification by one level too", () => {
	// Default policy: high is deny. The rule lowers it to medium, which asks.
	const decision = applySessionRulePolicy(
		assessment("high"),
		DEFAULT_RISK_ACTIONS,
		true,
	);
	if (decision.kind === "deny") assert.fail("high must be lowered into a prompt");
	assert.equal(decision.kind, "ask");
	assert.equal(decision.assessment.risk_level, "medium");
	assert.equal(decision.loweredFrom, "high");

	// A deny level that falls onto another deny level keeps the outcome and the
	// original level, because the rule did not change the decision.
	for (const level of ["very_high", "critical"] as const) {
		assert.deepEqual(
			applySessionRulePolicy(assessment(level), DEFAULT_RISK_ACTIONS, true),
			{ kind: "deny", assessment: assessment(level) },
		);
	}

	// With a policy that allows the lowered level, a matched rule can even turn
	// a deny into an automatic allow.
	const permissive = applySessionRulePolicy(
		assessment("high"),
		riskActionsFor({ medium: "allow" }),
		true,
	);
	if (permissive.kind === "deny") assert.fail("the lowered level is allowed");
	assert.equal(permissive.kind, "allow");
	assert.equal(permissive.assessment.risk_level, "medium");
	assert.equal(permissive.loweredFrom, "high");
});

test("a matched rule leaves allow classifications and the very_low floor untouched", () => {
	const allowed = applySessionRulePolicy(
		assessment("low"),
		DEFAULT_RISK_ACTIONS,
		true,
	);
	assert.deepEqual(allowed, { kind: "allow", assessment: assessment("low") });

	const floor = applySessionRulePolicy(
		assessment("very_low"),
		riskActionsFor({ very_low: "ask" }),
		true,
	);
	assert.deepEqual(floor, {
		kind: "ask",
		assessment: assessment("very_low"),
	});
});

test("a matched rule can lower very_high into an allow when the policy allows the lowered level", () => {
	// A policy that allows high: very_high falls one step to high and runs.
	const decision = applySessionRulePolicy(
		assessment("very_high"),
		riskActionsFor({ high: "allow" }),
		true,
	);
	if (decision.kind === "deny") assert.fail("high is allowed by this policy");
	assert.equal(decision.kind, "allow");
	assert.equal(decision.assessment.risk_level, "high");
	assert.equal(decision.loweredFrom, "very_high");
});

test("a matched rule can never turn critical into an automatic allow", () => {
	// Hand-built config that bypasses the parser: very_high cannot resolve to
	// allow, so critical's single step down still cannot auto-allow.
	const decision = applySessionRulePolicy(
		assessment("critical"),
		riskActionsFor({ very_high: "allow" }) as never,
		true,
	);
	assert.deepEqual(decision, {
		kind: "deny",
		assessment: assessment("critical"),
	});
});

test("a matched rule never turns an ask outcome into a denial", () => {
	// A hand-built policy where the lowered level is stricter than the original.
	const actions = riskActionsFor({ medium: "ask", low: "deny" });
	const decision = applySessionRulePolicy(assessment("medium"), actions, true);
	assert.deepEqual(decision, {
		kind: "ask",
		assessment: assessment("medium"),
	});

	// The same guard holds for the highest levels: with very_high configured to
	// ask, the lowered high is denied, so the original prompt still stands.
	const denied = applySessionRulePolicy(
		assessment("very_high"),
		riskActionsFor({ very_high: "ask" }),
		true,
	);
	assert.deepEqual(denied, {
		kind: "ask",
		assessment: assessment("very_high"),
	});
});
