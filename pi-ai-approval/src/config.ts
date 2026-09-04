import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	REVIEW_TIMEOUT_MS,
	parseModelSpec,
	type RiskLevel,
} from "./review.ts";

/**
 * Special model setting meaning "use the current session model".
 */
export const CURRENT_MODEL_SETTING = "CURRENT";

export const PRIMARY_MODEL_ENV = "PI_AI_APPROVAL_PRIMARY_MODEL";
export const SECONDARY_MODEL_ENV = "PI_AI_APPROVAL_SECONDARY_MODEL";
export const POLICY_ENV = "PI_AI_APPROVAL_POLICY";
export const TIMEOUT_ENV = "PI_AI_APPROVAL_TIMEOUT_MS";
export const CONFIG_FILE_NAME = "ai-approval.json";

export type ReviewLevel =
	| "always"
	| "outside-or-private"
	| "private-only"
	| "off";

/** Local decision for an action, applied after the reviewer classifies risk. */
export type RiskAction = "allow" | "ask" | "deny";

/**
 * Per-risk-level policy. `very_high` and `critical` cannot be configured to
 * `allow`: the config parser warns and falls back to `deny` instead.
 */
export interface RiskActions {
	very_low: RiskAction;
	low: RiskAction;
	medium: RiskAction;
	high: RiskAction;
	very_high: Exclude<RiskAction, "allow">;
	critical: Exclude<RiskAction, "allow">;
}

export const RISK_LEVEL_KEYS: readonly RiskLevel[] = [
	"very_low",
	"low",
	"medium",
	"high",
	"very_high",
	"critical",
];

export const DEFAULT_RISK_ACTIONS: Readonly<RiskActions> = {
	very_low: "allow",
	low: "allow",
	medium: "ask",
	high: "deny",
	very_high: "deny",
	critical: "deny",
};

const RISK_ACTION_RANK: Record<RiskAction, number> = {
	allow: 0,
	ask: 1,
	deny: 2,
};

export const DEFAULT_REVIEW_RULES: Readonly<Record<string, ReviewLevel>> = {
	"bash.command": "always",
	"read.path": "outside-or-private",
	"grep.path": "outside-or-private",
	"find.path": "private-only",
	"ls.path": "private-only",
	"write.path": "outside-or-private",
	"edit.path": "outside-or-private",
};

/**
 * The documented default configuration, written by `/ai-approval init`. Every
 * value mirrors the built-in defaults the extension uses when a setting is
 * absent, so the generated file is a safe, editable starting point.
 */
export function buildDefaultConfigFile(): Record<string, unknown> {
	return {
		primaryModel: CURRENT_MODEL_SETTING,
		secondaryModel: CURRENT_MODEL_SETTING,
		timeoutMs: REVIEW_TIMEOUT_MS,
		assessmentLanguage: "auto",
		riskActions: { ...DEFAULT_RISK_ACTIONS },
		review: { ...DEFAULT_REVIEW_RULES },
	};
}

interface ApprovalConfigFile {
	primaryModel?: unknown;
	secondaryModel?: unknown;
	timeoutMs?: unknown;
	policy?: unknown;
	review?: unknown;
	riskActions?: unknown;
	assessmentLanguage?: unknown;
}

type ConfigSource = "environment" | "project" | "global" | "default";

export interface ApprovalConfig {
	/** Reviewer model setting: a provider/model-id or "CURRENT". */
	primaryModel: string;
	/** Reviewer model setting: a provider/model-id or "CURRENT". */
	secondaryModel: string;
	timeoutMs: number;
	policy?: string;
	review: Record<string, ReviewLevel>;
	globalPath: string;
	projectPath: string;
	globalConfigPresent: boolean;
	projectConfigPresent: boolean;
	primaryModelSource: ConfigSource;
	secondaryModelSource: ConfigSource;
	timeoutSource: ConfigSource;
	policySources: Array<"environment" | "project" | "global">;
	riskActions: RiskActions;
	/** Language for reviewer comments: "auto" or a fixed language name. */
	assessmentLanguage: string;
	assessmentLanguageSource: ConfigSource;
	warnings: string[];
}

