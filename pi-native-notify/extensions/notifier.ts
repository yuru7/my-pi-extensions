import { spawn } from "node:child_process";
import {
  detectEnvironment,
  selectBackend,
  type EnvironmentProbe,
} from "./environment.ts";
import { buildLinuxNotifyInvocation } from "./notifiers/linux.ts";
import { buildMacOSNotifyInvocation } from "./notifiers/macos.ts";
import { buildWindowsNotifyInvocation } from "./notifiers/windows.ts";

export interface Notification {
  title: string;
  message: string;
}

export interface CommandInvocation {
  command: string;
  args: string[];
}

export interface NotifyOptions {
  powershellPath?: string;
  probe?: EnvironmentProbe;
  spawn?: (invocation: CommandInvocation) => void;
}

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  console.error(`[pi-native-notify] ${message}`);
}

export const NOTIFICATION_TITLE = "Done - Pi";
export const NOTIFICATION_MESSAGE_MAX_LENGTH = 50;
const MESSAGE_ELLIPSIS = "…";
const FALLBACK_MESSAGE = "Task completed";

export function formatNotificationMessage(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized === "") {
    return FALLBACK_MESSAGE;
  }

  const chars = [...normalized];
  if (chars.length <= NOTIFICATION_MESSAGE_MAX_LENGTH) {
    return normalized;
  }

  const keep = NOTIFICATION_MESSAGE_MAX_LENGTH - MESSAGE_ELLIPSIS.length;
  return `${chars.slice(0, keep).join("")}${MESSAGE_ELLIPSIS}`;
}

export function shouldNotify(
  elapsedSeconds: number,
  thresholdSeconds: number,
  unfocused = false,
): boolean {
  return unfocused || elapsedSeconds >= thresholdSeconds;
}

export function spawnDetached(invocation: CommandInvocation): void {
  const child = spawn(invocation.command, invocation.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      if (invocation.command === "notify-send") {
        warnOnce(
          "notify-send",
          "notify-send was not found. On Linux, install libnotify-bin (for example: sudo apt install libnotify-bin).",
        );
        return;
      }
      if (invocation.command.includes("powershell")) {
        warnOnce(
          "powershell",
          `Could not run PowerShell (${invocation.command}). Check PATH or set powershellPath in ~/.pi/agent/notify-settings.json.`,
        );
        return;
      }
      if (invocation.command === "osascript") {
        warnOnce("osascript", "Could not run osascript.");
        return;
      }
    }
    warnOnce(
      `spawn:${invocation.command}`,
      `Failed to start the notification command: ${invocation.command}`,
    );
  });
  child.unref();
}

export function buildNotifyInvocation(
  notification: Notification,
  options: NotifyOptions = {},
): CommandInvocation | null {
  const environment = detectEnvironment(options.probe);
  const backend = selectBackend(environment);
  if (backend === null) {
    return null;
  }

  switch (backend) {
    case "windows":
      return buildWindowsNotifyInvocation(
        notification,
        options.powershellPath,
        options.probe
          ? {
              platform: options.probe.platform,
              env: options.probe.env,
            }
          : undefined,
      );
    case "linux":
      return buildLinuxNotifyInvocation(notification);
    case "macos":
      return buildMacOSNotifyInvocation(notification);
  }
}

export async function notify(
  notification: Notification,
  options: NotifyOptions = {},
): Promise<void> {
  try {
    const invocation = buildNotifyInvocation(notification, options);
    if (invocation === null) {
      return;
    }

    const run = options.spawn ?? spawnDetached;
    run(invocation);
  } catch {
    // 通知失敗で Agent 処理を失敗させない
  }
}
