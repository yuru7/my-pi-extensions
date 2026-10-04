import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMetrics } from "../extensions/index.ts";
import { DEFAULT_FORMAT } from "../src/config.ts";

type Mode = ExtensionContext["mode"];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface FakePi {
  on(event: string, handler: Handler): () => void;
  emit(event: string, payload: unknown, ctx: ExtensionContext): void;
}

function createFakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  return {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    emit(event, payload, ctx) {
      for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
    },
  };
}

interface RecordedNotification {
  message: string;
  type?: string;
}

function createFakeCtx(mode: Mode = "tui") {
  const notifications: RecordedNotification[] = [];
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications };
}

function controlledClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function assistantMessage(input: number, output: number, costUsd?: number) {
  return {
    role: "assistant",
    usage: { input, output, ...(costUsd === undefined ? {} : { cost: { total: costUsd } }) },
  };
}

function setup(mode: Mode = "tui", format = DEFAULT_FORMAT) {
  const clock = controlledClock();
  const { ctx, notifications } = createFakeCtx(mode);
  const pi = createFakePi();
  registerMetrics(pi as unknown as ExtensionAPI, {
    now: clock.now,
    loadConfig: () => ({ config: { format } }),
  });
  return { clock, ctx, notifications, pi };
}

/** Emit one assistant turn: optional TTFT delay, then `updates` streamed updates. */
function emitTurn(
  pi: FakePi,
  ctx: ExtensionContext,
  clock: ReturnType<typeof controlledClock>,
  options: {
    ttftMs: number;
    updates: number;
    intervalMs: number;
    input: number;
    output: number;
    costUsd?: number;
  },
): void {
  if (options.ttftMs > 0) clock.advance(options.ttftMs);
  const message = assistantMessage(options.input, options.output, options.costUsd);
  pi.emit("message_start", { message }, ctx);
  for (let i = 0; i < options.updates; i += 1) {
    pi.emit(
      "message_update",
      { message, assistantMessageEvent: { type: "text_delta", delta: "x" } },
      ctx,
    );
    if (i < options.updates - 1) clock.advance(options.intervalMs);
  }
  pi.emit("message_end", { message }, ctx);
}

