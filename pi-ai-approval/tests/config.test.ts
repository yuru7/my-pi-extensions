import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDefaultConfigFile, loadApprovalConfig } from "../src/config.ts";
import { parseModelSpec } from "../src/review.ts";

test("builds the default configuration file contents", () => {
	assert.deepEqual(buildDefaultConfigFile(), {
		primaryModel: "CURRENT",
		secondaryModel: "CURRENT",
		primaryThinkingLevel: "low",
		secondaryThinkingLevel: "low",
		timeoutMs: 90000,
		assessmentLanguage: "auto",
		riskActions: {
			very_low: "allow",
			low: "allow",
			medium: "ask",
			high: "deny",
			very_high: "deny",
			critical: "deny",
		},
		review: {
			"bash.command": "always",
			"read.path": "outside-or-private",
			"grep.path": "outside-or-private",
			"find.path": "private-only",
			"ls.path": "private-only",
			"write.path": "outside-or-private",
			"edit.path": "outside-or-private",
		},
	});
});

test("loads global and trusted project config with documented precedence", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({
			primaryModel: "global/reviewer",
			secondaryModel: "global/fallback",
			timeoutMs: 60_000,
			policy: "global policy",
			review: { "grep.path": "outside-or-private", "read.path": "off" },
		}),
	);
	writeFileSync(
		join(cwd, ".pi", "ai-approval.json"),
		JSON.stringify({
			primaryModel: "project/reviewer",
			secondaryModel: "project/fallback",
			policy: "project policy",
			review: { "read.path": "private-only" },
		}),
	);

	const config = loadApprovalConfig({
		cwd,
		projectTrusted: true,
		agentDir,
		env: {
			PI_AI_APPROVAL_PRIMARY_MODEL: "env/reviewer",
			PI_AI_APPROVAL_SECONDARY_MODEL: "openrouter/openai/gpt-5-mini",
		},
	});
	assert.equal(config.primaryModel, "env/reviewer");
	assert.equal(config.secondaryModel, "openrouter/openai/gpt-5-mini");
	assert.equal(config.secondaryModelSource, "environment");
	assert.equal(config.timeoutMs, 60_000);
	assert.equal(config.policy, "global policy\n\nproject policy");
	assert.equal(config.review["bash.command"], "always");
	assert.equal(config.review["read.path"], "private-only");
	assert.equal(config.review["grep.path"], "outside-or-private");
	assert.equal(config.globalConfigPresent, true);
	assert.equal(config.projectConfigPresent, true);
});

test("trusted project review rules cannot weaken the global floor", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({ review: { "bash.command": "always", "read.path": "always" } }),
	);
	writeFileSync(
		join(cwd, ".pi", "ai-approval.json"),
		JSON.stringify({ review: { "bash.command": "off", "read.path": "off" } }),
	);
	const config = loadApprovalConfig({
		cwd,
		projectTrusted: true,
		agentDir,
		env: {},
	});
	assert.equal(config.review["bash.command"], "always");
	assert.equal(config.review["read.path"], "always");
});

test("warns and falls back to defaults for invalid configured values", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({
			policy: [],
			timeoutMs: 5,
			primaryModel: "",
			secondaryModel: "missing-slash",
		}),
	);
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.equal(config.warnings.length, 4);
	assert.match(config.warnings.join("\n"), /Invalid policy/);
	assert.match(config.warnings.join("\n"), /secondaryModel/);
	assert.equal(config.primaryModel, "CURRENT");
	assert.equal(config.primaryModelSource, "default");
	assert.equal(config.secondaryModel, "CURRENT");
	assert.equal(config.secondaryModelSource, "default");
	assert.equal(config.timeoutMs, 90_000);
	assert.equal(config.timeoutSource, "default");
	assert.equal(config.policy, undefined);
});

test("accepts nested model IDs and reports config typos without rejecting custom path rules", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({
			primaryModel: "openrouter/anthropic/claude-sonnet-4",
			unknownSetting: true,
			review: {
				"custom-reader.path": "always",
				"functions.reader.path": "outside-or-private",
				"custom-reader.target": "off",
			},
		}),
	);
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.equal(config.primaryModel, "openrouter/anthropic/claude-sonnet-4");
	assert.equal(config.primaryModelSource, "global");
	assert.equal(config.review["custom-reader.path"], "always");
	assert.equal(config.review["functions.reader.path"], "outside-or-private");
	assert.match(config.warnings.join("\n"), /unknownSetting/);
	assert.match(config.warnings.join("\n"), /custom-reader.target/);
	assert.deepEqual(parseModelSpec("openrouter/anthropic/claude-sonnet-4"), {
		provider: "openrouter",
		model: "anthropic/claude-sonnet-4",
	});
});