export interface LoadApprovalConfigOptions {
	cwd: string;
	projectTrusted: boolean;
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
}

export function loadApprovalConfig(
	options: LoadApprovalConfigOptions,
): ApprovalConfig {
	const agentDir = options.agentDir ?? getAgentDir();
	const env = options.env ?? process.env;
	const globalPath = join(agentDir, CONFIG_FILE_NAME);
	const projectPath = join(options.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
	const warnings: string[] = [];
	if (
		env[PRIMARY_MODEL_ENV] !== undefined &&
		!isModelSettingString(env[PRIMARY_MODEL_ENV])
	) {
		warnings.push(
			`Invalid ${PRIMARY_MODEL_ENV}: expected provider/model-id or CURRENT.`,
		);
	}
	if (
		env[SECONDARY_MODEL_ENV] !== undefined &&
		!isModelSettingString(env[SECONDARY_MODEL_ENV])
	) {
		warnings.push(
			`Invalid ${SECONDARY_MODEL_ENV}: expected provider/model-id or CURRENT.`,
		);
	}
	if (
		env[TIMEOUT_ENV] !== undefined &&
		firstTimeout(env[TIMEOUT_ENV]) === undefined
	) {
		warnings.push(
			`Invalid ${TIMEOUT_ENV}: expected an integer from 1000 to 300000.`,
		);
	}
	const globalConfig = readConfigFile(globalPath, warnings);
	const projectConfig = options.projectTrusted
		? readConfigFile(projectPath, warnings)
		: {};

	const primaryModelValue = firstModelSettingWithSource(
		["environment", env[PRIMARY_MODEL_ENV]],
		["project", projectConfig.primaryModel],
		["global", globalConfig.primaryModel],
	);
	const secondaryModelValue = firstModelSettingWithSource(
		["environment", env[SECONDARY_MODEL_ENV]],
		["project", projectConfig.secondaryModel],
		["global", globalConfig.secondaryModel],
	);
	const timeoutValue = firstTimeoutWithSource(
		["environment", env[TIMEOUT_ENV]],
		["project", projectConfig.timeoutMs],
		["global", globalConfig.timeoutMs],
	);
	const policies = [
		["global", globalConfig.policy],
		["project", projectConfig.policy],
		["environment", env[POLICY_ENV]],
	] as const;
	const policySources = policies.flatMap(([source, value]) =>
		typeof value === "string" && value.trim().length > 0 ? [source] : [],
	);

	const globalReview = parseReviewRules(
		globalConfig.review,
		globalPath,
		warnings,
	);
	const projectReview = parseReviewRules(
		projectConfig.review,
		projectPath,
		warnings,
	);
	const review = mergeReviewRules(globalReview, projectReview);

	const globalRiskActions = parseRiskActions(
		globalConfig.riskActions,
		globalPath,
		warnings,
	);
	const projectRiskActions = parseRiskActions(
		projectConfig.riskActions,
		projectPath,
		warnings,
	);
	const riskActions = mergeRiskActions(globalRiskActions, projectRiskActions);
	const assessmentLanguage = firstAssessmentLanguageWithSource(
		["project", projectConfig.assessmentLanguage],
		["global", globalConfig.assessmentLanguage],
	);

	return {
		primaryModel: primaryModelValue?.value ?? CURRENT_MODEL_SETTING,
		secondaryModel: secondaryModelValue?.value ?? CURRENT_MODEL_SETTING,
		timeoutMs: timeoutValue?.value ?? REVIEW_TIMEOUT_MS,
		policy:
			policySources.length > 0
				? policies
						.flatMap(([, value]) =>
							typeof value === "string" && value.trim() ? [value.trim()] : [],
						)
						.join("\n\n")
				: undefined,
		review,
		riskActions,
		assessmentLanguage: assessmentLanguage?.value ?? "auto",
		assessmentLanguageSource: assessmentLanguage?.source ?? "default",
		globalPath,
		projectPath,
		globalConfigPresent: existsSync(globalPath),
		projectConfigPresent: existsSync(projectPath),
		primaryModelSource: primaryModelValue?.source ?? "default",
		secondaryModelSource: secondaryModelValue?.source ?? "default",
		timeoutSource: timeoutValue?.source ?? "default",
		policySources,
		warnings,
	};
}

function readConfigFile(path: string, warnings: string[]): ApprovalConfigFile {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warnings.push(`Invalid ${path}: expected a JSON object.`);
			return {};
		}
		const config = parsed as ApprovalConfigFile;
		validateConfigFile(config, path, warnings);
		return config;
	} catch (error) {
		warnings.push(
			`Invalid or unreadable ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {};
	}
}

const CONFIG_FILE_KEYS = new Set([
	"primaryModel",
	"secondaryModel",
	"timeoutMs",
	"policy",
	"review",
	"riskActions",
	"assessmentLanguage",
]);

const REVIEW_LEVEL_RANK: Record<ReviewLevel, number> = {
	off: 0,
	"private-only": 1,
	"outside-or-private": 2,
	always: 3,
};

function mergeReviewRules(
	globalRules: Record<string, ReviewLevel>,
	projectRules: Record<string, ReviewLevel>,
): Record<string, ReviewLevel> {
	const effective: Record<string, ReviewLevel> = {
		...DEFAULT_REVIEW_RULES,
		...globalRules,
	};
	for (const [key, projectLevel] of Object.entries(projectRules)) {
		const floor = effective[key] ?? "private-only";
		effective[key] =
			REVIEW_LEVEL_RANK[projectLevel] > REVIEW_LEVEL_RANK[floor]
				? projectLevel
				: floor;
	}
	return effective;
}

function parseRiskActions(
	value: unknown,
	path: string,
	warnings: string[],
): Partial<RiskActions> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`Invalid riskActions in ${path}: expected an object.`);
		return {};
	}
	const actions: Partial<RiskActions> = {};
	for (const [key, level] of Object.entries(value)) {
		if (!RISK_LEVEL_KEYS.includes(key as RiskLevel)) {
			warnings.push(`Unsupported riskActions.${key} in ${path}.`);
			continue;
		}
		if (level === "allow" || level === "ask" || level === "deny") {
			if (
				(key === "very_high" || key === "critical") &&
				level === "allow"
			) {
				warnings.push(
					`riskActions.${key} in ${path} cannot allow; using deny.`,
				);
				actions[key as "very_high" | "critical"] = "deny";
			} else {
				(actions as Record<RiskLevel, RiskAction>)[key as RiskLevel] = level;
			}
		} else {
			warnings.push(
				`Invalid riskActions.${key} in ${path}: expected allow, ask, or deny.`,
			);
		}
	}
	return actions;
}

function mergeRiskActions(
	globalActions: Partial<RiskActions>,
	projectActions: Partial<RiskActions>,
): RiskActions {
	// Project config can only strengthen the policy (allow < ask < deny); the
	// parser already coerces very_high/critical "allow" entries to "deny".
	const effective = {
		...DEFAULT_RISK_ACTIONS,
		...globalActions,
	} as Record<RiskLevel, RiskAction>;
	for (const [key, projectAction] of Object.entries(projectActions)) {
		const level = key as RiskLevel;
		const floor = effective[level];
		if (RISK_ACTION_RANK[projectAction] > RISK_ACTION_RANK[floor]) {
			effective[level] = projectAction;
		}
	}
	return effective as RiskActions;
}

function validateConfigFile(
	config: ApprovalConfigFile,
	path: string,
	warnings: string[],
): void {
	for (const key of Object.keys(config)) {
		if (!CONFIG_FILE_KEYS.has(key)) {
			warnings.push(`Unknown top-level key ${key} in ${path}.`);
		}
	}
	if (config.primaryModel !== undefined && !isModelSettingString(config.primaryModel)) {
		warnings.push(
			`Invalid primaryModel in ${path}: expected provider/model-id or CURRENT.`,
		);
	}
	if (
		config.secondaryModel !== undefined &&
		!isModelSettingString(config.secondaryModel)
	) {
		warnings.push(
			`Invalid secondaryModel in ${path}: expected provider/model-id or CURRENT.`,
		);
	}
	if (
		config.timeoutMs !== undefined &&
		firstTimeout(config.timeoutMs) === undefined
	) {
		warnings.push(
			`Invalid timeoutMs in ${path}: expected an integer from 1000 to 300000.`,
		);
	}
	if (config.policy !== undefined && typeof config.policy !== "string") {
		warnings.push(`Invalid policy in ${path}: expected a string.`);
	}
	if (
		config.assessmentLanguage !== undefined &&
		!isAssessmentLanguageString(config.assessmentLanguage)
	) {
		warnings.push(
			`Invalid assessmentLanguage in ${path}: expected a non-empty language name up to ${ASSESSMENT_LANGUAGE_MAX_CHARS} characters.`,
		);
	}
}

function parseReviewRules(
	value: unknown,
	path: string,
	warnings: string[],
): Record<string, ReviewLevel> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`Invalid review in ${path}: expected an object.`);
		return {};
	}
	const rules: Record<string, ReviewLevel> = {};
	for (const [key, level] of Object.entries(value)) {
		if (!isReviewRuleKey(key)) {
			warnings.push(`Unsupported review.${key} in ${path}.`);
			continue;
		}
		if (
			level === "always" ||
			level === "outside-or-private" ||
			level === "private-only" ||
			level === "off"
		) {
			rules[key] = level;
		} else {
			warnings.push(
				`Invalid review.${key} in ${path}: expected always, outside-or-private, private-only, or off.`,
			);
		}
	}
	return rules;
}

function isReviewRuleKey(key: string): boolean {
	if (Object.hasOwn(DEFAULT_REVIEW_RULES, key)) return true;
	const toolName = key.endsWith(".path") ? key.slice(0, -".path".length) : "";
	return toolName.length > 0 && !/\s/.test(toolName);
}

function isModelSettingString(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	if (!trimmed) return false;
	return trimmed === CURRENT_MODEL_SETTING || parseModelSpec(trimmed) !== undefined;
}

function firstModelSettingWithSource(
	...values: Array<[ApprovalConfig["primaryModelSource"], unknown]>
): { source: ApprovalConfig["primaryModelSource"]; value: string } | undefined {
	for (const [source, value] of values) {
		if (isModelSettingString(value)) {
			return { source, value: value.trim() };
		}
	}
	return undefined;
}

const ASSESSMENT_LANGUAGE_MAX_CHARS = 64;

function isAssessmentLanguageString(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.trim().length <= ASSESSMENT_LANGUAGE_MAX_CHARS
	);
}

function firstAssessmentLanguageWithSource(
	...values: Array<[ApprovalConfig["assessmentLanguageSource"], unknown]>
):
	| { source: ApprovalConfig["assessmentLanguageSource"]; value: string }
	| undefined {
	for (const [source, value] of values) {
		if (isAssessmentLanguageString(value)) {
			return { source, value: value.trim() };
		}
	}
	return undefined;
}

function firstTimeoutWithSource(
	...values: Array<[ApprovalConfig["timeoutSource"], unknown]>
): { source: ApprovalConfig["timeoutSource"]; value: number } | undefined {
	for (const [source, value] of values) {
		const timeout = firstTimeout(value);
		if (timeout !== undefined) return { source, value: timeout };
	}
	return undefined;
}

function firstTimeout(...values: unknown[]): number | undefined {
	for (const value of values) {
		const parsed =
			typeof value === "number"
				? value
				: typeof value === "string"
					? Number(value)
					: NaN;
		if (Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 300_000)
			return parsed;
	}
	return undefined;
}
