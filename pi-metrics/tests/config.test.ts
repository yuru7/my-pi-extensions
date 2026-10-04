import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  configPath,
  DEFAULT_CONFIG,
  DEFAULT_FORMAT,
  loadConfig,
  parseConfig,
} from "../src/config.ts";

function tempConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-metrics-")), "pi-metrics.json");
}

describe("configPath", () => {
  test("defaults to <agent dir>/pi-metrics.json", () => {
    assert.equal(configPath(), join(getAgentDir(), "pi-metrics.json"));
  });

  test("uses the provided agent directory", () => {
    assert.equal(configPath("/home/tester"), "/home/tester/pi-metrics.json");
  });

  test("honors PI_CODING_AGENT_DIR", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = "/tmp/pi-metrics-agent";
      assert.equal(configPath(), "/tmp/pi-metrics-agent/pi-metrics.json");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

describe("loadConfig", () => {
  test("missing file returns the default config without a warning", () => {
    const result = loadConfig(tempConfigPath());
    assert.deepEqual(result.config, DEFAULT_CONFIG);
    assert.equal(result.warning, undefined);
  });

  test("loads a custom format", () => {
    const path = tempConfigPath();
    writeFileSync(path, JSON.stringify({ format: "{elapsed} | {tps}" }));
    const result = loadConfig(path);
    assert.deepEqual(result.config, { format: "{elapsed} | {tps}" });
    assert.equal(result.warning, undefined);
  });

  test("missing format field falls back to the default format", () => {
    const path = tempConfigPath();
    writeFileSync(path, JSON.stringify({ something: true }));
    assert.deepEqual(loadConfig(path).config, DEFAULT_CONFIG);
  });

  test("unknown fields are ignored", () => {
    const path = tempConfigPath();
    writeFileSync(path, JSON.stringify({ format: "{input}", future: 42 }));
    assert.deepEqual(loadConfig(path).config, { format: "{input}" });
  });

  test("invalid JSON falls back to the default config with a warning", () => {
    const path = tempConfigPath();
    writeFileSync(path, "{ not json");
    const result = loadConfig(path);
    assert.deepEqual(result.config, DEFAULT_CONFIG);
    assert.match(result.warning ?? "", /invalid configuration/);
  });

  test("a non-string format falls back to the default config with a warning", () => {
    const path = tempConfigPath();
    writeFileSync(path, JSON.stringify({ format: 123 }));
    const result = loadConfig(path);
    assert.deepEqual(result.config, DEFAULT_CONFIG);
    assert.match(result.warning ?? "", /format must be a string/);
  });

  test("a non-object root falls back to the default config with a warning", () => {
    const path = tempConfigPath();
    writeFileSync(path, JSON.stringify(["not", "an", "object"]));
    const result = loadConfig(path);
    assert.deepEqual(result.config, DEFAULT_CONFIG);
    assert.match(result.warning ?? "", /must be a JSON object/);
  });
});

describe("parseConfig", () => {
  test("defaults the format when absent", () => {
    assert.equal(parseConfig({}).format, DEFAULT_FORMAT);
  });

  test("preserves an explicit format", () => {
    assert.equal(parseConfig({ format: "x" }).format, "x");
  });
});
