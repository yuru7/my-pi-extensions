/**
 * Configuration loading for pi-auto-title.
 *
 * The configuration is optional and lives in one fixed file,
 * `~/.pi/agent/pi-auto-title.json`. A missing file is normal: the extension runs
 * on {@link DEFAULT_CONFIG} and never writes the file by itself. When a file
 * exists, unknown fields are ignored and missing fields fall back to the
 * defaults. Invalid JSON falls back to the defaults entirely; an invalid field
 * type falls back per field, so a setting the user deliberately chose — turning
 * title generation off, say — survives an unrelated field error. All problems
 * are reported as warnings instead of throwing, so a broken file can never stop
 * Pi from starting and is never repaired or overwritten.
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

/** Result of validating a configuration value. */
export interface ParseConfigResult {
	config: AutoTitleConfig;
	/**
	 * One entry per invalid field, naming the field; every named field fell back
	 * to its default. Empty when the value is fully valid.
	 */
	errors: string[];
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

type ParseErrors = string[];

function asObject(
	value: unknown,
	field: string,
	errors: ParseErrors,
): Record<string, unknown> {
	if (value === undefined) return {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		errors.push(`${field} must be a JSON object`);
		return {};
	}
	return value as Record<string, unknown>;
}

function readBoolean(
	source: Record<string, unknown>,
	section: string,
	key: string,
	fallback: boolean,
	errors: ParseErrors,
): boolean {
	const value = source[key];
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		errors.push(`${section}.${key} must be a boolean`);
		return fallback;
	}
	return value;
}

function readString(
	source: Record<string, unknown>,
	section: string,
	key: string,
	fallback: string,
	allowEmpty: boolean,
	errors: ParseErrors,
): string {
	const value = source[key];
	if (value === undefined) return fallback;
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		errors.push(
			`${section}.${key} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
		);
		return fallback;
	}
	return value;
}

function readNumber(
	source: Record<string, unknown>,
	section: string,
	key: string,
	fallback: number,
	minimum: number,
	errors: ParseErrors,
): number {
	const value = source[key];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
		errors.push(`${section}.${key} must be a finite number >= ${minimum}`);
		return fallback;
	}
	return value;
}

/**
 * Validate a parsed configuration value and fill missing fields with defaults.
 *
 * An invalid field falls back to its default and is named in `errors`, while
 * valid fields — privacy-relevant ones such as `autoTitle.enabled: false`
 * included — keep their value. A section that is not an object falls back as a
 * whole. Only a root that is not an object yields the defaults entirely.
 */
export function parseConfig(value: unknown): ParseConfigResult {
	const errors: ParseErrors = [];
	const root = asObject(value, "configuration", errors);
	const autoTitle = asObject(root.autoTitle, "autoTitle", errors);
	const statusIndicator = asObject(
		root.statusIndicator,
		"statusIndicator",
		errors,
	);
	const stallDetection = asObject(
		statusIndicator.stallDetection,
		"statusIndicator.stallDetection",
		errors,
	);
	return {
		config: {
			autoTitle: {
				enabled: readBoolean(
					autoTitle,
					"autoTitle",
					"enabled",
					DEFAULT_CONFIG.autoTitle.enabled,
					errors,
				),
				model: readString(
					autoTitle,
					"autoTitle",
					"model",
					DEFAULT_CONFIG.autoTitle.model,
					false,
					errors,
				),
				thinkingLevel: readString(
					autoTitle,
					"autoTitle",
					"thinkingLevel",
					DEFAULT_CONFIG.autoTitle.thinkingLevel,
					false,
					errors,
				),
				fallbackToCurrentModel: readBoolean(
					autoTitle,
					"autoTitle",
					"fallbackToCurrentModel",
					DEFAULT_CONFIG.autoTitle.fallbackToCurrentModel,
					errors,
				),
			},
			statusIndicator: {
				enabled: readBoolean(
					statusIndicator,
					"statusIndicator",
					"enabled",
					DEFAULT_CONFIG.statusIndicator.enabled,
					errors,
				),
				running: readString(
					statusIndicator,
					"statusIndicator",
					"running",
					DEFAULT_CONFIG.statusIndicator.running,
					true,
					errors,
				),
				idle: readString(
					statusIndicator,
					"statusIndicator",
					"idle",
					DEFAULT_CONFIG.statusIndicator.idle,
					true,
					errors,
				),
				stalled: readString(
					statusIndicator,
					"statusIndicator",
					"stalled",
					DEFAULT_CONFIG.statusIndicator.stalled,
					true,
					errors,
				),
				stallDetection: {
					enabled: readBoolean(
						stallDetection,
						"statusIndicator.stallDetection",
						"enabled",
						DEFAULT_CONFIG.statusIndicator.stallDetection.enabled,
						errors,
					),
					thresholdSeconds: readNumber(
						stallDetection,
						"statusIndicator.stallDetection",
						"thresholdSeconds",
						DEFAULT_CONFIG.statusIndicator.stallDetection.thresholdSeconds,
						1,
						errors,
					),
				},
			},
		},
		errors,
	};
}

/**
 * Read and validate the configuration file.
 *
 * A missing file is normal and returns the defaults without a warning. Invalid
 * JSON (or an unreadable file) returns the defaults with a warning; invalid
 * fields fall back one by one and the warning names each of them, so a chosen
 * setting such as `autoTitle.enabled: false` survives an unrelated field error.
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
		const { config, errors } = parseConfig(JSON.parse(text));
		if (errors.length === 0) return { config };
		return {
			config,
			warning: `pi-auto-title: invalid configuration fields at ${path} (${errors.join(
				", ",
			)}); those fields use the defaults`,
		};
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
