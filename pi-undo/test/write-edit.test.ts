import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { executeFilesystemRestore } from "../src/undo.ts";
import { cleanupTempDirs, createHarness } from "./helpers.ts";

afterEach(() => {
  cleanupTempDirs();
});

describe("write / edit snapshots", () => {
  test("existing file write is restored to original bytes", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "notes.txt");
    writeFileSync(file, "original");

    await harness.snapshotter.beginWriteEdit({
      toolName: "write",
      toolCallId: "c1",
      path: "notes.txt",
      sessionId: "session-1",
      turnEntryId: "turn-1",
    });
    writeFileSync(file, "changed by pi");
    await harness.snapshotter.finish("c1");

    executeFilesystemRestore({
      mutations: harness.journal.mutations(),
      turnIds: new Set(["turn-1"]),
      config: harness.config,
      store: harness.store,
      force: true,
    });

    assert.equal(readFileSync(file, "utf8"), "original");
  });

  test("new file write is removed on undo", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "created.txt");

    await harness.snapshotter.beginWriteEdit({
      toolName: "write",
      toolCallId: "c1",
      path: "created.txt",
      sessionId: "session-1",
      turnEntryId: "turn-1",
    });
    writeFileSync(file, "new");
    await harness.snapshotter.finish("c1");

    executeFilesystemRestore({
      mutations: harness.journal.mutations(),
      turnIds: new Set(["turn-1"]),
      config: harness.config,
      store: harness.store,
      force: true,
    });

    assert.equal(existsSync(file), false);
  });

  test("edit same file three times in one turn keeps one pre-image", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "app.ts");
    writeFileSync(file, "v0");

    for (const [index, content] of ["v1", "v2", "v3"].entries()) {
      await harness.snapshotter.beginWriteEdit({
        toolName: "edit",
        toolCallId: `c${index + 1}`,
        path: "app.ts",
        sessionId: "session-1",
        turnEntryId: "turn-1",
      });
      writeFileSync(file, content);
      await harness.snapshotter.finish(`c${index + 1}`);
    }

    const uniquePres = new Set(
      harness.journal
        .mutations()
        .filter((mutation) => mutation.key.endsWith("app.ts"))
        .map((mutation) => (mutation.pre.kind === "file" ? mutation.pre.sha256 : mutation.pre.kind)),
    );
    assert.equal(uniquePres.size, 1);

    executeFilesystemRestore({
      mutations: harness.journal.mutations(),
      turnIds: new Set(["turn-1"]),
      config: harness.config,
      store: harness.store,
      force: true,
    });
    assert.equal(readFileSync(file, "utf8"), "v0");
  });

  test("multi-turn undo restores the target turn start state", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "a.txt");
    writeFileSync(file, "t0");

    for (const [index, content] of ["t1", "t2", "t3"].entries()) {
      const turn = `turn-${index + 1}`;
      await harness.snapshotter.beginWriteEdit({
        toolName: "edit",
        toolCallId: `c${index + 1}`,
        path: "a.txt",
        sessionId: "session-1",
        turnEntryId: turn,
      });
      writeFileSync(file, content);
      await harness.snapshotter.finish(`c${index + 1}`);
    }

    executeFilesystemRestore({
      mutations: harness.journal.mutations(),
      turnIds: new Set(["turn-2", "turn-3"]),
      config: harness.config,
      store: harness.store,
      force: true,
    });
    assert.equal(readFileSync(file, "utf8"), "t1");
  });

  test("snapshot failure does not throw to the tool", async () => {
    const harness = createHarness();
    const file = join(harness.cwd, "ok.txt");
    writeFileSync(file, "hello");
    chmodSync(harness.storeRoot, 0o555);
    try {
      await harness.snapshotter.beginWriteEdit({
        toolName: "write",
        toolCallId: "c1",
        path: "ok.txt",
        sessionId: "session-1",
        turnEntryId: "turn-1",
      });
    } finally {
      chmodSync(harness.storeRoot, 0o755);
    }
  });
});
