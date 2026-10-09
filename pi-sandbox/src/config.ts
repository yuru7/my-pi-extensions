import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSandboxMode, type SandboxMode } from "./policy";

/**
 * 宿主の思考量。Pi の `ExtensionContext["thinkingLevel"]` と一致させる。
 * 増減したらこの配列を型エラーで更新する。
 */
export const REVIEWER_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReviewerThinkingLevel = (typeof REVIEWER_THINKING_LEVELS)[number];

type HostThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;
type _ReviewerThinkingCoversHost = [Exclude<HostThinkingLevel, ReviewerThinkingLevel>] extends [never] ? true : never;
type _ReviewerThinkingIsHost = [ReviewerThinkingLevel] extends [HostThinkingLevel] ? true : never;
const _thinkingLevelsMatch: _ReviewerThinkingCoversHost & _ReviewerThinkingIsHost = true;
void _thinkingLevelsMatch;

export type ApprovalMode = "human" | "auto-review" | "allow-all";

export interface AutoReviewConfig {
	model: string;
	thinkingLevel: string;
}

/** 承認方式だけを切り出した結果。未信頼時はグローバル側を使う。 */
export interface ApprovalSettings {
	approvalMode: ApprovalMode;
	autoReview: AutoReviewConfig;
	/** 明示された承認設定が不正。昇格は DENY し、allow-all へは倒さない。 */
	approvalInvalid: boolean;
}

/** sandbox.json / pi-sandbox.json の統合スキーマ。 */
export interface SandboxConfig {
	mode: SandboxMode;
	/** 运维覆盖：自定义 bwrap 兼容 runner argv；必须与 runnerFailureSignatures 成对。 */
	runnerCommand: string[] | null;
	runnerFailureSignatures: string[] | null;
	/** 每个功能探测的超时；必须为正有限数（0 对 Node 意味着无超时）。 */
	probeTimeoutMs: number;
	approvalMode: ApprovalMode;
	autoReview: AutoReviewConfig;
	approvalInvalid: boolean;
	/** プロジェクト設定を除いた承認設定。信頼できないときはこちらだけを使う。 */
	globalApproval: ApprovalSettings;
}

const DEFAULT_AUTO_REVIEW: AutoReviewConfig = {
	model: "CURRENT",
	thinkingLevel: "CURRENT",
};

const DEFAULT_APPROVAL: ApprovalSettings = {
	approvalMode: "auto-review",
	autoReview: DEFAULT_AUTO_REVIEW,
	approvalInvalid: false,
};

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
	mode: "workspace-write",
	runnerCommand: null,
	runnerFailureSignatures: null,
	probeTimeoutMs: 5000,
	approvalMode: DEFAULT_APPROVAL.approvalMode,
	autoReview: DEFAULT_APPROVAL.autoReview,
	approvalInvalid: false,
	globalApproval: DEFAULT_APPROVAL,
};

/**
 * `/pi-sandbox init` が書き出す既定設定。未設定時の組み込み既定値と同じ内容。
 */
export function buildDefaultConfigFile(): Record<string, unknown> {
	return {
		mode: DEFAULT_SANDBOX_CONFIG.mode,
		runnerCommand: DEFAULT_SANDBOX_CONFIG.runnerCommand,
		runnerFailureSignatures: DEFAULT_SANDBOX_CONFIG.runnerFailureSignatures,
		probeTimeoutMs: DEFAULT_SANDBOX_CONFIG.probeTimeoutMs,
		approvalMode: DEFAULT_SANDBOX_CONFIG.approvalMode,
		autoReview: {
			model: DEFAULT_SANDBOX_CONFIG.autoReview.model,
			thinkingLevel: DEFAULT_SANDBOX_CONFIG.autoReview.thinkingLevel,
		},
	};
}

const APPROVAL_MODES = ["human", "auto-review", "allow-all"] as const;
const LEGACY_GROUPS = ["image", "runtime", "host"] as const;
const SANDBOX_FIELD_KEYS = ["mode", "runnerCommand", "runnerFailureSignatures", "probeTimeoutMs"] as const;
const NEW_CONFIG_NAME = "pi-sandbox.json";
const LEGACY_CONFIG_NAME = "sandbox.json";

/** `pi-sandbox.json` のグローバルとプロジェクトのパス。 */
export function piSandboxConfigPaths(hostCwd: string, agentDir = getAgentDir()): { globalPath: string; projectPath: string } {
	return {
		globalPath: resolvePath(agentDir, NEW_CONFIG_NAME),
		projectPath: resolvePath(hostCwd, CONFIG_DIR_NAME, NEW_CONFIG_NAME),
	};
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
	return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

export function isReviewerThinkingLevel(value: string): value is ReviewerThinkingLevel {
	return (REVIEWER_THINKING_LEVELS as readonly string[]).includes(value);
}

/** `CURRENT` または `provider/model-id`（model id にスラッシュを含んでよい）。 */
export function isReviewerModelSetting(value: string): boolean {
	if (value === "CURRENT") return true;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash >= value.length - 1) return false;
	return !/\s/u.test(value);
}

