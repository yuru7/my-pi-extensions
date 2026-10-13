/**
 * Configuration loading for pi-auto-title.
 *
 * The configuration is optional and lives in one fixed file,
 * `~/.pi/agent/pi-auto-title.json`. A missing file is normal: the extension runs
 * on {@link DEFAULT_CONFIG} and never writes the file by itself. When a file
 * exists, unknown fields are ignored and missing fields fall back to the
 * defaults. Invalid JSON or invalid field types are reported as warnings and
 * fall back to the defaults instead of throwing, so a broken file can never
 * stop Pi from starting and is never repaired or overwritten.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE_NAME = "pi-auto-title.json";
const UTF8_ENCODING = "utf8";
const FILE_NOT_FOUND_CODE = "ENOENT";

/** `model` value that selects the active Pi session model. */
export const CURRENT_MODEL = "CURRENT";
/** `thinkingLevel` value that selects the active Pi session thinking level. */
export const CURRENT_THINKING_LEVEL = "CURRENT";

export interface AutoTitleSettings {
	/** Whether AI title generation runs at all. */
	enabled: boolean;
	/** `CURRENT` or a `provider/model-id` reference. */
	model: string;
	/** `CURRENT` or a thinking level such as `off`, `low`, `high`. */
	thinkingLevel: string;
	/** Whether a failed model selection falls back to the current session model. */
	fallbackToCurrentModel: boolean;
}

export interface StatusIndicatorSettings {
	/** Whether the running/idle marker is part of the tab title. */
	enabled: boolean;
	/** Marker shown while the agent runs; an empty string shows none. */
	running: string;
	/** Marker shown while the agent is idle; an empty string shows none. */
	idle: string;
	/** Marker shown while a watched tool is stalled; an empty string shows none. */
	stalled: string;
	/** Inactivity-based stall detection for running tools. */
	stallDetection: StallDetectionSettings;
}

export interface StallDetectionSettings {
	/** Whether running tools are watched for inactivity at all. */
	enabled: boolean;
	/** Seconds of tool silence before the stalled marker shows; finite and >= 1. */
	thresholdSeconds: number;
}

export interface AutoTitleConfig {
	autoTitle: AutoTitleSettings;
	statusIndicator: StatusIndicatorSettings;
}

export const DEFAULT_CONFIG: AutoTitleConfig = {
	autoTitle: {
		enabled: true,
		model: CURRENT_MODEL,
		thinkingLevel: CURRENT_THINKING_LEVEL,
		fallbackToCurrentModel: true,
	},
	statusIndicator: {
		enabled: true,
		running: "⏳",
		idle: "✅",
		stalled: "⏸️",
		stallDetection: {
			enabled: true,
			thresholdSeconds: 30,
		},
	},
};

/** Result of loading the configuration; `warning` is set when defaults were used after an error. */
export interface LoadConfigResult {
	config: AutoTitleConfig;
	warning?: string;
}

/** Path of the configuration file: `<agent dir>/pi-auto-title.json` (e.g. `~/.pi/agent/`). */
export function configPath(): string {
	return join(getAgentDir(), CONFIG_FILE_NAME);
}

