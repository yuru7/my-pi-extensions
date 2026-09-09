import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import {
  buildChildArgs,
  flagOn,
  isChildGuardSet,
  runChildStream,
  swallowedPrompt,
} from "../src/child.ts";
import { Renderer } from "../src/renderer.ts";
import { RunStats } from "../src/stats.ts";
import { StreamProcessor } from "../src/events.ts";

describe("flagOn", () => {
  test("accepts boolean true", () => {
    assert.equal(flagOn(true), true);
    assert.equal(flagOn(false), false);
  });

  test("accepts truthy strings", () => {
    assert.equal(flagOn("yes"), true);
    assert.equal(flagOn(" true "), true);
    assert.equal(flagOn("false"), false);
    assert.equal(flagOn("0"), false);
    assert.equal(flagOn("no"), false);
    assert.equal(flagOn(""), false);
  });

  test("rejects other types", () => {
    assert.equal(flagOn(undefined), false);
    assert.equal(flagOn(1), false);
  });
});

describe("swallowedPrompt", () => {
  test("recovers the prompt after --stream", () => {
    assert.equal(swallowedPrompt(["--stream", "hello"]), "hello");
    assert.equal(swallowedPrompt(["-p", "--stream", "hello"]), "hello");
  });

  test("ignores flags and equals form", () => {
    assert.equal(swallowedPrompt(["--stream", "--model", "x"]), undefined);
    assert.equal(swallowedPrompt(["--stream=1", "hello"]), undefined);
    assert.equal(swallowedPrompt(["-p", "hello"]), undefined);
  });
});

describe("buildChildArgs", () => {
  test("sets json mode and print with passthrough flags", () => {
    const args = buildChildArgs(
      ["-p", "hello", "--model", "foo", "--stream"],
      "hello",
      undefined,
    );
    assert.deepEqual(args, ["--mode", "json", "-p", "hello", "--model", "foo"]);
  });

  test("drops swallowed prompt and previous mode", () => {
    const args = buildChildArgs(
      ["--stream", "hello", "--mode", "text", "--thinking", "high"],
      "hello",
      "hello",
    );
    assert.deepEqual(args, [
      "--mode",
      "json",
      "-p",
      "hello",
      "--thinking",
      "high",
    ]);
  });

  test("drops equals-form flags", () => {
    const args = buildChildArgs(
      ["--stream=true", "--mode=json", "-p", "hi"],
      "hi",
      undefined,
    );
    assert.deepEqual(args, ["--mode", "json", "-p", "hi"]);
  });

  test("keeps dash-leading prompts behind -- and drops the dangling separator", () => {
    const args = buildChildArgs(
      ["-p", "--stream", "--", "- summarize"],
      "- summarize",
      undefined,
    );
    assert.deepEqual(args, ["--mode", "json", "-p", "- summarize"]);
  });

  test("drops the swallowed prompt value but keeps other positionals", () => {
    const args = buildChildArgs(
      ["--stream", "hello", "--model", "foo"],
      "hello",
      "hello",
    );
    assert.deepEqual(args, ["--mode", "json", "-p", "hello", "--model", "foo"]);
  });
});

describe("isChildGuardSet", () => {
  test("detects the guard variable", () => {
    assert.equal(isChildGuardSet({ PI_STREAM_WRAPPER_CHILD: "1" }), true);
    assert.equal(isChildGuardSet({}), false);
  });
});

class FakeChild extends EventEmitter {
  stdout: PassThrough;
  killedWith: string | undefined;

  constructor() {
    super();
    this.stdout = new PassThrough();
  }

  kill(signal?: string): boolean {
    this.killedWith = signal;
    return true;
  }
}