describe("pi-metrics extension", () => {
  test("single turn renders exactly one dim info line at agent_settled", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("session_start", {}, ctx);
    pi.emit("input", { source: "interactive", text: "hi" }, ctx);
    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", { turnIndex: 0, timestamp: 0 }, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 500, updates: 5, intervalMs: 100, input: 1_200, output: 80 });
    pi.emit("turn_end", { turnIndex: 0 }, ctx);
    clock.advance(100);
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.type, "info");
    assert.equal(
      notifications[0]?.message,
      "Worked for 1.0s · TPS 200.0 tok/s · TTFT 0.5s · in 1.2K · out 80",
    );
  });

  test("a multi-turn tool loop renders nothing until it settles, then one summed line", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("input", { source: "interactive", text: "go" }, ctx);
    pi.emit("agent_start", {}, ctx);

    pi.emit("turn_start", { turnIndex: 0, timestamp: 0 }, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 0, updates: 5, intervalMs: 100, input: 1_000, output: 100 });
    pi.emit("turn_end", { turnIndex: 0 }, ctx);
    assert.equal(notifications.length, 0);

    clock.advance(2_000); // tool execution
    pi.emit("turn_start", { turnIndex: 1, timestamp: 0 }, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 0, updates: 5, intervalMs: 100, input: 1_000, output: 900 });
    pi.emit("turn_end", { turnIndex: 1 }, ctx);
    assert.equal(notifications.length, 0);

    pi.emit("agent_settled", {}, ctx);
    assert.equal(notifications.length, 1);
    // 1000 tokens over both 400ms windows → 1250 TPS; tokens are summed.
    assert.equal(
      notifications[0]?.message,
      "Worked for 2.8s · TPS 1250.0 tok/s · TTFT 0.0s · in 2K · out 1K",
    );
  });

  test("TTFT is taken from the first turn, not the last", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("input", { source: "interactive", text: "go" }, ctx);
    pi.emit("agent_start", {}, ctx);

    pi.emit("turn_start", { turnIndex: 0, timestamp: 0 }, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 2_000, updates: 5, intervalMs: 100, input: 10, output: 10 });
    pi.emit("turn_end", { turnIndex: 0 }, ctx);

    clock.advance(1_000);
    pi.emit("turn_start", { turnIndex: 1, timestamp: 0 }, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 700, updates: 5, intervalMs: 100, input: 10, output: 10 });
    pi.emit("turn_end", { turnIndex: 1 }, ctx);

    pi.emit("agent_settled", {}, ctx);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]?.message ?? "", /TTFT 2\.0s/);
  });

  test("an aborted run still reports what it collected and resets", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("input", { source: "interactive", text: "go" }, ctx);
    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", { turnIndex: 0, timestamp: 0 }, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 1_200, updates: 3, intervalMs: 100, input: 4_100, output: 322 });
    clock.advance(200);
    // No turn_end: Esc aborted the turn.
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
    assert.match(notifications[0]?.message ?? "", /in 4\.1K · out 322$/);

    // The next run must not inherit the aborted run's tokens.
    pi.emit("input", { source: "interactive", text: "again" }, ctx);
    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", { turnIndex: 0, timestamp: 0 }, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 0, updates: 1, intervalMs: 0, input: 5, output: 4 });
    pi.emit("turn_end", { turnIndex: 0 }, ctx);
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 2);
    assert.match(notifications[1]?.message ?? "", /TPS n\/a tok\/s .* in 5 · out 4$/);
  });

  test("a stray agent_settled without a run renders nothing", () => {
    const { ctx, notifications, pi } = setup("tui");
    pi.emit("agent_settled", {}, ctx);
    assert.equal(notifications.length, 0);
  });

  test("non-TUI modes render nothing but keep no leftover state", () => {
    for (const mode of ["rpc", "json", "print"] as const) {
      const { clock, ctx, notifications, pi } = setup(mode);

      pi.emit("input", { source: "interactive", text: "go" }, ctx);
      pi.emit("agent_start", {}, ctx);
      pi.emit("turn_start", { turnIndex: 0, timestamp: 0 }, ctx);
      emitTurn(pi, ctx, clock, { ttftMs: 0, updates: 5, intervalMs: 100, input: 10, output: 10 });
      pi.emit("turn_end", { turnIndex: 0 }, ctx);
      pi.emit("agent_settled", {}, ctx);

      assert.equal(notifications.length, 0, `mode ${mode} should not render`);
    }
  });

  test("session_shutdown clears an in-progress run", () => {
    const { clock, ctx, notifications, pi } = setup("tui");
    pi.emit("session_start", {}, ctx);
    pi.emit("input", { source: "interactive", text: "go" }, ctx);
    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", { turnIndex: 0, timestamp: 0 }, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 0, updates: 5, intervalMs: 100, input: 10, output: 10 });
    pi.emit("turn_end", { turnIndex: 0 }, ctx);

    pi.emit("session_shutdown", {}, ctx);
    pi.emit("agent_settled", {}, ctx);
    assert.equal(notifications.length, 0);
  });

  test("an early abort before any turn renders zeros once", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("input", { source: "interactive", text: "go" }, ctx);
    pi.emit("agent_start", {}, ctx);
    clock.advance(300);
    // Aborted before any turn started.
    pi.emit("agent_settled", {}, ctx);
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
    assert.equal(
      notifications[0]?.message,
      "Worked for 0.3s · TPS n/a tok/s · TTFT n/a · in 0 · out 0",
    );
  });

  test("duplicate agent_settled renders only once", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("input", { source: "interactive", text: "go" }, ctx);
    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", { turnIndex: 0, timestamp: 0 }, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 0, updates: 5, intervalMs: 100, input: 10, output: 10 });
    pi.emit("turn_end", { turnIndex: 0 }, ctx);

    pi.emit("agent_settled", {}, ctx);
    pi.emit("agent_settled", {}, ctx);
    assert.equal(notifications.length, 1);
  });

  test("agent_start without an input event still starts a run", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", { turnIndex: 0, timestamp: 0 }, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 0, updates: 5, intervalMs: 100, input: 10, output: 10 });
    pi.emit("turn_end", { turnIndex: 0 }, ctx);
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
  });

  test("session_start clears an in-progress run", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("input", { source: "interactive", text: "go" }, ctx);
    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", { turnIndex: 0, timestamp: 0 }, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 0, updates: 5, intervalMs: 100, input: 10, output: 10 });
    pi.emit("turn_end", { turnIndex: 0 }, ctx);

    pi.emit("session_start", {}, ctx);
    pi.emit("agent_settled", {}, ctx);
    assert.equal(notifications.length, 0);
  });

  test("a non-TUI run does not leak into the next TUI run", () => {
    const clock = controlledClock();
    const rpc = createFakeCtx("rpc");
    const tui = createFakeCtx("tui");
    const pi = createFakePi();
    registerMetrics(pi as unknown as ExtensionAPI, {
      now: clock.now,
      loadConfig: () => ({ config: { format: DEFAULT_FORMAT } }),
    });

    pi.emit("input", { source: "interactive", text: "first" }, rpc.ctx);
    pi.emit("agent_start", {}, rpc.ctx);
    pi.emit("turn_start", { turnIndex: 0, timestamp: 0 }, rpc.ctx);
    emitTurn(pi, rpc.ctx, clock, { ttftMs: 0, updates: 5, intervalMs: 100, input: 999, output: 999 });
    pi.emit("turn_end", { turnIndex: 0 }, rpc.ctx);
    pi.emit("agent_settled", {}, rpc.ctx);
    assert.equal(rpc.notifications.length, 0);

    pi.emit("input", { source: "interactive", text: "second" }, tui.ctx);
    pi.emit("agent_start", {}, tui.ctx);
    pi.emit("turn_start", { turnIndex: 0, timestamp: 0 }, tui.ctx);
    emitTurn(pi, tui.ctx, clock, { ttftMs: 0, updates: 5, intervalMs: 100, input: 7, output: 9 });
    pi.emit("turn_end", { turnIndex: 0 }, tui.ctx);
    pi.emit("agent_settled", {}, tui.ctx);

    assert.equal(tui.notifications.length, 1);
    assert.match(tui.notifications[0]?.message ?? "", /in 7 · out 9$/);
  });

  test("empty stream lifecycle events do not count as tokens", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", {}, ctx);

    const message = assistantMessage(1, 200);
    pi.emit("message_start", { message }, ctx);
    // Block start/end events are forwarded as message_update but carry no token.
    pi.emit("message_update", { message, assistantMessageEvent: { type: "text_start" } }, ctx);
    clock.advance(500);
    pi.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "a" } }, ctx);
    clock.advance(300);
    pi.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "b" } }, ctx);
    // The trailing end event is only 300ms after the last delta, below the stall
    // threshold, so counting it would visibly drop TPS.
    clock.advance(300);
    pi.emit("message_update", { message, assistantMessageEvent: { type: "text_end" } }, ctx);
    pi.emit("message_end", { message }, ctx);
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
    // TTFT is the first delta (0.5s) and 200 tokens span the 300ms between
    // deltas; counting text_end would widen the window to 600ms (TPS 333.3).
    assert.equal(
      notifications[0]?.message,
      "Worked for 1.1s · TPS 666.7 tok/s · TTFT 0.5s · in 1 · out 200",
    );
  });

  test("thinking and toolcall deltas count as generation", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", {}, ctx);

    const message = assistantMessage(1, 100);
    pi.emit("message_start", { message }, ctx);
    pi.emit("message_update", { message, assistantMessageEvent: { type: "thinking_start" } }, ctx);
    pi.emit("message_update", { message, assistantMessageEvent: { type: "thinking_delta", delta: "t" } }, ctx);
    clock.advance(300);
    pi.emit("message_update", { message, assistantMessageEvent: { type: "toolcall_start" } }, ctx);
    pi.emit("message_update", { message, assistantMessageEvent: { type: "toolcall_delta", delta: "{" } }, ctx);
    pi.emit("message_update", { message, assistantMessageEvent: { type: "toolcall_end" } }, ctx);
    pi.emit("message_end", { message }, ctx);
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
    // 100 tokens over the 300ms between the thinking and toolcall deltas.
    assert.match(notifications[0]?.message ?? "", /TPS 333\.3 tok\/s/);
  });

  test("empty deltas do not count as tokens", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", {}, ctx);

    const message = assistantMessage(1, 200);
    pi.emit("message_start", { message }, ctx);
    // An empty delta carries no token and must not fix TTFT.
    pi.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "" } }, ctx);
    clock.advance(500);
    pi.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "a" } }, ctx);
    clock.advance(300);
    pi.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "b" } }, ctx);
    pi.emit("message_end", { message }, ctx);
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
    // TTFT is the first non-empty delta (0.5s); 200 tokens span the 300ms between deltas.
    assert.equal(
      notifications[0]?.message,
      "Worked for 0.8s · TPS 666.7 tok/s · TTFT 0.5s · in 1 · out 200",
    );
  });

  test("a single-delta turn reports an estimated TPS instead of n/a", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", {}, ctx);

    const message = assistantMessage(1, 100);
    pi.emit("message_start", { message }, ctx);
    clock.advance(200);
    pi.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "a" } }, ctx);
    clock.advance(300);
    pi.emit("message_end", { message }, ctx);
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
    // One delta has no span, so TPS is an estimate over the 500ms turn duration,
    // marked with `≈` (100 / 0.5s).
    assert.equal(
      notifications[0]?.message,
      "Worked for 0.5s · TPS ≈200.0 tok/s · TTFT 0.2s · in 1 · out 100",
    );
  });

  test("an input that never starts a run leaves no timer behind", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("input", {}, ctx);
    clock.advance(10_000);
    // A run starts without a new input, as an extension-injected message does.
    pi.emit("agent_start", {}, ctx);
    clock.advance(100);
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
    // Elapsed is measured from agent_start, so the rejected input adds nothing.
    assert.equal(
      notifications[0]?.message,
      "Worked for 0.1s · TPS n/a tok/s · TTFT n/a · in 0 · out 0",
    );
  });

  test("turns are summed even without a turn_end event", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("input", {}, ctx);
    pi.emit("agent_start", {}, ctx);

    pi.emit("turn_start", {}, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 0, updates: 5, intervalMs: 100, input: 1_000, output: 100 });
    // No turn_end: the next turn_start (then agent_settled) folds the turn.

    clock.advance(2_000);
    pi.emit("turn_start", {}, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 0, updates: 5, intervalMs: 100, input: 1_000, output: 900 });
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
    assert.match(notifications[0]?.message ?? "", /in 2K · out 1K$/);
  });

  test("a custom format is rendered with the metrics values", () => {
    const clock = controlledClock();
    const { ctx, notifications } = createFakeCtx("tui");
    const pi = createFakePi();
    registerMetrics(pi as unknown as ExtensionAPI, {
      now: clock.now,
      loadConfig: () => ({ config: { format: "{elapsed} | {input} → {output} | {tps} tok/s" } }),
    });

    pi.emit("input", { source: "interactive", text: "go" }, ctx);
    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", { turnIndex: 0, timestamp: 0 }, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 0, updates: 11, intervalMs: 100, input: 8_100, output: 1_300 });
    pi.emit("turn_end", { turnIndex: 0 }, ctx);
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.message, "1.0s | 8.1K → 1.3K | 1300.0 tok/s");
  });

  test("a reported cost is appended to the metrics line", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", {}, ctx);
    emitTurn(pi, ctx, clock, {
      ttftMs: 500,
      updates: 5,
      intervalMs: 100,
      input: 1_200,
      output: 80,
      costUsd: 1.234567,
    });
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
    assert.equal(
      notifications[0]?.message,
      "Worked for 0.9s · TPS 200.0 tok/s · TTFT 0.5s · in 1.2K · out 80 · cost $1.234567",
    );
  });

  test("a run without a reported cost has no cost segment", () => {
    const { clock, ctx, notifications, pi } = setup("tui");

    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", {}, ctx);
    emitTurn(pi, ctx, clock, { ttftMs: 500, updates: 5, intervalMs: 100, input: 1_200, output: 80 });
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
    assert.equal(
      notifications[0]?.message,
      "Worked for 0.9s · TPS 200.0 tok/s · TTFT 0.5s · in 1.2K · out 80",
    );
  });

  test("a cost is appended after a custom format too", () => {
    const { clock, ctx, notifications, pi } = setup("tui", "{elapsed} | in {input}");

    pi.emit("agent_start", {}, ctx);
    pi.emit("turn_start", {}, ctx);
    emitTurn(pi, ctx, clock, {
      ttftMs: 0,
      updates: 5,
      intervalMs: 100,
      input: 1_200,
      output: 80,
      costUsd: 0.5,
    });
    pi.emit("agent_settled", {}, ctx);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.message, "0.4s | in 1.2K · cost $0.500000");
  });

  test("a configuration warning is surfaced once", () => {
    const clock = controlledClock();
    const { ctx, notifications } = createFakeCtx("tui");
    const pi = createFakePi();
    registerMetrics(pi as unknown as ExtensionAPI, {
      now: clock.now,
      loadConfig: () => ({ config: { format: DEFAULT_FORMAT }, warning: "pi-metrics: bad config" }),
    });

    pi.emit("session_start", {}, ctx);
    pi.emit("session_start", {}, ctx);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.type, "warning");
    assert.equal(notifications[0]?.message, "pi-metrics: bad config");
  });
});
