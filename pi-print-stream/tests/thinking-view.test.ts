import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MAX_THINKING_CHARS,
  ThinkingBuffer,
} from "../src/thinking-view.ts";

describe("ThinkingBuffer", () => {
  test("appends deltas and returns the tail", () => {
    const buffer = new ThinkingBuffer();
    buffer.append("hello ");
    buffer.append("world");
    assert.equal(buffer.getText(), "hello world");
    assert.equal(buffer.isEmpty(), false);
  });

  test("clear empties the buffer", () => {
    const buffer = new ThinkingBuffer();
    buffer.append("something");
    buffer.clear();
    assert.equal(buffer.isEmpty(), true);
    assert.deepEqual(buffer.getVisibleLines(80), []);
  });

  test("returns at most 8 screen rows by default", () => {
    const buffer = new ThinkingBuffer();
    buffer.append(Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n"));
    const visible = buffer.getVisibleLines(80);
    assert.equal(visible.length, 8);
    assert.equal(visible[0], "line12");
    assert.equal(visible[7], "line19");
  });

  test("wraps long logical lines by terminal width", () => {
    const buffer = new ThinkingBuffer();
    buffer.append("a".repeat(100));
    const visible = buffer.getVisibleLines(20);
    assert.equal(visible.length, 5);
    assert.ok(visible.every((row) => row.length <= 20));
  });

  test("counts full-width Japanese as 2 columns", () => {
    const buffer = new ThinkingBuffer();
    // 10 full-width chars = 20 columns.
    buffer.append("あ".repeat(10));
    const fits = buffer.getVisibleLines(20);
    assert.equal(fits.length, 1);
    const wrapped = buffer.getVisibleLines(19);
    assert.equal(wrapped.length, 2);
  });

  test("handles emoji without splitting the visible tail", () => {
    const buffer = new ThinkingBuffer();
    buffer.append(`start-${"🎉".repeat(30)}-end`);
    const visible = buffer.getVisibleLines(20, 8);
    assert.ok(visible.length <= 8);
    const joined = visible.join("");
    // The tail must survive wrapping.
    assert.ok(joined.includes("-end"));
  });

  test("ignores ANSI sequences for width calculation", () => {
    const buffer = new ThinkingBuffer();
    buffer.append("a".repeat(20));
    const plain = buffer.getVisibleLines(20);
    buffer.clear();
    buffer.append(`\x1b[2m${"a".repeat(20)}\x1b[0m`);
    const styled = buffer.getVisibleLines(20);
    assert.deepEqual(styled, plain);
    // Stored display text must not leak escape codes.
    assert.ok(!styled.join("").includes("\x1b"));
  });

  test("trims old content beyond the memory bound", () => {
    const buffer = new ThinkingBuffer();
    buffer.append("x".repeat(MAX_THINKING_CHARS + 1000));
    assert.ok(buffer.getText().length <= MAX_THINKING_CHARS);
    const visible = buffer.getVisibleLines(80);
    assert.equal(visible.length, 8);
    assert.ok(visible[7].includes("x"));
  });

  test("empty lines still count as screen rows", () => {
    const buffer = new ThinkingBuffer();
    buffer.append("a\n\nb");
    const visible = buffer.getVisibleLines(80);
    assert.deepEqual(visible, ["a", "", "b"]);
  });
});
