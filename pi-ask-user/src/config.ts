import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+o"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const EXTENSION_NAME = "pi-ask-user";
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+o";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";

export interface GuidanceFields {
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export interface AskUserQuestionConfig {
	/** Positive seconds, or `null` when the questionnaire waits without a time limit. */
	timeoutSeconds: number | null;
	collapseKey: CollapseKeySpec;
	guidance: GuidanceFields;
}

export interface LoadedConfig {
	config: AskUserQuestionConfig;
	warnings: string[];
}

const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

const COMPOUND_KEY_DISPLAY: Record<string, string> = {
	pageup: "PageUp",
	pagedown: "PageDown",
};

/**
 * `<agent dir>/pi-ask-user.json`. The directory comes from Pi's
 * {@link getAgentDir}, so `PI_CODING_AGENT_DIR` and a custom config directory
 * are honored. The default is `~/.pi/agent`.
 */
export function configPath(agentDir = getAgentDir()): string {
	return join(agentDir, `${EXTENSION_NAME}.json`);
}

function isValidCollapseKeySpec(spec: string): boolean {
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((modifier) => MODIFIERS.has(modifier))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

export function resolveCollapseKey(raw: unknown, warnings?: string[]): CollapseKeySpec {
	if (raw === undefined) return DEFAULT_COLLAPSE_KEY;
	if (typeof raw !== "string") {
		warnings?.push("collapseKey must be a string; using ctrl+o");
		return DEFAULT_COLLAPSE_KEY;
	}
	const spec = raw.trim().toLowerCase();
	if (spec === "") return DEFAULT_COLLAPSE_KEY;
	if (spec === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	if (isValidCollapseKeySpec(spec)) return spec;
	warnings?.push(`collapseKey ${JSON.stringify(raw)} is not a valid key spec; using ctrl+o`);
	return DEFAULT_COLLAPSE_KEY;
}

/**
 * Positive finite seconds become milliseconds. `null`, `0`, and negative
 * numbers wait forever. Missing values use 600 seconds. Any other type or a
 * non-finite number falls back to 600 seconds.
 */
export function resolveTimeoutMs(raw: unknown, warnings?: string[]): number | null {
	if (raw === undefined) return DEFAULT_TIMEOUT_SECONDS * 1000;
	if (raw === null) return null;
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		warnings?.push("timeoutSeconds must be a finite number or null; using 600");
		return DEFAULT_TIMEOUT_SECONDS * 1000;
	}
	if (raw <= 0) return null;
	return raw * 1000;
}

export function resolveTimeoutSeconds(raw: unknown, warnings?: string[]): number | null {
	const ms = resolveTimeoutMs(raw, warnings);
	return ms === null ? null : ms / 1000;
}

export function formatKeySpecForDisplay(spec: CollapseKeySpec): string {
	return spec
		.split("+")
		.map(
			(part) =>
				COMPOUND_KEY_DISPLAY[part] ??
				(part.length <= 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)),
		)
		.join("+");
}

function optionalText(value: unknown, field: string, warnings: string[]): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		warnings.push(`${field} must be a string; ignoring it`);
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? value : undefined;
}

export function validateGuidanceFields(raw: unknown, warnings: string[] = []): GuidanceFields {
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("guidance must be an object; ignoring it");
		return {};
	}
	const record = raw as Record<string, unknown>;
	const guidance: GuidanceFields = {};
	const description = optionalText(record.description, "guidance.description", warnings);
	const promptSnippet = optionalText(record.promptSnippet, "guidance.promptSnippet", warnings);
	if (description !== undefined) guidance.description = description;
	if (promptSnippet !== undefined) guidance.promptSnippet = promptSnippet;
	if (record.promptGuidelines !== undefined) {
		if (
			!Array.isArray(record.promptGuidelines) ||
			record.promptGuidelines.some((entry) => typeof entry !== "string")
		) {
			warnings.push("guidance.promptGuidelines must be an array of strings; ignoring it");
		} else {
			guidance.promptGuidelines = record.promptGuidelines;
		}
	}
	return guidance;
}

export function defaultConfig(): AskUserQuestionConfig {
	return {
		timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
		collapseKey: DEFAULT_COLLAPSE_KEY,
		guidance: {},
	};
}

export function parseConfig(raw: unknown, warnings: string[]): AskUserQuestionConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("config must be a JSON object; using defaults");
		return defaultConfig();
	}
	const record = raw as Record<string, unknown>;
	return {
		timeoutSeconds: resolveTimeoutSeconds(record.timeoutSeconds, warnings),
		collapseKey: resolveCollapseKey(record.collapseKey, warnings),
		guidance: validateGuidanceFields(record.guidance, warnings),
	};
}

/** Read the config from {@link configPath}. A missing file is the default config. */
export function loadConfig(file = configPath()): LoadedConfig {
	const warnings: string[] = [];
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { config: defaultConfig(), warnings };
		warnings.push(`failed to read ${file}: ${(error as Error).message}`);
		return { config: defaultConfig(), warnings };
	}
	try {
		return { config: parseConfig(JSON.parse(text) as unknown, warnings), warnings };
	} catch (error) {
		warnings.push(`ignored malformed JSON in ${file}: ${(error as Error).message}`);
		return { config: defaultConfig(), warnings };
	}
}

export function warnConfig(loaded: LoadedConfig, warn: (message: string) => void = console.warn): void {
	for (const warning of loaded.warnings) warn(`pi-ask-user: ${warning}`);
}
