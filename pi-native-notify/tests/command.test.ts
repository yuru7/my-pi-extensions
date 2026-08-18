import assert from "node:assert/strict";
import { describe, test } from "node:test";
import factory from "../extensions/index.ts";
import { NOTIFY_TEST_ENTRY_TYPE } from "../extensions/notify-test.ts";

function createFakePi() {
  const events = new Map<string, (...args: never[]) => unknown>();
  const commands = new Map<
    string,
    { description?: string; handler: (...args: never[]) => unknown }
  >();
  const entries: Array<{ customType: string; data?: unknown }> = [];
  const entryRenderers = new Map<string, unknown>();

  return {
    on(name: string, handler: (...args: never[]) => unknown) {
      events.set(name, handler);
    },
    registerCommand(
      name: string,
      options: { description?: string; handler: (...args: never[]) => unknown },
    ) {
      commands.set(name, options);
    },
    registerEntryRenderer(customType: string, renderer: unknown) {
      entryRenderers.set(customType, renderer);
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ customType, data });
    },
    events,
    commands,
    entries,
    entryRenderers,
  };
}

describe("/notify-settings", () => {
  test("コマンドと agent イベントを登録する", () => {
    const pi = createFakePi();
    factory(pi as never);

    assert.equal(pi.events.has("session_start"), true);
    assert.equal(pi.events.has("session_shutdown"), true);
    assert.equal(pi.events.has("before_agent_start"), true);
    assert.equal(pi.events.has("agent_start"), true);
    assert.equal(pi.events.has("agent_end"), false);
    assert.equal(pi.events.has("agent_settled"), true);
    assert.equal(pi.commands.has("notify-settings"), true);
    assert.equal(pi.commands.has("notify-test"), true);
    assert.equal(pi.entryRenderers.has(NOTIFY_TEST_ENTRY_TYPE), true);
    assert.equal(
      pi.commands.get("notify-settings")?.description,
      "Set the native notification threshold",
    );
    assert.equal(
      pi.commands.get("notify-test")?.description,
      "Send a test native notification and show detection details",
    );
  });

  test("キャンセルと不正値では設定を変えない", async () => {
    const pi = createFakePi();
    factory(pi as never);
    const handler = pi.commands.get("notify-settings")?.handler;
    assert.ok(handler);

    const notifications: Array<[string, string]> = [];
    const ctx = {
      hasUI: true,
      ui: {
        input: async () => undefined,
        notify: (message: string, level: string) => {
          notifications.push([message, level]);
        },
      },
    };

    await handler("", ctx as never);
    assert.deepEqual(notifications, []);

    ctx.ui.input = async () => "abc";
    await handler("", ctx as never);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.[1], "error");
    assert.match(notifications[0]?.[0] ?? "", /Invalid/);
  });

  test("session_start でフォーカス追跡を開始し shutdown で停止する", async () => {
    const pi = createFakePi();
    const calls: string[] = [];
    factory(pi as never, {
      focusTracker: {
        attach: () => {
          calls.push("attach");
        },
        detach: () => {
          calls.push("detach");
        },
        isUnfocused: () => false,
      },
    });

    const start = pi.events.get("session_start");
    const shutdown = pi.events.get("session_shutdown");
    assert.ok(start);
    assert.ok(shutdown);

    await start(undefined as never, { hasUI: true } as never);
    await shutdown();
    assert.deepEqual(calls, ["attach", "detach"]);
  });

  test("hasUI が false ならフォーカス追跡しない", async () => {
    const pi = createFakePi();
    const calls: string[] = [];
    factory(pi as never, {
      focusTracker: {
        attach: () => {
          calls.push("attach");
        },
        detach: () => {
          calls.push("detach");
        },
        isUnfocused: () => false,
      },
    });

    const start = pi.events.get("session_start");
    assert.ok(start);
    await start(undefined as never, { hasUI: false } as never);
    assert.deepEqual(calls, []);
  });

  test("hasUI が false のときは対話しない", async () => {
    const pi = createFakePi();
    factory(pi as never);
    const handler = pi.commands.get("notify-settings")?.handler;
    assert.ok(handler);

    let called = false;
    await handler("", {
      hasUI: false,
      ui: {
        input: async () => {
          called = true;
          return "1";
        },
        notify: () => {},
      },
    } as never);
    assert.equal(called, false);
  });
});

describe("/notify-test", () => {
  function createUi() {
    const notifications: Array<[string, string]> = [];
    return {
      notifications,
      ctx: {
        hasUI: true,
        ui: {
          notify: (message: string, level: string) => {
            notifications.push([message, level]);
          },
        },
      },
    };
  }

  test("送信成功なら診断と成功メッセージを出す", async () => {
    const pi = createFakePi();
    factory(pi as never, {
      runNotifyTest: async () => ({
        environment: "wsl",
        platform: "linux",
        backend: "windows",
        invocation: {
          command: "powershell.exe",
          args: ["-NoProfile", "-Command", "script"],
        },
        wslDistro: "Ubuntu",
        sent: true,
      }),
    });
    const handler = pi.commands.get("notify-test")?.handler;
    assert.ok(handler);

    const ui = createUi();
    await handler("", ui.ctx as never);

    assert.equal(ui.notifications.length, 1);
    assert.equal(ui.notifications[0]?.[1], "info");
    assert.match(ui.notifications[0]?.[0] ?? "", /Test notification sent/);
    const entry = pi.entries[0];
    assert.equal(entry?.customType, NOTIFY_TEST_ENTRY_TYPE);
    const lines = (entry?.data as { lines: string[] }).lines;
    assert.equal(lines[1], "environment: wsl");
    assert.equal(lines[4], "backend: Windows toast (PowerShell)");
    assert.equal(lines.at(-1), "result: sent");
  });

  test("失敗なら error 通知を出す", async () => {
    const pi = createFakePi();
    factory(pi as never, {
      runNotifyTest: async () => ({
        environment: "linux",
        platform: "linux",
        backend: "linux",
        invocation: { command: "notify-send", args: [] },
        sent: false,
        error: "command not found: notify-send",
      }),
    });
    const handler = pi.commands.get("notify-test")?.handler;
    assert.ok(handler);

    const ui = createUi();
    await handler("", ui.ctx as never);
    assert.deepEqual(ui.notifications, [
      ["command not found: notify-send", "error"],
    ]);
    const lines = (pi.entries[0]?.data as { lines: string[] }).lines;
    assert.equal(lines.at(-1), "error: command not found: notify-send");
  });

  test("未対応環境なら warning を出す", async () => {
    const pi = createFakePi();
    factory(pi as never, {
      runNotifyTest: async () => ({
        environment: "unsupported",
        platform: "freebsd",
        backend: null,
        invocation: null,
        sent: false,
      }),
    });
    const handler = pi.commands.get("notify-test")?.handler;
    assert.ok(handler);

    const ui = createUi();
    await handler("", ui.ctx as never);
    assert.deepEqual(ui.notifications, [
      ["No notification backend for this platform.", "warning"],
    ]);
  });

  test("hasUI が false のときは実行しない", async () => {
    let called = false;
    const pi = createFakePi();
    factory(pi as never, {
      runNotifyTest: async () => {
        called = true;
        return {
          environment: "linux",
          platform: "linux",
          backend: "linux",
          invocation: null,
          sent: false,
        };
      },
    });
    const handler = pi.commands.get("notify-test")?.handler;
    assert.ok(handler);

    await handler("", { hasUI: false, ui: { notify: () => {} } } as never);
    assert.equal(called, false);
  });
});
