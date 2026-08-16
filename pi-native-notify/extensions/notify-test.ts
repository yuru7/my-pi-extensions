import { spawn } from "node:child_process";
import type { NotifyConfig } from "./config.ts";
import type { NotifyBackend, NotifyEnvironment } from "./environment.ts";
import {
  planNotify,
  type CommandInvocation,
  type Notification,
  type NotifyOptions,
} from "./notifier.ts";

export const TEST_NOTIFICATION: Notification = {
  title: "Test - Pi",
  message: "Native notification test",
};

export const TEST_SPAWN_TIMEOUT_MS = 15_000;

const BACKEND_LABEL: Record<NotifyBackend, string> = {
  windows: "Windows toast (PowerShell)",
  linux: "notify-send",
  macos: "osascript display notification",
};

export interface NotifyTestResult {
  environment: NotifyEnvironment;
  platform: NodeJS.Platform;
  backend: NotifyBackend | null;
  invocation: CommandInvocation | null;
  powershellPath?: string;
  wslDistro?: string;
  sent: boolean;
  error?: string;
}

export interface NotifyTestOptions {
  powershellPath?: string;
  probe?: NotifyOptions["probe"];
  wait?: (invocation: CommandInvocation) => Promise<{ error?: string }>;
}

export function spawnAndWait(
  invocation: CommandInvocation,
  timeoutMs = TEST_SPAWN_TIMEOUT_MS,
): Promise<{ exitCode: number | null; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { exitCode: number | null; error?: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, invocation.args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      finish({
        exitCode: null,
        error: `timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        finish({
          exitCode: null,
          error: `command not found: ${invocation.command}`,
        });
        return;
      }
      finish({ exitCode: null, error: error.message });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish({ exitCode: 0 });
        return;
      }
      const detail = stderr.trim();
      finish({
        exitCode: code,
        error: detail || `exit ${code ?? "unknown"}`,
      });
    });
  });
}

export async function runNotifyTest(
  config: NotifyConfig,
  options: NotifyTestOptions = {},
): Promise<NotifyTestResult> {
  const probe = options.probe ?? {
    platform: process.platform,
    env: process.env,
  };
  const powershellPath = config.powershellPath ?? options.powershellPath;
  const plan = planNotify(TEST_NOTIFICATION, {
    powershellPath,
    probe,
  });

  const result: NotifyTestResult = {
    environment: plan.environment,
    platform: probe.platform,
    backend: plan.backend,
    invocation: plan.invocation,
    sent: false,
  };
  if (config.powershellPath) {
    result.powershellPath = config.powershellPath;
  }
  const wslDistro = probe.env.WSL_DISTRO_NAME;
  if (plan.environment === "wsl" && wslDistro) {
    result.wslDistro = wslDistro;
  }

  if (plan.invocation === null) {
    return result;
  }

  try {
    const wait = options.wait ?? spawnAndWait;
    const waited = await wait(plan.invocation);
    if (waited.error) {
      result.error = waited.error;
      return result;
    }
    result.sent = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

function formatInvocationArgs(invocation: CommandInvocation): string {
  return invocation.args
    .map((arg, index, args) => {
      if (args[index - 1] === "-Command") {
        return "<Windows toast script>";
      }
      return /[\s"]/.test(arg) ? JSON.stringify(arg) : arg;
    })
    .join(" ");
}

export function formatNotifyTestReport(result: NotifyTestResult): string[] {
  const lines = [
    "pi-native-notify test",
    `environment: ${result.environment}`,
    `platform: ${result.platform}`,
  ];

  if (result.wslDistro) {
    lines.push(`wslDistro: ${result.wslDistro}`);
  }

  lines.push(
    `backend: ${result.backend ? BACKEND_LABEL[result.backend] : "none"}`,
  );

  if (result.invocation) {
    lines.push(`command: ${result.invocation.command}`);
    lines.push(`args: ${formatInvocationArgs(result.invocation)}`);
  }

  if (result.powershellPath) {
    lines.push(`powershellPath: ${result.powershellPath}`);
  }

  if (result.error) {
    lines.push("result: failed");
    lines.push(`error: ${result.error}`);
  } else if (result.sent) {
    lines.push("result: sent");
  } else {
    lines.push("result: skipped");
  }

  return lines;
}
