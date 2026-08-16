import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  detectEnvironment,
  isWsl,
  selectBackend,
  type EnvironmentProbe,
} from "../extensions/environment.ts";

function probe(
  partial: Partial<EnvironmentProbe> & Pick<EnvironmentProbe, "platform">,
): EnvironmentProbe {
  return {
    env: {},
    ...partial,
  };
}

describe("detectEnvironment", () => {
  test("win32 は Windows notifier", () => {
    assert.equal(detectEnvironment(probe({ platform: "win32" })), "windows");
    assert.equal(selectBackend("windows"), "windows");
  });

  test("darwin は macOS notifier", () => {
    assert.equal(detectEnvironment(probe({ platform: "darwin" })), "macos");
    assert.equal(selectBackend("macos"), "macos");
  });

  test("Linux native は Linux notifier", () => {
    const env = detectEnvironment(
      probe({
        platform: "linux",
        readFile: () => "6.8.0-generic",
      }),
    );
    assert.equal(env, "linux");
    assert.equal(selectBackend(env), "linux");
  });

  test("WSL_DISTRO_NAME があれば WSL", () => {
    const env = detectEnvironment(
      probe({
        platform: "linux",
        env: { WSL_DISTRO_NAME: "Ubuntu" },
      }),
    );
    assert.equal(env, "wsl");
    assert.equal(selectBackend(env), "windows");
  });

  test("WSL_INTEROP があれば WSL", () => {
    const env = detectEnvironment(
      probe({
        platform: "linux",
        env: { WSL_INTEROP: "/run/WSL/1_interop" },
      }),
    );
    assert.equal(env, "wsl");
    assert.equal(selectBackend(env), "windows");
  });

  test("/proc の Microsoft / WSL 表記で WSL と判定する", () => {
    assert.equal(
      detectEnvironment(
        probe({
          platform: "linux",
          readFile: (path) =>
            path.endsWith("osrelease")
              ? "6.6.87.2-microsoft-standard-WSL2"
              : "Linux",
        }),
      ),
      "wsl",
    );
    assert.equal(
      detectEnvironment(
        probe({
          platform: "linux",
          readFile: (path) =>
            path.endsWith("version")
              ? "linux version 5.15.0-microsoft-standard-wsl2"
              : "generic",
        }),
      ),
      "wsl",
    );
  });

  test("通常の Linux カーネルを WSL と誤判定しない", () => {
    assert.equal(
      isWsl(
        probe({
          platform: "linux",
          readFile: () => "6.8.0-40-generic #40-Ubuntu SMP",
        }),
      ),
      false,
    );
  });

  test("未対応プラットフォームは通知しない", () => {
    assert.equal(detectEnvironment(probe({ platform: "freebsd" })), "unsupported");
    assert.equal(selectBackend("unsupported"), null);
  });
});