test("warns and skips invalid environment overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({
			primaryModel: "global/reviewer",
			secondaryModel: "global/fallback",
			timeoutMs: 45_000,
		}),
	);
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: {
			PI_AI_APPROVAL_PRIMARY_MODEL: "missing-slash",
			PI_AI_APPROVAL_SECONDARY_MODEL: "also-missing-slash",
			PI_AI_APPROVAL_TIMEOUT_MS: "5",
		},
	});
	assert.equal(config.warnings.length, 3);
	assert.equal(config.primaryModel, "global/reviewer");
	assert.equal(config.primaryModelSource, "global");
	assert.equal(config.secondaryModel, "global/fallback");
	assert.equal(config.secondaryModelSource, "global");
	assert.equal(config.timeoutMs, 45_000);
	assert.equal(config.timeoutSource, "global");
});

test("uses an environment model ID containing nested slashes", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir: join(root, "agent"),
		env: { PI_AI_APPROVAL_PRIMARY_MODEL: "openrouter/anthropic/claude-sonnet-4" },
	});
	assert.equal(config.primaryModelSource, "environment");
	assert.equal(config.warnings.length, 0);
});

test("does not load project config for an untrusted project", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "ai-approval.json"),
		JSON.stringify({
			primaryModel: "project/reviewer",
			policy: "project policy",
		}),
	);

	const config = loadApprovalConfig({
		cwd,
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.equal(config.primaryModel, "CURRENT");
	assert.equal(config.secondaryModel, "CURRENT");
	assert.equal(config.secondaryModelSource, "default");
	assert.equal(config.policy, undefined);
	assert.equal(config.review["read.path"], "outside-or-private");
	assert.equal(config.review["grep.path"], "outside-or-private");
	assert.equal(config.review["find.path"], "private-only");
	assert.equal(config.review["ls.path"], "private-only");
	assert.equal(config.review["hypa_read.path"], undefined);
	assert.equal(config.review["write.path"], "outside-or-private");
	assert.equal(config.projectConfigPresent, true);
});

test("applies the documented default riskActions without configuration", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir: join(root, "agent"),
		env: {},
	});
	assert.deepEqual(config.riskActions, {
		very_low: "allow",
		low: "allow",
		medium: "ask",
		high: "deny",
		very_high: "deny",
		critical: "deny",
	});
	assert.equal(config.warnings.length, 0);
});

test("merges global and project riskActions without weakening the policy", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({
			riskActions: {
				very_low: "allow",
				low: "ask",
				medium: "deny",
				high: "ask",
				very_high: "ask",
				critical: "ask",
			},
		}),
	);
	writeFileSync(
		join(cwd, ".pi", "ai-approval.json"),
		JSON.stringify({
			riskActions: {
				low: "deny",
				medium: "allow",
				high: "deny",
				very_high: "deny",
				critical: "allow",
			},
		}),
	);
	const config = loadApprovalConfig({
		cwd,
		projectTrusted: true,
		agentDir,
		env: {},
	});
	assert.equal(config.riskActions.very_low, "allow");
	assert.equal(config.riskActions.low, "deny", "project deny strengthens global ask");
	assert.equal(config.riskActions.medium, "deny", "project cannot weaken deny to allow");
	assert.equal(config.riskActions.high, "deny", "ask -> deny strengthens");
	assert.equal(config.riskActions.very_high, "deny", "project cannot weaken ask to allow");
	assert.equal(config.riskActions.critical, "deny", "global ask; project allow coerced to deny and deny is stronger");
	const warnings = config.warnings.join("\n");
	assert.match(warnings, /riskActions\.critical.*cannot allow/);
	assert.doesNotMatch(warnings, /riskActions\.very_high/);
});

test("warns and denies when very_high or critical are configured to allow", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({
			riskActions: { very_high: "allow", critical: "allow" },
		}),
	);
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.equal(config.riskActions.very_high, "deny");
	assert.equal(config.riskActions.critical, "deny");
	const warnings = config.warnings.join("\n");
	assert.match(warnings, /riskActions\.very_high in .* cannot allow; using deny\./);
	assert.match(warnings, /riskActions\.critical in .* cannot allow; using deny\./);
});

test("warns on invalid riskActions entries and keeps valid ones", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({
			riskActions: {
				medium: "maybe",
				extreme: "deny",
			},
		}),
	);
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.equal(config.riskActions.medium, "ask", "invalid entries fall back to defaults");
	const warnings = config.warnings.join("\n");
	assert.match(warnings, /Invalid riskActions\.medium in .*: expected allow, ask, or deny\./);
	assert.match(warnings, /Unsupported riskActions\.extreme in .*\./);
});

test("warns when riskActions is not an object", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({ riskActions: ["allow"] }),
	);
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.deepEqual(config.riskActions, {
		very_low: "allow",
		low: "allow",
		medium: "ask",
		high: "deny",
		very_high: "deny",
		critical: "deny",
	});
	assert.match(config.warnings.join("\n"), /Invalid riskActions in .*: expected an object\./);
});

test("defaults assessmentLanguage to auto without configuration", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir: join(root, "agent"),
		env: {},
	});
	assert.equal(config.assessmentLanguage, "auto");
	assert.equal(config.assessmentLanguageSource, "default");
	assert.equal(config.warnings.length, 0);
});

