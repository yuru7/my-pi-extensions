import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { parseJsonLine, StreamProcessor } from "./events.ts";
import { Renderer } from "./renderer.ts";
import { RunStats } from "./stats.ts";
import {
  createColumnsProbe,
  isRealTTY,
  writeRealStdout,
} from "./terminal.ts";

export const STREAM_FLAG = "stream";
/** Set on the spawned child so it renders normally instead of re-wrapping. */
export const CHILD_GUARD = "PI_STREAM_WRAPPER_CHILD";

/** Whether --stream is on. Boolean flag; tolerate stringy truthy values. */
export function flagOn(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return (
      normalized !== "" &&
      normalized !== "false" &&
      normalized !== "0" &&
      normalized !== "no"
    );
  }
  return false;
}

/**
 * If Pi's arg parser swallowed the prompt into `--stream`'s value
 * (`pi --stream "prompt"`), return that word. Returns undefined when nothing
 * was swallowed.
 */
export function swallowedPrompt(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === `--${STREAM_FLAG}`) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        return next;
      }
      return undefined;
    }
    if (token.startsWith(`--${STREAM_FLAG}=`)) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Build the child `pi --mode json -p <prompt>` argv from the parent's argv.
 * Passes through everything except the prompt, --stream (and its swallowed
 * value), and any -p/--print/--mode (we set --mode json -p explicitly).
 */
