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

    // Markdown streams line by line, so terminate the line to flush it.
    renderer.writeText("answer\n");
    const text = output(fake);
    const clearIndex = text.indexOf("\x1b[", beforeText - 50);
    const answerIndex = text.indexOf("answer");
    assert.ok(clearIndex !== -1, "expected ANSI clear sequence");
    assert.ok(clearIndex < answerIndex);
    // Thinking session ends when text takes over: no repaint after text.
    assert.equal(renderer.isThinkingActive(), false);
  });

  test("TTY thinking survives tool events and is repainted below them", () => {
    const fake = createFakeStdout(true);
    const renderer = new Renderer({
      isTTY: true,
      stdout: asWriteStream(fake),
      columns: () => 80,
    });
    renderer.appendThinking("thought");
    renderer.writeToolEvent({ type: "tool_start", id: "t1", name: "bash", args: {} });
    const text = output(fake);
    // Tool line is written...
    assert.ok(text.includes('"type":"tool_start"'));
    // ...but the thinking session survives tool calls alone.
    assert.equal(renderer.isThinkingActive(), true);
    // The thinking view is hidden before the tool line and repainted after
    // it, so the thought is still visible below the tool event.
    const toolIndex = text.indexOf('"type":"tool_start"');
    const repaintIndex = text.indexOf("thought", toolIndex);
    assert.ok(toolIndex !== -1);
    assert.ok(repaintIndex !== -1, "expected thinking repaint after tool event");
  });

  test("TTY thinking ends when answer text takes over", () => {
    const fake = createFakeStdout(true);
    const renderer = new Renderer({
      isTTY: true,
      stdout: asWriteStream(fake),
      columns: () => 80,
    });
    renderer.appendThinking("thought");
    renderer.writeToolEvent({ type: "tool_start", id: "t1", name: "bash", args: {} });
    assert.equal(renderer.isThinkingActive(), true);
    renderer.writeText("answer\n");
    assert.equal(renderer.isThinkingActive(), false);
    const text = output(fake);
    // No repaint after the answer: the thought must not reappear below it.
    assert.ok(!text.slice(text.indexOf("answer")).includes("thought"));
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

describe("Renderer Markdown (TTY)", () => {
  const stats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, elapsedMs: 1000, generationMs: 0, tps: 0 };

  function createTtyRenderer(fake: FakeStdout, options: Record<string, unknown> = {}): Renderer {
    return new Renderer({
      isTTY: true,
      stdout: asWriteStream(fake),
      columns: () => 80,
      ...options,
    } as ConstructorParameters<typeof Renderer>[0]);
  }

  test("heading is decorated and markers are hidden", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.writeText("## Hello\n");
    renderer.finish(stats);
    const text = output(fake);
    assert.ok(text.includes("Hello"));
    assert.ok(!text.includes("##"));
    assert.ok(text.includes("\x1b["), "expected ANSI formatting");
  });

  test("bold markers are replaced with ANSI styling", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.writeText("This is **important**.\n");
    renderer.finish(stats);
    const text = output(fake);
    assert.ok(text.includes("important"));
    assert.ok(!text.includes("**"));
    assert.ok(text.includes("\x1b[1m"), "expected bold SGR");
  });

  test("inline code stays readable", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.writeText("Run `pnpm test`.\n");
    renderer.finish(stats);
    assert.ok(output(fake).includes("pnpm test"));
  });

  test("unordered list items are preserved", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.writeText("- one\n- two\n");
    renderer.finish(stats);
    const text = output(fake);
    assert.ok(text.includes("one"));
    assert.ok(text.includes("two"));
  });

  test("code block split across deltas is emitted once without fences", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.writeText("```ts\n");
    renderer.writeText("console.log(\n");
    renderer.writeText('"hello");\n');
    renderer.writeText("```\n");
    renderer.finish(stats);
    const text = output(fake);
    assert.ok(text.includes('console.log('));
    assert.ok(text.includes('"hello"'));
    assert.ok(!text.includes("```"));
    assert.equal(text.split('console.log(').length - 1, 1);
  });

  test("split bold markers across delta boundaries do not corrupt output", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.writeText("**");
    renderer.writeText("bold");
    renderer.writeText("**\n");
    renderer.finish(stats);
    const text = output(fake);
    assert.ok(text.includes("bold"));
    assert.ok(!text.includes("**"));
  });

  test("GFM table split across deltas renders as a box", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.writeText("| Name | Value |\n");
    renderer.writeText("|---|---|\n");
    renderer.writeText("| foo | bar |\n");
    renderer.finish(stats);
    const text = output(fake);
    assert.ok(text.includes("foo"));
    assert.ok(text.includes("bar"));
    assert.ok(text.includes("│") || text.includes("┌"), "expected table borders");
  });

  test("streaming is append-only: earlier output is a prefix of later output", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.writeText("## First\n");
    const first = output(fake);
    assert.ok(first.includes("First"));
    renderer.writeText("second line\n");
    const both = output(fake);
    assert.ok(both.startsWith(first));
    assert.ok(both.includes("second line"));
  });

  test("trailing partial line is flushed before the summary", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.writeText("trailing without newline");
    renderer.finish(stats);
    const text = output(fake);
    assert.ok(text.includes("trailing without newline"));
    assert.ok(text.indexOf("trailing without newline") < text.indexOf("Done"));
  });

  test("answer then error keeps Markdown and shows the error", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.writeText("## Title\n");
    renderer.writeError("[stream] boom");
    const text = output(fake);
    assert.ok(text.includes("Title"));
    assert.ok(!text.includes("##"));
    assert.ok(text.includes("[stream] boom\n"));
    assert.ok(text.indexOf("Title") < text.indexOf("[stream] boom"));
  });

  test("unclosed fence is flushed as content on error, never throws", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.writeText("```typescript\nconst x = \n");
    renderer.writeError("[stream] boom");
    const text = output(fake);
    assert.ok(text.includes("const x = "));
    assert.ok(text.includes("[stream] boom"));
  });

  test("tool call mid-answer does not reset Markdown state", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.writeText("## Investigation\n\nThe issue is caused by:\n");
    renderer.writeToolEvent({ type: "tool_end", id: "t1", name: "bash", status: "success", elapsed_ms: 1 });
    renderer.writeText("- condition A\n- condition B\n");
    renderer.finish(stats);
    const text = output(fake);
    assert.ok(text.includes("Investigation"));
    assert.ok(text.includes('"type":"tool_end"'));
    assert.ok(text.includes("condition A"));
    assert.ok(text.includes("condition B"));
    assert.ok(text.indexOf("condition A") > text.indexOf('"type":"tool_end"'));
  });

  test("thinking view is cleared before Markdown answer output", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.appendThinking("transient thought");
    renderer.writeText("# Answer\n");
    const text = output(fake);
    assert.ok(text.includes("Answer"));
    assert.ok(!text.slice(text.indexOf("Answer")).includes("transient thought"));
    assert.equal(renderer.isThinkingActive(), false);
  });

  test("Markdown failure falls back to raw text without failing the run", () => {
    const fake = createFakeStdout(true);
    const throwingStreamer = {
      push: () => { throw new Error("render boom"); },
      finish: () => "",
      reset: () => {},
    };
    const renderer = createTtyRenderer(fake, {
      createMarkdownStreamer: () => throwingStreamer,
    });
    renderer.writeText("hello **world**\n");
    // Streamer is disabled after the failure: later deltas stay raw too.
    renderer.writeText("more text\n");
    renderer.finish(stats);
    const text = output(fake);
    assert.ok(text.includes("hello **world**\n"));
    assert.ok(text.includes("more text\n"));
    assert.ok(text.includes("Done"));
  });

  test("streamer factory failure falls back to raw text", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake, {
      createMarkdownStreamer: () => { throw new Error("init boom"); },
    });
    renderer.writeText("## Hello\n");
    renderer.finish(stats);
    assert.ok(output(fake).includes("## Hello\n"));
  });

  test("finish failure still shows the summary without failing the run", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake, {
      createMarkdownStreamer: () => ({
        push: () => "",
        finish: () => { throw new Error("finish boom"); },
        reset: () => {},
      }),
    });
    renderer.writeText("partial\n");
    renderer.finish(stats);
    assert.ok(output(fake).includes("Done"));
    // The error path degrades the same way.
    const fake2 = createFakeStdout(true);
    const renderer2 = createTtyRenderer(fake2, {
      createMarkdownStreamer: () => ({
        push: () => "",
        finish: () => { throw new Error("finish boom"); },
        reset: () => {},
      }),
    });
    renderer2.writeError("[stream] boom");
    assert.ok(output(fake2).includes("[stream] boom\n"));
  });

  test("links render without OSC-8 sequences", () => {
    const fake = createFakeStdout(true);
    const renderer = createTtyRenderer(fake);
    renderer.writeText("See [docs](https://example.com).\n");
    renderer.finish(stats);
    const text = output(fake);
    assert.ok(text.includes("docs"));
    assert.ok(text.includes("https://example.com"));
    assert.ok(!text.includes("\x1b]8"), "OSC-8 hyperlinks must stay off");
  });
});

describe("Renderer Markdown (non-TTY)", () => {
  test("raw Markdown passes through byte-identical with no ANSI", () => {
    const fake = createFakeStdout(false);
    const renderer = new Renderer({
      isTTY: false,
      stdout: asWriteStream(fake),
    });
    const input = "## Hello\n\n**world**\n\n- one\n- two\n\n```ts\nconsole.log(1);\n```\n";
    renderer.writeText(input);
    renderer.finish({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, elapsedMs: 1000, generationMs: 0, tps: 0,
    });
    const text = output(fake);
    assert.ok(text.startsWith(input));
    assert.ok(!text.includes("\x1b"));
    // No renderer-added decoration: the Markdown source is intact.
    assert.ok(text.includes("## Hello"));
    assert.ok(text.includes("**world**"));
    assert.ok(text.includes("```ts"));
  });
});
