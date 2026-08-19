import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import factory from "../extensions/pi-rollback.ts";
import { DEFAULT_CONFIG, getConfigPath, loadConfig, saveConfig } from "../src/config.ts";
import { cleanupTempDirs, tempDir } from "./helpers.ts";

afterEach(() => {
  cleanupTempDirs();
});

function createFakePi() {
  const events = new Map<string, (...args: never[]) => unknown>();
  const commands = new Map<
    string,
    { description?: string; handler: (args: string, ctx: unknown) => unknown }
  >();
  const entries: Array<{ customType: string; data?: unknown }> = [];
  const entryRenderers = new Map<string, unknown>();

  return {
    on(name: string, handler: (...args: never[]) => unknown) {
      events.set(name, handler);
    },
    registerCommand(
      name: string,
      options: { description?: string; handler: (args: string, ctx: unknown) => unknown },
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

function setup() {
  const home = tempDir();
  const pi = createFakePi();
  factory(pi as never, { home });
  return { pi, home };
}

describe("/rollback command", () => {
  test("registers lifecycle events and the rollback command", () => {
    const { pi } = setup();

    assert.equal(pi.events.has("session_start"), true);
    assert.equal(pi.events.has("session_shutdown"), true);
    assert.equal(pi.events.has("session_tree"), true);
    assert.equal(pi.events.has("session_before_tree"), true);
    assert.equal(pi.events.has("tool_call"), true);
    assert.equal(pi.events.has("tool_result"), true);
    assert.equal(pi.commands.has("rollback"), true);
    assert.equal(pi.commands.has("rollback-setting-reset"), true);
    assert.equal(
      pi.commands.get("rollback")?.description,
      "Rollback files and conversation to a previous user turn",
    );
    assert.equal(
      pi.commands.get("rollback-setting-reset")?.description,
      "Reset pi-rollback configuration to the built-in defaults",
    );
  });

  test("writes the default config file when it is missing", () => {
    const { home } = setup();
    const path = getConfigPath(home);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), DEFAULT_CONFIG);
  });

  test("tool_call never returns a block result", async () => {
    const { pi } = setup();
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

  test("session_tree with no runtime is a no-op", async () => {
    const { pi } = setup();
    const handler = pi.events.get("session_tree");
    assert.ok(handler);
    await handler(
      { newLeafId: "u1", oldLeafId: "u2" } as never,
      {
        hasUI: false,
        cwd: process.cwd(),
        sessionManager: {
          getBranch: () => [],
          getSessionId: () => "s1",
        },
        ui: { notify() {} },
      } as never,
    );
  });

  test("/rollback-setting-reset restores defaults after confirmation", async () => {
    const { pi, home } = setup();
    const path = getConfigPath(home);
    saveConfig({ ...DEFAULT_CONFIG, syncTree: false, enabled: false }, path);
    const handler = pi.commands.get("rollback-setting-reset")?.handler;
    assert.ok(handler);

    const notifications: string[] = [];
    await handler("", {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1" },
      cwd: process.cwd(),
      ui: {
        confirm: async () => true,
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    } as never);

    assert.equal(loadConfig(path).config.syncTree, true);
    assert.equal(loadConfig(path).config.enabled, true);
    assert.equal(notifications.some((message) => message.includes("reset to defaults")), true);
  });

  test("/rollback-setting-reset does nothing when cancelled", async () => {
    const { pi, home } = setup();
    const path = getConfigPath(home);
    saveConfig({ ...DEFAULT_CONFIG, syncTree: false }, path);
    const handler = pi.commands.get("rollback-setting-reset")?.handler;
    assert.ok(handler);

    await handler("", {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1" },
      cwd: process.cwd(),
      ui: {
        confirm: async () => false,
        notify() {},
      },
    } as never);

    assert.equal(loadConfig(path).config.syncTree, false);
  });

  test("/rollback-setting-reset writes defaults when there is no confirm UI", async () => {
    const { pi, home } = setup();
    const path = getConfigPath(home);
    saveConfig({ ...DEFAULT_CONFIG, syncTree: false }, path);
    const handler = pi.commands.get("rollback-setting-reset")?.handler;
    assert.ok(handler);

    await handler("", {
      hasUI: false,
      sessionManager: { getSessionId: () => "s1" },
      cwd: process.cwd(),
      ui: { notify() {} },
    } as never);

    assert.equal(loadConfig(path).config.syncTree, true);
  });
});