function createCapture(isTTY: boolean) {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const stdout = {
    isTTY,
    columns: 80,
    write: (chunk: string) => {
      outChunks.push(String(chunk));
      return true;
    },
    on: () => stdout,
    off: () => stdout,
  } as unknown as NodeJS.WriteStream;
  const stderr = {
    write: (chunk: string) => {
      errChunks.push(String(chunk));
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { outChunks, errChunks, stdout, stderr };
}

describe("runChildStream", () => {
  test("streams text and writes Done summary on success", async () => {
    const capture = createCapture(false);
    const renderer = new Renderer({ isTTY: false, stdout: capture.stdout });
    const stats = new RunStats(() => 0);
    const processor = new StreamProcessor(renderer, stats);
    let child!: FakeChild;
    const exitCode = await runChildStream(["--mode", "json", "-p", "hi"], {
      renderer,
      stats,
      processor,
      stdout: capture.stdout,
      stderr: capture.stderr,
      spawnFn: () => {
        child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.write(
            '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}\n',
          );
          child.stdout.write(
            '{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0},"stopReason":"stop"}}\n',
          );
          child.emit("close", 0, null);
        });
        return child as never;
      },
    });
    assert.equal(exitCode, 0);
    const out = capture.outChunks.join("");
    assert.ok(out.includes("hi"));
    assert.ok(out.includes("Done"));
    assert.ok(out.includes("10"));
  });

  test("assistant error maps to exit 1 with Failed summary", async () => {
    const capture = createCapture(false);
    const renderer = new Renderer({ isTTY: false, stdout: capture.stdout });
    const stats = new RunStats(() => 0);
    const processor = new StreamProcessor(renderer, stats);
    const exitCode = await runChildStream([], {
      renderer,
      stats,
      processor,
      stdout: capture.stdout,
      stderr: capture.stderr,
      spawnFn: () => {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.write(
            '{"type":"message_end","message":{"role":"assistant","usage":{},"stopReason":"error"}}\n',
          );
          child.emit("close", 0, null);
        });
        return child as never;
      },
    });
    assert.equal(exitCode, 1);
    assert.ok(capture.outChunks.join("").includes("Failed"));
  });

  test("non-zero child exit propagates with Failed summary", async () => {
    const capture = createCapture(false);
    const renderer = new Renderer({ isTTY: false, stdout: capture.stdout });
    const stats = new RunStats(() => 0);
    const processor = new StreamProcessor(renderer, stats);
    const exitCode = await runChildStream([], {
      renderer,
      stats,
      processor,
      stdout: capture.stdout,
      stderr: capture.stderr,
      spawnFn: () => {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.emit("close", 3, null);
        });
        return child as never;
      },
    });
    assert.equal(exitCode, 3);
    assert.ok(capture.outChunks.join("").includes("Failed"));
  });

  test("malformed lines warn on stderr without breaking stdout", async () => {
    const capture = createCapture(false);
    const renderer = new Renderer({ isTTY: false, stdout: capture.stdout });
    const stats = new RunStats(() => 0);
    const processor = new StreamProcessor(renderer, stats);
    const exitCode = await runChildStream([], {
      renderer,
      stats,
      processor,
      stdout: capture.stdout,
      stderr: capture.stderr,
      spawnFn: () => {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.write("{broken\n");
          child.stdout.write('{"type":"agent_start"}\n');
          child.emit("close", 0, null);
        });
        return child as never;
      },
    });
    assert.equal(exitCode, 0);
    assert.ok(capture.errChunks.join("").includes("malformed"));
    assert.ok(capture.outChunks.join("").includes("Done"));
  });

  test("spawn failure writes Failed summary and exits 1", async () => {
    const capture = createCapture(false);
    const exitCode = await runChildStream([], {
      stdout: capture.stdout,
      stderr: capture.stderr,
      isTTY: false,
      spawnFn: () => {
        throw new Error("nope");
      },
    });
    assert.equal(exitCode, 1);
  });

  test("close signal maps to conventional exit codes", async () => {
    for (const [signal, expected] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const capture = createCapture(false);
      const renderer = new Renderer({ isTTY: false, stdout: capture.stdout });
      const stats = new RunStats(() => 0);
      const exitCode = await runChildStream([], {
        renderer,
        stats,
        stdout: capture.stdout,
        stderr: capture.stderr,
        spawnFn: () => {
          const child = new FakeChild();
          queueMicrotask(() => {
            child.emit("close", null, signal);
          });
          return child as never;
        },
      });
      assert.equal(exitCode, expected);
    }
  });
});
