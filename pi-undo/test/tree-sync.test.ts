import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { maxFileSizeBytes } from "../src/config.ts";
import {
  captureTrackedStates,
  executeTreeRestore,
} from "../src/undo.ts";
import {
  collectToolCallIds,
  shouldRedoMutation,
  shouldUndoMutation,
  stayTurnIds,
  type SessionEntryLike,
} from "../src/session.ts";
import { cleanupTempDirs, createHarness } from "./helpers.ts";

afterEach(() => {
  cleanupTempDirs();
});

function user(id: string): SessionEntryLike {
  return { id, type: "message", message: { role: "user", content: id, timestamp: 1 } };
}

function assistantTool(id: string, toolCallId: string): SessionEntryLike {
  return {
    id,
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId }] },
  };
}

function toolResult(id: string, toolCallId: string): SessionEntryLike {
  return {
    id,
    type: "message",
    message: { role: "toolResult", toolCallId, toolName: "write" },
  };
}

describe("tree branch matching", () => {
  test("collects toolCall ids from assistant calls and tool results", () => {
    const ids = collectToolCallIds([
      user("u1"),
      assistantTool("a1", "call-1"),
      toolResult("r1", "call-1"),
    ]);
    assert.equal(ids.has("call-1"), true);
  });

  test("a user-message leaf excludes that turn from stay turns", () => {
    const branch = [user("u1"), assistantTool("a1", "c1"), toolResult("r1", "c1"), user("u2")];
    const stay = stayTurnIds(branch, "u2");
    assert.equal(stay.has("u1"), true);
    assert.equal(stay.has("u2"), false);
  });

  test("undoes tool calls that left the active path", () => {
    assert.equal(
      shouldUndoMutation(
        { toolCallId: "c2", turnEntryId: "u2" },
        new Set(["c1", "c2"]),
        new Set(["c1"]),
        new Set(["u1"]),
      ),
      true,
    );
    assert.equal(
      shouldUndoMutation(
        { toolCallId: "c1", turnEntryId: "u1" },
        new Set(["c1", "c2"]),
        new Set(["c1"]),
        new Set(["u1"]),
      ),
      false,
    );
  });

  test("redoes tool calls that re-enter the active path", () => {
    assert.equal(
      shouldRedoMutation(
        { toolCallId: "c2", turnEntryId: "u2" },
        new Set(["c1"]),
        new Set(["c1", "c2"]),
        new Set(["u1", "u2"]),
      ),
      true,
    );
    assert.equal(
      shouldRedoMutation(
        { toolCallId: "c1", turnEntryId: "u1" },
        new Set(["c1"]),
        new Set(["c1", "c2"]),
        new Set(["u1", "u2"]),
      ),
      false,
    );
  });
});

