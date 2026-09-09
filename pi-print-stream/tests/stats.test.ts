import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RunStats } from "../src/stats.ts";

function controlledClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("RunStats", () => {
  test("aggregates usage across multiple messages", () => {
    const clock = controlledClock();
    const stats = new RunStats(clock.now);
    stats.startGeneration();
    clock.advance(1000);
    stats.endGeneration({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
    stats.startGeneration();
    clock.advance(2000);
    stats.endGeneration({ input: 200, output: 150, cacheRead: 20, cacheWrite: 0 });

    const snapshot = stats.snapshot();
    assert.equal(snapshot.input, 300);
    assert.equal(snapshot.output, 200);
    assert.equal(snapshot.cacheRead, 30);
    assert.equal(snapshot.cacheWrite, 5);
    assert.equal(snapshot.generationMs, 3000);
    assert.equal(snapshot.elapsedMs, 3000);
  });

  test("TPS is output tokens divided by generation seconds", () => {
    const clock = controlledClock();
    const stats = new RunStats(clock.now);
    stats.startGeneration();
    clock.advance(2000);
    stats.endGeneration({ input: 0, output: 400, cacheRead: 0, cacheWrite: 0 });
    const snapshot = stats.snapshot();
    assert.equal(snapshot.tps, 200);
  });

  test("TPS is zero when no generation happened", () => {
    const stats = new RunStats(() => 0);
    const snapshot = stats.snapshot();
    assert.equal(snapshot.tps, 0);
  });

  test("tool execution time is excluded from generation", () => {
    const clock = controlledClock();
    const stats = new RunStats(clock.now);
    stats.startGeneration();
    clock.advance(100); // LLM work
    stats.endGeneration({ input: 10, output: 10, cacheRead: 0, cacheWrite: 0 });
    clock.advance(5000); // tool execution happens while no generation is open
    stats.startGeneration();
    clock.advance(100);
    stats.endGeneration({ input: 10, output: 10, cacheRead: 0, cacheWrite: 0 });

    const snapshot = stats.snapshot();
    assert.equal(snapshot.generationMs, 200);
    assert.equal(snapshot.elapsedMs, 5200);
    // 20 output tokens / 0.2s = 100 tok/s (tool time excluded).
    assert.equal(snapshot.tps, 100);
  });

  test("missing usage fields are treated as zero", () => {
    const clock = controlledClock();
    const stats = new RunStats(clock.now);
    stats.startGeneration();
    clock.advance(10);
    stats.endGeneration({});
    stats.startGeneration();
    clock.advance(10);
    stats.endGeneration(undefined);
    stats.startGeneration();
    clock.advance(10);
    stats.endGeneration(null);
    const snapshot = stats.snapshot();
    assert.equal(snapshot.input, 0);
    assert.equal(snapshot.output, 0);
    assert.equal(snapshot.generationMs, 30);
  });

  test("abortGeneration closes an open interval without usage", () => {
    const clock = controlledClock();
    const stats = new RunStats(clock.now);
    stats.startGeneration();
    clock.advance(250);
    stats.abortGeneration();
    const snapshot = stats.snapshot();
    assert.equal(snapshot.generationMs, 250);
    assert.equal(snapshot.output, 0);
  });
});
