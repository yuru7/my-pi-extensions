export interface UsageLike {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

export interface StatsSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  elapsedMs: number;
  generationMs: number;
  tps: number;
}

/**
 * Aggregates token usage and timing for one streamed run.
 *
 * TPS is defined as `output tokens / assistant generation seconds`.
 * Tool execution time is excluded: only the message_start → message_end
 * intervals are counted as generation time.
 */
export class RunStats {
  readonly startedAt: number;
  private readonly now: () => number;
  private generationStartedAt: number | undefined;
  private generationMs = 0;

  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;

  constructor(now?: () => number) {
    this.now = now ?? (() => performance.now());
    this.startedAt = this.now();
  }

  startGeneration(): void {
    if (this.generationStartedAt === undefined) {
      this.generationStartedAt = this.now();
    }
  }

  endGeneration(usage?: UsageLike | null): void {
    if (this.generationStartedAt !== undefined) {
      this.generationMs += Math.max(0, this.now() - this.generationStartedAt);
      this.generationStartedAt = undefined;
    }
    if (usage) {
      this.input += toCount(usage.input);
      this.output += toCount(usage.output);
      this.cacheRead += toCount(usage.cacheRead);
      this.cacheWrite += toCount(usage.cacheWrite);
    }
  }

  /** Close an open generation interval without adding usage. */
  abortGeneration(): void {
    this.endGeneration(undefined);
  }

  snapshot(): StatsSnapshot {
    const elapsedMs = Math.max(0, this.now() - this.startedAt);
    return {
      input: this.input,
      output: this.output,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      elapsedMs,
      generationMs: this.generationMs,
      tps:
        this.generationMs > 0 ? this.output / (this.generationMs / 1000) : 0,
    };
  }
}