describe("tree-synced restore", () => {
  test("going back to a user message restores that turn's start state", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "a.txt");
    writeFileSync(file, "t0");

    await harness.snapshotter.beginWriteEdit({
      toolName: "edit",
      toolCallId: "c1",
      path: "a.txt",
      sessionId: "session-1",
      turnEntryId: "u1",
    });
    writeFileSync(file, "t1");
    await harness.snapshotter.finish("c1");

    await harness.snapshotter.beginWriteEdit({
      toolName: "edit",
      toolCallId: "c2",
      path: "a.txt",
      sessionId: "session-1",
      turnEntryId: "u2",
    });
    writeFileSync(file, "t2");
    await harness.snapshotter.finish("c2");

    const oldBranch = [
      user("u1"),
      assistantTool("a1", "c1"),
      toolResult("r1", "c1"),
      user("u2"),
      assistantTool("a2", "c2"),
      toolResult("r2", "c2"),
    ];
    const newBranch = [user("u1")];

    harness.journal.saveLeafSnapshot(
      "r2",
      captureTrackedStates(
        harness.journal.mutations(),
        harness.store,
        maxFileSizeBytes(harness.config),
      ),
    );

    const back = executeTreeRestore({
      mutations: harness.journal.mutations(),
      oldBranch,
      newBranch,
      newLeafId: "u1",
      journal: harness.journal,
      store: harness.store,
      config: harness.config,
      force: true,
    });
    assert.equal(back.via, "mutations");
    assert.equal(readFileSync(file, "utf8"), "t0");

    harness.journal.saveLeafSnapshot(
      "u1",
      captureTrackedStates(
        harness.journal.mutations(),
        harness.store,
        maxFileSizeBytes(harness.config),
      ),
    );

    const forward = executeTreeRestore({
      mutations: harness.journal.mutations(),
      oldBranch: newBranch,
      newBranch: oldBranch,
      newLeafId: "r2",
      journal: harness.journal,
      store: harness.store,
      config: harness.config,
      force: false,
    });
    assert.equal(forward.via, "cache");
    assert.equal(readFileSync(file, "utf8"), "t2");
  });

  test("returning after /undo re-applies mutations without a leaf cache", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "a.txt");
    writeFileSync(file, "t0");

    await harness.snapshotter.beginWriteEdit({
      toolName: "edit",
      toolCallId: "c1",
      path: "a.txt",
      sessionId: "session-1",
      turnEntryId: "u1",
    });
    writeFileSync(file, "t1");
    await harness.snapshotter.finish("c1");

    await harness.snapshotter.beginWriteEdit({
      toolName: "edit",
      toolCallId: "c2",
      path: "a.txt",
      sessionId: "session-1",
      turnEntryId: "u2",
    });
    writeFileSync(file, "t2");
    await harness.snapshotter.finish("c2");

    const fullBranch = [
      user("u1"),
      assistantTool("a1", "c1"),
      toolResult("r1", "c1"),
      user("u2"),
      assistantTool("a2", "c2"),
      toolResult("r2", "c2"),
    ];
    const rolledBackBranch = [
      user("u1"),
      assistantTool("a1", "c1"),
      toolResult("r1", "c1"),
    ];

    const back = executeTreeRestore({
      mutations: harness.journal.mutations(),
      oldBranch: fullBranch,
      newBranch: rolledBackBranch,
      newLeafId: "r1",
      journal: harness.journal,
      store: harness.store,
      config: harness.config,
      force: true,
    });
    assert.equal(back.via, "mutations");
    assert.equal(readFileSync(file, "utf8"), "t1");

    const forward = executeTreeRestore({
      mutations: harness.journal.mutations(),
      oldBranch: rolledBackBranch,
      newBranch: fullBranch,
      newLeafId: "r2",
      journal: harness.journal,
      store: harness.store,
      config: harness.config,
      force: false,
    });
    assert.equal(forward.via, "mutations");
    assert.equal(readFileSync(file, "utf8"), "t2");
  });

  test("returning to an assistant message on the abandoned branch restores files", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "a.txt");
    writeFileSync(file, "t0");

    await harness.snapshotter.beginWriteEdit({
      toolName: "edit",
      toolCallId: "c1",
      path: "a.txt",
      sessionId: "session-1",
      turnEntryId: "u1",
    });
    writeFileSync(file, "t1");
    await harness.snapshotter.finish("c1");

    await harness.snapshotter.beginWriteEdit({
      toolName: "edit",
      toolCallId: "c2",
      path: "a.txt",
      sessionId: "session-1",
      turnEntryId: "u2",
    });
    writeFileSync(file, "t2");
    await harness.snapshotter.finish("c2");

    const fullBranch = [
      user("u1"),
      assistantTool("a1", "c1"),
      toolResult("r1", "c1"),
      user("u2"),
      assistantTool("a2", "c2"),
      toolResult("r2", "c2"),
    ];
    const rolledBackBranch = [
      user("u1"),
      assistantTool("a1", "c1"),
      toolResult("r1", "c1"),
    ];
    const assistantBranch = [
      user("u1"),
      assistantTool("a1", "c1"),
      toolResult("r1", "c1"),
      user("u2"),
      assistantTool("a2", "c2"),
    ];

    executeTreeRestore({
      mutations: harness.journal.mutations(),
      oldBranch: fullBranch,
      newBranch: rolledBackBranch,
      newLeafId: "r1",
      journal: harness.journal,
      store: harness.store,
      config: harness.config,
      force: true,
    });
    assert.equal(readFileSync(file, "utf8"), "t1");

    const forward = executeTreeRestore({
      mutations: harness.journal.mutations(),
      oldBranch: rolledBackBranch,
      newBranch: assistantBranch,
      newLeafId: "a2",
      journal: harness.journal,
      store: harness.store,
      config: harness.config,
      force: false,
    });
    assert.equal(forward.via, "mutations");
    assert.equal(readFileSync(file, "utf8"), "t2");
  });

  test("safe restore skips user edits when re-applying a later branch", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "a.txt");
    writeFileSync(file, "t0");

    await harness.snapshotter.beginWriteEdit({
      toolName: "edit",
      toolCallId: "c1",
      path: "a.txt",
      sessionId: "session-1",
      turnEntryId: "u1",
    });
    writeFileSync(file, "t1");
    await harness.snapshotter.finish("c1");

    await harness.snapshotter.beginWriteEdit({
      toolName: "edit",
      toolCallId: "c2",
      path: "a.txt",
      sessionId: "session-1",
      turnEntryId: "u2",
    });
    writeFileSync(file, "t2");
    await harness.snapshotter.finish("c2");

    const fullBranch = [
      user("u1"),
      assistantTool("a1", "c1"),
      toolResult("r1", "c1"),
      user("u2"),
      assistantTool("a2", "c2"),
      toolResult("r2", "c2"),
    ];
    const rolledBackBranch = [
      user("u1"),
      assistantTool("a1", "c1"),
      toolResult("r1", "c1"),
    ];

    executeTreeRestore({
      mutations: harness.journal.mutations(),
      oldBranch: fullBranch,
      newBranch: rolledBackBranch,
      newLeafId: "r1",
      journal: harness.journal,
      store: harness.store,
      config: harness.config,
      force: true,
    });
    writeFileSync(file, "user");

    const forward = executeTreeRestore({
      mutations: harness.journal.mutations(),
      oldBranch: rolledBackBranch,
      newBranch: fullBranch,
      newLeafId: "r2",
      journal: harness.journal,
      store: harness.store,
      config: harness.config,
      force: false,
    });
    assert.equal(readFileSync(file, "utf8"), "user");
    assert.equal(forward.plan.skipped.length, 1);
  });
});
