import assert from "node:assert/strict";
import { describe, test } from "node:test";
import factory from "../extensions/pi-rollback.ts";

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

describe("/rollback command", () => {
  test("registers lifecycle events and the rollback command", () => {
    const pi = createFakePi();
    factory(pi as never);

    assert.equal(pi.events.has("session_start"), true);
    assert.equal(pi.events.has("session_shutdown"), true);
    assert.equal(pi.events.has("session_tree"), true);
    assert.equal(pi.events.has("tool_call"), true);
    assert.equal(pi.events.has("tool_result"), true);
    assert.equal(pi.commands.has("rollback"), true);
    assert.equal(
      pi.commands.get("rollback")?.description,
      "Rollback files and conversation to a previous user turn",
    );
  });

  test("tool_call never returns a block result", async () => {
    const pi = createFakePi();
    factory(pi as never);
    const handler = pi.events.get("tool_call");
    assert.ok(handler);
    const result = await handler(
      {
        toolName: "write",
        toolCallId: "t1",
        input: { path: "x.ts", content: "hi" },
      } as never,
      {
        cwd: process.cwd(),
        sessionManager: {
          getBranch: () => [],
          getSessionId: () => "s1",
        },
        ui: { notify() {} },
      } as never,
    );
    assert.equal(result, undefined);
  });
});
