import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, test } from "node:test";
import {
  createColumnsProbe,
  formatCount,
  formatSeconds,
  formatTps,
  isRealTTY,
  safeJsonStringify,
  sanitizeJsonValue,
  separatorLine,
  stripAnsi,
  writeRealStdout,
} from "../src/terminal.ts";

describe("terminal helpers", () => {
  test("stripAnsi removes escape sequences", () => {
    assert.equal(stripAnsi("\x1b[2mdim\x1b[0m plain"), "dim plain");
    assert.equal(stripAnsi("no escapes"), "no escapes");
  });

  test("safeJsonStringify never throws", () => {
    assert.equal(safeJsonStringify({ a: 1 }), '{"a":1}');
    assert.equal(safeJsonStringify(undefined), "null");
  });

  test("safeJsonStringify tolerates circular and BigInt values", () => {
    const circular: Record<string, unknown> = { n: 1n };
    circular.self = circular;
    assert.equal(
      safeJsonStringify(circular),
      '{"n":"1","self":"<circular>"}',
    );
    // Shared (non-circular) references are preserved.
    const shared = { v: 1 };
    assert.equal(
      safeJsonStringify({ a: shared, b: shared }),
      '{"a":{"v":1},"b":{"v":1}}',
    );
  });

  test("sanitizeJsonValue drops unserializable leaves", () => {
    assert.deepEqual(
      sanitizeJsonValue({ fn: () => 1, sym: Symbol("s"), u: undefined, keep: 1 }),
      { keep: 1 },
    );
    assert.deepEqual(sanitizeJsonValue([undefined, 1]), [null, 1]);
    assert.deepEqual(
      sanitizeJsonValue({ when: new Date("2026-01-02T03:04:05.000Z") }),
      { when: "2026-01-02T03:04:05.000Z" },
    );
  });

  test("formatCount uses thousands separators", () => {
    assert.equal(formatCount(12481), "12,481");
    assert.equal(formatCount(0), "0");
    assert.equal(formatCount(Number.NaN), "0");
  });

  test("formatSeconds shows one decimal", () => {
    assert.equal(formatSeconds(24800), "24.8s");
    assert.equal(formatSeconds(0), "0.0s");
  });

  test("formatTps divides output by generation seconds", () => {
    assert.equal(formatTps(3842, 11600), "331.2 tok/s");
    assert.equal(formatTps(100, 0), "-");
  });

  test("separatorLine is clamped", () => {
    assert.equal(separatorLine(80).length, 40);
    assert.equal(separatorLine(5).length, 10);
    assert.equal(separatorLine(200, 60).length, 60);
  });
});

describe("real stdout helpers", () => {
  test("isRealTTY is false for piped test output", () => {
    // Under `node --test` fd 1 is a pipe, never a TTY.
    assert.equal(isRealTTY(1), false);
  });

  test("isRealTTY is false for /dev/null (character device, not a TTY)", () => {
    let fd: number | undefined;
    try {
      fd = fs.openSync("/dev/null", "w");
    } catch {
      // Non-Unix platform without /dev/null; nothing to assert.
      return;
    }
    try {
      assert.equal(isRealTTY(fd), false);
    } finally {
      fs.closeSync(fd);
    }
  });

  test("writeRealStdout never throws on empty input", () => {
    // NOTE: non-empty writes go to fd 1 and would corrupt TAP output,
    // so only the no-op path is exercised here (live runs cover the rest).
    writeRealStdout("");
  });

  test("createColumnsProbe honors env and fallback", () => {
    if (isRealTTY(1)) {
      // On a real TTY the probed width wins; nothing deterministic to assert.
      return;
    }
    const previousEnv = process.env.COLUMNS;
    process.env.COLUMNS = "132";
    try {
      // fd 1 is a pipe here, so the env value is used.
      assert.equal(createColumnsProbe(1)(), 132);
    } finally {
      if (previousEnv === undefined) {
        delete process.env.COLUMNS;
      } else {
        process.env.COLUMNS = previousEnv;
      }
    }
    delete process.env.COLUMNS;
    // process.stdout/stderr may or may not have columns in this env;
    // either a probed positive width or the fallback must come out.
    const width = createColumnsProbe(1, 77)();
    assert.ok(width === 77 || width > 0);
    const probe = createColumnsProbe(1, 77);
    assert.equal(probe.refresh(), probe());
  });
});
