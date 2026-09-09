import * as fs from "node:fs";
import { isatty, WriteStream as TtyWriteStream } from "node:tty";

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PRZcf-nqry=><]/g;

/** Remove ANSI escape sequences for width calculation and safe display. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

/** JSON.stringify that never throws (for tool args logging). */
export function safeJsonStringify(value: unknown): string {
  try {
    const text = JSON.stringify(sanitizeJsonValue(value));
    return typeof text === "string" ? text : "null";
  } catch {
    return "null";
  }
}

/**
 * Deep-clone a value into plain JSON-safe data.
 *
 * - `bigint` becomes its decimal string (JSON has no bigint literal).
 * - Circular references become `"<circular>"`.
 * - `Date` becomes its ISO string.
 * - `undefined` / functions / symbols are dropped from objects and become
 *   `null` in arrays (matching `JSON.stringify` semantics).
 * - Anything else unreadable becomes `"<unserializable>"`.
 *
 * `toJSON` methods are deliberately ignored so a throwing serializer cannot
 * break event output.
 */
export function sanitizeJsonValue(value: unknown, seen: Set<object> = new Set()): unknown {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
    case "undefined":
      return undefined;
    case "object":
      break;
    default:
      return value;
  }
  const record = value as Record<string, unknown>;
  if (record instanceof Date) {
    try {
      return record.toISOString();
    } catch {
      return "<unserializable>";
    }
  }
  if (seen.has(record)) {
    return "<circular>";
  }
  seen.add(record);
  try {
    if (Array.isArray(record)) {
      return record.map((item) => {
        const sanitized = sanitizeJsonValue(item, seen);
        return sanitized === undefined ? null : sanitized;
      });
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      const sanitized = sanitizeJsonValue(entry, seen);
      if (sanitized !== undefined) {
        out[key] = sanitized;
      }
    }
    return out;
  } catch {
    return "<unserializable>";
  } finally {
    seen.delete(record);
  }
}

/** Format an integer with thousands separators (en-US). */
export function formatCount(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return safe.toLocaleString("en-US");
}

/** Format milliseconds as seconds with one decimal, e.g. "24.8s". */
export function formatSeconds(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  return `${(safe / 1000).toFixed(1)}s`;
}

/** Format TPS as e.g. "331.2 tok/s", or "-" when generation time is zero. */
export function formatTps(outputTokens: number, generationMs: number): string {
  if (!Number.isFinite(generationMs) || generationMs <= 0) {
    return "-";
  }
  const safeOutput = Number.isFinite(outputTokens)
    ? Math.max(0, outputTokens)
    : 0;
  return `${(safeOutput / (generationMs / 1000)).toFixed(1)} tok/s`;
}

/** Separator line used for the thinking view. */
export function separatorLine(columns: number, maxWidth = 40): string {
  const width = Math.floor(Number.isFinite(columns) ? columns : maxWidth);
  const clamped = Math.max(10, Math.min(width, maxWidth));
  return "─".repeat(clamped);
}

/** ANSI wrappers for subtle (gray/dimmed) output. TTY only. */
export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";

/** Wrap text in dim styling. Callers must skip this when not on a TTY. */
export function dimText(text: string): string {
  return `${DIM}${text}${RESET}`;
}

/**
 * Write bytes to the real stdout (fd 1).
 *
 * Pi takes over `process.stdout.write` in print mode (forwarding extension
 * output to stderr to protect machine-readable output), so user-facing
 * output must go through fd 1 directly. Failures (e.g. EPIPE from `| head`)
 * are swallowed so they never crash the run.
 */
export function writeRealStdout(chunk: string): void {
  if (!chunk) {
    return;
  }
  try {
    fs.writeSync(1, chunk);
  } catch {
    // Broken pipe / closed stdout: nothing useful left to do.
  }
}

/**
 * True when fd 1 is a TTY.
 *
 * This intentionally ignores `process.stdout.isTTY`: inside Pi's extension
 * sandbox that object is replaced and no longer reflects the real stdout.
 * `isatty` alone is sufficient — character devices such as `/dev/null` are
 * correctly reported as non-TTY.
 */
export function isRealTTY(fd = 1): boolean {
  try {
    return isatty(fd);
  } catch {
    return false;
  }
}

function firstPositive(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate > 0
    ) {
      return Math.floor(candidate);
    }
  }
  return undefined;
}

/**
 * Query the terminal width of fd 1 via a throwaway TTY stream.
 * Returns undefined when fd 1 is not a TTY (redirects, pipes).
 */
function probeTtyColumns(fd = 1): number | undefined {
  try {
    // Intentionally not destroyed: destroying could close fd 1 on platforms
    // where libuv shares (rather than dups) the descriptor. An idle handle
    // neither keeps the event loop alive nor affects fd 1 usability.
    const stream = new TtyWriteStream(fd);
    return firstPositive(stream.columns);
  } catch {
    return undefined;
  }
}

/**
 * Create a cached terminal-width getter for fd 1.
 *
 * The width is probed once (a real TTY reports it directly) and then cached;
 * call `refresh()` after a terminal resize to re-probe. probing is skipped
 * entirely when fd 1 is not a TTY.
 */
export function createColumnsProbe(
  fd = 1,
  fallback = 80,
): (() => number) & { refresh: () => number } {
  let cached: number | undefined;
  const probe = (): number => {
    const probed =
      probeTtyColumns(fd) ??
      firstPositive(
        (process.stdout as unknown as { columns?: unknown }).columns,
        (process.stderr as unknown as { columns?: unknown }).columns,
        process.env.COLUMNS !== undefined
          ? Number(process.env.COLUMNS)
          : undefined,
      ) ??
      fallback;
    cached = probed;
    return probed;
  };
  const get = (() => cached ?? probe()) as (() => number) & {
    refresh: () => number;
  };
  get.refresh = () => probe();
  return get;
}
