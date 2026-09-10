import * as readline from "node:readline";
import { createMarkdownStreamer, render as renderMarkdown } from "markdansi";
import { MAX_THINKING_LINES, ThinkingBuffer } from "./thinking-view.ts";
import type { StatsSnapshot } from "./stats.ts";
import {
  createColumnsProbe,
  dimText,
  formatCount,
  formatSeconds,
  formatTps,
  isRealTTY,
  safeJsonStringify,
  separatorLine,
  stripAnsi,
  writeRealStdout,
} from "./terminal.ts";

export interface RendererOptions {
  isTTY?: boolean;
  columns?: () => number;
  /**
   * Test seam for Markdown streamer creation. Production code omits this
   * and uses markdansi's `createMarkdownStreamer` directly.
   */
  createMarkdownStreamer?: typeof createMarkdownStreamer;
  /** Direct write seam. Defaults to the real stdout (fd 1). */
  write?: (chunk: string) => void;
  /**
   * Test seam: when `write` is omitted, output and cursor control go here.
   * Production code omits both and targets fd 1 directly.
   */
  stdout?: NodeJS.WriteStream;
}

export interface ToolStartEvent {
  type: "tool_start";
  id: string;
  name: string;
  args: unknown;
}

export interface ToolEndEvent {
  type: "tool_end";
  id: string;
  name: string;
  status: "success" | "error";
  elapsed_ms: number;
}

/**
 * Splits output into persistent (scrollback) and transient (thinking) parts.
 *
 * Thinking is only rendered when stdout is a TTY. It is drawn as a trailing
 * block of at most 8 screen rows plus header/separator lines. The block is
 * erased before answer text, errors, or the final summary. Tool events
 * alone never end the thinking session: the view is hidden, the tool line
 * is written, and the thinking view is repainted below it.
 */
export class Renderer {
  private readonly isTTY: boolean;
  private readonly columns: () => number;
  private readonly writeChunk: (chunk: string) => void;
  private readonly cursorStream: NodeJS.WriteStream;
  private readonly buffer = new ThinkingBuffer();
  private thinkingActive = false;
  private renderedRows = 0;
  private persistentEmpty = true;
  private tail = "";
  private lastWasToolEvent = false;
  /**
   * Markdown streamer for answer text (TTY only). Undefined on non-TTY
   * output, or after Markdown rendering fails and we fall back to raw.
   * Tool events never touch it: tool JSONL and Markdown parser state stay
   * independent, so a tool call mid-answer does not reset rendering.
   */
  private markdownStreamer: ReturnType<typeof createMarkdownStreamer> | undefined;

