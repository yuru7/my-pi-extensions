import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import factory from "../extensions/pi-undo.ts";
import { DEFAULT_CONFIG, getConfigPath, getStoreRoot, loadConfig, saveConfig } from "../src/config.ts";
import { SessionJournal } from "../src/mutation-journal.ts";
import { ObjectStore } from "../src/store.ts";
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

describe("/undo command", () => {
  test("registers lifecycle events and the undo command", () => {
    const { pi } = setup();

    assert.equal(pi.events.has("session_start"), true);
    assert.equal(pi.events.has("session_shutdown"), true);
    assert.equal(pi.events.has("session_tree"), true);
    assert.equal(pi.events.has("session_before_tree"), true);
    assert.equal(pi.events.has("tool_call"), true);
    assert.equal(pi.events.has("tool_result"), true);
    assert.equal(pi.commands.has("undo"), true);
    assert.equal(pi.commands.has("undo:reset-setting"), true);
    assert.equal(pi.commands.has("undo:clear-undo-store"), true);
    assert.equal(
      pi.commands.get("undo")?.description,
      "Undo files and conversation to a previous user turn",
    );
    assert.equal(
      pi.commands.get("undo:reset-setting")?.description,
      "Reset pi-undo configuration to the built-in defaults",
    );
    assert.equal(
      pi.commands.get("undo:clear-undo-store")?.description,
      "Permanently delete all stored undo snapshots",
    );
  });

  test("/undo list omits numbers for turns without file changes", async () => {
    const { pi, home } = setup();
    const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
    const stored = store.put(Buffer.from("snapshot-bytes"));
    new SessionJournal(store, "s1").appendMutation({
      sessionId: "s1",
      turnEntryId: "u-files",
      toolCallId: "c1",
      toolName: "write",
      path: "/tmp/x",
      key: "/tmp/x",
      pre: { kind: "file", sha256: stored.sha256, size: 14 },
      post: { kind: "absent" },
      coverage: "exact",
      timestamp: new Date().toISOString(),
    });

    const start = pi.events.get("session_start");
    assert.ok(start);
    await start(undefined as never, {
      cwd: process.cwd(),
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
      ui: { notify() {} },
    } as never);

    const handler = pi.commands.get("undo")?.handler;
    assert.ok(handler);
    await handler("", {
      hasUI: true,
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [
          { id: "u-files", message: { role: "user", content: "edit files", timestamp: 1 } },
          { id: "u-chat", message: { role: "user", content: "just chatting", timestamp: 2 } },
        ],
      },
      cwd: process.cwd(),
      waitForIdle: async () => {},
      ui: { notify() {} },
    } as never);

    const list = pi.entries.find((entry) => entry.customType === "pi-undo/list");
    assert.ok(list);
    const lines = (list.data as { lines: Array<{ text: string; dim?: boolean }> }).lines;
    assert.equal(lines[0]?.text, "Undo points (1 = newest):");
    assert.equal(lines[1]?.dim, undefined);
    assert.match(lines[1]?.text ?? "", /^1  /);
    assert.match(lines[1]?.text ?? "", /edit files/);
    assert.equal(lines[2]?.dim, true);
    assert.match(lines[2]?.text ?? "", /^ {1}  /);
    assert.match(lines[2]?.text ?? "", /just chatting/);
    assert.match(lines[2]?.text ?? "", /no file changes/);
  });

  test("/undo <N> ignores turns that did not change files", async () => {
    const { pi, home } = setup();
    const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
    const stored = store.put(Buffer.from("snapshot-bytes"));
    new SessionJournal(store, "s1").appendMutation({
      sessionId: "s1",
      turnEntryId: "u-files",
      toolCallId: "c1",
      toolName: "write",
      path: "/tmp/x",
      key: "/tmp/x",
      pre: { kind: "file", sha256: stored.sha256, size: 14 },
      post: { kind: "absent" },
      coverage: "exact",
      timestamp: new Date().toISOString(),
    });

    const start = pi.events.get("session_start");
    assert.ok(start);
    await start(undefined as never, {
      cwd: process.cwd(),
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
      ui: { notify() {} },
    } as never);

    const handler = pi.commands.get("undo")?.handler;
    assert.ok(handler);
    const notifications: string[] = [];
    let navigatedTo: string | undefined;
    const ctx = {
      hasUI: true,
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [
          { id: "u-files", message: { role: "user", content: "edit files", timestamp: 1 } },
          { id: "u-chat", message: { role: "user", content: "just chatting", timestamp: 2 } },
        ],
      },
      cwd: process.cwd(),
      waitForIdle: async () => {},
      navigateTree: async (id: string) => {
        navigatedTo = id;
        return {};
      },
      ui: {
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    };

    await handler("1", ctx as never);
    assert.equal(navigatedTo, "u-files");

    navigatedTo = undefined;
    await handler("2", ctx as never);
    assert.equal(navigatedTo, undefined);
    assert.equal(notifications.some((message) => message.includes("No undo point 2")), true);
  });

  test("writes the default config file when it is missing", async () => {
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

  test("/undo:reset-setting restores defaults after confirmation", async () => {
    const { pi, home } = setup();
    const path = getConfigPath(home);
    saveConfig({ ...DEFAULT_CONFIG, syncTree: false, enabled: false }, path);
    const handler = pi.commands.get("undo:reset-setting")?.handler;
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

  test("/undo:reset-setting does nothing when cancelled", async () => {
    const { pi, home } = setup();
    const path = getConfigPath(home);
    saveConfig({ ...DEFAULT_CONFIG, syncTree: false }, path);
    const handler = pi.commands.get("undo:reset-setting")?.handler;
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

  test("/undo:reset-setting writes defaults when there is no confirm UI", async () => {
    const { pi, home } = setup();
    const path = getConfigPath(home);
    saveConfig({ ...DEFAULT_CONFIG, syncTree: false }, path);
    const handler = pi.commands.get("undo:reset-setting")?.handler;
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

function seedStore(
  home: string,
  sessionIds: string[] = ["old-session"],
): { hash: string; sessionIds: string[] } {
  const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
  const stored = store.put(Buffer.from("snapshot-bytes"));
  for (const sessionId of sessionIds) {
    const journal = new SessionJournal(store, sessionId);
    journal.appendMutation({
      sessionId,
      turnEntryId: "t1",
      toolCallId: "c1",
      toolName: "write",
      path: "/tmp/x",
      key: "/tmp/x",
      pre: { kind: "file", sha256: stored.sha256, size: 14 },
      post: { kind: "absent" },
      coverage: "exact",
      timestamp: new Date().toISOString(),
    });
  }
  const journalDir = store.journalDir("tx-1");
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(join(journalDir, "entry.json"), "{}\n");
  return { hash: stored.sha256, sessionIds };
}

function commandCtx(options: {
  confirm?: boolean;
  notifications?: string[];
  hasUI?: boolean;
}) {
  return {
    hasUI: options.hasUI ?? true,
    sessionManager: { getSessionId: () => "s1" },
    cwd: process.cwd(),
    waitForIdle: async () => {},
    ui: {
      confirm: async () => options.confirm ?? true,
      notify: (message: string) => {
        options.notifications?.push(message);
      },
    },
  } as never;
}

describe("/undo:clear-undo-store command", () => {
  test("wipes stored snapshots including the current session", async () => {
    const { pi, home } = setup();
    const { hash, sessionIds } = seedStore(home, ["old-session", "s1"]);
    const handler = pi.commands.get("undo:clear-undo-store")?.handler;
    assert.ok(handler);

    const notifications: string[] = [];
    await handler("", commandCtx({ confirm: true, notifications }));

    const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
    assert.equal(store.has(hash), false);
    for (const sessionId of sessionIds) {
      assert.equal(existsSync(join(store.sessionDir(sessionId), "mutations.jsonl")), false);
    }
    assert.equal(existsSync(join(store.journalDir("tx-1"), "entry.json")), false);
    assert.equal(existsSync(join(getStoreRoot(home), "maintenance.json")), false);
    assert.deepEqual(JSON.parse(readFileSync(getConfigPath(home), "utf8")), DEFAULT_CONFIG);
    assert.equal(notifications.some((message) => message.includes("stored undo data was removed")), true);
  });

  test("does nothing when cancelled", async () => {
    const { pi, home } = setup();
    const { hash, sessionIds } = seedStore(home, ["old-session", "s1"]);
    const handler = pi.commands.get("undo:clear-undo-store")?.handler;
    assert.ok(handler);

    await handler("", commandCtx({ confirm: false }));

    const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
    assert.equal(store.has(hash), true);
    for (const sessionId of sessionIds) {
      assert.equal(existsSync(join(store.sessionDir(sessionId), "mutations.jsonl")), true);
    }
  });

  test("wipes the store when there is no confirm UI", async () => {
    const { pi, home } = setup();
    const { hash, sessionIds } = seedStore(home, ["s1"]);
    const handler = pi.commands.get("undo:clear-undo-store")?.handler;
    assert.ok(handler);

    await handler("", commandCtx({ hasUI: false }));

    const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
    assert.equal(store.has(hash), false);
    assert.equal(existsSync(join(store.sessionDir(sessionIds[0]), "mutations.jsonl")), false);
  });

  test("lets the current session snapshot again after a wipe", async () => {
    const { pi, home } = setup();
    seedStore(home, ["s1"]);
    const handler = pi.commands.get("undo:clear-undo-store")?.handler;
    assert.ok(handler);
    await handler("", commandCtx({ confirm: true }));

    const status = pi.commands.get("undo")?.handler;
    assert.ok(status);
    await status("status", {
      hasUI: true,
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [],
      },
      cwd: process.cwd(),
      waitForIdle: async () => {},
      ui: { notify() {} },
    } as never);

    const statusEntry = pi.entries.find((entry) => entry.customType === "pi-undo/status");
    assert.ok(statusEntry);
    const lines = (statusEntry.data as { lines: Array<{ text: string }> }).lines;
    assert.equal(lines.some((line) => line.text.includes("tracked files: 0")), true);
    assert.equal(lines.some((line) => line.text.includes("0 MB /")), true);
  });
});