export function isReviewerThinkingSetting(value: string): boolean {
	return value === "CURRENT" || isReviewerThinkingLevel(value);
}

/**
 * プロジェクトを信頼できるか。
 * メソッドが無い・例外・真偽以外は「確認できない」として null（承認はグローバルに限定する）。
 */
export function readProjectTrusted(ctx: { isProjectTrusted?: () => boolean }): boolean | null {
	try {
		if (typeof ctx.isProjectTrusted !== "function") return null;
		const value = ctx.isProjectTrusted();
		if (value === true) return true;
		if (value === false) return false;
		return null;
	} catch {
		return null;
	}
}

/** 信頼できるプロジェクトだけがプロジェクト側の承認設定を使える。 */
export function selectApprovalSettings(config: SandboxConfig, projectTrusted: boolean | null): ApprovalSettings {
	if (projectTrusted === true) {
		return {
			approvalMode: config.approvalMode,
			autoReview: config.autoReview,
			approvalInvalid: config.approvalInvalid,
		};
	}
	return config.globalApproval;
}

export function describeApproval(settings: ApprovalSettings): string {
	if (settings.approvalInvalid) return "approval: deny (invalid approval config)";
	if (settings.approvalMode === "auto-review") {
		return `approval: auto-review (reviewer ${settings.autoReview.model}, thinking ${settings.autoReview.thinkingLevel})`;
	}
	return `approval: ${settings.approvalMode}`;
}

function sameApproval(a: ApprovalSettings, b: ApprovalSettings): boolean {
	return a.approvalMode === b.approvalMode
		&& a.approvalInvalid === b.approvalInvalid
		&& a.autoReview.model === b.autoReview.model
		&& a.autoReview.thinkingLevel === b.autoReview.thinkingLevel;
}

/** `/permission` 用。未信頼・信頼不明のときはプロジェクト側の緩和を使っていないことを示す。 */
export function approvalStatusLine(config: SandboxConfig, projectTrusted: boolean | null): string {
	const effective = selectApprovalSettings(config, projectTrusted);
	const merged: ApprovalSettings = {
		approvalMode: config.approvalMode,
		autoReview: config.autoReview,
		approvalInvalid: config.approvalInvalid,
	};
	let line = describeApproval(effective);
	if (projectTrusted !== true && !sameApproval(effective, merged)) {
		line += projectTrusted === false
			? " (project untrusted; using global approval)"
			: " (project trust unknown; using global approval)";
	}
	return line;
}

