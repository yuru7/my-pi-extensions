import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createNotifyRuntime } from "../extensions/index.ts";
import {
  formatNotificationMessage,
  shouldNotify,
} from "../extensions/notifier.ts";

describe("shouldNotify", () => {
  test("29秒 / threshold 30 → 通知なし", () => {
    assert.equal(shouldNotify(29, 30), false);
  });

  test("29.9秒 / threshold 30 → 通知なし", () => {
    assert.equal(shouldNotify(29.9, 30), false);
  });

  test("30秒 / threshold 30 → 通知あり", () => {
    assert.equal(shouldNotify(30, 30), true);
  });

  test("31秒 / threshold 30 → 通知あり", () => {
    assert.equal(shouldNotify(31, 30), true);
  });

  test("threshold 0 は毎回通知", () => {
    assert.equal(shouldNotify(0, 0), true);
    assert.equal(shouldNotify(0.1, 0), true);
  });

  test("フォーカスアウトなら閾値未満でも通知する", () => {
    assert.equal(shouldNotify(0, 30, true), true);
    assert.equal(shouldNotify(1, 30, true), true);
  });

  test("フォーカス中なら閾値判定のまま", () => {
    assert.equal(shouldNotify(29, 30, false), false);
    assert.equal(shouldNotify(30, 30, false), true);
  });
});

describe("formatNotificationMessage", () => {
  test("空や空白のみなら完了メッセージにフォールバックする", () => {
    assert.equal(formatNotificationMessage(""), "タスクが完了しました");
    assert.equal(formatNotificationMessage("   \n\t  "), "タスクが完了しました");
  });

  test("改行を空白にまとめる", () => {
    assert.equal(
      formatNotificationMessage("hello\nworld\n  test"),
      "hello world test",
    );
  });

  test("50文字以内はそのまま返す", () => {
    const prompt = "あ".repeat(50);
    assert.equal(formatNotificationMessage(prompt), prompt);
  });

  test("50文字を超えたら省略する", () => {
    const prompt = "あ".repeat(51);
    const message = formatNotificationMessage(prompt);
    assert.equal(message, `${"あ".repeat(49)}…`);
    assert.equal([...message].length, 50);
  });
});

describe("createNotifyRuntime", () => {
  test("フォーカスアウトなら閾値未満でも通知する", async () => {
    let now = 0;
    const sent: string[] = [];
    const runtime = createNotifyRuntime({
      now: () => now,
      getConfig: () => ({ thresholdSeconds: 30 }),
      isUnfocused: () => true,
      notify: async (_title, message) => {
        sent.push(message);
      },
    });

    runtime.markStart();
    now = 1000;
    assert.equal(await runtime.onSettled(), true);
    assert.deepEqual(sent, ["タスクが完了しました"]);
  });

  test("フォーカス中でも閾値以上なら通知する", async () => {
    let now = 0;
    const sent: string[] = [];
    const runtime = createNotifyRuntime({
      now: () => now,
      getConfig: () => ({ thresholdSeconds: 30 }),
      isUnfocused: () => false,
      notify: async (_title, message) => {
        sent.push(message);
      },
    });

    runtime.markStart();
    now = 30_000;
    assert.equal(await runtime.onSettled(), true);
    assert.deepEqual(sent, ["タスクが完了しました"]);
  });

  test("閾値未満では通知しない", async () => {
    let now = 0;
    const sent: string[] = [];
    const runtime = createNotifyRuntime({
      now: () => now,
      getConfig: () => ({ thresholdSeconds: 30 }),
      notify: async (_title, message) => {
        sent.push(message);
      },
    });

    runtime.markStart();
    now = 29_000;
    assert.equal(await runtime.onSettled(), false);
    assert.deepEqual(sent, []);
  });

  test("閾値以上では一度だけ通知する", async () => {
    let now = 0;
    const sent: Array<{ title: string; message: string }> = [];
    const runtime = createNotifyRuntime({
      now: () => now,
      getConfig: () => ({ thresholdSeconds: 30 }),
      notify: async (title, message) => {
        sent.push({ title, message });
      },
    });

    runtime.markStart();
    now = 30_000;
    assert.equal(await runtime.onSettled(), true);
    assert.deepEqual(sent, [
      { title: "Done - Pi", message: "タスクが完了しました" },
    ]);

    assert.equal(await runtime.onSettled(), false);
    assert.equal(sent.length, 1);
  });

  test("通知本文は対象プロンプトの省略表記", async () => {
    let now = 0;
    const sent: Array<{ title: string; message: string }> = [];
    const runtime = createNotifyRuntime({
      now: () => now,
      getConfig: () => ({ thresholdSeconds: 0 }),
      notify: async (title, message) => {
        sent.push({ title, message });
      },
    });

    runtime.capturePrompt(`最初の依頼\n${"あ".repeat(60)}`);
    runtime.capturePrompt("後続の follow-up は本文に使わない");
    runtime.markStart();
    now = 1000;
    assert.equal(await runtime.onSettled(), true);
    assert.deepEqual(sent, [
      {
        title: "Done - Pi",
        message: formatNotificationMessage(`最初の依頼\n${"あ".repeat(60)}`),
      },
    ]);
  });

  test("retry 相当の追加 agent_start では開始時刻をリセットしない", async () => {
    let now = 0;
    const sent: string[] = [];
    const runtime = createNotifyRuntime({
      now: () => now,
      getConfig: () => ({ thresholdSeconds: 30 }),
      notify: async (_title, message) => {
        sent.push(message);
      },
    });

    runtime.markStart();
    now = 10_000;
    runtime.markStart();
    now = 35_000;
    assert.equal(await runtime.onSettled(), true);
    assert.deepEqual(sent, ["タスクが完了しました"]);
  });

  test("start なしの settled では通知しない", async () => {
    const sent: string[] = [];
    const runtime = createNotifyRuntime({
      now: () => 1000,
      getConfig: () => ({ thresholdSeconds: 0 }),
      notify: async () => {
        sent.push("nope");
      },
    });

    assert.equal(await runtime.onSettled(), false);
    assert.deepEqual(sent, []);
  });

  test("通知関数が失敗しても例外を外へ出さない", async () => {
    const runtime = createNotifyRuntime({
      now: () => 0,
      getConfig: () => ({ thresholdSeconds: 0 }),
      notify: async () => {
        throw new Error("powershell missing");
      },
    });

    runtime.markStart();
    await assert.doesNotReject(() => runtime.onSettled());
  });
});
