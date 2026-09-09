import stringWidth from "string-width";
import { stripAnsi } from "./terminal.ts";

export const MAX_THINKING_LINES = 8;
/** Keep only the tail of the thinking text to bound memory. */
export const MAX_THINKING_CHARS = 64 * 1024;

function splitGraphemes(text: string): string[] {
  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter("en", { granularity: "grapheme" })
      : undefined;
  if (segmenter) {
    const out: string[] = [];
    for (const segment of segmenter.segment(text)) {
      out.push(segment.segment);
    }
    return out;
  }
  return Array.from(text);
}

function wrapLogicalLine(line: string, columns: number): string[] {
  const width = Math.max(1, Math.floor(columns));
  const clean = stripAnsi(line).replace(/\t/g, "  ");
  if (clean.length === 0) {
    return [""];
  }
  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const grapheme of splitGraphemes(clean)) {
    if (grapheme === "\n" || grapheme === "\r") {
      continue;
    }
    const graphemeWidth = Math.max(0, stringWidth(grapheme));
    if (currentWidth + graphemeWidth > width && current !== "") {
      rows.push(current);
      current = "";
      currentWidth = 0;
      // Skip leading spaces created by wrapping.
      if (grapheme.trim() === "") {
        continue;
      }
    }
    // A single wide grapheme wider than the column still gets its own row.
    current += grapheme;
    currentWidth += graphemeWidth;
  }
  rows.push(current);
  return rows;
}

/**
 * Accumulates thinking deltas and exposes the last N screen rows.
 *
 * Screen rows account for terminal wrapping (including CJK wide chars and
 * emoji), not just newlines. Only the tail is kept in memory.
 */
export class ThinkingBuffer {
  private text = "";

  append(delta: string): void {
    if (!delta) {
      return;
    }
    this.text += delta;
    if (this.text.length > MAX_THINKING_CHARS) {
      this.text = this.text.slice(this.text.length - MAX_THINKING_CHARS);
    }
  }

  clear(): void {
    this.text = "";
  }

  isEmpty(): boolean {
    return this.text.length === 0;
  }

  getText(): string {
    return this.text;
  }

  getVisibleLines(columns: number, maxLines: number = MAX_THINKING_LINES): string[] {
    if (this.text.length === 0) {
      return [];
    }
    const width = Number.isFinite(columns) && columns > 0 ? columns : 80;
    const limit = Math.max(1, Math.floor(maxLines));
    const rows: string[] = [];
    for (const logicalLine of this.text.split("\n")) {
      for (const row of wrapLogicalLine(logicalLine, width)) {
        rows.push(row);
        if (rows.length > limit * 4) {
          // Keep work bounded; only the tail is returned.
          rows.splice(0, rows.length - limit * 4);
        }
      }
    }
    return rows.slice(Math.max(0, rows.length - limit));
  }
}