test("project assessmentLanguage overrides global configuration", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({ assessmentLanguage: "English" }),
	);
	const globalOnly = loadApprovalConfig({
		cwd,
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.equal(globalOnly.assessmentLanguage, "English");
	assert.equal(globalOnly.assessmentLanguageSource, "global");

	writeFileSync(
		join(cwd, ".pi", "ai-approval.json"),
		JSON.stringify({ assessmentLanguage: "日本語" }),
	);
	const withProject = loadApprovalConfig({
		cwd,
		projectTrusted: true,
		agentDir,
		env: {},
	});
	assert.equal(withProject.assessmentLanguage, "日本語");
	assert.equal(withProject.assessmentLanguageSource, "project");
});

test("warns and falls back when assessmentLanguage is invalid", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({ assessmentLanguage: "   " }),
	);
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.equal(config.assessmentLanguage, "auto");
	assert.equal(config.assessmentLanguageSource, "default");
	assert.match(
		config.warnings.join("\n"),
		/Invalid assessmentLanguage in .*: expected a non-empty language name/,
	);
});

test("defaults primary and secondary models to the CURRENT session model", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir: join(root, "agent"),
		env: {},
	});
	assert.equal(config.primaryModel, "CURRENT");
	assert.equal(config.secondaryModel, "CURRENT");
	assert.equal(config.primaryModelSource, "default");
	assert.equal(config.secondaryModelSource, "default");
	assert.equal(config.warnings.length, 0);
});

test("accepts an explicit CURRENT model setting from project config", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "ai-approval.json"),
		JSON.stringify({
			primaryModel: "openai/gpt-5.6-luna",
			secondaryModel: "CURRENT",
		}),
	);
	const config = loadApprovalConfig({
		cwd,
		projectTrusted: true,
		agentDir,
		env: {},
	});
	assert.equal(config.primaryModel, "openai/gpt-5.6-luna");
	assert.equal(config.secondaryModel, "CURRENT");
	assert.equal(config.secondaryModelSource, "project");
	assert.equal(config.warnings.length, 0);
});

test("warns when a model setting is neither a spec nor CURRENT", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({ secondaryModel: "CURRENT-MODEL" }),
	);
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.equal(config.secondaryModel, "CURRENT");
	assert.equal(config.secondaryModelSource, "default");
	assert.match(
		config.warnings.join("\n"),
		/Invalid secondaryModel in .*: expected provider\/model-id or CURRENT\./,
	);
});

test("defaults reviewer thinking levels to low", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir: join(root, "agent"),
		env: {},
	});
	assert.equal(config.primaryThinkingLevel, "low");
	assert.equal(config.secondaryThinkingLevel, "low");
	assert.equal(config.primaryThinkingLevelSource, "default");
	assert.equal(config.secondaryThinkingLevelSource, "default");
	assert.equal(config.warnings.length, 0);
});

test("loads fixed reviewer thinking levels with documented precedence", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({
			primaryThinkingLevel: "medium",
			secondaryThinkingLevel: "high",
		}),
	);
	writeFileSync(
		join(cwd, ".pi", "ai-approval.json"),
		JSON.stringify({ primaryThinkingLevel: "max" }),
	);
	const config = loadApprovalConfig({
		cwd,
		projectTrusted: true,
		agentDir,
		env: { PI_AI_APPROVAL_SECONDARY_THINKING_LEVEL: "minimal" },
	});
	assert.equal(config.primaryThinkingLevel, "max");
	assert.equal(config.primaryThinkingLevelSource, "project");
	assert.equal(config.secondaryThinkingLevel, "minimal");
	assert.equal(config.secondaryThinkingLevelSource, "environment");
	assert.equal(config.warnings.length, 0);
});

test("accepts CURRENT reviewer thinking levels", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({
			primaryThinkingLevel: "CURRENT",
			secondaryThinkingLevel: "CURRENT",
		}),
	);
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: {},
	});
	assert.equal(config.primaryThinkingLevel, "CURRENT");
	assert.equal(config.secondaryThinkingLevel, "CURRENT");
	assert.equal(config.primaryThinkingLevelSource, "global");
	assert.equal(config.warnings.length, 0);
});

test("warns and falls back to low for invalid thinking levels", () => {
	const root = mkdtempSync(join(tmpdir(), "ai-approval-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "ai-approval.json"),
		JSON.stringify({
			primaryThinkingLevel: "ultra",
			secondaryThinkingLevel: "",
		}),
	);
	const config = loadApprovalConfig({
		cwd: join(root, "project"),
		projectTrusted: false,
		agentDir,
		env: { PI_AI_APPROVAL_PRIMARY_THINKING_LEVEL: "bogus" },
	});
	assert.equal(config.primaryThinkingLevel, "low");
	assert.equal(config.primaryThinkingLevelSource, "default");
	assert.equal(config.secondaryThinkingLevel, "low");
	assert.equal(config.secondaryThinkingLevelSource, "default");
	assert.match(config.warnings.join("\n"), /Invalid primaryThinkingLevel/);
	assert.match(config.warnings.join("\n"), /Invalid secondaryThinkingLevel/);
	assert.match(config.warnings.join("\n"), /PI_AI_APPROVAL_PRIMARY_THINKING_LEVEL/);
});
