import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MetricsTracker, STALL_THRESHOLD_MS, type AssistantMessageLike } from "../src/metrics.ts";

function controlledClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function assistant(input: number, output: number, costUsd?: number): AssistantMessageLike {
  return {
    role: "assistant",
    usage: { input, output, ...(costUsd === undefined ? {} : { cost: { total: costUsd } }) },
  };
}

/** Stream `updates` message updates `intervalMs` apart, then record one message. */
function streamTurn(
  tracker: MetricsTracker,
  clock: ReturnType<typeof controlledClock>,
  options: { updates: number; intervalMs: number; input: number; output: number },
): void {
  tracker.startMessage();
  for (let i = 0; i < options.updates; i += 1) {
    tracker.recordUpdate();
    if (i < options.updates - 1) clock.advance(options.intervalMs);
  }
  tracker.recordAssistantMessage(assistant(options.input, options.output));
}

describe("MetricsTracker", () => {
  test("single turn: elapsed, TTFT and TPS from the stream window", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    clock.advance(250);
    tracker.startTurn();
    clock.advance(500);
    streamTurn(tracker, clock, { updates: 5, intervalMs: 100, input: 1_200, output: 80 });
    tracker.endTurn();
    clock.advance(50);

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.elapsedMs, 1_200);
    assert.equal(metrics.ttftMs, 500);
    assert.equal(metrics.inputTokens, 1_200);
    assert.equal(metrics.outputTokens, 80);
    // 80 tokens over a 400ms window.
    assert.equal(metrics.tps, 200);
  });

  test("tokens are counted once, from the final message, not from updates", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    streamTurn(tracker, clock, { updates: 4, intervalMs: 100, input: 10, output: 20 });
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.inputTokens, 10);
    assert.equal(metrics.outputTokens, 20);
  });

  test("multi-turn run sums tokens and weights TPS by generation time", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();

    tracker.startTurn();
    streamTurn(tracker, clock, { updates: 51, intervalMs: 100, input: 100, output: 100 });
    tracker.endTurn();

    tracker.startTurn();
    streamTurn(tracker, clock, { updates: 101, intervalMs: 100, input: 200, output: 1_000 });
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.inputTokens, 300);
    assert.equal(metrics.outputTokens, 1_100);
    // 1100 tokens over 15s, not the 60 TPS a simple average would give.
    assert.equal(metrics.tps, 73.3);
  });

  test("TTFT is the first measurable turn's TTFT", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();

    tracker.startTurn();
    clock.advance(2_000);
    streamTurn(tracker, clock, { updates: 5, intervalMs: 100, input: 10, output: 10 });
    tracker.endTurn();

    clock.advance(1_000);
    tracker.startTurn();
    clock.advance(700);
    streamTurn(tracker, clock, { updates: 5, intervalMs: 100, input: 10, output: 10 });
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.ttftMs, 2_000);
  });

  test("stall time is excluded from TPS generation time", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();

    tracker.startMessage();
    for (let i = 0; i < 11; i += 1) {
      tracker.recordUpdate();
      if (i < 10) clock.advance(100);
    }
    // A 1s stall, longer than STALL_THRESHOLD_MS.
    clock.advance(1_000);
    for (let i = 0; i < 11; i += 1) {
      tracker.recordUpdate();
      if (i < 10) clock.advance(100);
    }
    tracker.recordAssistantMessage(assistant(0, 200));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    // 3s window minus the 1s stall: 200 tokens / 2s.
    assert.equal(metrics.tps, 100);
  });

  test("a gap at or below the stall threshold is kept", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    tracker.startMessage();
    tracker.recordUpdate();
    clock.advance(STALL_THRESHOLD_MS);
    tracker.recordUpdate();
    clock.advance(STALL_THRESHOLD_MS);
    tracker.recordUpdate();
    tracker.recordAssistantMessage(assistant(0, 200));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    // 1s window, no stall: 200 tokens / 1s.
    assert.equal(metrics.tps, 200);
  });

  test("a turn without a delta span is estimated from its duration", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    clock.advance(400);
    tracker.startMessage();
    tracker.recordUpdate();
    clock.advance(500);
    tracker.recordAssistantMessage(assistant(50, 7));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.ttftMs, 400);
    assert.equal(metrics.outputTokens, 7);
    // A single delta has no span: 7 tokens over the 900ms turn duration, flagged
    // as an estimate so it is rendered as approximate.
    assert.equal(metrics.tps, 7.8);
    assert.equal(metrics.tpsEstimated, true);
  });

  test("a message without deltas has no TTFT and an estimated TPS", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    clock.advance(300);
    tracker.startMessage();
    clock.advance(600);
    tracker.recordAssistantMessage(assistant(10, 60));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    // No delta, so TTFT is unknown; TPS is estimated over the 900ms turn duration.
    assert.equal(metrics.ttftMs, null);
    assert.equal(metrics.tps, 66.7);
    assert.equal(metrics.tpsEstimated, true);
  });

  test("a short stream yields measured TPS from its delta span", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    tracker.startMessage();
    tracker.recordUpdate();
    clock.advance(50);
    tracker.recordUpdate();
    tracker.recordAssistantMessage(assistant(0, 10));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    // 10 tokens over the 50ms between the two deltas, with no 200ms floor.
    assert.equal(metrics.tps, 200);
    assert.equal(metrics.tpsEstimated, false);
  });

  test("an instantaneous response without deltas reports no TPS", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    tracker.startMessage();
    tracker.recordAssistantMessage(assistant(10, 60));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    // start and end share a timestamp, so there is no duration to divide by.
    assert.equal(metrics.tps, null);
  });

  test("a turn with no output reports no TPS", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    tracker.startMessage();
    clock.advance(500);
    tracker.recordAssistantMessage(assistant(10, 0));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.tps, null);
  });

  test("a turn with a same-timestamp message uses the turn duration estimate", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    clock.advance(700);
    tracker.startMessage();
    tracker.recordAssistantMessage(assistant(10, 70));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    // message_start and message_end share a timestamp; the turn's 700ms duration
    // is the only denominator, and no delta means TTFT is unknown.
    assert.equal(metrics.ttftMs, null);
    assert.equal(metrics.tps, 100);
    assert.equal(metrics.tpsEstimated, true);
  });

  test("a mixed run aggregates measured and estimated turns", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });
    tracker.startRun();

    // Measured turn: two deltas 400ms apart, 100 tokens.
    tracker.startTurn();
    tracker.startMessage();
    tracker.recordUpdate();
    clock.advance(400);
    tracker.recordUpdate();
    tracker.recordAssistantMessage(assistant(0, 100));
    tracker.endTurn();

    // Estimated turn: one delta, 500ms turn duration, 50 tokens.
    tracker.startTurn();
    tracker.startMessage();
    tracker.recordUpdate();
    clock.advance(500);
    tracker.recordAssistantMessage(assistant(0, 50));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    // (100 + 50) tokens over (400ms + 500ms).
    assert.equal(metrics.tps, 166.7);
    assert.equal(metrics.tpsEstimated, true);
  });

  test("a turn with missing usage reports no TPS", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    tracker.startMessage();
    tracker.recordUpdate();
    clock.advance(300);
    tracker.recordAssistantMessage({ role: "assistant" });
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.tps, null);
  });

  test("a turn whose gaps are all stalls falls back to the turn duration", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    tracker.startMessage();
    tracker.recordUpdate();
    clock.advance(1_000);
    tracker.recordUpdate();
    clock.advance(1_000);
    tracker.recordUpdate();
    tracker.recordAssistantMessage(assistant(0, 100));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    // Both 1s gaps are stalls, so the delta span collapses to 0; the 2s turn
    // duration is used instead.
    assert.equal(metrics.tps, 50);
    assert.equal(metrics.tpsEstimated, true);
  });

  test("a burst after a long silence is reported as an estimate", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    clock.advance(11_000);
    tracker.startMessage();
    tracker.recordUpdate();
    clock.advance(61);
    tracker.recordUpdate();
    tracker.recordAssistantMessage(assistant(0, 198));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    // 198 tokens over 61ms would be ~3246 tok/s, but the 11s silence dominates:
    // the 11.061s turn duration is used as an estimate instead.
    assert.equal(metrics.tpsEstimated, true);
    assert.equal(metrics.tps, 17.9);
  });

  test("flushing an aborted turn keeps the collected metrics and resets", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    streamTurn(tracker, clock, { updates: 5, intervalMs: 100, input: 4_100, output: 322 });
    // No endTurn: the run is aborted mid-turn. The 400ms stream plus this
    // 800ms tail is the elapsed time.
    clock.advance(800);

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.inputTokens, 4_100);
    assert.equal(metrics.outputTokens, 322);
    assert.equal(metrics.elapsedMs, 1_200);
  });

  test("a finished run does not leak into the next run", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    streamTurn(tracker, clock, { updates: 5, intervalMs: 100, input: 999, output: 999 });
    tracker.endTurn();
    tracker.finish();

    tracker.startRun();
    tracker.startTurn();
    streamTurn(tracker, clock, { updates: 5, intervalMs: 100, input: 3, output: 5 });
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.inputTokens, 3);
    assert.equal(metrics.outputTokens, 5);
  });

  test("startRun is idempotent while a run is in progress", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    clock.advance(500);
    tracker.startRun();
    tracker.startTurn();
    streamTurn(tracker, clock, { updates: 5, intervalMs: 100, input: 1, output: 1 });
    tracker.endTurn();
    clock.advance(500);

    // The run started at 0, not at the ignored second startRun (500).
    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.elapsedMs, 1_400);
  });

  test("only a measurable message counts toward TPS within a turn", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();

    tracker.startMessage();
    for (let i = 0; i < 5; i += 1) {
      tracker.recordUpdate();
      if (i < 4) clock.advance(100);
    }
    tracker.recordAssistantMessage(assistant(0, 100));

    // A second message with too few updates to be measurable.
    tracker.startMessage();
    tracker.recordUpdate();
    tracker.recordAssistantMessage(assistant(0, 1_000));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.outputTokens, 1_100);
    // Only the measurable 100-token window: 100 / 0.4s, not 1100 / 0.4s.
    assert.equal(metrics.tps, 250);
  });

  test("a retry wait between messages is not generation time", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();

    tracker.startMessage();
    for (let i = 0; i < 5; i += 1) {
      tracker.recordUpdate();
      if (i < 4) clock.advance(100);
    }
    tracker.recordAssistantMessage(assistant(0, 100));

    // The retry wait sits between two message windows, not inside one.
    clock.advance(2_000);

    tracker.startMessage();
    for (let i = 0; i < 5; i += 1) {
      tracker.recordUpdate();
      if (i < 4) clock.advance(100);
    }
    tracker.recordAssistantMessage(assistant(0, 100));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    // Two 400ms windows; 200 tokens / 0.8s, with the 2s wait excluded.
    assert.equal(metrics.tps, 250);
  });

  test("TTFT is kept when the assistant message has no usage", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    clock.advance(300);
    tracker.startMessage();
    tracker.recordUpdate();
    tracker.recordAssistantMessage({ role: "assistant" });
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.ttftMs, 300);
    assert.equal(metrics.outputTokens, 0);
    assert.equal(metrics.tps, null);
  });

  test("finish without a started run returns null", () => {
    const tracker = new MetricsTracker({ now: () => 0 });
    assert.equal(tracker.finish(), null);
  });

  test("a started run with no completed turn still reports zero tokens", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });
    tracker.startRun();
    clock.advance(300);

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.elapsedMs, 300);
    assert.equal(metrics.inputTokens, 0);
    assert.equal(metrics.outputTokens, 0);
    assert.equal(metrics.tps, null);
    assert.equal(metrics.ttftMs, null);
  });

  test("startTurn folds a previous turn that never ended", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    streamTurn(tracker, clock, { updates: 5, intervalMs: 100, input: 100, output: 100 });
    // No endTurn: the next startTurn must fold the unfinished turn.
    tracker.startTurn();
    streamTurn(tracker, clock, { updates: 5, intervalMs: 100, input: 200, output: 900 });
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.inputTokens, 300);
    assert.equal(metrics.outputTokens, 1_000);
    // 1000 tokens over 800ms; dropping the first turn would report 900/0.4s.
    assert.equal(metrics.tps, 1_250);
  });

  test("cost is summed over every finalized assistant message", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    tracker.startMessage();
    tracker.recordAssistantMessage(assistant(0, 100, 0.25));
    // A second message in the same turn, as a retry produces.
    tracker.startMessage();
    tracker.recordAssistantMessage(assistant(0, 100, 0.5));
    tracker.endTurn();

    tracker.startTurn();
    tracker.startMessage();
    tracker.recordAssistantMessage(assistant(0, 100, 1.25));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.costUsd, 2);
  });

  test("a run without reported cost stays at zero", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    streamTurn(tracker, clock, { updates: 5, intervalMs: 100, input: 10, output: 10 });
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.costUsd, 0);
  });

  test("a finished run does not leak its cost into the next run", () => {
    const clock = controlledClock();
    const tracker = new MetricsTracker({ now: clock.now });

    tracker.startRun();
    tracker.startTurn();
    tracker.startMessage();
    tracker.recordAssistantMessage(assistant(0, 100, 3.5));
    tracker.endTurn();
    tracker.finish();

    tracker.startRun();
    tracker.startTurn();
    tracker.startMessage();
    tracker.recordAssistantMessage(assistant(0, 100, 0.5));
    tracker.endTurn();

    const metrics = tracker.finish();
    assert.ok(metrics);
    assert.equal(metrics.costUsd, 0.5);
  });
});
