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

class FakeProcess extends EventEmitter {
  pid = 4242;
  platform: NodeJS.Platform = "linux";
  kills: Array<[number, string | undefined]> = [];

  kill(pid: number, signal?: string) {
    this.kills.push([pid, signal]);
    return true;
  }
}

function createIo(options?: {
  stdinTty?: boolean;
  stdoutTty?: boolean;
  platform?: NodeJS.Platform;
}) {
  const stdin = new FakeStdin();
  stdin.isTTY = options?.stdinTty ?? true;
  const stdout = new FakeStdout();
  stdout.isTTY = options?.stdoutTty ?? true;
  const proc = new FakeProcess();
  proc.platform = options?.platform ?? "linux";
  return { stdin, stdout, proc };
}

function dataListenerCount(stdin: FakeStdin) {
  return stdin.listenerCount("data");
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
    assert.equal(io.proc.listenerCount("SIGTSTP"), 0);
    assert.equal(io.proc.listenerCount("SIGCONT"), 0);
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
    assert.equal(dataListenerCount(io.stdin), 1);
    assert.equal(io.proc.listenerCount("SIGTSTP"), 1);
    assert.equal(io.proc.listenerCount("SIGCONT"), 1);
  });

  test("detach で無効化し、状態を戻す", () => {
    const io = createIo();
    const tracker = createFocusTracker(io);
    tracker.attach();
    io.stdin.emit("data", Buffer.from(FOCUS_OUT_SEQ, "binary"));
    tracker.detach();
    assert.deepEqual(io.stdout.writes, [FOCUS_ENABLE, FOCUS_DISABLE]);
    assert.equal(tracker.isUnfocused(), false);
    assert.equal(dataListenerCount(io.stdin), 0);
    assert.equal(io.proc.listenerCount("SIGTSTP"), 0);
    assert.equal(io.proc.listenerCount("SIGCONT"), 0);

    io.stdin.emit("data", Buffer.from(FOCUS_OUT_SEQ, "binary"));
    assert.equal(tracker.isUnfocused(), false);
  });

  test("SIGTSTP で Focus Tracking を無効化し、プロセスを停止する", () => {
    const io = createIo();
    const tracker = createFocusTracker(io);
    tracker.attach();
    io.stdin.emit("data", Buffer.from(FOCUS_OUT_SEQ, "binary"));
    assert.equal(tracker.isUnfocused(), true);

    io.proc.emit("SIGTSTP");
    assert.deepEqual(io.stdout.writes, [FOCUS_ENABLE, FOCUS_DISABLE]);
    assert.equal(tracker.isUnfocused(), false);
    assert.equal(dataListenerCount(io.stdin), 0);
    assert.deepEqual(io.proc.kills, [[io.proc.pid, "SIGTSTP"]]);
    assert.equal(io.proc.listenerCount("SIGTSTP"), 0);
    assert.equal(io.proc.listenerCount("SIGCONT"), 1);

    io.stdin.emit("data", Buffer.from(FOCUS_OUT_SEQ, "binary"));
    assert.equal(tracker.isUnfocused(), false);
  });

  test("SIGCONT で Focus Tracking を再有効化する", () => {
    const io = createIo();
    const tracker = createFocusTracker(io);
    tracker.attach();
    io.proc.emit("SIGTSTP");
    io.proc.emit("SIGCONT");

    assert.deepEqual(io.stdout.writes, [
      FOCUS_ENABLE,
      FOCUS_DISABLE,
      FOCUS_ENABLE,
    ]);
    assert.equal(dataListenerCount(io.stdin), 1);
    assert.equal(io.proc.listenerCount("SIGTSTP"), 1);
    assert.equal(io.proc.listenerCount("SIGCONT"), 1);

    io.stdin.emit("data", Buffer.from(FOCUS_OUT_SEQ, "binary"));
    assert.equal(tracker.isUnfocused(), true);
    io.stdin.emit("data", Buffer.from(FOCUS_IN_SEQ, "binary"));
    assert.equal(tracker.isUnfocused(), false);
  });

  test("Ctrl+Z / fg を繰り返しても listener が多重登録されない", () => {
    const io = createIo();
    const tracker = createFocusTracker(io);
    tracker.attach();

    for (let i = 0; i < 3; i++) {
      io.proc.emit("SIGTSTP");
      io.proc.emit("SIGCONT");
    }

    assert.equal(dataListenerCount(io.stdin), 1);
    assert.equal(io.proc.listenerCount("SIGTSTP"), 1);
    assert.equal(io.proc.listenerCount("SIGCONT"), 1);
    assert.equal(
      io.stdout.writes.filter((write) => write === FOCUS_ENABLE).length,
      4,
    );
    assert.equal(
      io.stdout.writes.filter((write) => write === FOCUS_DISABLE).length,
      3,
    );
    assert.equal(io.proc.kills.length, 3);

    io.stdin.emit("data", Buffer.from(FOCUS_OUT_SEQ, "binary"));
    assert.equal(tracker.isUnfocused(), true);
  });

  test("detach 後は SIGCONT で再有効化しない", () => {
    const io = createIo();
    const tracker = createFocusTracker(io);
    tracker.attach();
    tracker.detach();
    io.proc.emit("SIGCONT");
    io.proc.emit("SIGTSTP");

    assert.deepEqual(io.stdout.writes, [FOCUS_ENABLE, FOCUS_DISABLE]);
    assert.equal(dataListenerCount(io.stdin), 0);
    assert.deepEqual(io.proc.kills, []);
  });

  test("win32 ではジョブ制御シグナルを登録しない", () => {
    const io = createIo({ platform: "win32" });
    const tracker = createFocusTracker(io);
    tracker.attach();
    assert.deepEqual(io.stdout.writes, [FOCUS_ENABLE]);
    assert.equal(io.proc.listenerCount("SIGTSTP"), 0);
    assert.equal(io.proc.listenerCount("SIGCONT"), 0);
    assert.equal(dataListenerCount(io.stdin), 1);
  });
});
