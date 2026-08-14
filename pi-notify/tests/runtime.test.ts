import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createNotifyRuntime } from "../extensions/index.ts";
import {
  formatCompletionMessage,
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
});

describe("formatCompletionMessage", () => {
  test("固定フォーマットで小数1桁を出す", () => {
    assert.equal(formatCompletionMessage(42.34), "タスクが完了しました（42.3秒）");
  });
});

describe("createNotifyRuntime", () => {
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
    const sent: string[] = [];
    const runtime = createNotifyRuntime({
      now: () => now,
      getConfig: () => ({ thresholdSeconds: 30 }),
      notify: async (_title, message) => {
        sent.push(message);
      },
    });

    runtime.markStart();
    now = 30_000;
    assert.equal(await runtime.onSettled(), true);
    assert.deepEqual(sent, ["タスクが完了しました（30.0秒）"]);

    assert.equal(await runtime.onSettled(), false);
    assert.equal(sent.length, 1);
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
    assert.deepEqual(sent, ["タスクが完了しました（35.0秒）"]);
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
