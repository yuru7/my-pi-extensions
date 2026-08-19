import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { cleanupTempDirs, createHarness } from "./helpers.ts";

afterEach(() => {
  cleanupTempDirs();
});

describe("snapshot overhead", () => {
  for (const size of [1024, 100 * 1024, 1024 * 1024, 10 * 1024 * 1024]) {
    test(`write snapshot of ${size} bytes completes quickly`, async () => {
      const harness = createHarness();
      const file = join(harness.cwd, "blob.bin");
      writeFileSync(file, Buffer.alloc(size, 7));
      const started = performance.now();
      await harness.snapshotter.beginWriteEdit({
        toolName: "write",
        toolCallId: "c1",
        path: "blob.bin",
        sessionId: "session-1",
        turnEntryId: "turn-1",
      });
      writeFileSync(file, Buffer.alloc(size, 8));
      await harness.snapshotter.finish("c1");
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 15_000, `snapshot took ${elapsed}ms`);
      if (size <= 10 * 1024 * 1024) {
        assert.equal(harness.journal.mutations().length, 1);
      }
    });
  }
});