export function buildChildArgs(
  argv: readonly string[],
  prompt: string,
  swallowed: string | undefined,
): string[] {
  const passthrough: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${STREAM_FLAG}`) {
      if (swallowed !== undefined && argv[i + 1] === swallowed) {
        i++;
      }
      continue;
    }
    if (arg.startsWith(`--${STREAM_FLAG}=`)) {
      continue;
    }
    if (arg === "-p" || arg === "--print") {
      continue;
    }
    if (arg === "--mode") {
      i++;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      continue;
    }
    if (arg === prompt) {
      continue;
    }
    passthrough.push(arg);
  }
  // A dangling `--` (left after the prompt was dropped) carries no meaning
  // for the child parser, so remove it to keep the child argv clean.
  while (passthrough.length > 0 && passthrough[passthrough.length - 1] === "--") {
    passthrough.pop();
  }
  return ["--mode", "json", "-p", prompt, ...passthrough];
}

export function isChildGuardSet(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CHILD_GUARD] === "1";
}

export interface ChildRunDeps {
  renderer?: Renderer;
  stats?: RunStats;
  processor?: StreamProcessor;
  /**
   * Test seam for the output target. Production code omits this and writes
   * to the real stdout (fd 1), bypassing Pi's print-mode stdout takeover.
   */
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  write?: (chunk: string) => void;
  spawnFn?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "inherit"] },
  ) => ChildProcess;
  isTTY?: boolean;
  columns?: () => number;
}

function resolveCommand(childArgs: string[]): { command: string; args: string[] } {
  const cli = process.argv[1];
  if (cli) {
    return { command: process.execPath, args: [cli, ...childArgs] };
  }
  return { command: "pi", args: childArgs };
}

interface ResizeEmitter {
  on(event: "resize", listener: () => void): void;
  off(event: "resize", listener: () => void): void;
}

function asResizeEmitter(value: unknown): ResizeEmitter | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { on, off } = value as Record<string, unknown>;
  if (typeof on !== "function" || typeof off !== "function") {
    return undefined;
  }
  return value as ResizeEmitter;
}

/**
 * Spawn `pi --mode json -p <prompt>` and render its JSONL event stream.
 * Resolves with the exit code the parent should use.
 */
export function runChildStream(
  childArgs: string[],
  deps: ChildRunDeps = {},
): Promise<number> {
  const stderr =
    deps.stderr ?? (process.stderr as unknown as NodeJS.WriteStream);
  const columnsProbe = createColumnsProbe();
  const columns = deps.columns ?? columnsProbe;
  const seamStdout = deps.stdout;
  const isTTY =
    deps.isTTY ?? (seamStdout ? seamStdout.isTTY === true : isRealTTY());
  const write =
    deps.write ??
    (seamStdout
      ? (chunk: string) => {
          try {
            seamStdout.write(chunk);
          } catch {
            // Ignore write errors in tests.
          }
        }
      : writeRealStdout);
  const renderer =
    deps.renderer ?? new Renderer({ isTTY, columns, write });
  const stats = deps.stats ?? new RunStats();
  const processor = deps.processor ?? new StreamProcessor(renderer, stats);
  const spawnFn =
    deps.spawnFn ??
    ((command: string, args: string[], options: Parameters<typeof spawn>[2]) =>
      spawn(command, args, options) as ChildProcess);

  return new Promise<number>((resolve) => {
    const { command, args } = resolveCommand(childArgs);
    let child: ChildProcess;
    try {
      child = spawnFn(command, args, {
        env: { ...process.env, [CHILD_GUARD]: "1" },
        stdio: ["ignore", "pipe", "inherit"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      renderer.writeError(`[stream] failed to spawn child: ${message}`);
      processor.abortGeneration();
      renderer.fail(stats.snapshot());
      resolve(1);
      return;
    }

    let settled = false;
    let pendingSignal: NodeJS.Signals | undefined;

    const finish = (code: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      processor.abortGeneration();
      const failed = code !== 0 || processor.hasError();
      try {
        if (failed) {
          renderer.fail(stats.snapshot());
        } else {
          renderer.finish(stats.snapshot());
        }
      } catch {
        // Summary must not mask the exit code.
      }
      resolve(code);
    };

    const forwardSignal = (signal: NodeJS.Signals): void => {
      pendingSignal = signal;
      try {
        renderer.clearThinking();
      } catch {
        // Ignore cleanup errors during signal handling.
      }
      try {
        child.kill(signal);
      } catch {
        // Child may already be gone.
      }
      if (signal === "SIGINT") {
        process.exitCode = 130;
      } else if (signal === "SIGTERM") {
        process.exitCode = 143;
      }
    };

    const onSigint = (): void => {
      forwardSignal("SIGINT");
    };
    const onSigterm = (): void => {
      forwardSignal("SIGTERM");
    };
    const onExit = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Gone.
      }
    };
    const onResize = (): void => {
      try {
        columnsProbe.refresh();
      } catch {
        // Keep the last known width.
      }
      renderer.repaintThinking();
    };
    // `process.stdout` is replaced inside Pi's extension sandbox, so its
    // resize emitter is unreliable there. SIGWINCH always reflects the real
    // terminal and is the primary resize source on Unix.
    const onSigWinch = (): void => {
      onResize();
    };

    const resizeEmitters: ResizeEmitter[] = [];
    for (const source of [process.stdout, process.stderr, seamStdout]) {
      const emitter = asResizeEmitter(source);
      if (emitter) {
        resizeEmitters.push(emitter);
      }
    }

    const cleanup = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.off("exit", onExit);
      if (process.platform !== "win32") {
        try {
          process.off("SIGWINCH", onSigWinch);
        } catch {
          // Never supported here; ignore.
        }
      }
      for (const emitter of resizeEmitters) {
        try {
          emitter.off("resize", onResize);
        } catch {
          // Streams without emitter support; ignore.
        }
      }
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    process.once("exit", onExit);
    if (process.platform !== "win32") {
      try {
        process.on("SIGWINCH", onSigWinch);
      } catch {
        // Platform without SIGWINCH; resize events are best-effort.
      }
    }
    for (const emitter of resizeEmitters) {
      try {
        emitter.on("resize", onResize);
      } catch {
        // Non-TTY streams may not support resize; ignore.
      }
    }

    if (!child.stdout) {
      renderer.writeError("[stream] child produced no output");
      finish(1);
      return;
    }

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line: string) => {
      if (!line.trim()) {
        return;
      }
      const parsed = parseJsonLine(line);
      if (!parsed.ok) {
        try {
          stderr.write(`[stream] ignoring malformed event: ${parsed.error}\n`);
        } catch {
          // stderr write failure must not break the stream.
        }
        return;
      }
      try {
        processor.handle(parsed.event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          stderr.write(`[stream] failed to handle event: ${message}\n`);
        } catch {
          // Ignore.
        }
      }
    });

    child.on("error", () => {
      try {
        rl.close();
      } catch {
        // Ignore.
      }
      finish(1);
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      try {
        rl.close();
      } catch {
        // Ignore.
      }
      if (pendingSignal === "SIGINT") {
        finish(130);
        return;
      }
      if (pendingSignal === "SIGTERM") {
        finish(143);
        return;
      }
      if (signal === "SIGINT") {
        finish(130);
        return;
      }
      if (signal === "SIGTERM") {
        finish(143);
        return;
      }
      if (typeof code === "number" && code !== 0) {
        finish(code);
        return;
      }
      finish(processor.hasError() ? 1 : 0);
    });
  });
}
