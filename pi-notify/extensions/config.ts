import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface NotifyConfig {
  thresholdSeconds: number;
  powershellPath?: string;
}

export const DEFAULT_CONFIG: NotifyConfig = {
  thresholdSeconds: 30,
};

export function getConfigPath(home = homedir()): string {
  return join(home, ".config", "pi", "notify-config.json");
}

export function isValidThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseThresholdInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }

  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

export function parseConfig(raw: unknown): NotifyConfig {
  if (raw === null || typeof raw !== "object") {
    return { ...DEFAULT_CONFIG };
  }

  const record = raw as Record<string, unknown>;
  const config: NotifyConfig = {
    thresholdSeconds: isValidThreshold(record.thresholdSeconds)
      ? record.thresholdSeconds
      : DEFAULT_CONFIG.thresholdSeconds,
  };

  if (typeof record.powershellPath === "string") {
    const powershellPath = record.powershellPath.trim();
    if (powershellPath !== "") {
      config.powershellPath = powershellPath;
    }
  }

  return config;
}

export function loadConfig(configPath = getConfigPath()): NotifyConfig {
  try {
    const text = readFileSync(configPath, "utf8");
    return parseConfig(JSON.parse(text));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(
  config: NotifyConfig,
  configPath = getConfigPath(),
): void {
  mkdirSync(dirname(configPath), { recursive: true });

  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  const tmpPath = `${configPath}.tmp`;
  writeFileSync(tmpPath, serialized, "utf8");

  try {
    renameSync(tmpPath, configPath);
  } catch {
    copyFileSync(tmpPath, configPath);
    unlinkSync(tmpPath);
  }
}