/** A fresh copy of the default configuration, so callers cannot mutate {@link DEFAULT_CONFIG}. */
export function defaultConfig(): AutoTitleConfig {
	return {
		autoTitle: { ...DEFAULT_CONFIG.autoTitle },
		statusIndicator: {
			...DEFAULT_CONFIG.statusIndicator,
			stallDetection: { ...DEFAULT_CONFIG.statusIndicator.stallDetection },
		},
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asObject(value: unknown, field: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${field} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

function readBoolean(
	source: Record<string, unknown>,
	section: string,
	key: string,
	fallback: boolean,
): boolean {
	const value = source[key];
	if (value === undefined) return fallback;
	if (typeof value !== "boolean")
		throw new Error(`${section}.${key} must be a boolean`);
	return value;
}

function readString(
	source: Record<string, unknown>,
	section: string,
	key: string,
	fallback: string,
	allowEmpty: boolean,
): string {
	const value = source[key];
	if (value === undefined) return fallback;
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		throw new Error(
			`${section}.${key} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
		);
	}
	return value;
}

function readNumber(
	source: Record<string, unknown>,
	section: string,
	key: string,
	fallback: number,
	minimum: number,
): number {
	const value = source[key];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
		throw new Error(`${section}.${key} must be a finite number >= ${minimum}`);
	}
	return value;
}

/**
 * Validate a parsed configuration value and fill missing fields with defaults.
 *
 * Throws when the value is not an object or a known field has the wrong type,
 * naming the offending field so the warning can point at it.
 */
export function parseConfig(value: unknown): AutoTitleConfig {
	const root = asObject(value, "configuration");
	const autoTitle = asObject(root.autoTitle, "autoTitle");
	const statusIndicator = asObject(root.statusIndicator, "statusIndicator");
	const stallDetection = asObject(
		statusIndicator.stallDetection,
		"statusIndicator.stallDetection",
	);
	return {
		autoTitle: {
			enabled: readBoolean(
				autoTitle,
				"autoTitle",
				"enabled",
				DEFAULT_CONFIG.autoTitle.enabled,
			),
			model: readString(
				autoTitle,
				"autoTitle",
				"model",
				DEFAULT_CONFIG.autoTitle.model,
				false,
			),
			thinkingLevel: readString(
				autoTitle,
				"autoTitle",
				"thinkingLevel",
				DEFAULT_CONFIG.autoTitle.thinkingLevel,
				false,
			),
			fallbackToCurrentModel: readBoolean(
				autoTitle,
				"autoTitle",
				"fallbackToCurrentModel",
				DEFAULT_CONFIG.autoTitle.fallbackToCurrentModel,
			),
		},
		statusIndicator: {
			enabled: readBoolean(
				statusIndicator,
				"statusIndicator",
				"enabled",
				DEFAULT_CONFIG.statusIndicator.enabled,
			),
			running: readString(
				statusIndicator,
				"statusIndicator",
				"running",
				DEFAULT_CONFIG.statusIndicator.running,
				true,
			),
			idle: readString(
				statusIndicator,
				"statusIndicator",
				"idle",
				DEFAULT_CONFIG.statusIndicator.idle,
				true,
			),
			stalled: readString(
				statusIndicator,
				"statusIndicator",
				"stalled",
				DEFAULT_CONFIG.statusIndicator.stalled,
				true,
			),
			stallDetection: {
				enabled: readBoolean(
					stallDetection,
					"statusIndicator.stallDetection",
					"enabled",
					DEFAULT_CONFIG.statusIndicator.stallDetection.enabled,
				),
				thresholdSeconds: readNumber(
					stallDetection,
					"statusIndicator.stallDetection",
					"thresholdSeconds",
					DEFAULT_CONFIG.statusIndicator.stallDetection.thresholdSeconds,
					1,
				),
			},
		},
	};
}

/**
 * Read and validate the configuration file.
 *
 * A missing file is normal and returns the defaults without a warning. Any
 * other failure (unreadable file, invalid JSON, invalid field) returns the
 * defaults together with a warning for the caller to surface once.
 */
export function loadConfig(path = configPath()): LoadConfigResult {
	let text: string;
	try {
		text = readFileSync(path, UTF8_ENCODING);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_CODE) {
			return { config: defaultConfig() };
		}
		return {
			config: defaultConfig(),
			warning: `pi-auto-title: could not read ${path}: ${errorMessage(error)}`,
		};
	}

	try {
		return { config: parseConfig(JSON.parse(text)) };
	} catch (error) {
		return {
			config: defaultConfig(),
			warning: `pi-auto-title: invalid configuration at ${path}: ${errorMessage(error)}`,
		};
	}
}

/**
 * Write the default configuration to `path`, creating parent directories.
 *
 * The JSON is indented with two spaces and ends with a newline.
 */
export function writeDefaultConfig(path = configPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`,
		UTF8_ENCODING,
	);
}
