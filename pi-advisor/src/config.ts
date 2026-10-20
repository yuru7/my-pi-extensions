/**
 * Settings at `~/.pi/agent/pi-advisor.json` (Pi's agent directory).
 *
 * A missing file uses defaults and is not created until `/pi-advisor` saves.
 * Invalid JSON warns and falls back to defaults. A save merges into the
 * existing object so unknown keys, `guidance`, and `disabledForModels` survive.
 * The write uses a temp file and rename. Memory is updated only after it succeeds.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { EFFORT_ORDINAL, type GradedEffort, isGradedEffort } from "./messages.ts";

export const CONFIG_FILE_NAME = "pi-advisor.json";

export type ToolInventory = "full" | "active" | "names";
export type DisabledForModelsEntry = string | { model: string; minEffort?: GradedEffort };

export interface AdvisorSettings {
	model?: string;
	effort?: GradedEffort;
	promptMode: "standard";
	disabledForModels: DisabledForModelsEntry[];
	toolInventory: ToolInventory;
	guidance: unknown;
}

const warned = new Set<string>();

let configPathOverride: string | undefined;

export function advisorConfigPath(): string {
	if (configPathOverride) return configPathOverride;
	return join(getAgentDir(), CONFIG_FILE_NAME);
}

export function __setAdvisorConfigPathForTests(path: string | undefined): void {
	configPathOverride = path;
}

export function __resetConfigWarningsForTests(): void {
	warned.clear();
}

function warnConfig(message: string): void {
	if (warned.has(message)) return;
	warned.add(message);
	console.warn(`[pi-advisor] ${message}`);
}

export function validateDisabledForModels(value: unknown): DisabledForModelsEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: DisabledForModelsEntry[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			if (entry.length > 0) entries.push(entry);
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.model !== "string" || record.model.length === 0) continue;
		if (record.minEffort !== undefined && !isGradedEffort(record.minEffort)) {
			warnConfig(
				`${CONFIG_FILE_NAME}: unknown minEffort "${String(record.minEffort)}" — dropping disabledForModels entry for "${record.model}"`,
			);
			continue;
		}
		const normalized: DisabledForModelsEntry = { model: record.model };
		if (isGradedEffort(record.minEffort)) normalized.minEffort = record.minEffort;
		entries.push(normalized);
	}
	return entries;
}

function validateToolInventory(value: unknown): ToolInventory {
	if (value === undefined) return "full";
	if (value === "full" || value === "active" || value === "names") return value;
	warnConfig(`${CONFIG_FILE_NAME}: unknown toolInventory "${String(value)}" — using "full"`);
	return "full";
}

function validatePromptMode(value: unknown): "standard" {
	if (value === undefined || value === "standard") return "standard";
	warnConfig(`${CONFIG_FILE_NAME}: unknown promptMode "${String(value)}" — using "standard"`);
	return "standard";
}

function settingsFromRaw(raw: Record<string, unknown>): AdvisorSettings {
	let model: string | undefined;
	if (typeof raw.model === "string" && raw.model.trim().length > 0) {
		model = raw.model.trim();
	} else if (raw.model !== undefined) {
		warnConfig(`${CONFIG_FILE_NAME}: model must be a non-empty string — ignoring it`);
	}

	let effort: GradedEffort | undefined;
	if (raw.effort !== undefined) {
		if (isGradedEffort(raw.effort)) {
			effort = raw.effort;
		} else {
			warnConfig(
				`${CONFIG_FILE_NAME}: unknown effort "${String(raw.effort)}" — ignoring (valid values: ${EFFORT_ORDINAL.join(", ")})`,
			);
		}
	}

	return {
		model,
		effort,
		promptMode: validatePromptMode(raw.promptMode),
		disabledForModels: validateDisabledForModels(raw.disabledForModels),
		toolInventory: validateToolInventory(raw.toolInventory),
		guidance: raw.guidance,
	};
}

export function loadAdvisorSettings(): AdvisorSettings {
	const path = advisorConfigPath();
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return settingsFromRaw({});
		warnConfig(`${CONFIG_FILE_NAME}: failed to read config (${code ?? "unknown"}) — using defaults`);
		return settingsFromRaw({});
	}

	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			warnConfig(`${CONFIG_FILE_NAME}: expected a JSON object — using defaults`);
			return settingsFromRaw({});
		}
		return settingsFromRaw(parsed as Record<string, unknown>);
	} catch {
		warnConfig(`${CONFIG_FILE_NAME}: invalid JSON — using defaults`);
		return settingsFromRaw({});
	}
}

function readRawForSave(): Record<string, unknown> {
	const path = advisorConfigPath();
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			warnConfig(`${CONFIG_FILE_NAME}: could not read the existing file (${code ?? "unknown"})`);
		}
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return { ...(parsed as Record<string, unknown>) };
		}
		warnConfig(`${CONFIG_FILE_NAME}: existing file is not a JSON object — replacing it`);
	} catch {
		warnConfig(`${CONFIG_FILE_NAME}: existing file could not be parsed — replacing it`);
	}
	return {};
}

function writeConfigFile(data: Record<string, unknown>): boolean {
	const path = advisorConfigPath();
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// The temp file was never created, or was already renamed.
		}
		const message = error instanceof Error ? error.message : String(error);
		warnConfig(`failed to save ${CONFIG_FILE_NAME}: ${message}`);
		return false;
	}

	try {
		chmodSync(path, 0o600);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnConfig(`saved ${CONFIG_FILE_NAME} but could not set mode 0600: ${message}`);
	}
	return true;
}

/** Persist model and effort. Other keys already on disk are left in place. */
export function saveAdvisorSelection(key: string | undefined, effort: GradedEffort | undefined): boolean {
	const config = readRawForSave();
	if (key) config.model = key;
	else delete config.model;
	delete config.modelKey;
	if (effort) config.effort = effort;
	else delete config.effort;
	return writeConfigFile(config);
}
