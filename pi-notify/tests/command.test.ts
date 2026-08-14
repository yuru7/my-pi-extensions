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

    assert.equal(pi.events.has("before_agent_start"), true);
    assert.equal(pi.events.has("agent_start"), true);
    assert.equal(pi.events.has("agent_end"), false);
    assert.equal(pi.events.has("agent_settled"), true);
    assert.equal(pi.commands.has("notify-settings"), true);
    assert.equal(
      pi.commands.get("notify-settings")?.description,
      "ネイティブ通知の閾値を設定する",
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
    assert.match(notifications[0]?.[0] ?? "", /無効/);
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
