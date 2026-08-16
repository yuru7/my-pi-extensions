import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatNotifyTestReport,
  runNotifyTest,
  spawnAndWait,
  TEST_NOTIFICATION,
  type NotifyTestResult,
} from "../extensions/notify-test.ts";

describe("formatNotifyTestReport", () => {
  test("成功時は環境・バックエンド・コマンドを出す", () => {
    const result: NotifyTestResult = {
      environment: "wsl",
      platform: "linux",
      backend: "windows",
      invocation: {
        command: "powershell.exe",
        args: ["-NoProfile", "-Command", "very-long-script"],
      },
      wslDistro: "Ubuntu",
      powershellPath: "/mnt/c/Custom/powershell.exe",
      sent: true,
    };

    assert.deepEqual(formatNotifyTestReport(result), [
      "pi-native-notify test",
      "environment: wsl",
      "platform: linux",
      "wslDistro: Ubuntu",
      "backend: Windows toast (PowerShell)",
      "command: powershell.exe",
      "args: -NoProfile -Command <Windows toast script>",
      "powershellPath: /mnt/c/Custom/powershell.exe",
      "result: sent",
    ]);
  });

  test("未対応環境は skipped にする", () => {
    const result: NotifyTestResult = {
      environment: "unsupported",
      platform: "freebsd",
      backend: null,
      invocation: null,
      sent: false,
    };

    assert.deepEqual(formatNotifyTestReport(result), [
      "pi-native-notify test",
      "environment: unsupported",
      "platform: freebsd",
      "backend: none",
      "result: skipped",
    ]);
  });

  test("失敗時は error を出す", () => {
    const result: NotifyTestResult = {
      environment: "linux",
      platform: "linux",
      backend: "linux",
      invocation: {
        command: "notify-send",
        args: [
          "--app-name=Pi",
          "--urgency=normal",
          TEST_NOTIFICATION.title,
          TEST_NOTIFICATION.message,
        ],
      },
      sent: false,
      error: "command not found: notify-send",
    };

    const report = formatNotifyTestReport(result);
    assert.equal(report.at(-2), "result: failed");
    assert.equal(report.at(-1), "error: command not found: notify-send");
    assert.equal(
      report.find((line) => line.startsWith("args:")),
      `args: --app-name=Pi --urgency=normal ${JSON.stringify(TEST_NOTIFICATION.title)} ${JSON.stringify(TEST_NOTIFICATION.message)}`,
    );
  });
});

describe("runNotifyTest", () => {
  test("WSL では Windows バックエンドで送信する", async () => {
    const invoked: string[] = [];
    const result = await runNotifyTest(
      { thresholdSeconds: 30 },
      {
        probe: {
          platform: "linux",
          env: { WSL_DISTRO_NAME: "Ubuntu" },
        },
        powershellPath: "powershell.exe",
        wait: async (invocation) => {
          invoked.push(invocation.command);
          return {};
        },
      },
    );

    assert.equal(result.environment, "wsl");
    assert.equal(result.platform, "linux");
    assert.equal(result.backend, "windows");
    assert.equal(result.wslDistro, "Ubuntu");
    assert.equal(result.sent, true);
    assert.equal(result.error, undefined);
    assert.deepEqual(invoked, ["powershell.exe"]);
  });

  test("Linux native は notify-send を使う", async () => {
    const result = await runNotifyTest(
      { thresholdSeconds: 30 },
      {
        probe: {
          platform: "linux",
          env: {},
          readFile: () => "6.8.0-generic",
        },
        wait: async () => ({}),
      },
    );

    assert.equal(result.environment, "linux");
    assert.equal(result.backend, "linux");
    assert.equal(result.invocation?.command, "notify-send");
    assert.equal(result.sent, true);
  });

  test("未対応環境では送信しない", async () => {
    let waited = false;
    const result = await runNotifyTest(
      { thresholdSeconds: 30 },
      {
        probe: { platform: "freebsd", env: {} },
        wait: async () => {
          waited = true;
          return {};
        },
      },
    );

    assert.equal(result.environment, "unsupported");
    assert.equal(result.backend, null);
    assert.equal(result.invocation, null);
    assert.equal(result.sent, false);
    assert.equal(waited, false);
  });

  test("wait の失敗を error として返す", async () => {
    const result = await runNotifyTest(
      { thresholdSeconds: 30 },
      {
        probe: { platform: "darwin", env: {} },
        wait: async () => ({ error: "command not found: osascript" }),
      },
    );

    assert.equal(result.backend, "macos");
    assert.equal(result.sent, false);
    assert.equal(result.error, "command not found: osascript");
  });
});

describe("spawnAndWait", () => {
  test("成功コマンドは exit 0 を返す", async () => {
    const result = await spawnAndWait({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    assert.deepEqual(result, { exitCode: 0 });
  });

  test("失敗コマンドは stderr または exit code を返す", async () => {
    const result = await spawnAndWait({
      command: process.execPath,
      args: ["-e", "console.error('boom'); process.exit(2)"],
    });
    assert.equal(result.exitCode, 2);
    assert.match(result.error ?? "", /boom/);
  });

  test("存在しないコマンドを報告する", async () => {
    const result = await spawnAndWait({
      command: "pi-native-notify-missing-cmd",
      args: [],
    });
    assert.equal(result.exitCode, null);
    assert.match(result.error ?? "", /command not found/);
  });
});
