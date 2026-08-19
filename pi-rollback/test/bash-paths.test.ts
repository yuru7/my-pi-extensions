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
  });

  test("marks interpreter commands as partial coverage", () => {
    const extracted = extractBashTargets("python scripts/migrate.py");
    assert.equal(extracted.coverage, "partial");
    assert.ok(extracted.paths.includes("scripts/migrate.py"));
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
