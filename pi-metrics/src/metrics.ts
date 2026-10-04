/**
 * Run and turn accounting for pi-metrics.
 *
 * Pure logic with an injectable clock: no Pi UI, no session state, no
 * persistence. A run spans `agent_start` through `agent_settled` and may
 * contain several turns (tool loops, retries). Display totals sum every
 * message, while TPS is aggregated as measured output over measured generation
 * time, with a turn-duration estimate (shown as approximate) when a turn has no
 * measurable delta span.
 *
 * Timing terms, per assistant message:
 * - stream window: first token delta to last token delta
 * - stall: a single gap longer than {@link STALL_THRESHOLD_MS}, excluded whole
 * - generation time: stream window minus stalls; a turn with no measurable
 *   window, or one whose deltas arrived in a burst after a long silence, falls
 *   back to its own response duration, marked as an estimate
 */

import { performance } from "node:perf_hooks";

/** A stream gap longer than this is treated as a stall and excluded from TPS. */
export const STALL_THRESHOLD_MS = 500;
/** A delta span this many times shorter than the silence before it is a burst. */
const BURST_SILENCE_RATIO = 30;

const MS_PER_SECOND = 1_000;
const TPS_DECIMAL_PLACES = 1;

export type Clock = () => number;

/** Structural view of an assistant message's usage, so this module needs no Pi import. */
export interface AssistantMessageLike {
  role?: unknown;
  usage?: { input?: unknown; output?: unknown; cost?: { total?: unknown } | null } | null;
}

/** True when the value is an assistant message (usage may still be missing). */
export function isAssistantMessage(value: unknown): value is AssistantMessageLike {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { role?: unknown }).role === "assistant"
  );
}

/** Aggregated metrics for one settled run. */
export interface RunMetrics {
  /** From `agent_start` to `agent_settled`. */
  elapsedMs: number;
  /** Weighted output-token rate, or null when no turn had measurable output. */
  tps: number | null;
  /** True when `tps` is a turn-duration estimate rather than a delta span. */
  tpsEstimated: boolean;
  /** Time to the first token (or first content when not streamed), or null. */
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  /** Cost reported by the provider in US dollars; 0 when it reports none. */
  costUsd: number;
}

/** Timing and finalized usage for one assistant message within a turn. */
interface StreamWindow {
  firstUpdateMs: number | null;
  lastUpdateMs: number | null;
  /** When the final usage arrived (`message_end`); used by the turn estimate. */
  endedAtMs: number | null;
  stallMs: number;
  updateCount: number;
  outputTokens: number;
}

