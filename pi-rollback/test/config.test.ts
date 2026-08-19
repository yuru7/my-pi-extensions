import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  CONFIG_LOAD_WARNING,
  DEFAULT_CONFIG,
  getConfigPath,
  getStoreRoot,
  loadConfig,
  parseConfig,
  saveConfig,
  shouldRestoreOnTree,
} from "../src/config.ts";
import { cleanupTempDirs, tempDir } from "./helpers.ts";

afterEach(() => {
  cleanupTempDirs();
});

describe("config", () => {
  test("defaults match the v1 spec", () => {
    assert.deepEqual(parseConfig(null), DEFAULT_CONFIG);
    assert.equal(DEFAULT_CONFIG.enabled, true);
    assert.equal(DEFAULT_CONFIG.maxFileSizeMB, 10);
    assert.equal(DEFAULT_CONFIG.maxTotalSizeMB, 500);
    assert.equal(DEFAULT_CONFIG.retentionDays, 14);
    assert.equal(DEFAULT_CONFIG.safeRestore, true);
    assert.equal(DEFAULT_CONFIG.syncTree, true);
    assert.equal(DEFAULT_CONFIG.bash.maxFilesPerCall, 5000);
    assert.equal(DEFAULT_CONFIG.bash.maxBytesPerCallMB, 200);
  });

  test("invalid values fall back to defaults", () => {
    const parsed = parseConfig({
      enabled: "yes",
      maxFileSizeMB: -1,
      retentionDays: "nope",
      bash: { maxFilesPerCall: 0 },
    });
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.maxFileSizeMB, 10);
    assert.equal(parsed.retentionDays, 14);
    assert.equal(parsed.bash.maxFilesPerCall, 5000);
  });

  test("syncTree can be turned off", () => {
    assert.equal(parseConfig({ syncTree: false }).syncTree, false);
    assert.equal(parseConfig({ syncTree: "no" }).syncTree, true);
  });

  test("missing file writes defaults", () => {
    const path = join(tempDir(), "missing.json");
    const loaded = loadConfig(path);
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.equal(loaded.created, true);
    assert.equal(loaded.warning, undefined);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), DEFAULT_CONFIG);
  });

  test("broken JSON uses defaults and warns", () => {
    const path = join(tempDir(), "broken.json");
    writeFileSync(path, "{nope", "utf8");
    const loaded = loadConfig(path);
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.equal(loaded.warning, CONFIG_LOAD_WARNING);
    assert.equal(readFileSync(path, "utf8"), "{nope");
  });

  test("paths live under ~/.pi/agent", () => {
    assert.equal(getConfigPath("/home/dev"), join("/home/dev", ".pi", "agent", "pi-rollback.json"));
    assert.equal(getStoreRoot("/home/dev"), join("/home/dev", ".pi", "agent", "pi-rollback"));
  });

  test("shouldRestoreOnTree respects syncTree except for /rollback", () => {
    const on = { ...DEFAULT_CONFIG, syncTree: true };
    const off = { ...DEFAULT_CONFIG, syncTree: false };
    assert.equal(shouldRestoreOnTree(on), true);
    assert.equal(shouldRestoreOnTree(off), false);
    assert.equal(shouldRestoreOnTree(off, { fromExtension: true }), true);
    assert.equal(shouldRestoreOnTree(off, { fromRollbackCommand: true }), true);
  });

  test("saveConfig round-trips", () => {
    const path = join(tempDir(), "agent", "pi-rollback.json");
    saveConfig({ ...DEFAULT_CONFIG, syncTree: false }, path);
    assert.deepEqual(loadConfig(path).config.syncTree, false);
  });
});
