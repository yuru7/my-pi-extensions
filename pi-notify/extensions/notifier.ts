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

export function formatCompletionMessage(elapsedSeconds: number): string {
  return `タスクが完了しました（${elapsedSeconds.toFixed(1)}秒）`;
}

export function shouldNotify(
  elapsedSeconds: number,
  thresholdSeconds: number,
): boolean {
  return elapsedSeconds >= thresholdSeconds;
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
          "notify-send が見つかりません。Linux では libnotify-bin をインストールしてください（例: sudo apt install libnotify-bin）。",
        );
        return;
      }
      if (invocation.command.includes("powershell")) {
        warnOnce(
          "powershell",
          `PowerShell を実行できません (${invocation.command})。PATH を確認するか、~/.config/pi/notify-config.json の powershellPath を設定してください。`,
        );
        return;
      }
      if (invocation.command === "osascript") {
        warnOnce("osascript", "osascript を実行できませんでした。");
        return;
      }
    }
    warnOnce(
      `spawn:${invocation.command}`,
      `通知コマンドの起動に失敗しました: ${invocation.command}`,
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
