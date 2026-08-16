import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  DEFAULT_CONFIG,
  getConfigPath,
  loadConfig,
  parseConfig,
  parseThresholdInput,
  saveConfig,
} from "../extensions/config.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-notify-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("parseThresholdInput", () => {
  test("0 と小数と整数を受け入れる", () => {
    assert.equal(parseThresholdInput("0"), 0);
    assert.equal(parseThresholdInput("0.5"), 0.5);
    assert.equal(parseThresholdInput("1"), 1);
    assert.equal(parseThresholdInput("30"), 30);
    assert.equal(parseThresholdInput(" 60 "), 60);
    assert.equal(parseThresholdInput("300"), 300);
  });

  test("不正値を拒否する", () => {
    assert.equal(parseThresholdInput("-1"), undefined);
    assert.equal(parseThresholdInput("abc"), undefined);
    assert.equal(parseThresholdInput("NaN"), undefined);
    assert.equal(parseThresholdInput("Infinity"), undefined);
    assert.equal(parseThresholdInput(""), undefined);
    assert.equal(parseThresholdInput("   "), undefined);
  });
});

describe("parseConfig", () => {
  test("不正な値はデフォルト 30 秒へフォールバックする", () => {
    assert.deepEqual(parseConfig(null), DEFAULT_CONFIG);
    assert.deepEqual(parseConfig("nope"), DEFAULT_CONFIG);
    assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
    assert.deepEqual(parseConfig({ thresholdSeconds: -1 }), DEFAULT_CONFIG);
    assert.deepEqual(parseConfig({ thresholdSeconds: Number.NaN }), DEFAULT_CONFIG);
    assert.deepEqual(
      parseConfig({ thresholdSeconds: Number.POSITIVE_INFINITY }),
      DEFAULT_CONFIG,
    );
    assert.deepEqual(parseConfig({ thresholdSeconds: "30" }), DEFAULT_CONFIG);
  });

  test("0 は有効な閾値として残す", () => {
    assert.deepEqual(parseConfig({ thresholdSeconds: 0 }), {
      thresholdSeconds: 0,
    });
  });

  test("powershellPath を任意項目として読み取る", () => {
    assert.deepEqual(
      parseConfig({
        thresholdSeconds: 10,
        powershellPath: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      }),
      {
        thresholdSeconds: 10,
        powershellPath:
          "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      },
    );
    assert.deepEqual(parseConfig({ thresholdSeconds: 10, powershellPath: "  " }), {
      thresholdSeconds: 10,
    });
  });
});

describe("loadConfig / saveConfig", () => {
  test("ファイルなしはデフォルト 30 秒", () => {
    const path = join(tempDir(), "missing.json");
    assert.deepEqual(loadConfig(path), DEFAULT_CONFIG);
  });

  test("壊れた JSON はデフォルト 30 秒", () => {
    const path = join(tempDir(), "broken.json");
    writeFileSync(path, "{not json", "utf8");
    assert.deepEqual(loadConfig(path), DEFAULT_CONFIG);
  });

  test("正常な JSON を読み込む", () => {
    const path = join(tempDir(), "ok.json");
    writeFileSync(path, '{"thresholdSeconds": 5}\n', "utf8");
    assert.deepEqual(loadConfig(path), { thresholdSeconds: 5 });
  });

  test("保存した設定を再ロードできる", () => {
    const path = join(tempDir(), "agent", "notify-settings.json");
    saveConfig({ thresholdSeconds: 7, powershellPath: "powershell.exe" }, path);
    assert.deepEqual(loadConfig(path), {
      thresholdSeconds: 7,
      powershellPath: "powershell.exe",
    });
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(written.thresholdSeconds, 7);
  });

  test("設定パスは ~/.pi/agent/notify-settings.json", () => {
    assert.equal(
      getConfigPath("/home/dev"),
      join("/home/dev", ".pi", "agent", "notify-settings.json"),
    );
  });
});
