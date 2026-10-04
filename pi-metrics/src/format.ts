/**
 * Pure formatting helpers for the completion metrics line.
 *
 * No Pi or Node dependency: every function is deterministic and unit-tested.
 */

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

const TOKEN_PER_THOUSAND = 1_000;
const TOKEN_PER_MILLION = 1_000_000;
/** One decimal place for K/M values; a trailing `.0` is dropped. */
const SCALED_DECIMAL_PLACES = 1;
const ZERO_DECIMAL_SUFFIX = ".0";
const DURATION_DECIMAL_PLACES = 1;
const TPS_DECIMAL_PLACES = 1;
const COST_DECIMAL_PLACES = 6;

/** Segment appended after the rendered format when a run reported a cost. */
const COST_SEPARATOR = " · ";
const COST_LABEL = "cost ";

/** Label prefixed to the live elapsed time in Pi's streaming indicator. */
const WORKING_LABEL = "Working";

/** Placeholder values substituted into a user format string. */
export interface MetricValues {
  elapsed: string;
  tps: string;
  ttft: string;
  input: string;
  output: string;
}

/** Raw metrics needed to render one line. */
export interface RawMetrics {
  elapsedMs: number;
  tps: number | null;
  /** True when `tps` is a turn-duration estimate, rendered with a leading `≈`. */
  tpsEstimated?: boolean;
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  /** Cost reported by the provider in US dollars; 0 when it reports none. */
  costUsd: number;
}

/** Placeholder names recognized in a format string; anything else is left as-is. */
const PLACEHOLDER_PATTERN = /\{(elapsed|tps|ttft|input|output)\}/g;

/**
 * Format a duration in milliseconds for `{elapsed}` / `{ttft}`.
 *
 * Under a minute: `2.0s`. Under an hour: `1m 19.1s`. Longer: `1h 12m`.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = ms / MS_PER_SECOND;
  if (totalSeconds < SECONDS_PER_MINUTE) {
    return `${totalSeconds.toFixed(DURATION_DECIMAL_PLACES)}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  if (totalMinutes < MINUTES_PER_HOUR) {
    const seconds = totalSeconds - totalMinutes * SECONDS_PER_MINUTE;
    return `${totalMinutes}m ${seconds.toFixed(DURATION_DECIMAL_PLACES)}s`;
  }
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  return `${hours}h ${minutes}m`;
}

/**
 * Format elapsed run time for the live streaming indicator.
 *
 * Second precision, no decimals, no spaces, and only the units that have
 * passed: `0s`, `5s`, `1m19s`, `1h2m3s`. The whole seconds are truncated so
 * the value never shows a time that has not elapsed yet.
 */
export function formatWorkingElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (totalMinutes > 0) return `${totalMinutes}m${seconds}s`;
  return `${seconds}s`;
}

/** Text for Pi's streaming indicator, for example `Working (5s)`. */
export function formatWorkingMessage(elapsedMs: number): string {
  return `${WORKING_LABEL} (${formatWorkingElapsed(elapsedMs)})`;
}

/** Round a scaled count to the displayed precision. */
function roundScaled(value: number): number {
  const factor = 10 ** SCALED_DECIMAL_PLACES;
  return Math.round(value * factor) / factor;
}

/** Round to one decimal and drop a trailing `.0` (1000 → `1K`, 1234 → `1.2K`). */
function scaleCount(value: number, suffix: string): string {
  const rounded = roundScaled(value);
  const formatted = rounded.toFixed(SCALED_DECIMAL_PLACES);
  return formatted.endsWith(ZERO_DECIMAL_SUFFIX)
    ? `${rounded.toFixed(0)}${suffix}`
    : `${formatted}${suffix}`;
}

/**
 * Format a token count for `{input}` / `{output}`: 999, 1K, 1.2K, 12.2K, 1M.
 *
 * The unit is chosen from the rounded value, so a count that would display as
 * `1000.0K` (999_950..999_999) is promoted to millions instead.
 */
export function formatTokens(count: number): string {
  if (count < TOKEN_PER_THOUSAND) return String(count);
  const thousands = count / TOKEN_PER_THOUSAND;
  if (count < TOKEN_PER_MILLION && roundScaled(thousands) < TOKEN_PER_THOUSAND) {
    return scaleCount(thousands, "K");
  }
  return scaleCount(count / TOKEN_PER_MILLION, "M");
}

/**
 * Replace the known placeholders in a format string. Every occurrence is
 * replaced; unknown placeholders such as `{foo}` are kept verbatim so typos
 * stay visible and future placeholders remain valid.
 */
export function renderFormat(format: string, values: MetricValues): string {
  return format.replace(PLACEHOLDER_PATTERN, (_match, key: keyof MetricValues) => values[key]);
}

/** Format a cost in US dollars for a trailing `cost $1.234567` segment. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(COST_DECIMAL_PLACES)}`;
}

/**
 * Format raw metrics into one line using the configured format string.
 *
 * A positive cost is appended as ` · cost $1.234567`; providers that report no
 * cost leave it at zero, and the segment (including its separator) is omitted
 * so the line keeps its configured shape.
 */
export function renderMetrics(format: string, metrics: RawMetrics): string {
  const line = renderFormat(format, {
    elapsed: formatDuration(metrics.elapsedMs),
    tps:
      metrics.tps === null
        ? "n/a"
        : `${metrics.tpsEstimated === true ? "≈" : ""}${metrics.tps.toFixed(TPS_DECIMAL_PLACES)}`,
    ttft: metrics.ttftMs === null ? "n/a" : formatDuration(metrics.ttftMs),
    input: formatTokens(metrics.inputTokens),
    output: formatTokens(metrics.outputTokens),
  });
  return metrics.costUsd > 0
    ? `${line}${COST_SEPARATOR}${COST_LABEL}${formatCost(metrics.costUsd)}`
    : line;
}
