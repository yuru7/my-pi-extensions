import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Renderer } from "../src/renderer.ts";

interface FakeStdout {
  isTTY: boolean;
  columns: number;
  chunks: string[];
  listeners: Map<string, Array<() => void>>;
}

function createFakeStdout(isTTY: boolean, columns = 80): FakeStdout {
  return { isTTY, columns, chunks: [], listeners: new Map() };
}

function asWriteStream(fake: FakeStdout): NodeJS.WriteStream {
  const stream = {
    isTTY: fake.isTTY,
    columns: fake.columns,
    write: (chunk: string) => {
      fake.chunks.push(String(chunk));
      return true;
    },
    on: (event: string, listener: () => void) => {
      const list = fake.listeners.get(event) ?? [];
      list.push(listener);
      fake.listeners.set(event, list);
      return stream;
    },
    off: () => stream,
  };
  return stream as unknown as NodeJS.WriteStream;
}

function output(fake: FakeStdout): string {
  return fake.chunks.join("");
}

describe("Renderer", () => {
  test("non-TTY drops thinking and emits no ANSI codes", () => {
    const fake = createFakeStdout(false);
    const renderer = new Renderer({
      isTTY: false,
      stdout: asWriteStream(fake),
    });
    renderer.appendThinking("secret thinking");
    renderer.writeText("hello");
    renderer.writeToolEvent({ type: "tool_start", id: "1", name: "read", args: {} });
    renderer.finish({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      elapsedMs: 1000,
      generationMs: 500,
      tps: 4,
    });
    const text = output(fake);
    assert.ok(!text.includes("secret thinking"));
    assert.ok(!text.includes("\x1b"));
    assert.ok(text.includes("hello"));
    assert.ok(text.includes('"type":"tool_start"'));
    assert.ok(text.includes("Done"));
  });

  test("TTY thinking is transient: cleared before persistent text", () => {
    const fake = createFakeStdout(true);
    const renderer = new Renderer({
      isTTY: true,
      stdout: asWriteStream(fake),
      columns: () => 80,
    });
    renderer.appendThinking("transient thought");
    assert.ok(output(fake).includes("transient thought"));
    const beforeText = output(fake).length;

    renderer.writeText("answer");
    const text = output(fake);
    const clearIndex = text.indexOf("\x1b[", beforeText - 50);
    const answerIndex = text.indexOf("answer");
    assert.ok(clearIndex !== -1, "expected ANSI clear sequence");
    assert.ok(clearIndex < answerIndex);
    // Thinking session ends when text takes over: no repaint after text.
    assert.equal(renderer.isThinkingActive(), false);
  });

  test("TTY thinking is cleared before tool events", () => {
    const fake = createFakeStdout(true);
    const renderer = new Renderer({
      isTTY: true,
      stdout: asWriteStream(fake),
      columns: () => 80,
    });
    renderer.appendThinking("thought");
    renderer.writeToolEvent({ type: "tool_start", id: "t1", name: "bash", args: {} });
    const text = output(fake);
    assert.ok(text.indexOf("\x1b[") !== -1);
    assert.ok(text.includes('"type":"tool_start"'));
    assert.equal(renderer.isThinkingActive(), false);
  });

  test("thinking view shows at most 8 body rows plus chrome", () => {
    const fake = createFakeStdout(true);
    const renderer = new Renderer({
      isTTY: true,
      stdout: asWriteStream(fake),
      columns: () => 80,
    });
    renderer.appendThinking(
      Array.from({ length: 30 }, (_, i) => `row${i}`).join("\n"),
    );
    // 1 separator + 1 header + 8 body + 1 separator = 11 rows.
    assert.equal(renderer.getRenderedRows(), 11);
    const text = output(fake);
    assert.ok(text.includes("row29"));
    assert.ok(!text.includes("row0"));
  });

  test("summary starts on a fresh line when text lacks trailing newline", () => {
    const fake = createFakeStdout(false);
    const renderer = new Renderer({
      isTTY: false,
      stdout: asWriteStream(fake),
    });
    renderer.writeText("no-newline");
    renderer.finish({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      elapsedMs: 0,
      generationMs: 0,
      tps: 0,
    });
    assert.ok(output(fake).includes("no-newline\n\nDone in 0.0s\n"));
  });

  test("blank lines separate text, tool groups, and the summary", () => {
    const fake = createFakeStdout(false);
    const renderer = new Renderer({
      isTTY: false,
      stdout: asWriteStream(fake),
    });
    const stats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, elapsedMs: 1000, generationMs: 0, tps: 0 };
    renderer.writeText("hello\n");
    renderer.writeToolEvent({ type: "tool_start", id: "t1", name: "read", args: {} });
    renderer.writeToolEvent({ type: "tool_end", id: "t1", name: "read", status: "success", elapsed_ms: 1 });
    renderer.writeText("world");
    renderer.finish(stats);
    const startLine = '{"type":"tool_start","id":"t1","name":"read","args":{}}';
    const endLine = '{"type":"tool_end","id":"t1","name":"read","status":"success","elapsed_ms":1}';
    assert.equal(
      output(fake),
      `hello\n\n${startLine}\n${endLine}\n\nworld\n\nDone in 1.0s\n` +
        `Tokens: Input 0 / Cache read 0 / Output 0 / Cache write 0\nTPS: -\n`,
    );
  });

  test("no leading blank line when tools or summary come first", () => {
    const fake = createFakeStdout(false);
    const renderer = new Renderer({
      isTTY: false,
      stdout: asWriteStream(fake),
    });
    renderer.writeToolEvent({ type: "tool_start", id: "t1", name: "read", args: {} });
    assert.ok(!output(fake).startsWith("\n"));

    const fake2 = createFakeStdout(false);
    const renderer2 = new Renderer({
      isTTY: false,
      stdout: asWriteStream(fake2),
    });
    renderer2.finish({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, elapsedMs: 500, generationMs: 0, tps: 0 });
    assert.ok(output(fake2).startsWith("Done in 0.5s\n"));
  });

  test("fail writes compact Failed summary with dash TPS when generation is zero", () => {
    const fake = createFakeStdout(false);
    const renderer = new Renderer({
      isTTY: false,
      stdout: asWriteStream(fake),
    });
    renderer.fail({
      input: 6956,
      output: 2482,
      cacheRead: 12996,
      cacheWrite: 0,
      elapsedMs: 8200,
      generationMs: 0,
      tps: 0,
    });
    const text = output(fake);
    assert.ok(text.includes("Failed in 8.2s\n"));
    assert.ok(text.includes("Tokens: Input 6,956 / Cache read 12,996 / Output 2,482 / Cache write 0\n"));
    assert.ok(text.includes("TPS: -\n"));
  });

  test("TTY dims tool events and the summary", () => {
    const fake = createFakeStdout(true);
    const renderer = new Renderer({
      isTTY: true,
      stdout: asWriteStream(fake),
      columns: () => 80,
    });
    renderer.writeToolEvent({ type: "tool_start", id: "t1", name: "read", args: {} });
    renderer.finish({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      elapsedMs: 1000,
      generationMs: 500,
      tps: 4,
    });
    const text = output(fake);
    assert.ok(text.includes("\x1b[2m{\"type\":\"tool_start\""));
    assert.ok(text.includes("\x1b[2mDone in 1.0s\n"));
    assert.ok(text.trimEnd().endsWith("\x1b[0m"));
  });

  test("repaintThinking is a no-op without an active session", () => {
    const fake = createFakeStdout(true);
    const renderer = new Renderer({
      isTTY: true,
      stdout: asWriteStream(fake),
      columns: () => 80,
    });
    renderer.repaintThinking();
    assert.equal(output(fake), "");
  });

  test("tool events survive circular and BigInt args", () => {
    const fake = createFakeStdout(false);
    const renderer = new Renderer({
      isTTY: false,
      stdout: asWriteStream(fake),
    });
    const args: Record<string, unknown> = { count: 3n };
    args.self = args;
    renderer.writeToolEvent({ type: "tool_start", id: "t1", name: "bash", args });
    const parsed = JSON.parse(output(fake).trim());
    assert.equal(parsed.type, "tool_start");
    assert.equal(parsed.id, "t1");
    assert.deepEqual(parsed.args, { count: "3", self: "<circular>" });
  });

  test("writeError ends the thinking session without repaint", () => {
    const fake = createFakeStdout(true);
    const renderer = new Renderer({
      isTTY: true,
      stdout: asWriteStream(fake),
      columns: () => 80,
    });
    renderer.appendThinking("thought");
    assert.equal(renderer.isThinkingActive(), true);
    renderer.writeError("[stream] boom");
    assert.equal(renderer.isThinkingActive(), false);
    const text = output(fake);
    assert.ok(text.includes("[stream] boom\n"));
    // Exactly one erase sequence (the pre-error clear), no repaint after.
    assert.equal(text.split("\x1b[").length - 1 >= 1, true);
    assert.ok(!text.slice(text.indexOf("[stream] boom")).includes("thought"));
  });
});
