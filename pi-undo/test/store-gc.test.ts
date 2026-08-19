import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { deflateSync } from "node:zlib";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runMaintenance, SessionJournal } from "../src/mutation-journal.ts";
import { objectPath, ObjectStore, sha256 } from "../src/store.ts";
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

describe("CAS object compression", () => {
  test("small objects stay uncompressed and round-trip", () => {
    const store = new ObjectStore(join(tempDir(), "store"), DEFAULT_CONFIG);
    const data = Buffer.from("hello, undo");
    const put = store.put(data);
    assert.equal(put.status, "stored");
    assert.equal(put.sha256, sha256(data));
    assert.equal(put.bytes, data.byteLength);
    assert.deepEqual(store.get(put.sha256), data);

    const raw = objectPath(store.root, put.sha256);
    assert.equal(existsSync(raw), true);
    assert.equal(existsSync(`${raw}.deflate`), false);
    assert.equal(statSync(raw).size, data.byteLength);
    assert.equal(store.sizeBytes(), data.byteLength);
  });

  test("compressible objects are stored as .deflate under the original CAS key", () => {
    const store = new ObjectStore(join(tempDir(), "store"), DEFAULT_CONFIG);
    const data = Buffer.from(`export function greet(name: string): string {\n  return \`hello \${name}\`;\n}\n`.repeat(200));
    assert.ok(data.byteLength >= 4 * 1024);

    const put = store.put(data);
    assert.equal(put.status, "stored");
    assert.equal(put.sha256, sha256(data));
    assert.equal(put.bytes, data.byteLength);
    assert.equal(store.has(put.sha256), true);
    assert.deepEqual(store.get(put.sha256), data);

    const raw = objectPath(store.root, put.sha256);
    const deflate = `${raw}.deflate`;
    assert.equal(existsSync(raw), false);
    assert.equal(existsSync(deflate), true);
    const onDisk = statSync(deflate).size;
    assert.ok(onDisk < data.byteLength, `stored ${onDisk} bytes, original ${data.byteLength}`);
    assert.equal(store.sizeBytes(), onDisk);
  });

  test("incompressible objects stay raw when deflate does not shrink them", () => {
    const store = new ObjectStore(join(tempDir(), "store"), DEFAULT_CONFIG);
    const data = randomBytes(8 * 1024);
    const put = store.put(data);
    assert.equal(put.status, "stored");
    assert.deepEqual(store.get(put.sha256), data);

    const raw = objectPath(store.root, put.sha256);
    assert.equal(existsSync(raw), true);
    assert.equal(existsSync(`${raw}.deflate`), false);
    assert.equal(statSync(raw).size, data.byteLength);
  });

  test("legacy extensionless objects still round-trip", () => {
    const store = new ObjectStore(join(tempDir(), "store"), DEFAULT_CONFIG);
    const data = Buffer.from("legacy-raw-bytes");
    const hash = sha256(data);
    const dest = objectPath(store.root, hash);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, data);
    assert.deepEqual(store.get(hash), data);
  });

  test("legacy PUO1 objects still round-trip", () => {
    const store = new ObjectStore(join(tempDir(), "store"), DEFAULT_CONFIG);
    const small = Buffer.from("abc");
    writeLegacyPuo1(store, small, 0);
    assert.deepEqual(store.get(sha256(small)), small);

    const large = Buffer.alloc(8 * 1024, 65);
    writeLegacyPuo1(store, large, 1);
    assert.deepEqual(store.get(sha256(large)), large);
  });

  test("store quota counts compressed size", () => {
    const store = new ObjectStore(join(tempDir(), "store"), {
      ...DEFAULT_CONFIG,
      maxTotalSizeMB: 0.001,
    });
    const data = Buffer.alloc(50 * 1024, 65);
    const put = store.put(data);
    assert.equal(put.status, "stored");
    assert.ok(store.sizeBytes() < 1024);
    assert.deepEqual(store.get(put.sha256), data);
  });

  test("mark-and-sweep deletes unreferenced deflate objects", () => {
    const store = new ObjectStore(join(tempDir(), "store"), DEFAULT_CONFIG);
    const drop = store.put(Buffer.alloc(8 * 1024, 65));
    assert.equal(existsSync(`${objectPath(store.root, drop.sha256)}.deflate`), true);
    store.sweepUnreferenced(new Set());
    assert.equal(store.has(drop.sha256), false);
  });
});

function writeLegacyPuo1(store: ObjectStore, data: Buffer, codec: 0 | 1): void {
  const dest = objectPath(store.root, sha256(data));
  const payload = codec === 1 ? deflateSync(data, { level: 1 }) : data;
  const stored = Buffer.alloc(9 + payload.byteLength);
  stored.write("PUO1", 0, 4, "ascii");
  stored.writeUInt8(codec, 4);
  stored.writeUInt32BE(data.byteLength, 5);
  stored.set(payload, 9);
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, stored);
}
