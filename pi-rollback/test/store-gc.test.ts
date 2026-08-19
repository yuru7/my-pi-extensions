import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runMaintenance, SessionJournal } from "../src/mutation-journal.ts";
import { ObjectStore, sha256 } from "../src/store.ts";
import { cleanupTempDirs, createHarness, tempDir } from "./helpers.ts";

afterEach(() => {
  cleanupTempDirs();
});

describe("CAS store and GC", () => {
  test("identical contents are stored once", () => {
    const harness = createHarness();
    const first = harness.store.put(Buffer.from("hello"));
    const second = harness.store.put(Buffer.from("hello"));
    assert.equal(first.sha256, sha256("hello"));
    assert.equal(first.status, "stored");
    assert.equal(second.status, "exists");
    assert.equal(first.sha256, second.sha256);
  });

  test("mark-and-sweep deletes unreferenced objects", () => {
    const root = tempDir();
    const config = { ...DEFAULT_CONFIG, retentionDays: 0 };
    const store = new ObjectStore(join(root, "store"), config);
    const keep = store.put(Buffer.from("keep-me"));
    const drop = store.put(Buffer.from("drop-me"));
    const journal = new SessionJournal(store, "active");
    journal.appendMutation({
      sessionId: "active",
      turnEntryId: "t1",
      toolCallId: "c1",
      toolName: "write",
      path: "/tmp/keep.txt",
      key: "/tmp/keep.txt",
      pre: { kind: "file", sha256: keep.sha256, size: 7 },
      post: { kind: "absent" },
      coverage: "exact",
      timestamp: new Date().toISOString(),
    });
    assert.equal(store.has(drop.sha256), true);
    store.sweepUnreferenced(store.referencedHashesFromSessions());
    assert.equal(store.has(keep.sha256), true);
    assert.equal(store.has(drop.sha256), false);
  });

  test("wipe removes objects, sessions, journals, and maintenance", () => {
    const root = tempDir();
    const store = new ObjectStore(join(root, "store"), DEFAULT_CONFIG);
    const stored = store.put(Buffer.from("wipe-me"));
    const journal = new SessionJournal(store, "session-a");
    journal.appendMutation({
      sessionId: "session-a",
      turnEntryId: "t1",
      toolCallId: "c1",
      toolName: "write",
      path: "/tmp/x",
      key: "/tmp/x",
      pre: { kind: "file", sha256: stored.sha256, size: 7 },
      post: { kind: "absent" },
      coverage: "exact",
      timestamp: new Date().toISOString(),
    });
    mkdirSync(store.journalDir("tx-1"), { recursive: true });
    writeFileSync(join(store.journalDir("tx-1"), "entry.json"), "{}\n");
    store.writeMaintenance({ lastGcAt: "2020-01-01T00:00:00.000Z", storeSizeBytes: 7 });

    store.wipe();

    assert.equal(store.has(stored.sha256), false);
    assert.equal(store.listSessionIds().length, 0);
    assert.equal(existsSync(join(store.journalDir("tx-1"), "entry.json")), false);
    assert.equal(store.readMaintenance().storeSizeBytes, undefined);
    assert.equal(store.sizeBytes(), 0);

    const again = store.put(Buffer.from("after-wipe"));
    assert.equal(again.status, "stored");
    assert.equal(store.has(again.sha256), true);
  });

  test("expired inactive sessions are removed", () => {
    const root = tempDir();
    const storeRoot = join(root, "store");
    const config = { ...DEFAULT_CONFIG, retentionDays: 1 };
    const store = new ObjectStore(storeRoot, config);
    const oldJournal = new SessionJournal(store, "old-session", () => Date.parse("2020-01-01T00:00:00Z"));
    oldJournal.appendMutation({
      sessionId: "old-session",
      turnEntryId: "t1",
      toolCallId: "c1",
      toolName: "write",
      path: "/tmp/x",
      key: "/tmp/x",
      pre: { kind: "absent" },
      post: { kind: "absent" },
      coverage: "exact",
      timestamp: "2020-01-01T00:00:00.000Z",
    });
    const result = runMaintenance(store, config, {
      activeSessionId: "active",
      now: Date.parse("2020-02-01T00:00:00Z"),
      reason: "startup",
    });
    assert.equal(result.ranGc, true);
    assert.equal(result.deletedSessions >= 1, true);
  });

  test("store limit skips new snapshots", async () => {
    const harness = createHarness({
      config: { maxTotalSizeMB: 0.000001, maxFileSizeMB: 10 },
    });
    const file = join(harness.cwd, "big.txt");
    writeFileSync(file, "not huge but over tiny cap");
    await harness.snapshotter.beginWriteEdit({
      toolName: "write",
      toolCallId: "c1",
      path: "big.txt",
      sessionId: "session-1",
      turnEntryId: "turn-1",
    });
    assert.equal(
      harness.notifications.some((message) => message.text.includes("Store limit reached")),
      true,
    );
  });
});
