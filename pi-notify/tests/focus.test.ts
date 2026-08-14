import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import {
  consumeFocusBuffer,
  createFocusTracker,
  FOCUS_DISABLE,
  FOCUS_ENABLE,
  FOCUS_IN_SEQ,
  FOCUS_OUT_SEQ,
} from "../extensions/focus.ts";

class FakeStdin extends EventEmitter {
  isTTY = true;
}

class FakeStdout {
  isTTY = true;
  writes: string[] = [];
  write(data: string) {
    this.writes.push(data);
    return true;
  }
}

function createIo(options?: { stdinTty?: boolean; stdoutTty?: boolean }) {
  const stdin = new FakeStdin();
  stdin.isTTY = options?.stdinTty ?? true;
  const stdout = new FakeStdout();
  stdout.isTTY = options?.stdoutTty ?? true;
  return { stdin, stdout };
}

describe("consumeFocusBuffer", () => {
  test("フォーカスアウトを検出する", () => {
    assert.deepEqual(consumeFocusBuffer(FOCUS_OUT_SEQ), {
      rest: "",
      unfocused: true,
    });
  });

  test("フォーカスインを検出する", () => {
    assert.deepEqual(consumeFocusBuffer(FOCUS_IN_SEQ), {
      rest: "",
      unfocused: false,
    });
  });

  test("同じチャンク内では後勝ち", () => {
    assert.deepEqual(
      consumeFocusBuffer(`${FOCUS_OUT_SEQ}hello${FOCUS_IN_SEQ}`),
      { rest: "", unfocused: false },
    );
  });

  test("途中のバイトを次チャンクへ残す", () => {
    assert.deepEqual(consumeFocusBuffer("\x1b["), {
      rest: "\x1b[",
      unfocused: undefined,
    });
  });
});

describe("createFocusTracker", () => {
  test("初期状態はフォーカス中とみなす", () => {
    const tracker = createFocusTracker(createIo());
    tracker.attach();
    assert.equal(tracker.isUnfocused(), false);
  });

  test("TTY でなければ有効化しない", () => {
    const io = createIo({ stdinTty: false });
    const tracker = createFocusTracker(io);
    tracker.attach();
    assert.deepEqual(io.stdout.writes, []);
    assert.equal(tracker.isUnfocused(), false);
  });

  test("DECSET 1004 を有効化し、フォーカスアウトを追跡する", () => {
    const io = createIo();
    const tracker = createFocusTracker(io);
    tracker.attach();
    assert.deepEqual(io.stdout.writes, [FOCUS_ENABLE]);

    io.stdin.emit("data", Buffer.from(FOCUS_OUT_SEQ, "binary"));
    assert.equal(tracker.isUnfocused(), true);

    io.stdin.emit("data", Buffer.from(FOCUS_IN_SEQ, "binary"));
    assert.equal(tracker.isUnfocused(), false);
  });

  test("シーケンスがチャンクを跨いでも検出する", () => {
    const io = createIo();
    const tracker = createFocusTracker(io);
    tracker.attach();
    io.stdin.emit("data", Buffer.from("\x1b", "binary"));
    assert.equal(tracker.isUnfocused(), false);
    io.stdin.emit("data", Buffer.from("[O", "binary"));
    assert.equal(tracker.isUnfocused(), true);
  });

  test("attach は冪等", () => {
    const io = createIo();
    const tracker = createFocusTracker(io);
    tracker.attach();
    tracker.attach();
    assert.deepEqual(io.stdout.writes, [FOCUS_ENABLE]);
  });

  test("detach で無効化し、状態を戻す", () => {
    const io = createIo();
    const tracker = createFocusTracker(io);
    tracker.attach();
    io.stdin.emit("data", Buffer.from(FOCUS_OUT_SEQ, "binary"));
    tracker.detach();
    assert.deepEqual(io.stdout.writes, [FOCUS_ENABLE, FOCUS_DISABLE]);
    assert.equal(tracker.isUnfocused(), false);

    io.stdin.emit("data", Buffer.from(FOCUS_OUT_SEQ, "binary"));
    assert.equal(tracker.isUnfocused(), false);
  });
});
