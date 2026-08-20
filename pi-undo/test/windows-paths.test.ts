import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canonicalizePathKey,
  convertMsysPath,
  convertWslPath,
  isUncPath,
  isWindowsDrivePath,
  normalizeWindowsSeparators,
} from "../src/bash/windows-path.ts";
import { resolveCanonicalPath, toRelativeDisplayPath, type PathContext } from "../src/platform.ts";

function ctx(partial: Partial<PathContext> & Pick<PathContext, "platform">): PathContext {
  return {
    cwd: partial.cwd ?? "C:\\Users\\test",
    home: partial.home ?? "C:\\Users\\test",
    isWsl: partial.isWsl ?? false,
    storeRoot: partial.storeRoot ?? "C:\\Users\\test\\.pi\\agent\\pi-undo",
    excludeGlobs: partial.excludeGlobs ?? [],
    platform: partial.platform,
  };
}

describe("Windows path normalization", () => {
  test("drive paths with mixed separators are the same canonical key", () => {
    const a = normalizeWindowsSeparators("C:\\Users\\test\\a.txt");
    const b = normalizeWindowsSeparators("C:/Users/test/a.txt");
    assert.equal(canonicalizePathKey(a, "win32"), canonicalizePathKey(b, "win32"));
    assert.equal(isWindowsDrivePath("C:\\Users\\test\\a.txt"), true);
    assert.equal(isWindowsDrivePath("C:/Users/test/a.txt"), true);
  });

  test("Git Bash /c/Users/... converts to a Windows path", () => {
    assert.equal(convertMsysPath("/c/Users/test/a.txt"), "C:\\Users\\test\\a.txt");
    const resolved = resolveCanonicalPath("/c/Users/test/a.txt", ctx({ platform: "win32" }));
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(canonicalizePathKey(resolved.path, "win32"), canonicalizePathKey("C:\\Users\\test\\a.txt", "win32"));
    }
  });

  test("WSL /mnt/c/Users/... converts to a Windows path on win32", () => {
    assert.equal(convertWslPath("/mnt/c/Users/test/a.txt"), "C:\\Users\\test\\a.txt");
  });

  test("UNC paths are preserved", () => {
    const unc = "\\\\server\\share\\foo.txt";
    assert.equal(isUncPath(unc), true);
    const resolved = resolveCanonicalPath(unc, ctx({ platform: "win32", cwd: "C:\\tmp" }));
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.path.startsWith("\\\\server\\share\\"), true);
    }
  });

  test("case-insensitive keys on Windows", () => {
    assert.equal(
      canonicalizePathKey("C:\\Foo\\bar.txt", "win32"),
      canonicalizePathKey("c:\\foo\\BAR.txt", "win32"),
    );
  });
});

describe("toRelativeDisplayPath", () => {
  test("returns a posix-style path under cwd", () => {
    assert.equal(
      toRelativeDisplayPath("/home/dev/proj/src/a.ts", "/home/dev/proj", "linux"),
      "src/a.ts",
    );
  });

  test("keeps a relative path when the file is outside cwd", () => {
    assert.equal(
      toRelativeDisplayPath("/tmp/x", "/home/dev/proj", "linux"),
      "../../../tmp/x",
    );
  });

  test("uses forward slashes for Windows paths under cwd", () => {
    assert.equal(
      toRelativeDisplayPath("C:\\Users\\test\\src\\a.ts", "C:\\Users\\test", "win32"),
      "src/a.ts",
    );
  });

  test("normalizes a different Windows drive to forward slashes", () => {
    assert.equal(
      toRelativeDisplayPath("D:\\other\\a.ts", "C:\\Users\\test", "win32"),
      "D:/other/a.ts",
    );
  });
});