interface TurnState {
  startedAtMs: number;
  window: StreamWindow;
  completedWindows: StreamWindow[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface MetricsTrackerOptions {
  /** Monotonic clock; defaults to `performance.now`. */
  now?: Clock;
  /** Stall gap threshold in milliseconds. */
  stallThresholdMs?: number;
}

function createWindow(): StreamWindow {
  return {
    firstUpdateMs: null,
    lastUpdateMs: null,
    endedAtMs: null,
    stallMs: 0,
    updateCount: 0,
    outputTokens: 0,
  };
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function roundTps(value: number): number {
  const scale = 10 ** TPS_DECIMAL_PLACES;
  return Math.round(value * scale) / scale;
}

/** True when a window holds anything worth folding (a delta or finalized usage). */
function hasContent(window: StreamWindow): boolean {
  return window.updateCount > 0 || window.outputTokens > 0;
}

/**
 * Span between the first and last token delta (minus stalls), or null when the
 * window streamed too few deltas to measure one.
 */
function deltaSpanMs(window: StreamWindow): number | null {
  if (window.updateCount < 2 || window.firstUpdateMs === null || window.lastUpdateMs === null) {
    return null;
  }
  const streamMs = window.lastUpdateMs - window.firstUpdateMs - window.stallMs;
  return streamMs > 0 ? streamMs : null;
}

/**
 * Detect a delivery burst: a long silence before the first delta followed by all
 * deltas arriving in a span far shorter than that silence. The span then
 * reflects delivery time rather than generation time, so the turn-duration
 * estimate is safer than reporting an implausibly high rate.
 */
function isBurst(turn: TurnState, measured: StreamWindow[]): boolean {
  let totalSpanMs = 0;
  for (const window of measured) totalSpanMs += deltaSpanMs(window) as number;
  if (totalSpanMs <= 0) return false;

  let firstDeltaMs: number | null = null;
  for (const window of turn.completedWindows) {
    if (window.firstUpdateMs !== null) {
      firstDeltaMs = window.firstUpdateMs;
      break;
    }
  }
  if (firstDeltaMs === null) return false;
  return firstDeltaMs - turn.startedAtMs >= totalSpanMs * BURST_SILENCE_RATIO;
}

/**
 * Stateful run/turn accountant driven by Pi lifecycle events.
 *
 * The caller maps events to methods; this class only tracks time and tokens.
 * `finish()` always resets the run, so consecutive runs cannot leak into each
 * other, even when a run is aborted.
 */
export class MetricsTracker {
  private readonly now: Clock;
  private readonly stallThresholdMs: number;

  private runStartedAtMs: number | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;
  private firstTtftMs: number | null = null;
  private measuredOutputTokens = 0;
  private measuredGenerationMs = 0;
  private tpsEstimated = false;
  private turn: TurnState | null = null;

  constructor(options: MetricsTrackerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.stallThresholdMs = options.stallThresholdMs ?? STALL_THRESHOLD_MS;
  }

  /**
   * Start a run when idle. Elapsed is measured from `agent_start`, the first
   * event guaranteed to be followed by `agent_settled`, so a prompt that never
   * becomes a run cannot leave a stale timer behind. A steer or follow-up
   * mid-run keeps the original start.
   */
  startRun(): void {
    if (this.runStartedAtMs === null) this.runStartedAtMs = this.now();
  }

  /**
   * Begin a turn. The previous turn is folded first, so a run is aggregated at
   * the next `turn_start` (or in `finish()` for the last turn) and `turn_end`
   * never needs to be observed.
   */
  startTurn(): void {
    this.endTurn();
    const now = this.now();
    this.turn = {
      startedAtMs: now,
      window: createWindow(),
      completedWindows: [],
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  }

  /** Begin a new assistant message within the current turn, closing the previous window. */
  startMessage(): void {
    const turn = this.turn;
    if (!turn) return;
    if (hasContent(turn.window)) turn.completedWindows.push(turn.window);
    turn.window = createWindow();
  }

  /** Record one token delta of the current message window. */
  recordUpdate(): void {
    const turn = this.turn;
    if (!turn) return;
    const now = this.now();

    const window = turn.window;
    if (window.firstUpdateMs === null || window.lastUpdateMs === null) {
      window.firstUpdateMs = now;
      window.lastUpdateMs = now;
      window.updateCount = 1;
      return;
    }
    const gap = now - window.lastUpdateMs;
    if (gap > this.stallThresholdMs) window.stallMs += gap;
    window.lastUpdateMs = now;
    window.updateCount += 1;
  }

  /**
   * Record the final usage of a finished assistant message. Called once per
   * `message_end`, so tokens are never counted from partial stream updates. The
   * usage is attached to the message's own window, so a turn whose messages are
   * only partly measurable contributes only the measurable output to TPS while
   * the display totals still sum everything.
   */
  recordAssistantMessage(message: AssistantMessageLike): void {
    const turn = this.turn;
    if (!turn) return;
    const input = toCount(message.usage?.input);
    const output = toCount(message.usage?.output);
    const cost = toCount(message.usage?.cost?.total);
    turn.inputTokens += input;
    turn.outputTokens += output;
    turn.costUsd += cost;
    turn.window.outputTokens += output;
    turn.window.endedAtMs = this.now();
  }

  /**
   * Fold the current turn into the run. Safe to call when no turn is open,
   * which `finish()` relies on to flush a turn that an abort left unfinished.
   */
  endTurn(): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    if (hasContent(turn.window)) turn.completedWindows.push(turn.window);

    this.inputTokens += turn.inputTokens;
    this.outputTokens += turn.outputTokens;
    this.costUsd += turn.costUsd;

    // TTFT is the first observed token delta; a response without deltas has none.
    if (this.firstTtftMs === null) {
      for (const window of turn.completedWindows) {
        if (window.firstUpdateMs === null) continue;
        this.firstTtftMs = window.firstUpdateMs - turn.startedAtMs;
        break;
      }
    }

    // A window with a delta span contributes its own output and span. When the
    // whole turn has no measurable span, fall back to the turn's response
    // duration as an estimate and flag the aggregate as approximate.
    const measured = turn.completedWindows.filter(
      (window) => window.outputTokens > 0 && deltaSpanMs(window) !== null,
    );
    if (measured.length > 0 && !isBurst(turn, measured)) {
      for (const window of measured) {
        this.measuredOutputTokens += window.outputTokens;
        this.measuredGenerationMs += deltaSpanMs(window) as number;
      }
      return;
    }

    if (turn.outputTokens <= 0) return;
    let endedAtMs: number | null = null;
    for (const window of turn.completedWindows) {
      if (window.endedAtMs !== null) endedAtMs = window.endedAtMs;
    }
    if (endedAtMs === null) return;
    const responseMs = endedAtMs - turn.startedAtMs;
    if (responseMs <= 0) return;
    this.measuredOutputTokens += turn.outputTokens;
    this.measuredGenerationMs += responseMs;
    this.tpsEstimated = true;
  }

  /**
   * Finish the run and reset all state. Returns null when no run was started,
   * so a stray `agent_settled` renders nothing; a started run is always shown,
   * even with zero completed turns.
   */
  finish(): RunMetrics | null {
    this.endTurn();
    const startedAtMs = this.runStartedAtMs;
    if (startedAtMs === null) {
      this.reset();
      return null;
    }

    const metrics: RunMetrics = {
      elapsedMs: this.now() - startedAtMs,
      tps:
        this.measuredOutputTokens > 0 && this.measuredGenerationMs > 0
          ? roundTps(this.measuredOutputTokens / (this.measuredGenerationMs / MS_PER_SECOND))
          : null,
      tpsEstimated: this.tpsEstimated,
      ttftMs: this.firstTtftMs,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
    };
    this.reset();
    return metrics;
  }

  /** Discard all run and turn state. */
  reset(): void {
    this.runStartedAtMs = null;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.costUsd = 0;
    this.firstTtftMs = null;
    this.measuredOutputTokens = 0;
    this.measuredGenerationMs = 0;
    this.tpsEstimated = false;
    this.turn = null;
  }
}
