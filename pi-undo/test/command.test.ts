import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import factory from "../extensions/pi-undo.ts";
import { DEFAULT_CONFIG, getConfigPath, getStoreRoot, loadConfig, saveConfig } from "../src/config.ts";
import { SessionJournal } from "../src/mutation-journal.ts";
import { ObjectStore } from "../src/store.ts";
import {
  formatOverwriteSelectTitle,
  formatTreeRestoreSelectTitle,
  OVERWRITE_SELECT_NO,
  OVERWRITE_SELECT_YES,
  overwriteSelectOptions,
  TREE_RESTORE_SELECT_NO,
  TREE_RESTORE_SELECT_YES,
  treeRestoreSelectOptions,
} from "../src/undo.ts";
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
    assert.equal(pi.commands.has("undo-list"), true);
    assert.equal(pi.commands.has("undo-diff"), true);
    assert.equal(pi.commands.has("undo-start"), true);
    assert.equal(pi.commands.has("undo-status"), true);
    assert.equal(pi.commands.has("edited-file-list"), true);
    assert.equal(pi.commands.has("redo"), true);
    assert.equal(pi.commands.has("pi-undo:reset-setting"), true);
    assert.equal(pi.commands.has("pi-undo:clear-undo-store"), true);
    assert.equal(
      pi.commands.get("undo")?.description,
      "Undo files and conversation to a previous restore point",
    );
    assert.equal(
      pi.commands.get("undo-list")?.description,
      "List undo points in the current session",
    );
    assert.equal(
      pi.commands.get("undo-diff")?.description,
      "Preview files that /undo <N> would restore",
    );
    assert.equal(
      pi.commands.get("undo-start")?.description,
      "Restore this session's files and start a new empty session",
    );
    assert.equal(
      pi.commands.get("undo-status")?.description,
      "Show pi-undo status for the current session",
    );
    assert.equal(
      pi.commands.get("edited-file-list")?.description,
      "List files changed since this session started",
    );
    assert.equal(
      pi.commands.get("redo")?.description,
      "Restore conversation and files to the state before the last /undo",
    );
    assert.equal(
      pi.commands.get("pi-undo:reset-setting")?.description,
      "Reset pi-undo configuration to the built-in defaults",
    );
    assert.equal(
      pi.commands.get("pi-undo:clear-undo-store")?.description,
      "Permanently delete all stored undo snapshots",
    );
  });

  test("/undo-list omits numbers for turns without file changes", async () => {
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

    const handler = pi.commands.get("undo-list")?.handler;
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

  test("/undo-list numbers external edits between Pi writes", async () => {
    const { pi, home } = setup();
    const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
    const hog = store.put(Buffer.from("hog"));
    const fuga = store.put(Buffer.from("hog\nfuga\n"));
    const ten = store.put(Buffer.from("ten chars!"));
    const orig = store.put(Buffer.from("t0"));
    const journal = new SessionJournal(store, "s1");
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u1",
      toolCallId: "c1",
      toolName: "write",
      path: "/tmp/x",
      key: "/tmp/x",
      pre: { kind: "file", sha256: orig.sha256, size: orig.bytes },
      post: { kind: "file", sha256: hog.sha256, size: hog.bytes },
      coverage: "exact",
      timestamp: "2020-01-01T00:00:00.000Z",
    });
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u2",
      toolCallId: "c2",
      toolName: "write",
      path: "/tmp/x",
      key: "/tmp/x",
      pre: { kind: "file", sha256: fuga.sha256, size: fuga.bytes },
      post: { kind: "file", sha256: ten.sha256, size: ten.bytes },
      coverage: "exact",
      timestamp: "2020-01-01T00:01:00.000Z",
    });

    const start = pi.events.get("session_start");
    assert.ok(start);
    await start(undefined as never, {
      cwd: process.cwd(),
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
      ui: { notify() {} },
    } as never);

    const handler = pi.commands.get("undo-list")?.handler;
    assert.ok(handler);
    await handler("", {
      hasUI: true,
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [
          { id: "u1", message: { role: "user", content: "three chars", timestamp: 1 } },
          { id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1" }] } },
          { id: "r1", message: { role: "toolResult", toolCallId: "c1", toolName: "write" } },
          { id: "u2", message: { role: "user", content: "ten chars", timestamp: 2 } },
          { id: "a2", message: { role: "assistant", content: [{ type: "toolCall", id: "c2" }] } },
          { id: "r2", message: { role: "toolResult", toolCallId: "c2", toolName: "write" } },
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
    assert.match(lines[1]?.text ?? "", /^3  /);
    assert.match(lines[1]?.text ?? "", /three chars/);
    assert.match(lines[2]?.text ?? "", /^2  /);
    assert.match(lines[2]?.text ?? "", /\(external edit\)/);
    assert.match(lines[3]?.text ?? "", /^1  /);
    assert.match(lines[3]?.text ?? "", /ten chars/);
  });

  test("/undo to an external edit restores Pi's last write", async () => {
    const { pi, home } = setup();
    const cwd = tempDir();
    const file = join(cwd, "hoge");
    writeFileSync(file, "ext1");
    const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
    const one = store.put(Buffer.from("1"));
    const two = store.put(Buffer.from("2"));
    const ext = store.put(Buffer.from("ext1"));
    const three = store.put(Buffer.from("3"));
    const orig = store.put(Buffer.from("0"));
    const mode = statSync(file).mode & 0o777;
    const journal = new SessionJournal(store, "s1");
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u1",
      toolCallId: "c1",
      toolName: "write",
      path: file,
      key: file,
      pre: { kind: "file", sha256: orig.sha256, size: orig.bytes, mode },
      post: { kind: "file", sha256: one.sha256, size: one.bytes, mode },
      coverage: "exact",
      timestamp: "2020-01-01T00:07:00.000Z",
    });
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u2",
      toolCallId: "c2",
      toolName: "write",
      path: file,
      key: file,
      pre: { kind: "file", sha256: one.sha256, size: one.bytes, mode },
      post: { kind: "file", sha256: two.sha256, size: two.bytes, mode },
      coverage: "exact",
      timestamp: "2020-01-01T00:08:00.000Z",
    });
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u3",
      toolCallId: "c3",
      toolName: "write",
      path: file,
      key: file,
      pre: { kind: "file", sha256: ext.sha256, size: ext.bytes, mode },
      post: { kind: "file", sha256: three.sha256, size: three.bytes, mode },
      coverage: "exact",
      timestamp: "2020-01-01T00:09:00.000Z",
    });

    const start = pi.events.get("session_start");
    assert.ok(start);
    await start(undefined as never, {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
      ui: { notify() {} },
    } as never);

    const branch = [
      { id: "u1", message: { role: "user", content: "write 1", timestamp: 1 } },
      { id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1" }] } },
      { id: "r1", message: { role: "toolResult", toolCallId: "c1", toolName: "write" } },
      { id: "u2", message: { role: "user", content: "write 2", timestamp: 2 } },
      { id: "a2", message: { role: "assistant", content: [{ type: "toolCall", id: "c2" }] } },
      { id: "r2", message: { role: "toolResult", toolCallId: "c2", toolName: "write" } },
    ];
    const getBranch = (fromId?: string) => {
      if (!fromId) {
        return branch;
      }
      const index = branch.findIndex((entry) => entry.id === fromId);
      return index === -1 ? branch : branch.slice(0, index + 1);
    };
    const undo = pi.commands.get("undo")?.handler;
    assert.ok(undo);
    await undo("1", {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      waitForIdle: async () => {},
      navigateTree: async () => ({}),
      ui: { notify() {} },
    } as never);

    assert.equal(readFileSync(file, "utf8"), "2");

    pi.entries.length = 0;
    const list = pi.commands.get("undo-list")?.handler;
    assert.ok(list);
    await list("", {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      waitForIdle: async () => {},
      ui: { notify() {} },
    } as never);
    const listed = pi.entries.find((entry) => entry.customType === "pi-undo/list");
    assert.ok(listed);
    const texts = (listed.data as { lines: Array<{ text: string }> }).lines.map((line) => line.text);
    assert.equal(texts.some((text) => text.includes("external edit")), false);
    assert.match(texts[1] ?? "", /write 1/);
    assert.match(texts[2] ?? "", /write 2/);
  });

  test("/redo after undoing an external edit restores the outside change", async () => {
    const { pi, home } = setup();
    const cwd = tempDir();
    const file = join(cwd, "hoge");
    writeFileSync(file, "ext");
    const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
    const one = store.put(Buffer.from("1"));
    const two = store.put(Buffer.from("2"));
    const ext = store.put(Buffer.from("ext"));
    const three = store.put(Buffer.from("3"));
    const orig = store.put(Buffer.from("0"));
    const mode = statSync(file).mode & 0o777;
    const journal = new SessionJournal(store, "s1");
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u1",
      toolCallId: "c1",
      toolName: "write",
      path: file,
      key: file,
      pre: { kind: "file", sha256: orig.sha256, size: orig.bytes, mode },
      post: { kind: "file", sha256: one.sha256, size: one.bytes, mode },
      coverage: "exact",
      timestamp: "2020-01-01T00:07:00.000Z",
    });
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u2",
      toolCallId: "c2",
      toolName: "write",
      path: file,
      key: file,
      pre: { kind: "file", sha256: one.sha256, size: one.bytes, mode },
      post: { kind: "file", sha256: two.sha256, size: two.bytes, mode },
      coverage: "exact",
      timestamp: "2020-01-01T00:08:00.000Z",
    });
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u3",
      toolCallId: "c3",
      toolName: "write",
      path: file,
      key: file,
      pre: { kind: "file", sha256: ext.sha256, size: ext.bytes, mode },
      post: { kind: "file", sha256: three.sha256, size: three.bytes, mode },
      coverage: "exact",
      timestamp: "2020-01-01T00:09:00.000Z",
    });

    const start = pi.events.get("session_start");
    assert.ok(start);
    await start(undefined as never, {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
      ui: { notify() {} },
    } as never);

    const branch = [
      { id: "u1", message: { role: "user", content: "write 1", timestamp: 1 } },
      { id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1" }] } },
      { id: "r1", message: { role: "toolResult", toolCallId: "c1", toolName: "write" } },
      { id: "u2", message: { role: "user", content: "write 2", timestamp: 2 } },
      { id: "a2", message: { role: "assistant", content: [{ type: "toolCall", id: "c2" }] } },
      { id: "r2", message: { role: "toolResult", toolCallId: "c2", toolName: "write" } },
    ];
    const getBranch = (fromId?: string) => {
      if (!fromId) {
        return branch;
      }
      const index = branch.findIndex((entry) => entry.id === fromId);
      return index === -1 ? branch : branch.slice(0, index + 1);
    };
    const notifications: string[] = [];
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      waitForIdle: async () => {},
      navigateTree: async () => ({}),
      ui: {
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    };
    const undo = pi.commands.get("undo")?.handler;
    const redo = pi.commands.get("redo")?.handler;
    const list = pi.commands.get("undo-list")?.handler;
    assert.ok(undo);
    assert.ok(redo);
    assert.ok(list);

    await undo("1", ctx as never);
    assert.equal(readFileSync(file, "utf8"), "2");

    notifications.length = 0;
    await redo("", ctx as never);
    assert.equal(readFileSync(file, "utf8"), "ext");
    assert.equal(notifications.some((message) => message.includes("Nothing to redo.")), false);

    pi.entries.length = 0;
    await list("", ctx as never);
    const listed = pi.entries.find((entry) => entry.customType === "pi-undo/list");
    assert.ok(listed);
    const texts = (listed.data as { lines: Array<{ text: string }> }).lines.map((line) => line.text);
    assert.equal(texts.some((text) => text.includes("external edit")), true);
    assert.match(texts[1] ?? "", /write 1/);
    assert.match(texts[2] ?? "", /write 2/);
    assert.match(texts[3] ?? "", /\(external edit\)/);
  });

  test("/undo of the newest turn restores the external edit before that turn, not the previous Pi write", async () => {
    const { pi, home } = setup();
    const cwd = tempDir();
    const file = join(cwd, "hoge");
    writeFileSync(file, "3");
    const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
    const zero = store.put(Buffer.from("0"));
    const one = store.put(Buffer.from("1"));
    const two = store.put(Buffer.from("2"));
    const ext = store.put(Buffer.from("ext"));
    const three = store.put(Buffer.from("3"));
    const mode = statSync(file).mode & 0o777;
    const journal = new SessionJournal(store, "s1");
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u1",
      toolCallId: "c1",
      toolName: "write",
      path: file,
      key: file,
      pre: { kind: "file", sha256: zero.sha256, size: zero.bytes, mode },
      post: { kind: "file", sha256: one.sha256, size: one.bytes, mode },
      coverage: "exact",
      timestamp: "2020-01-01T00:07:00.000Z",
    });
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u2",
      toolCallId: "c2",
      toolName: "write",
      path: file,
      key: file,
      pre: { kind: "file", sha256: one.sha256, size: one.bytes, mode },
      post: { kind: "file", sha256: two.sha256, size: two.bytes, mode },
      coverage: "exact",
      timestamp: "2020-01-01T00:08:00.000Z",
    });
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u3",
      toolCallId: "c3",
      toolName: "write",
      path: file,
      key: file,
      pre: { kind: "file", sha256: ext.sha256, size: ext.bytes, mode },
      post: { kind: "file", sha256: three.sha256, size: three.bytes, mode },
      coverage: "exact",
      timestamp: "2020-01-01T00:09:00.000Z",
    });

    const start = pi.events.get("session_start");
    assert.ok(start);
    await start(undefined as never, {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
      ui: { notify() {} },
    } as never);

    type BranchEntry = {
      id: string;
      parentId: string | null;
      message?: { role: string; content?: unknown; toolCallId?: string; toolName?: string };
    };
    const byId: Record<string, BranchEntry> = {
      u1: { id: "u1", parentId: null, message: { role: "user", content: "write 1" } },
      a1: { id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1" }] } },
      r1: { id: "r1", parentId: "a1", message: { role: "toolResult", toolCallId: "c1", toolName: "write" } },
      u2: { id: "u2", parentId: "r1", message: { role: "user", content: "write 2" } },
      a2: { id: "a2", parentId: "u2", message: { role: "assistant", content: [{ type: "toolCall", id: "c2" }] } },
      r2: { id: "r2", parentId: "a2", message: { role: "toolResult", toolCallId: "c2", toolName: "write" } },
      u3: { id: "u3", parentId: "r2", message: { role: "user", content: "write 3" } },
      a3: { id: "a3", parentId: "u3", message: { role: "assistant", content: [{ type: "toolCall", id: "c3" }] } },
      r3: { id: "r3", parentId: "a3", message: { role: "toolResult", toolCallId: "c3", toolName: "write" } },
    };
    const pathTo = (id: string) => {
      const path: BranchEntry[] = [];
      let current: string | null = id;
      while (current) {
        const entry: BranchEntry | undefined = byId[current];
        if (!entry) {
          break;
        }
        path.unshift(entry);
        current = entry.parentId;
      }
      return path;
    };
    let leafId = "r3";
    const getBranch = (fromId?: string) => pathTo(fromId ?? leafId);
    const sessionTree = pi.events.get("session_tree");
    assert.ok(sessionTree);
    const undo = pi.commands.get("undo")?.handler;
    assert.ok(undo);
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      waitForIdle: async () => {},
      navigateTree: async (id: string) => {
        const target = byId[id];
        const oldLeafId = leafId;
        leafId = target?.message?.role === "user" ? (target.parentId ?? id) : id;
        await sessionTree({ newLeafId: leafId, oldLeafId, fromExtension: true } as never, ctx as never);
        return {};
      },
      ui: { notify() {} },
    };

    await undo("", ctx as never);

    assert.equal(leafId, "r2");
    assert.equal(readFileSync(file, "utf8"), "ext");
  });

  test("/undo-diff without a number is the same as /undo-diff 1", async () => {
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

    const handler = pi.commands.get("undo-diff")?.handler;
    assert.ok(handler);
    const ctx = {
      hasUI: true,
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [
          { id: "u-files", message: { role: "user", content: "edit files", timestamp: 1 } },
        ],
      },
      cwd: process.cwd(),
      waitForIdle: async () => {},
      ui: { notify() {} },
    };

    await handler("", ctx as never);
    const first = pi.entries.find((entry) => entry.customType === "pi-undo/diff");
    assert.ok(first);
    const firstLines = (first.data as { lines: Array<{ text: string }> }).lines;
    assert.equal(firstLines[0]?.text, "Undo to turn 1");

    await handler("1", ctx as never);
    const diffs = pi.entries.filter((entry) => entry.customType === "pi-undo/diff");
    assert.equal(diffs.length, 2);
    const secondLines = (diffs[1]?.data as { lines: Array<{ text: string }> }).lines;
    assert.equal(secondLines[0]?.text, "Undo to turn 1");
  });

  test("/edited-file-list shows unique relative paths for the current branch", async () => {
    const { pi, home } = setup();
    const cwd = tempDir();
    const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
    const stored = store.put(Buffer.from("snapshot-bytes"));
    const journal = new SessionJournal(store, "s1");
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u1",
      toolCallId: "c1",
      toolName: "write",
      path: join(cwd, "src", "b.ts"),
      key: join(cwd, "src", "b.ts"),
      pre: { kind: "file", sha256: stored.sha256, size: 14 },
      post: { kind: "absent" },
      coverage: "exact",
      timestamp: new Date().toISOString(),
    });
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u1",
      toolCallId: "c2",
      toolName: "write",
      path: join(cwd, "src", "a.ts"),
      key: join(cwd, "src", "a.ts"),
      pre: { kind: "file", sha256: stored.sha256, size: 14 },
      post: { kind: "absent" },
      coverage: "exact",
      timestamp: new Date().toISOString(),
    });
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u1",
      toolCallId: "c2",
      toolName: "write",
      path: join(cwd, "src", "a.ts"),
      key: join(cwd, "src", "a.ts"),
      pre: { kind: "file", sha256: stored.sha256, size: 14 },
      post: { kind: "absent" },
      coverage: "exact",
      timestamp: new Date().toISOString(),
    });
    journal.appendMutation({
      sessionId: "s1",
      turnEntryId: "u-other",
      toolCallId: "c-other",
      toolName: "write",
      path: join(cwd, "src", "skip.ts"),
      key: join(cwd, "src", "skip.ts"),
      pre: { kind: "file", sha256: stored.sha256, size: 14 },
      post: { kind: "absent" },
      coverage: "exact",
      timestamp: new Date().toISOString(),
    });

    const start = pi.events.get("session_start");
    assert.ok(start);
    await start(undefined as never, {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
      ui: { notify() {} },
    } as never);

    const handler = pi.commands.get("edited-file-list")?.handler;
    assert.ok(handler);
    await handler("", {
      hasUI: true,
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [
          { id: "u1", message: { role: "user", content: "edit files", timestamp: 1 } },
          {
            id: "a1",
            message: { role: "assistant", content: [{ type: "toolCall", id: "c1" }, { type: "toolCall", id: "c2" }] },
          },
        ],
      },
      cwd,
      waitForIdle: async () => {},
      ui: { notify() {} },
    } as never);

    const listed = pi.entries.find((entry) => entry.customType === "pi-undo/edited-files");
    assert.ok(listed);
    const lines = (listed.data as { lines: Array<{ text: string }> }).lines.map((line) => line.text);
    assert.deepEqual(lines, ["Edited files (since session start):", "D  src/a.ts", "D  src/b.ts"]);
  });

  test("/edited-file-list is empty when nothing has been changed", async () => {
    const { pi } = setup();
    const handler = pi.commands.get("edited-file-list")?.handler;
    assert.ok(handler);
    await handler("", {
      hasUI: true,
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [{ id: "u1", message: { role: "user", content: "hello", timestamp: 1 } }],
      },
      cwd: process.cwd(),
      waitForIdle: async () => {},
      ui: { notify() {} },
    } as never);

    const listed = pi.entries.find((entry) => entry.customType === "pi-undo/edited-files");
    assert.ok(listed);
    const lines = (listed.data as { lines: Array<{ text: string }> }).lines.map((line) => line.text);
    assert.deepEqual(lines, ["No edited files since session start."]);
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

    await handler("", ctx as never);
    assert.equal(navigatedTo, "u-files");

    navigatedTo = undefined;
    await handler("1", ctx as never);
    assert.equal(navigatedTo, "u-files");

    navigatedTo = undefined;
    await handler("2", ctx as never);
    assert.equal(navigatedTo, undefined);
    assert.equal(notifications.some((message) => message.includes("No undo point 2")), true);
  });

  test("/redo restores the leaf that was active before /undo", async () => {
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

    const undo = pi.commands.get("undo")?.handler;
    const redo = pi.commands.get("redo")?.handler;
    assert.ok(undo);
    assert.ok(redo);

    let leafId = "u-chat";
    const filesTurn = { id: "u-files", message: { role: "user", content: "edit files", timestamp: 1 } };
    const chatTurn = { id: "u-chat", message: { role: "user", content: "just chatting", timestamp: 2 } };
    const notifications: string[] = [];
    const ctx = {
      hasUI: true,
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => (leafId === "u-chat" ? [filesTurn, chatTurn] : [filesTurn]),
      },
      cwd: process.cwd(),
      waitForIdle: async () => {},
      navigateTree: async (id: string) => {
        leafId = id;
        return {};
      },
      ui: {
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    };

    await redo("", ctx as never);
    assert.equal(leafId, "u-chat");
    assert.equal(notifications.some((message) => message.includes("Nothing to redo.")), true);

    await undo("", ctx as never);
    assert.equal(leafId, "u-files");

    notifications.length = 0;
    await redo("", ctx as never);
    assert.equal(leafId, "u-chat");
    assert.equal(notifications.some((message) => message.includes("Nothing to redo.")), false);

    await redo("", ctx as never);
    assert.equal(leafId, "u-chat");
    assert.equal(notifications.some((message) => message.includes("Nothing to redo.")), true);
  });

  test("/redo is not armed when /undo is cancelled", async () => {
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

    const undo = pi.commands.get("undo")?.handler;
    const redo = pi.commands.get("redo")?.handler;
    assert.ok(undo);
    assert.ok(redo);

    const notifications: string[] = [];
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
      navigateTree: async () => ({ cancelled: true }),
      ui: {
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    };

    await undo("", ctx as never);
    await redo("", ctx as never);
    assert.equal(notifications.some((message) => message.includes("Nothing to redo.")), true);
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

  test("session_tree does not snapshot the destination leaf after restore", async () => {
    const { pi, home } = setup();
    const cwd = tempDir();
    const file = join(cwd, "tracked.txt");
    writeFileSync(file, "after");
    const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
    const before = store.put(Buffer.from("before"));
    const after = store.put(Buffer.from("after"));
    new SessionJournal(store, "s1").appendMutation({
      sessionId: "s1",
      turnEntryId: "u1",
      toolCallId: "c1",
      toolName: "write",
      path: file,
      key: file,
      pre: { kind: "file", sha256: before.sha256, size: before.bytes },
      post: { kind: "file", sha256: after.sha256, size: after.bytes },
      coverage: "exact",
      timestamp: new Date().toISOString(),
    });

    const start = pi.events.get("session_start");
    assert.ok(start);
    await start(undefined as never, {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
      ui: { notify() {} },
    } as never);

    const handler = pi.events.get("session_tree");
    assert.ok(handler);
    const src = [
      { id: "u1", type: "message", message: { role: "user", content: "edit", timestamp: 1 } },
      { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1" }] } },
      { id: "r1", type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "write" } },
    ];
    await handler(
      { newLeafId: "dest", oldLeafId: "r1" } as never,
      {
        hasUI: true,
        cwd,
        sessionManager: {
          getSessionId: () => "s1",
          getBranch: (fromId?: string) => (fromId === "r1" ? src : [{ id: "dest" }]),
        },
        ui: { notify() {} },
      } as never,
    );

    assert.equal(new SessionJournal(store, "s1").loadLeafSnapshot("dest"), undefined);
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

  test("/pi-undo:reset-setting restores defaults after confirmation", async () => {
    const { pi, home } = setup();
    const path = getConfigPath(home);
    saveConfig({ ...DEFAULT_CONFIG, syncTree: false, enabled: false }, path);
    const handler = pi.commands.get("pi-undo:reset-setting")?.handler;
    assert.ok(handler);

    const notifications: string[] = [];
    const selectCalls: Array<{ title: string; options: string[] }> = [];
    await handler("", {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1" },
      cwd: process.cwd(),
      ui: {
        select: async (title: string, options: string[]) => {
          selectCalls.push({ title, options });
          return "Yes";
        },
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    } as never);

    assert.equal(loadConfig(path).config.syncTree, true);
    assert.equal(loadConfig(path).config.enabled, true);
    assert.equal(notifications.some((message) => message.includes("reset to defaults")), true);
    assert.deepEqual(selectCalls[0]?.options, ["No", "Yes"]);
  });

  test("/pi-undo:reset-setting does nothing when cancelled", async () => {
    const { pi, home } = setup();
    const path = getConfigPath(home);
    saveConfig({ ...DEFAULT_CONFIG, syncTree: false }, path);
    const handler = pi.commands.get("pi-undo:reset-setting")?.handler;
    assert.ok(handler);

    await handler("", {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1" },
      cwd: process.cwd(),
      ui: {
        select: async () => "No",
        notify() {},
      },
    } as never);

    assert.equal(loadConfig(path).config.syncTree, false);
  });

  test("/pi-undo:reset-setting writes defaults when there is no confirm UI", async () => {
    const { pi, home } = setup();
    const path = getConfigPath(home);
    saveConfig({ ...DEFAULT_CONFIG, syncTree: false }, path);
    const handler = pi.commands.get("pi-undo:reset-setting")?.handler;
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

function userMessage(id: string, content: string, timestamp: number) {
  return { id, message: { role: "user" as const, content, timestamp } };
}

function assistantTool(id: string, toolCallId: string) {
  return {
    id,
    message: { role: "assistant" as const, content: [{ type: "toolCall", id: toolCallId }] },
  };
}

function toolResult(id: string, toolCallId: string) {
  return {
    id,
    message: { role: "toolResult" as const, toolCallId, toolName: "write" },
  };
}

async function setupExternalEditUndo(options: { disk?: string } = {}) {
  const { pi, home } = setup();
  const cwd = tempDir();
  const file = join(cwd, "notes.txt");
  writeFileSync(file, "original");
  const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
  const original = store.put(Buffer.from("original"));
  const afterPi = store.put(Buffer.from("pi"));
  const mode = statSync(file).mode & 0o777;
  writeFileSync(file, options.disk ?? "user");
  new SessionJournal(store, "s1").appendMutation({
    sessionId: "s1",
    turnEntryId: "u1",
    toolCallId: "c1",
    toolName: "write",
    path: file,
    key: file,
    pre: { kind: "file", sha256: original.sha256, size: original.bytes, mode },
    post: { kind: "file", sha256: afterPi.sha256, size: afterPi.bytes, mode },
    coverage: "exact",
    timestamp: new Date().toISOString(),
  });

  const start = pi.events.get("session_start");
  assert.ok(start);
  await start(undefined as never, {
    cwd,
    hasUI: true,
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    ui: { notify() {} },
  } as never);

  const full = [
    userMessage("u1", "write notes", 1),
    assistantTool("a1", "c1"),
    toolResult("r1", "c1"),
    userMessage("u2", "just chatting", 2),
  ];
  const rolled = [userMessage("u1", "write notes", 1)];
  let leafId = "u2";
  const getBranch = (fromId?: string) => {
    if (fromId === "u1") {
      return rolled;
    }
    if (fromId === "u2") {
      return full;
    }
    return leafId === "u1" ? rolled : full;
  };
  const sessionTree = pi.events.get("session_tree");
  const sessionBeforeTree = pi.events.get("session_before_tree");
  assert.ok(sessionTree);
  assert.ok(sessionBeforeTree);

  return {
    pi,
    file,
    cwd,
    getBranch,
    getLeaf: () => leafId,
    setLeaf: (id: string) => {
      leafId = id;
    },
    sessionTree,
    sessionBeforeTree,
  };
}

describe("/undo overwrite prompt", () => {
  test("/undo No keeps external edits", async () => {
    const { pi, file, cwd, getBranch, getLeaf, setLeaf, sessionTree, sessionBeforeTree } =
      await setupExternalEditUndo();
    const undo = pi.commands.get("undo")?.handler;
    assert.ok(undo);
    const selectCalls: Array<{ title: string; options: string[] }> = [];
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      waitForIdle: async () => {},
      navigateTree: async (id: string) => {
        const oldLeafId = getLeaf();
        await sessionBeforeTree(
          { preparation: { targetId: id, oldLeafId } } as never,
          ctx as never,
        );
        setLeaf(id);
        await sessionTree({ newLeafId: id, oldLeafId, fromExtension: true } as never, ctx as never);
        return {};
      },
      ui: {
        select: async (title: string, options: string[]) => {
          selectCalls.push({ title, options });
          return OVERWRITE_SELECT_NO;
        },
        notify() {},
      },
    };

    await undo("", ctx as never);

    assert.equal(getLeaf(), "u1");
    assert.equal(readFileSync(file, "utf8"), "user");
    assert.equal(selectCalls.length, 1);
    assert.deepEqual(selectCalls[0]?.options, overwriteSelectOptions());
    assert.equal(selectCalls[0]?.title, formatOverwriteSelectTitle([file]));
  });

  test("/undo Yes overwrites external edits", async () => {
    const { pi, file, cwd, getBranch, getLeaf, setLeaf, sessionTree } = await setupExternalEditUndo();
    const undo = pi.commands.get("undo")?.handler;
    assert.ok(undo);
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      waitForIdle: async () => {},
      navigateTree: async (id: string) => {
        const oldLeafId = getLeaf();
        setLeaf(id);
        await sessionTree({ newLeafId: id, oldLeafId, fromExtension: true } as never, ctx as never);
        return {};
      },
      ui: {
        select: async () => OVERWRITE_SELECT_YES,
        notify() {},
      },
    };

    await undo("", ctx as never);

    assert.equal(getLeaf(), "u1");
    assert.equal(readFileSync(file, "utf8"), "original");
  });

  test("/undo --force overwrites without asking", async () => {
    const { pi, file, cwd, getBranch, getLeaf, setLeaf, sessionTree } = await setupExternalEditUndo();
    const undo = pi.commands.get("undo")?.handler;
    assert.ok(undo);
    let asked = false;
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      waitForIdle: async () => {},
      navigateTree: async (id: string) => {
        const oldLeafId = getLeaf();
        setLeaf(id);
        await sessionTree({ newLeafId: id, oldLeafId, fromExtension: true } as never, ctx as never);
        return {};
      },
      ui: {
        select: async () => {
          asked = true;
          return OVERWRITE_SELECT_NO;
        },
        notify() {},
      },
    };

    await undo("--force", ctx as never);

    assert.equal(asked, false);
    assert.equal(getLeaf(), "u1");
    assert.equal(readFileSync(file, "utf8"), "original");
  });

  test("/undo cancel leaves conversation and files unchanged", async () => {
    const { pi, file, cwd, getBranch, getLeaf } = await setupExternalEditUndo();
    const undo = pi.commands.get("undo")?.handler;
    assert.ok(undo);
    let navigated = false;
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      waitForIdle: async () => {},
      navigateTree: async () => {
        navigated = true;
        return {};
      },
      ui: {
        select: async () => undefined,
        notify() {},
      },
    };

    await undo("", ctx as never);

    assert.equal(navigated, false);
    assert.equal(getLeaf(), "u2");
    assert.equal(readFileSync(file, "utf8"), "user");
  });

  test("/redo Yes overwrites external edits", async () => {
    const { pi, file, cwd, getBranch, getLeaf, setLeaf, sessionTree } = await setupExternalEditUndo();
    const undo = pi.commands.get("undo")?.handler;
    const redo = pi.commands.get("redo")?.handler;
    assert.ok(undo);
    assert.ok(redo);
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      waitForIdle: async () => {},
      navigateTree: async (id: string) => {
        const oldLeafId = getLeaf();
        setLeaf(id);
        await sessionTree({ newLeafId: id, oldLeafId, fromExtension: true } as never, ctx as never);
        return {};
      },
      ui: {
        select: async () => OVERWRITE_SELECT_NO,
        notify() {},
      },
    };

    await undo("", ctx as never);
    assert.equal(readFileSync(file, "utf8"), "user");

    ctx.ui.select = async () => OVERWRITE_SELECT_YES;
    await redo("", ctx as never);

    assert.equal(getLeaf(), "u2");
    assert.equal(readFileSync(file, "utf8"), "pi");
  });

  test("/tree restore No keeps files and does not ask to overwrite", async () => {
    const { file, cwd, getBranch, getLeaf, sessionBeforeTree, sessionTree } = await setupExternalEditUndo();
    const selectCalls: Array<{ title: string; options: string[] }> = [];
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      ui: {
        select: async (title: string, options: string[]) => {
          selectCalls.push({ title, options });
          return TREE_RESTORE_SELECT_NO;
        },
        notify() {},
      },
    };

    const before = await sessionBeforeTree(
      { preparation: { targetId: "u1", oldLeafId: getLeaf() } } as never,
      ctx as never,
    );
    assert.equal((before as { cancel?: boolean } | undefined)?.cancel, undefined);
    await sessionTree(
      { newLeafId: "u1", oldLeafId: getLeaf(), fromExtension: false } as never,
      ctx as never,
    );

    assert.equal(selectCalls.length, 1);
    assert.deepEqual(selectCalls[0]?.options, treeRestoreSelectOptions());
    assert.equal(selectCalls[0]?.title, formatTreeRestoreSelectTitle([file]));
    assert.equal(readFileSync(file, "utf8"), "user");
  });

  test("/tree restore Yes then overwrite No keeps external edits", async () => {
    const { file, cwd, getBranch, getLeaf, sessionBeforeTree, sessionTree } = await setupExternalEditUndo();
    const selectCalls: Array<{ title: string; options: string[] }> = [];
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      ui: {
        select: async (title: string, options: string[]) => {
          selectCalls.push({ title, options });
          if (options[0] === TREE_RESTORE_SELECT_NO) {
            return TREE_RESTORE_SELECT_YES;
          }
          return OVERWRITE_SELECT_NO;
        },
        notify() {},
      },
    };

    const before = await sessionBeforeTree(
      { preparation: { targetId: "u1", oldLeafId: getLeaf() } } as never,
      ctx as never,
    );
    assert.equal((before as { cancel?: boolean } | undefined)?.cancel, undefined);
    await sessionTree(
      { newLeafId: "u1", oldLeafId: getLeaf(), fromExtension: false } as never,
      ctx as never,
    );

    assert.equal(selectCalls.length, 2);
    assert.deepEqual(selectCalls[0]?.options, treeRestoreSelectOptions());
    assert.equal(selectCalls[0]?.title, formatTreeRestoreSelectTitle([file]));
    assert.deepEqual(selectCalls[1]?.options, overwriteSelectOptions());
    assert.equal(selectCalls[1]?.title, formatOverwriteSelectTitle([file]));
    assert.equal(readFileSync(file, "utf8"), "user");
  });

  test("/tree restore Yes then overwrite Yes overwrites external edits", async () => {
    const { file, cwd, getBranch, getLeaf, sessionBeforeTree, sessionTree } = await setupExternalEditUndo();
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      ui: {
        select: async (_title: string, options: string[]) => {
          if (options[0] === TREE_RESTORE_SELECT_NO) {
            return TREE_RESTORE_SELECT_YES;
          }
          return OVERWRITE_SELECT_YES;
        },
        notify() {},
      },
    };

    await sessionBeforeTree(
      { preparation: { targetId: "u1", oldLeafId: getLeaf() } } as never,
      ctx as never,
    );
    await sessionTree(
      { newLeafId: "u1", oldLeafId: getLeaf(), fromExtension: false } as never,
      ctx as never,
    );

    assert.equal(readFileSync(file, "utf8"), "original");
  });

  test("/tree restore Yes without external edits restores with one prompt", async () => {
    const { file, cwd, getBranch, getLeaf, sessionBeforeTree, sessionTree } =
      await setupExternalEditUndo({ disk: "pi" });
    const selectCalls: Array<{ title: string; options: string[] }> = [];
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      ui: {
        select: async (title: string, options: string[]) => {
          selectCalls.push({ title, options });
          return TREE_RESTORE_SELECT_YES;
        },
        notify() {},
      },
    };

    await sessionBeforeTree(
      { preparation: { targetId: "u1", oldLeafId: getLeaf() } } as never,
      ctx as never,
    );
    await sessionTree(
      { newLeafId: "u1", oldLeafId: getLeaf(), fromExtension: false } as never,
      ctx as never,
    );

    assert.equal(selectCalls.length, 1);
    assert.deepEqual(selectCalls[0]?.options, treeRestoreSelectOptions());
    assert.equal(readFileSync(file, "utf8"), "original");
  });

  test("/tree restore Yes asks again on later /tree moves, overwrite only when needed", async () => {
    const { file, cwd, getBranch, getLeaf, setLeaf, sessionBeforeTree, sessionTree } =
      await setupExternalEditUndo();
    const selectCalls: Array<{ title: string; options: string[] }> = [];
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      ui: {
        select: async (title: string, options: string[]) => {
          selectCalls.push({ title, options });
          if (options[0] === TREE_RESTORE_SELECT_NO) {
            return TREE_RESTORE_SELECT_YES;
          }
          return OVERWRITE_SELECT_YES;
        },
        notify() {},
      },
    };

    const from = getLeaf();
    await sessionBeforeTree(
      { preparation: { targetId: "u1", oldLeafId: from } } as never,
      ctx as never,
    );
    await sessionTree(
      { newLeafId: "u1", oldLeafId: from, fromExtension: false } as never,
      ctx as never,
    );
    setLeaf("u1");
    assert.equal(selectCalls.length, 2);
    assert.deepEqual(selectCalls[0]?.options, treeRestoreSelectOptions());
    assert.deepEqual(selectCalls[1]?.options, overwriteSelectOptions());
    assert.equal(readFileSync(file, "utf8"), "original");

    await sessionBeforeTree(
      { preparation: { targetId: "u2", oldLeafId: "u1" } } as never,
      ctx as never,
    );
    await sessionTree(
      { newLeafId: "u2", oldLeafId: "u1", fromExtension: false } as never,
      ctx as never,
    );
    setLeaf("u2");
    assert.equal(selectCalls.length, 3);
    assert.deepEqual(selectCalls[2]?.options, treeRestoreSelectOptions());
    assert.equal(readFileSync(file, "utf8"), "pi");

    await sessionBeforeTree(
      { preparation: { targetId: "u1", oldLeafId: "u2" } } as never,
      ctx as never,
    );
    await sessionTree(
      { newLeafId: "u1", oldLeafId: "u2", fromExtension: false } as never,
      ctx as never,
    );
    assert.equal(selectCalls.length, 4);
    assert.deepEqual(selectCalls[3]?.options, treeRestoreSelectOptions());
    assert.equal(readFileSync(file, "utf8"), "original");
  });

  test("/tree cancel on restore prompt leaves conversation and files unchanged", async () => {
    const { file, cwd, getBranch, getLeaf, sessionBeforeTree, sessionTree } = await setupExternalEditUndo();
    let restored = false;
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      ui: {
        select: async () => undefined,
        notify() {},
      },
    };

    const before = await sessionBeforeTree(
      { preparation: { targetId: "u1", oldLeafId: getLeaf() } } as never,
      ctx as never,
    );
    assert.deepEqual(before, { cancel: true });
    if (!(before as { cancel?: boolean }).cancel) {
      restored = true;
      await sessionTree(
        { newLeafId: "u1", oldLeafId: getLeaf(), fromExtension: false } as never,
        ctx as never,
      );
    }

    assert.equal(restored, false);
    assert.equal(getLeaf(), "u2");
    assert.equal(readFileSync(file, "utf8"), "user");
  });

  test("/tree cancel on overwrite prompt leaves conversation and files unchanged", async () => {
    const { file, cwd, getBranch, getLeaf, sessionBeforeTree, sessionTree } = await setupExternalEditUndo();
    let restored = false;
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1", getBranch },
      cwd,
      ui: {
        select: async (_title: string, options: string[]) => {
          if (options[0] === TREE_RESTORE_SELECT_NO) {
            return TREE_RESTORE_SELECT_YES;
          }
          return undefined;
        },
        notify() {},
      },
    };

    const before = await sessionBeforeTree(
      { preparation: { targetId: "u1", oldLeafId: getLeaf() } } as never,
      ctx as never,
    );
    assert.deepEqual(before, { cancel: true });
    if (!(before as { cancel?: boolean }).cancel) {
      restored = true;
      await sessionTree(
        { newLeafId: "u1", oldLeafId: getLeaf(), fromExtension: false } as never,
        ctx as never,
      );
    }

    assert.equal(restored, false);
    assert.equal(getLeaf(), "u2");
    assert.equal(readFileSync(file, "utf8"), "user");
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
  selectCalls?: Array<{ title: string; options: string[] }>;
}) {
  const hasUI = options.hasUI ?? true;
  return {
    hasUI,
    sessionManager: { getSessionId: () => "s1" },
    cwd: process.cwd(),
    waitForIdle: async () => {},
    ui: {
      ...(hasUI
        ? {
            select: async (title: string, items: string[]) => {
              options.selectCalls?.push({ title, options: items });
              return options.confirm === false ? "No" : "Yes";
            },
          }
        : {}),
      notify: (message: string) => {
        options.notifications?.push(message);
      },
    },
  } as never;
}

