import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { executeFilesystemRestore } from "../src/undo.ts";
import { cleanupTempDirs, createHarness } from "./helpers.ts";

afterEach(() => {
  cleanupTempDirs();
});

describe("safe restore", () => {
  test("skips files edited after Pi's last write", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "safe.txt");
    writeFileSync(file, "original");

    await harness.snapshotter.beginWriteEdit({
      toolName: "edit",
      toolCallId: "c1",
      path: "safe.txt",
      sessionId: "session-1",
      turnEntryId: "turn-1",
    });
    writeFileSync(file, "pi");
    await harness.snapshotter.finish("c1");
    writeFileSync(file, "user");

    const result = executeFilesystemRestore({
      mutations: harness.journal.mutations(),
      turnIds: new Set(["turn-1"]),
      config: harness.config,
      store: harness.store,
      force: false,
    });

    assert.equal(readFileSync(file, "utf8"), "user");
    assert.equal(result.plan.skipped.length, 1);
  });

  test("--force overwrites external edits", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "safe.txt");
    writeFileSync(file, "original");

    await harness.snapshotter.beginWriteEdit({
      toolName: "edit",
      toolCallId: "c1",
      path: "safe.txt",
      sessionId: "session-1",
      turnEntryId: "turn-1",
    });
    writeFileSync(file, "pi");
    await harness.snapshotter.finish("c1");
    writeFileSync(file, "user");

    executeFilesystemRestore({
      mutations: harness.journal.mutations(),
      turnIds: new Set(["turn-1"]),
      config: harness.config,
      store: harness.store,
      force: true,
    });

    assert.equal(readFileSync(file, "utf8"), "original");
  });
});
