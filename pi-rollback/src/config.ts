import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BashConfig {
  enabled: boolean;
  maxFilesPerCall: number;
  maxBytesPerCallMB: number;
  warnOnUnresolvedMutation: boolean;
}

export interface RollbackConfig {
  enabled: boolean;
  maxFileSizeMB: number;
  maxTotalSizeMB: number;
  retentionDays: number;
  safeRestore: boolean;
  bash: BashConfig;
  excludeGlobs: string[];
}

export const DEFAULT_BASH_CONFIG: BashConfig = {
  enabled: true,
  maxFilesPerCall: 5000,
  maxBytesPerCallMB: 200,
  warnOnUnresolvedMutation: true,
};

export const DEFAULT_CONFIG: RollbackConfig = {
  enabled: true,
  maxFileSizeMB: 10,
  maxTotalSizeMB: 500,
  retentionDays: 14,
  safeRestore: true,
  bash: { ...DEFAULT_BASH_CONFIG },
  excludeGlobs: [],
};

export const CONFIG_LOAD_WARNING =
  "pi-rollback: Failed to load configuration; using defaults.";

export function getConfigPath(home = homedir()): string {
  return join(home, ".pi", "agent", "pi-rollback.json");
}

export function getStoreRoot(home = homedir()): string {
  return join(home, ".pi", "agent", "pi-rollback");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function parseBashConfig(raw: unknown): BashConfig {
  if (raw === null || typeof raw !== "object") {
    return { ...DEFAULT_BASH_CONFIG };
  }

  const record = raw as Record<string, unknown>;
  return {
    enabled:
      typeof record.enabled === "boolean"
        ? record.enabled
        : DEFAULT_BASH_CONFIG.enabled,
    maxFilesPerCall: isPositiveNumber(record.maxFilesPerCall)
      ? Math.floor(record.maxFilesPerCall)
      : DEFAULT_BASH_CONFIG.maxFilesPerCall,
    maxBytesPerCallMB: isPositiveNumber(record.maxBytesPerCallMB)
      ? record.maxBytesPerCallMB
      : DEFAULT_BASH_CONFIG.maxBytesPerCallMB,
    warnOnUnresolvedMutation:
      typeof record.warnOnUnresolvedMutation === "boolean"
        ? record.warnOnUnresolvedMutation
        : DEFAULT_BASH_CONFIG.warnOnUnresolvedMutation,
  };
}

export function parseConfig(raw: unknown): RollbackConfig {
  if (raw === null || typeof raw !== "object") {
    return structuredClone(DEFAULT_CONFIG);
  }

  const record = raw as Record<string, unknown>;
  const excludeGlobs = Array.isArray(record.excludeGlobs)
    ? record.excludeGlobs.filter((item): item is string => typeof item === "string")
    : [...DEFAULT_CONFIG.excludeGlobs];

  return {
    enabled:
      typeof record.enabled === "boolean"
        ? record.enabled
        : DEFAULT_CONFIG.enabled,
    maxFileSizeMB: isPositiveNumber(record.maxFileSizeMB)
      ? record.maxFileSizeMB
      : DEFAULT_CONFIG.maxFileSizeMB,
    maxTotalSizeMB: isPositiveNumber(record.maxTotalSizeMB)
      ? record.maxTotalSizeMB
      : DEFAULT_CONFIG.maxTotalSizeMB,
    retentionDays: isNonNegativeNumber(record.retentionDays)
      ? Math.floor(record.retentionDays)
      : DEFAULT_CONFIG.retentionDays,
    safeRestore:
      typeof record.safeRestore === "boolean"
        ? record.safeRestore
        : DEFAULT_CONFIG.safeRestore,
    bash: parseBashConfig(record.bash),
    excludeGlobs,
  };
}

export interface LoadedConfig {
  config: RollbackConfig;
  warning?: string;
}

export function loadConfig(configPath = getConfigPath()): LoadedConfig {
  try {
    const text = readFileSync(configPath, "utf8");
    return { config: parseConfig(JSON.parse(text)) };
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return { config: structuredClone(DEFAULT_CONFIG) };
    }
    return {
      config: structuredClone(DEFAULT_CONFIG),
      warning: CONFIG_LOAD_WARNING,
    };
  }
}

export function maxFileSizeBytes(config: RollbackConfig): number {
  return config.maxFileSizeMB * 1024 * 1024;
}

export function maxTotalSizeBytes(config: RollbackConfig): number {
  return config.maxTotalSizeMB * 1024 * 1024;
}

export function maxBytesPerCall(config: RollbackConfig): number {
  return config.bash.maxBytesPerCallMB * 1024 * 1024;
}