  constructor(options: RendererOptions = {}) {
    const stdout = options.stdout;
    this.writeChunk =
      options.write ??
      (stdout
        ? (chunk: string) => {
            try {
              stdout.write(chunk);
            } catch {
              // EPIPE and friends must not crash the run.
            }
          }
        : writeRealStdout);
    // Cursor control bytes must land on the same target as the thinking
    // block itself, so route readline through the effective writer.
    const writeChunk = this.writeChunk;
    this.cursorStream = {
      write: (chunk: string) => {
        writeChunk(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    this.isTTY = options.isTTY ?? (stdout ? stdout.isTTY === true : isRealTTY());
    this.columns = options.columns ?? createColumnsProbe();
    // Markdown rendering is a TTY-only display enhancement. Redirected
    // output (pipes, files) keeps raw Markdown with no ANSI sequences.
    if (this.isTTY) {
      try {
        const factory = options.createMarkdownStreamer ?? createMarkdownStreamer;
        // The render callback reads the width lazily so terminal resizes
        // apply to newly rendered blocks. Already emitted scrollback is
        // never redrawn (append-only). `color: true` forces ANSI styling
        // even when markdansi's own TTY detection cannot see the real
        // stdout (e.g. inside Pi's extension sandbox). `hyperlinks: false`
        // keeps links as styled text plus a dimmed URL: OSC-8 sequences
        // would otherwise bypass stripAnsi() and corrupt blank-line
        // tracking. A throwing fragment falls back to its raw Markdown so
        // buffered content is never lost and the stream continues.
        this.markdownStreamer = factory({
          render: (markdown: string) => {
            try {
              return renderMarkdown(markdown, {
                width: this.currentColumns(),
                color: true,
                hyperlinks: false,
                tableDense: true,
              });
            } catch {
              return markdown;
            }
          },
          spacing: "single",
        });
      } catch {
        // Markdown setup must never break the run; writeText() falls back
        // to raw output when the streamer is missing.
        this.markdownStreamer = undefined;
      }
    }
  }

  isThinkingActive(): boolean {
    return this.thinkingActive;
  }

  getRenderedRows(): number {
    return this.renderedRows;
  }

  private write(chunk: string): void {
    if (!chunk) {
      return;
    }
    try {
      this.writeChunk(chunk);
    } catch {
      // EPIPE and friends (e.g. `| head`) must not crash the run.
    }
  }

  private trackPersistent(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    this.persistentEmpty = false;
    // Measure the visible tail so dimmed (ANSI-wrapped) lines still count
    // as the single screen line they occupy.
    this.tail = (this.tail + stripAnsi(chunk)).slice(-2);
  }

  private get endsWithNewline(): boolean {
    return this.tail.endsWith("\n");
  }

  private get endsWithBlankLine(): boolean {
    return this.tail === "\n\n";
  }

  /**
   * Separate the upcoming block from previous output with a blank line.
   * No-op at the start of the run or when already separated, so consecutive
   * lines within one group (tool start/end, answer deltas) stay together.
   */
  private ensureBlankLineBefore(): void {
    if (this.persistentEmpty || this.endsWithBlankLine) {
      return;
    }
    const sep = this.endsWithNewline ? "\n" : "\n\n";
    this.write(sep);
    this.trackPersistent(sep);
  }

  private currentColumns(): number {
    try {
      const value = this.columns();
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
      }
    } catch {
      // Fall through to the default width.
    }
    return 80;
  }

  private clearThinkingView(): void {
    if (!this.isTTY || this.renderedRows <= 0) {
      this.renderedRows = 0;
      return;
    }
    const rows = this.renderedRows;
    this.renderedRows = 0;
    try {
      readline.moveCursor(this.cursorStream, 0, -rows);
      readline.cursorTo(this.cursorStream, 0);
      readline.clearScreenDown(this.cursorStream);
    } catch {
      // Never let transient cleanup break persistent output.
    }
  }

  private renderThinkingView(): void {
    if (!this.isTTY || !this.thinkingActive || this.buffer.isEmpty()) {
      return;
    }
    const columns = this.currentColumns();
    const bodyWidth = Math.max(10, columns - 2);
    const visible = this.buffer.getVisibleLines(
      bodyWidth,
      MAX_THINKING_LINES,
    );
    if (visible.length === 0) {
      return;
    }
    const separator = separatorLine(columns);
    const lines = [
      separator,
      "Thinking",
      ...visible.map((row) => `  ${row}`),
      separator,
    ];
    const block = `${lines.join("\n")}\n`;
    this.clearThinkingView();
    this.write(block);
    this.renderedRows = lines.length;
  }

  writeError(message: string): void {
    // Errors are persistent output and always end the thinking session,
    // matching the failure path which clears the transient view first.
    this.endThinkingForPersistent();
    // Flush buffered Markdown first so answer content is not lost; the
    // streamer renders partial blocks (e.g. an unclosed fence) as-is
    // instead of throwing.
    this.finishMarkdown();
    if (this.lastWasToolEvent) {
      this.ensureBlankLineBefore();
      this.lastWasToolEvent = false;
    }
    const line = message.endsWith("\n") ? message : `${message}\n`;
    this.write(line);
    this.trackPersistent(line);
  }

  appendThinking(delta: string): void {
    if (!this.isTTY || !delta) {
      return;
    }
    this.thinkingActive = true;
    this.buffer.append(delta);
    this.renderThinkingView();
  }

  /** Erase the thinking view and reset the thinking session. */
  clearThinking(): void {
    this.clearThinkingView();
    this.buffer.clear();
    this.thinkingActive = false;
  }

  /** End the thinking session when text/tool/message output takes over. */
  private endThinkingForPersistent(): void {
    if (!this.isTTY) {
      return;
    }
    if (this.thinkingActive || this.renderedRows > 0) {
      this.clearThinkingView();
      this.buffer.clear();
      this.thinkingActive = false;
    }
  }

  /**
   * Flush markdansi's pending buffer (unfinished line, fence, or table).
   * No-op without a streamer. Safe to call repeatedly: an empty buffer
   * flushes to "" and later deltas keep streaming, so error paths that
   * flush mid-answer do not lose content that arrives afterwards.
   */
  private finishMarkdown(): void {
    if (!this.isTTY || !this.markdownStreamer) {
      return;
    }
    let rendered = "";
    try {
      rendered = this.markdownStreamer.finish();
    } catch {
      // Same fallback as writeText(): drop Markdown rendering entirely.
      this.markdownStreamer = undefined;
      return;
    }
    this.write(rendered);
    this.trackPersistent(rendered);
  }

  writeText(delta: string): void {
    if (!delta) {
      return;
    }
    // Text takes over the screen: drop the thinking session entirely so the
    // answer stream is never interleaved with a repainted thinking block.
    this.endThinkingForPersistent();
    if (this.lastWasToolEvent) {
      this.ensureBlankLineBefore();
      this.lastWasToolEvent = false;
    }
    // TTY answers stream through markdansi line by line (fenced code
    // blocks and tables stay buffered until complete). Deltas without a
    // trailing newline legitimately produce no output yet; the remainder
    // is flushed by finishMarkdown() at response completion.
    if (this.isTTY && this.markdownStreamer) {
      let rendered: string;
      try {
        rendered = this.markdownStreamer.push(delta);
      } catch {
        // Rendering is best-effort: keep the raw delta and disable the
        // streamer so later deltas pass through untouched.
        this.markdownStreamer = undefined;
        this.write(delta);
        this.trackPersistent(delta);
        return;
      }
      this.write(rendered);
      this.trackPersistent(rendered);
      return;
    }
    this.write(delta);
    this.trackPersistent(delta);
  }

  writeToolEvent(event: ToolStartEvent | ToolEndEvent): void {
    // Tool args come from the model and can contain anything, including
    // circular structures or BigInt. The JSONL stream must stay intact, so
    // serialization here is total: it always emits one JSON object line.
    // On a TTY the line is dimmed to keep it unobtrusive; redirected output
    // stays plain so grep/jq keep working.
    let line = safeJsonStringify(event);
    if (!line.startsWith("{")) {
      line = (
        `{"type":${JSON.stringify(event.type)},` +
        `"id":${JSON.stringify(event.id)},` +
        `"name":${JSON.stringify(event.name)},"unserializable":true}`
      );
    }
    if (this.isTTY) {
      line = dimText(line);
    }
    const framed = `${line}\n`;
    // Tool calls alone must not end the thinking session: hide the
    // transient view, write the tool line, then repaint thinking below it.
    // The session ends only when answer text (or an error/summary) takes
    // over.
    this.clearThinkingView();
    // Consecutive tool events stay together as one group; only the first
    // one after other output is separated by a blank line.
    if (!this.lastWasToolEvent) {
      this.ensureBlankLineBefore();
    }
    this.write(framed);
    this.trackPersistent(framed);
    this.lastWasToolEvent = true;
    this.renderThinkingView();
  }

  /** Repaint the active thinking view, e.g. after a terminal resize. */
  repaintThinking(): void {
    if (!this.isTTY || !this.thinkingActive || this.buffer.isEmpty()) {
      return;
    }
    this.clearThinkingView();
    this.renderThinkingView();
  }

  private writeSummaryBlock(succeeded: boolean, stats: StatsSnapshot, sessionId?: string): void {
    this.endThinkingForPersistent();
    this.ensureBlankLineBefore();
    this.lastWasToolEvent = false;
    const title = succeeded ? "Done" : "Failed";
    let body =
      `${title} in ${formatSeconds(stats.elapsedMs)}  TPS: ${formatTps(stats.output, stats.generationMs)}\n` +
      `Tokens: Input ${formatCount(stats.input)}` +
      ` / Cache read ${formatCount(stats.cacheRead)}` +
      ` / Output ${formatCount(stats.output)}` +
      ` / Cache write ${formatCount(stats.cacheWrite)}\n`;
    if (sessionId !== undefined && sessionId.trim().length > 0) {
      body += `To resume this session: pi --session ${sessionId}\n`;
    }
    // Dimmed on a TTY so the summary stays unobtrusive; plain otherwise so
    // redirected logs stay clean.
    this.write(this.isTTY ? dimText(body) : body);
    this.trackPersistent(body);
  }

  finish(stats: StatsSnapshot, sessionId?: string): void {
    this.endThinkingForPersistent();
    this.finishMarkdown();
    this.writeSummaryBlock(true, stats, sessionId);
  }

  fail(stats: StatsSnapshot, sessionId?: string): void {
    this.endThinkingForPersistent();
    this.finishMarkdown();
    this.writeSummaryBlock(false, stats, sessionId);
  }
}
