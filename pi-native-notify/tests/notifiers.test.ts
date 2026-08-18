import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildNotifyInvocation, notify, planNotify } from "../extensions/notifier.ts";
import { buildLinuxNotifyInvocation } from "../extensions/notifiers/linux.ts";
import { buildMacOSNotifyInvocation } from "../extensions/notifiers/macos.ts";
import {
  buildWindowsNotifyInvocation,
  encodeNotificationPayload,
  resolvePowershellPath,
  WINDOWS_POWERSHELL_APP_ID,
  WINDOWS_TOAST_APP_ID,
  WINDOWS_TOAST_APP_NAME,
} from "../extensions/notifiers/windows.ts";

const injection = {
  title: "Pi'; calc.exe; #",
  message: `hello"; rm -rf /; $(whoami) && echo '完了'`,
};

describe("windows notifier", () => {
  test("本文は Base64 ペイロードとして渡し、スクリプトへ連結しない", () => {
    const invocation = buildWindowsNotifyInvocation(injection, "powershell.exe", {
      platform: "linux",
      env: {},
      exists: () => false,
    });

    assert.equal(invocation.command, "powershell.exe");
    assert.equal(invocation.args.includes("-Command"), true);

    const script = invocation.args.at(-1) ?? "";
    assert.equal(script.includes(injection.message), false);
    assert.equal(script.includes("calc.exe"), false);
    assert.equal(script.includes("rm -rf"), false);

    const payloadB64 = encodeNotificationPayload(injection);
    assert.equal(script.includes(payloadB64), true);
    assert.equal(script.includes("FromBase64String"), true);
    assert.equal(script.includes("CreateTextNode"), true);
    assert.equal(script.includes("ms-winsoundevent:Notification.Default"), true);
  });

  test("カスタム AUMID を登録し、失敗時は PowerShell へフォールバックする", () => {
    const invocation = buildWindowsNotifyInvocation(
      { title: "Done - Pi", message: "hello" },
      "powershell.exe",
      {
        platform: "linux",
        env: {},
        exists: () => false,
      },
    );
    const script = invocation.args.at(-1) ?? "";

    assert.equal(script.includes("AppUserModelId"), true);
    assert.equal(script.includes("DisplayName"), true);
    assert.equal(script.includes("IconUri"), true);
    assert.equal(script.includes("appLogoOverride"), true);
    assert.match(
      script,
      /if \(-not \(Test-Path -LiteralPath \$iconFile\) -or \(\(Get-Item -LiteralPath \$iconFile\)\.LastWriteTime -lt \(Get-Date\)\.AddDays\(-1\)\)\) \{ \[IO\.File\]::WriteAllBytes/,
    );
    assert.equal(script.includes(WINDOWS_TOAST_APP_ID), true);
    assert.equal(script.includes(WINDOWS_TOAST_APP_NAME), true);
    assert.equal(script.includes(WINDOWS_POWERSHELL_APP_ID), true);
    assert.match(script, /try \{[\s\S]*\$appId = 'Pi\.NativeNotify'[\s\S]*\} catch \{ \}/);
  });

  test("設定された powershellPath を優先する", () => {
    const custom = "/mnt/c/Custom/powershell.exe";
    assert.equal(
      resolvePowershellPath(custom, {
        platform: "linux",
        env: {},
        exists: () => false,
      }),
      custom,
    );
  });

  test("WSL では一般的な絶対パスへフォールバックする", () => {
    const wslPath =
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    assert.equal(
      resolvePowershellPath(undefined, {
        platform: "linux",
        env: {},
        exists: (path) => path === wslPath,
      }),
      wslPath,
    );
  });
});

describe("linux notifier", () => {
  test("notify-send に title/message を引数として渡す", () => {
    const invocation = buildLinuxNotifyInvocation(injection);
    assert.equal(invocation.command, "notify-send");
    assert.deepEqual(invocation.args, [
      "--app-name=Pi",
      "--urgency=normal",
      injection.title,
      injection.message,
    ]);
  });
});

describe("macos notifier", () => {
  test("osascript の argv として値を渡し、AppleScript へ連結しない", () => {
    const invocation = buildMacOSNotifyInvocation(injection);
    assert.equal(invocation.command, "osascript");
    assert.equal(invocation.args.includes(injection.title), true);
    assert.equal(invocation.args.includes(injection.message), true);

    const scriptParts = invocation.args.filter((_, index, args) => args[index - 1] === "-e");
    for (const part of scriptParts) {
      assert.equal(part.includes("calc.exe"), false);
      assert.equal(part.includes("rm -rf"), false);
    }
  });
});

describe("buildNotifyInvocation routing", () => {
  test("WSL は Windows バックエンドを選ぶ", () => {
    const invocation = buildNotifyInvocation(
      { title: "Pi", message: "done" },
      {
        probe: {
          platform: "linux",
          env: { WSL_DISTRO_NAME: "Ubuntu" },
        },
        powershellPath: "powershell.exe",
      },
    );
    assert.ok(invocation);
    assert.equal(invocation.command, "powershell.exe");
  });

  test("Linux native は notify-send を選ぶ", () => {
    const invocation = buildNotifyInvocation(
      { title: "Pi", message: "done" },
      {
        probe: {
          platform: "linux",
          env: {},
          readFile: () => "6.8.0-generic",
        },
      },
    );
    assert.ok(invocation);
    assert.equal(invocation.command, "notify-send");
  });

  test("macOS は osascript を選ぶ", () => {
    const invocation = buildNotifyInvocation(
      { title: "Pi", message: "done" },
      {
        probe: { platform: "darwin", env: {} },
      },
    );
    assert.ok(invocation);
    assert.equal(invocation.command, "osascript");
  });

  test("planNotify は環境とバックエンドを返す", () => {
    const plan = planNotify(
      { title: "Pi", message: "done" },
      {
        probe: {
          platform: "linux",
          env: { WSL_DISTRO_NAME: "Ubuntu" },
        },
        powershellPath: "powershell.exe",
      },
    );
    assert.equal(plan.environment, "wsl");
    assert.equal(plan.backend, "windows");
    assert.equal(plan.invocation?.command, "powershell.exe");
  });

  test("spawn 失敗でも notify は例外を投げない", async () => {
    await assert.doesNotReject(() =>
      notify(
        { title: "Pi", message: "done" },
        {
          probe: { platform: "linux", env: {}, readFile: () => "generic" },
          spawn: () => {
            throw new Error("ENOENT");
          },
        },
      ),
    );
  });
});
