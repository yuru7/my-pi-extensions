import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extractBashTargets, isPathLike } from "../src/bash/extract-paths.ts";
import { tokenize } from "../src/bash/lexer.ts";

describe("bash lexer", () => {
  test("understands quotes, operators, and redirects", () => {
    const tokens = tokenize(`echo 'a b' && cat "x y" > out.txt || true | wc`);
    assert.deepEqual(
      tokens.map((token) => [token.kind, token.value]),
      [
        ["word", "echo"],
        ["word", "a b"],
        ["operator", "&&"],
        ["word", "cat"],
        ["word", "x y"],
        ["redirect", ">"],
        ["word", "out.txt"],
        ["operator", "||"],
        ["word", "true"],
        ["operator", "|"],
        ["word", "wc"],
      ],
    );
  });

  test("treats $(...) as opaque unresolved tokens", () => {
    const tokens = tokenize("rm $(echo ./secret)");
    assert.equal(tokens.some((token) => token.kind === "opaque" && token.unresolved), true);
  });
});

describe("bash path extraction", () => {
  test("extracts rm / cp / mv / sed -i / redirect / find -delete", () => {
    assert.deepEqual(extractBashTargets("rm ./gone.txt").paths, ["./gone.txt"]);
    assert.ok(extractBashTargets("cp src.txt dst.txt").paths.includes("src.txt"));
    assert.ok(extractBashTargets("cp src.txt dst.txt").paths.includes("dst.txt"));
    assert.ok(extractBashTargets("mv a b").paths.includes("a"));
    assert.ok(extractBashTargets("mv a b").paths.includes("b"));
    assert.ok(extractBashTargets("sed -i s/a/b/ file.txt").paths.includes("file.txt"));
    assert.deepEqual(extractBashTargets("echo x > file.txt").paths, ["file.txt"]);
    assert.ok(extractBashTargets("find dir -name '*.js' -delete").paths.includes("dir"));
    assert.ok(extractBashTargets("find dir -exec rm {} ;").paths.includes("dir"));
    assert.ok(extractBashTargets("git checkout -- file.txt").paths.includes("file.txt"));
    assert.ok(extractBashTargets("dd of=out.bin").paths.includes("out.bin"));
  });

  test("ignores inspect-only commands even when they mention paths", () => {
    assert.deepEqual(extractBashTargets("pwd && ls -la && find . -maxdepth 3 -type f").paths, []);
    assert.equal(extractBashTargets("pwd && ls -la && find . -maxdepth 3 -type f").mutating, false);
    assert.deepEqual(extractBashTargets("cat ./README.md").paths, []);
    assert.deepEqual(extractBashTargets("ls ./src").paths, []);
    assert.deepEqual(extractBashTargets("find dir -name '*.js'").paths, []);
    assert.equal(extractBashTargets("git status").mutating, false);
    assert.equal(extractBashTargets("dd if=in.bin").mutating, false);
  });

  test("marks interpreter commands as partial coverage", () => {
    const extracted = extractBashTargets("python scripts/migrate.py");
    assert.equal(extracted.coverage, "partial");
    assert.equal(extracted.interpreter, true);
    assert.equal(extracted.mutating, true);
    assert.deepEqual(extracted.paths, []);
  });

  test("detects path-like tokens", () => {
    assert.equal(isPathLike("./foo"), true);
    assert.equal(isPathLike("../foo"), true);
    assert.equal(isPathLike("/foo"), true);
    assert.equal(isPathLike("~/foo"), true);
    assert.equal(isPathLike("foo/bar"), true);
    assert.equal(isPathLike("plain.txt"), false);
  });
});
