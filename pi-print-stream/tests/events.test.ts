import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseJsonLine, StreamProcessor } from "../src/events.ts";
import { Renderer } from "../src/renderer.ts";
import { RunStats } from "../src/stats.ts";

function createHarness(now?: () => number) {
  const chunks: string[] = [];
  const stdout = {
    isTTY: false,
    columns: 80,
    write: (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    },
    on: () => stdout,
    off: () => stdout,
  } as unknown as NodeJS.WriteStream;
  const renderer = new Renderer({ isTTY: false, stdout });
  const stats = new RunStats(now ?? (() => 0));
  const processor = new StreamProcessor(renderer, stats, now ? { now } : {});
  return { chunks, renderer, stats, processor };
}

describe("parseJsonLine", () => {
  test("parses valid JSON", () => {
    const parsed = parseJsonLine('{"type":"agent_start"}');
    assert.equal(parsed.ok, true);
  });

  test("reports malformed JSON without throwing", () => {
    const parsed = parseJsonLine("{not json");
    assert.equal(parsed.ok, false);
  });
});

describe("StreamProcessor", () => {
  test("text deltas are written in order", () => {
    const harness = createHarness();
    harness.processor.handle({ type: "message_start", message: { role: "assistant" } });
    harness.processor.handle({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello " },
    });
    harness.processor.handle({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "world" },
    });
    assert.equal(harness.chunks.join(""), "hello world");
  });

  test("thinking deltas go through the renderer, text ends the session", () => {
    const chunks: string[] = [];
    const stdout = {
      isTTY: true,
      columns: 80,
      write: (chunk: string) => {
        chunks.push(String(chunk));
        return true;
      },
      on: () => stdout,
      off: () => stdout,
    } as unknown as NodeJS.WriteStream;
    const renderer = new Renderer({ isTTY: true, stdout, columns: () => 80 });
    const stats = new RunStats(() => 0);
    const processor = new StreamProcessor(renderer, stats);
    processor.handle({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    });
    assert.equal(renderer.isThinkingActive(), true);
    processor.handle({
      type: "message_update",
      // Markdown streams line by line: terminate the line to flush it.
      assistantMessageEvent: { type: "text_delta", delta: "answer\n" },
    });
    assert.equal(renderer.isThinkingActive(), false);
    assert.ok(chunks.join("").includes("answer"));
  });

  test("tool start/end emit JSONL with elapsed time", () => {
    let now = 1000;
    const harness = createHarness(() => now);
    harness.processor.handle({
      type: "tool_execution_start",
      toolCallId: "tool_1",
      toolName: "read",
      args: { path: "src/index.ts" },
    });
    now += 42;
    harness.processor.handle({
      type: "tool_execution_end",
      toolCallId: "tool_1",
      toolName: "read",
      result: {},
      isError: false,
    });
    const lines = harness.chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].type, "tool_start");
    assert.equal(lines[0].id, "tool_1");
    assert.equal(lines[0].name, "read");
    assert.deepEqual(lines[0].args, { path: "src/index.ts" });
    assert.equal(lines[1].type, "tool_end");
    assert.equal(lines[1].status, "success");
    assert.equal(lines[1].elapsed_ms, 42);
  });

  test("parallel tool calls track elapsed time independently", () => {
    let now = 0;
    const harness = createHarness(() => now);
    harness.processor.handle({
      type: "tool_execution_start",
      toolCallId: "a",
      toolName: "bash",
      args: {},
    });
    now = 100;
    harness.processor.handle({
      type: "tool_execution_start",
      toolCallId: "b",
      toolName: "read",
      args: {},
    });
    now = 150;
    harness.processor.handle({
      type: "tool_execution_end",
      toolCallId: "a",
      toolName: "bash",
      result: {},
      isError: true,
    });
    now = 300;
    harness.processor.handle({
      type: "tool_execution_end",
      toolCallId: "b",
      toolName: "read",
      result: {},
      isError: false,
    });
    const lines = harness.chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
    const endA = lines.find((line) => line.id === "a" && line.type === "tool_end");
    const endB = lines.find((line) => line.id === "b" && line.type === "tool_end");
    assert.equal(endA.elapsed_ms, 150);
    assert.equal(endA.status, "error");
    assert.equal(endB.elapsed_ms, 200);
  });

  test("message_end aggregates usage once per assistant message", () => {
    const harness = createHarness();
    harness.processor.handle({ type: "message_start", message: { role: "assistant" } });
    harness.processor.handle({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
        stopReason: "stop",
      },
    });
    harness.processor.handle({ type: "message_start", message: { role: "assistant" } });
    harness.processor.handle({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 20, output: 7, cacheRead: 3, cacheWrite: 0 },
        stopReason: "toolUse",
      },
    });
    const snapshot = harness.stats.snapshot();
    assert.equal(snapshot.input, 30);
    assert.equal(snapshot.output, 12);
    assert.equal(snapshot.cacheRead, 5);
    assert.equal(snapshot.cacheWrite, 1);
    assert.equal(harness.processor.hasError(), false);
  });

  test("assistant error is detected", () => {
    const harness = createHarness();
    harness.processor.handle({
      type: "message_end",
      message: { role: "assistant", usage: {}, stopReason: "error" },
    });
    assert.equal(harness.processor.hasError(), true);
  });

  test("unknown and malformed events are ignored", () => {
    const harness = createHarness();
    harness.processor.handle({ type: "definitely_unknown_future_event" });
    harness.processor.handle(null);
    harness.processor.handle("string");
    harness.processor.handle({ type: "message_update" });
    harness.processor.handle({
      type: "message_update",
      assistantMessageEvent: { type: "future_delta", delta: "x" },
    });
    assert.equal(harness.chunks.join(""), "");
  });
});