function readJsonFile(path: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		// I2：非 null 对象的 JSON（数组/数字/字符串/布尔）一律按 corrupt 处理
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

interface ApprovalState {
	mode: ApprovalMode;
	modeInvalid: boolean;
	model: string;
	modelInvalid: boolean;
	thinking: string;
	thinkingInvalid: boolean;
}

function defaultApprovalState(): ApprovalState {
	return {
		mode: DEFAULT_APPROVAL.approvalMode,
		modeInvalid: false,
		model: DEFAULT_AUTO_REVIEW.model,
		modelInvalid: false,
		thinking: DEFAULT_AUTO_REVIEW.thinkingLevel,
		thinkingInvalid: false,
	};
}

function toApprovalSettings(state: ApprovalState): ApprovalSettings {
	return {
		approvalMode: state.mode,
		autoReview: { model: state.model, thinkingLevel: state.thinking },
		approvalInvalid: state.modeInvalid || state.modelInvalid || state.thinkingInvalid,
	};
}

/** フィールド単位。上位ファイルの不正値は、さらに上位の正しい値で上書きできる。 */
function applyApproval(state: ApprovalState, raw: Record<string, unknown>): void {
	if ("approvalMode" in raw) {
		if (isApprovalMode(raw.approvalMode)) {
			state.mode = raw.approvalMode;
			state.modeInvalid = false;
		} else {
			state.modeInvalid = true;
		}
	}
	if (!("autoReview" in raw)) return;
	const autoReview = raw.autoReview;
	if (autoReview === null || typeof autoReview !== "object" || Array.isArray(autoReview)) {
		state.modelInvalid = true;
		state.thinkingInvalid = true;
		return;
	}
	const review = autoReview as Record<string, unknown>;
	if ("model" in review) {
		if (typeof review.model === "string" && isReviewerModelSetting(review.model)) {
			state.model = review.model;
			state.modelInvalid = false;
		} else {
			state.modelInvalid = true;
		}
	}
	if ("thinkingLevel" in review) {
		if (typeof review.thinkingLevel === "string" && isReviewerThinkingSetting(review.thinkingLevel)) {
			state.thinking = review.thinkingLevel;
			state.thinkingInvalid = false;
		} else {
			state.thinkingInvalid = true;
		}
	}
}

/** 校验并规范化一份合并后的原始配置；非法即 throw（source 用于报错定位）。 */
export function validateSandboxConfig(raw: Record<string, unknown>, source: string): SandboxConfig {
	let mode: SandboxMode = DEFAULT_SANDBOX_CONFIG.mode;
	if (raw.mode !== undefined) {
		if (isSandboxMode(raw.mode)) mode = raw.mode;
		else console.warn(`sandbox: invalid mode ${JSON.stringify(raw.mode)} in ${source}, falling back to "${DEFAULT_SANDBOX_CONFIG.mode}"`);
	}

	const runnerCommand = raw.runnerCommand ?? null;
	const runnerFailureSignatures = raw.runnerFailureSignatures ?? null;
	if ((runnerCommand === null) !== (runnerFailureSignatures === null)) {
		throw new Error(`sandbox: ${source}: runnerCommand and runnerFailureSignatures must be configured together`);
	}
	if (runnerCommand !== null && !isStringArray(runnerCommand)) {
		throw new Error(`sandbox: ${source}: runnerCommand must be a string array`);
	}
	if (runnerFailureSignatures !== null) {
		if (!isStringArray(runnerFailureSignatures)) {
			throw new Error(`sandbox: ${source}: runnerFailureSignatures must be a string array`);
		}
		for (const signature of runnerFailureSignatures) {
			if (signature.trim().length === 0 || /[\r\n]/u.test(signature)) {
				throw new Error(`sandbox: ${source}: runnerFailureSignatures entries must be non-empty single-line strings`);
			}
		}
	}

	const probeTimeoutMs = raw.probeTimeoutMs ?? DEFAULT_SANDBOX_CONFIG.probeTimeoutMs;
	if (typeof probeTimeoutMs !== "number" || !Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0) {
		throw new Error(`sandbox: ${source}: probeTimeoutMs must be a positive finite number`);
	}

	return {
		mode,
		runnerCommand: runnerCommand as string[] | null,
		runnerFailureSignatures: runnerFailureSignatures as string[] | null,
		probeTimeoutMs,
		approvalMode: DEFAULT_SANDBOX_CONFIG.approvalMode,
		autoReview: DEFAULT_SANDBOX_CONFIG.autoReview,
		approvalInvalid: false,
		globalApproval: DEFAULT_SANDBOX_CONFIG.globalApproval,
	};
}

/**
 * グローバル設定ディレクトリ。
 * Pi の `getAgentDir()` は `PI_CODING_AGENT_DIR` を読む。SDK の `agentDir` オプションは
 * ExtensionContext に出てこない（pi 1.0.2）ので、拡張から見えるのはこの解決結果だけ。
 * テストは第二引数で解決済みディレクトリを渡せる。
 */
export function loadSandboxConfig(hostCwd: string, agentDir = getAgentDir()): SandboxConfig {
	const files = [
		{ path: resolvePath(agentDir, LEGACY_CONFIG_NAME), scope: "global" as const },
		{ path: resolvePath(agentDir, NEW_CONFIG_NAME), scope: "global" as const },
		{ path: resolvePath(hostCwd, CONFIG_DIR_NAME, LEGACY_CONFIG_NAME), scope: "project" as const },
		{ path: resolvePath(hostCwd, CONFIG_DIR_NAME, NEW_CONFIG_NAME), scope: "project" as const },
	];
	const mergedSandbox: Record<string, unknown> = {};
	const approval = defaultApprovalState();
	const globalApproval = defaultApprovalState();

	for (const file of files) {
		const raw = readJsonFile(file.path);
		if (raw === null) continue;
		for (const key of LEGACY_GROUPS) {
			if (key in raw) console.warn(`sandbox: ignoring legacy "${key}" section in ${file.path} (removed in 2.0; see README migration notes)`);
		}
		for (const key of SANDBOX_FIELD_KEYS) {
			if (raw[key] !== undefined) mergedSandbox[key] = raw[key];
		}
		applyApproval(approval, raw);
		if (file.scope === "global") applyApproval(globalApproval, raw);
	}

	const sandbox = validateSandboxConfig(mergedSandbox, NEW_CONFIG_NAME);
	const mergedApproval = toApprovalSettings(approval);
	return {
		...sandbox,
		approvalMode: mergedApproval.approvalMode,
		autoReview: mergedApproval.autoReview,
		approvalInvalid: mergedApproval.approvalInvalid,
		globalApproval: toApprovalSettings(globalApproval),
	};
}

const configCache = new Map<string, SandboxConfig>();

/** 安全加载（fail-safe，I2）：任何加载/校验错误回落默认配置（仍是受约束的 workspace-write），按 cwd 缓存。 */
export function getSandboxConfig(hostCwd: string): SandboxConfig {
	let cached = configCache.get(hostCwd);
	if (!cached) {
		try {
			cached = loadSandboxConfig(hostCwd);
		} catch (err) {
			console.warn(`sandbox: failed to load config, falling back to defaults (mode "${DEFAULT_SANDBOX_CONFIG.mode}"): ${err instanceof Error ? err.message : String(err)}`);
			cached = DEFAULT_SANDBOX_CONFIG;
		}
		configCache.set(hostCwd, cached);
	}
	return cached;
}

export function resetSandboxConfigCache(): void {
	configCache.clear();
}
