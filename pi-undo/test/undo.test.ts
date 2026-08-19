import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, describe, test } from "node:test";
import { compensatingRestore, executeFilesystemRestore } from "../src/undo.ts";
import { indexFileChangingTurns, listUserTurns, parseOptionalForce, parseRequiredTurn, parseUndoArgs } from "../src/session.ts";
import { cleanupTempDirs, createHarness } from "./helpers.ts";

afterEach(() => {
  cleanupTempDirs();
});

describe("parseUndoArgs", () => {
  test("parses MVP commands", () => {
    assert.deepEqual(parseUndoArgs(""), { kind: "undo", n: 1, force: false });
    assert.deepEqual(parseUndoArgs("--force"), { kind: "undo", n: 1, force: true });
    assert.deepEqual(parseUndoArgs("3"), { kind: "undo", n: 3, force: false });
    assert.deepEqual(parseUndoArgs("3 --force"), { kind: "undo", n: 3, force: true });
    assert.deepEqual(parseUndoArgs("--force 3"), { kind: "undo", n: 3, force: true });
    assert.deepEqual(parseUndoArgs("help"), { kind: "help" });
    assert.equal(parseUndoArgs("diff 3").kind, "error");
    assert.equal(parseUndoArgs("start").kind, "error");
    assert.equal(parseUndoArgs("status").kind, "error");
  });
});

describe("parseOptionalForce", () => {
  test("accepts an optional --force flag", () => {
    assert.deepEqual(parseOptionalForce("", "Usage: /undo-start [--force]"), { force: false });
    assert.deepEqual(parseOptionalForce("--force", "Usage: /undo-start [--force]"), { force: true });
    assert.equal("error" in parseOptionalForce("nope", "Usage: /undo-start [--force]"), true);
  });
});

describe("parseRequiredTurn", () => {
  test("defaults to turn 1 when omitted", () => {
    assert.deepEqual(parseRequiredTurn("", "Usage: /undo-diff [N]"), { n: 1 });
    assert.deepEqual(parseRequiredTurn("3", "Usage: /undo-diff [N]"), { n: 3 });
    assert.equal("error" in parseRequiredTurn("3 extra", "Usage: /undo-diff [N]"), true);
  });
});

describe("listUserTurns", () => {
  test("numbers the newest turn as 1 and lists oldest first", () => {
    const turns = listUserTurns([
      { id: "a", message: { role: "user", content: "first", timestamp: 1 } },
      { id: "b", message: { role: "assistant", content: "ok" } },
      { id: "c", message: { role: "user", content: "second", timestamp: 2 } },
      { id: "d", message: { role: "user", content: "third", timestamp: 3 } },
    ]);
    assert.deepEqual(
      turns.map((turn) => ({ id: turn.id, index: turn.index })),
      [
        { id: "a", index: 3 },
        { id: "c", index: 2 },
        { id: "d", index: 1 },
      ],
    );
  });
});

describe("indexFileChangingTurns", () => {
  test("numbers only turns that changed files, newest first", () => {
    const turns = listUserTurns([
      { id: "a", message: { role: "user", content: "first", timestamp: 1 } },
      { id: "b", message: { role: "user", content: "second", timestamp: 2 } },
      { id: "c", message: { role: "user", content: "third", timestamp: 3 } },
    ]);
    const numbered = indexFileChangingTurns(turns, [
      { turnEntryId: "a" },
      { turnEntryId: "c" },
    ]);
    assert.deepEqual(
      numbered.map((turn) => ({ id: turn.id, index: turn.index })),
      [
        { id: "a", index: 2 },
        { id: "b", index: null },
        { id: "c", index: 1 },
      ],
    );
  });
});