describe("/pi-undo:clear-undo-store command", () => {
  test("wipes stored snapshots including the current session", async () => {
    const { pi, home } = setup();
    const { hash, sessionIds } = seedStore(home, ["old-session", "s1"]);
    const handler = pi.commands.get("pi-undo:clear-undo-store")?.handler;
    assert.ok(handler);

    const notifications: string[] = [];
    const selectCalls: Array<{ title: string; options: string[] }> = [];
    await handler("", commandCtx({ confirm: true, notifications, selectCalls }));

    const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
    assert.equal(store.has(hash), false);
    for (const sessionId of sessionIds) {
      assert.equal(existsSync(join(store.sessionDir(sessionId), "mutations.jsonl")), false);
    }
    assert.equal(existsSync(join(store.journalDir("tx-1"), "entry.json")), false);
    assert.equal(existsSync(join(getStoreRoot(home), "maintenance.json")), false);
    assert.deepEqual(JSON.parse(readFileSync(getConfigPath(home), "utf8")), DEFAULT_CONFIG);
    assert.equal(notifications.some((message) => message.includes("stored undo data was removed")), true);
    assert.deepEqual(selectCalls[0]?.options, ["No", "Yes"]);
  });

  test("does nothing when cancelled", async () => {
    const { pi, home } = setup();
    const { hash, sessionIds } = seedStore(home, ["old-session", "s1"]);
    const handler = pi.commands.get("pi-undo:clear-undo-store")?.handler;
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
    const handler = pi.commands.get("pi-undo:clear-undo-store")?.handler;
    assert.ok(handler);

    await handler("", commandCtx({ hasUI: false }));

    const store = new ObjectStore(getStoreRoot(home), DEFAULT_CONFIG);
    assert.equal(store.has(hash), false);
    assert.equal(existsSync(join(store.sessionDir(sessionIds[0]), "mutations.jsonl")), false);
  });

  test("lets the current session snapshot again after a wipe", async () => {
    const { pi, home } = setup();
    seedStore(home, ["s1"]);
    const handler = pi.commands.get("pi-undo:clear-undo-store")?.handler;
    assert.ok(handler);
    await handler("", commandCtx({ confirm: true }));

    const status = pi.commands.get("undo-status")?.handler;
    assert.ok(status);
    await status("", {
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
