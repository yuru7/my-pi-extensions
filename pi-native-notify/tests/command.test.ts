import assert from "node:assert/strict";
import { describe, test } from "node:test";
import factory from "../extensions/index.ts";

function createFakePi() {
  const events = new Map<string, (...args: never[]) => unknown>();
  const commands = new Map<
    string,
    { description?: string; handler: (...args: never[]) => unknown }
  >();

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
    events,
    commands,
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
    assert.equal(
      pi.commands.get("notify-settings")?.description,
      "Set the native notification threshold",
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