describe("undo restore", () => {
  test("bash mutations are recorded even when the command exits 1", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "broken.txt");
    writeFileSync(file, "before");

    await harness.snapshotter.beginBash({
      toolCallId: "b1",
      command: "rm broken.txt; exit 1",
      sessionId: "session-1",
      turnEntryId: "turn-1",
    });
    writeFileSync(file, "after failed command");
    await harness.snapshotter.finish("b1");

    assert.equal(harness.journal.mutations().length, 1);
    executeFilesystemRestore({
      mutations: harness.journal.mutations(),
      turnIds: new Set(["turn-1"]),
      config: harness.config,
      store: harness.store,
      force: true,
    });
    assert.equal(readFileSync(file, "utf8"), "before");
  });

  test("crash recovery promotes pending journals", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "crash.txt");
    writeFileSync(file, "pre");
    await harness.snapshotter.beginWriteEdit({
      toolName: "write",
      toolCallId: "pending-1",
      path: "crash.txt",
      sessionId: "session-1",
      turnEntryId: "turn-1",
    });
    writeFileSync(file, "post-crash");
    assert.equal(harness.journal.listPending().length, 1);

    const recovered = harness.snapshotter.recoverPending();
    assert.equal(recovered, 1);
    assert.equal(harness.journal.listPending().length, 0);
    assert.equal(harness.journal.mutations().length, 1);
  });

  test("compensating restore undoes a partial undo", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "tx.txt");
    writeFileSync(file, "original");
    await harness.snapshotter.beginWriteEdit({
      toolName: "write",
      toolCallId: "c1",
      path: "tx.txt",
      sessionId: "session-1",
      turnEntryId: "turn-1",
    });
    writeFileSync(file, "pi-edit");
    await harness.snapshotter.finish("c1");

    const { transactionId } = executeFilesystemRestore({
      mutations: harness.journal.mutations(),
      turnIds: new Set(["turn-1"]),
      config: harness.config,
      store: harness.store,
      force: true,
    });
    assert.equal(readFileSync(file, "utf8"), "original");
    compensatingRestore(harness.store, transactionId);
    assert.equal(readFileSync(file, "utf8"), "pi-edit");
  });

  test("bash directory snapshot keeps only actual mutations", async () => {
    const harness = createHarness();
    const dir = join(harness.cwd, "pkg");
    mkdirSync(dir);
    writeFileSync(join(dir, "changed.txt"), "old");
    writeFileSync(join(dir, "removed.txt"), "gone");
    writeFileSync(join(dir, "same.txt"), "same");

    await harness.snapshotter.beginBash({
      toolCallId: "b1",
      command: "rm -rf pkg",
      sessionId: "session-1",
      turnEntryId: "turn-1",
    });
    writeFileSync(join(dir, "changed.txt"), "new");
    writeFileSync(join(dir, "created.txt"), "created");
    writeFileSync(join(dir, "removed.txt"), "gone");
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(dir, "removed.txt"));
    await harness.snapshotter.finish("b1");

    const paths = harness.journal.mutations().map((mutation) => mutation.path).sort();
    assert.equal(paths.some((path) => path.endsWith("changed.txt")), true);
    assert.equal(paths.some((path) => path.endsWith("created.txt")), true);
    assert.equal(paths.some((path) => path.endsWith("removed.txt")), true);
    assert.equal(paths.some((path) => path.endsWith("same.txt")), false);
    assert.equal(harness.journal.mutations().length, 3);
    assert.equal(existsSync(join(dir, "same.txt")), true);
  });

  test("inspect-only bash commands do not snapshot the working tree", async () => {
    const harness = createHarness();
    writeFileSync(join(harness.cwd, "keep.txt"), "keep");

    await harness.snapshotter.beginBash({
      toolCallId: "b1",
      command: "pwd && ls -la && find . -maxdepth 3 -type f -o -type d | head -100",
      sessionId: "session-1",
      turnEntryId: "turn-1",
    });
    writeFileSync(join(harness.cwd, "keep.txt"), "changed");
    await harness.snapshotter.finish("b1");

    assert.equal(harness.journal.mutations().length, 0);
    assert.equal(harness.journal.listPending().length, 0);
    assert.equal(
      harness.notifications.some((message) => message.text.includes("Bash snapshot limit reached")),
      false,
    );
  });

  test("oversized bash directories are skipped instead of partially snapshotted", async () => {
    const harness = createHarness({
      config: { bash: { maxFilesPerCall: 3, maxBytesPerCallMB: 200 } },
    });
    const huge = join(harness.cwd, "huge");
    const small = join(harness.cwd, "small");
    mkdirSync(huge);
    mkdirSync(small);
    writeFileSync(join(huge, "a.txt"), "a");
    writeFileSync(join(huge, "b.txt"), "b");
    writeFileSync(join(huge, "c.txt"), "c");
    writeFileSync(join(huge, "d.txt"), "d");
    writeFileSync(join(small, "kept.txt"), "old");

    await harness.snapshotter.beginBash({
      toolCallId: "b1",
      command: "rm -rf huge small",
      sessionId: "session-1",
      turnEntryId: "turn-1",
    });
    writeFileSync(join(huge, "a.txt"), "changed");
    writeFileSync(join(small, "kept.txt"), "new");
    await harness.snapshotter.finish("b1");

    const paths = harness.journal.mutations().map((mutation) => mutation.path);
    assert.equal(paths.length, 1);
    assert.equal(paths[0]?.endsWith("kept.txt"), true);
    assert.equal(paths.some((path) => path.split(sep).includes("huge")), false);
    assert.equal(
      harness.notifications.some((message) => message.text.includes("Bash snapshot limit reached")),
      true,
    );
  });
});
