import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  CONFIG_LOAD_WARNING,
  DEFAULT_CONFIG,
  getConfigPath,
  getStoreRoot,
  loadConfig,
  parseConfig,
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

  test("missing file uses defaults without warning", () => {
    const loaded = loadConfig(join(tempDir(), "missing.json"));
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.equal(loaded.warning, undefined);
  });

  test("broken JSON uses defaults and warns", () => {
    const path = join(tempDir(), "broken.json");
    writeFileSync(path, "{nope", "utf8");
    const loaded = loadConfig(path);
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.equal(loaded.warning, CONFIG_LOAD_WARNING);
  });

  test("paths live under ~/.pi/agent", () => {
    assert.equal(getConfigPath("/home/dev"), join("/home/dev", ".pi", "agent", "pi-rollback.json"));
    assert.equal(getStoreRoot("/home/dev"), join("/home/dev", ".pi", "agent", "pi-rollback"));
  });
});
