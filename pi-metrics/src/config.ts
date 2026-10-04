/**
 * Configuration loading for pi-metrics.
 *
 * The configuration is optional. A missing file, invalid JSON, or an invalid
 * `format` value all fall back to {@link DEFAULT_CONFIG} without throwing, so a
 * broken file can never stop Pi from starting. Unknown fields are ignored for
 * forward compatibility.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE_NAME = "pi-metrics.json";
const UTF8_ENCODING = "utf8";
const FILE_NOT_FOUND_CODE = "ENOENT";

export const DEFAULT_FORMAT =
  "Worked for {elapsed} · TPS {tps} tok/s · TTFT {ttft} · in {input} · out {output}";

export interface MetricsConfig {
  /** Template rendered once when a run settles. */
  format: string;
}

export const DEFAULT_CONFIG: MetricsConfig = { format: DEFAULT_FORMAT };

/** Result of loading the configuration; `warning` is set when defaults were used after an error. */
export interface LoadConfigResult {
  config: MetricsConfig;
  warning?: string;
}

/**
 * Path of the configuration file: `<agent dir>/pi-metrics.json`.
 *
 * The agent directory comes from {@link getAgentDir}, so `PI_CODING_AGENT_DIR`
 * and a customized config directory are honored. It defaults to `~/.pi/agent`.
 */
export function configPath(agentDir = getAgentDir()): string {
  return join(agentDir, CONFIG_FILE_NAME);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate a parsed configuration value.
 *
 * Returns defaults when `format` is absent. Throws when the value is not an
 * object or `format` is present but not a string.
 */
export function parseConfig(value: unknown): MetricsConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.format === undefined) return { ...DEFAULT_CONFIG };
  if (typeof raw.format !== "string") {
    throw new Error("format must be a string");
  }
  return { format: raw.format };
}

/**
 * Read and validate the configuration file.
 *
 * A missing file is normal and returns the defaults without a warning. Any
 * other failure (unreadable file, invalid JSON, invalid `format`) returns the
 * defaults together with a warning for the caller to surface once.
 */
export function loadConfig(path = configPath()): LoadConfigResult {
  let text: string;
  try {
    text = readFileSync(path, UTF8_ENCODING);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_CODE) {
      return { config: { ...DEFAULT_CONFIG } };
    }
    return {
      config: { ...DEFAULT_CONFIG },
      warning: `pi-metrics: could not read ${path}: ${errorMessage(error)}`,
    };
  }

  try {
    return { config: parseConfig(JSON.parse(text)) };
  } catch (error) {
    return {
      config: { ...DEFAULT_CONFIG },
      warning: `pi-metrics: invalid configuration at ${path}: ${errorMessage(error)}`,
    };
  }
}
