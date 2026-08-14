import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { CommandInvocation, Notification } from "../notifier.ts";

export interface PowershellLookup {
  platform: NodeJS.Platform;
  env: NodeJS.Dict<string | undefined>;
  exists?: (path: string) => boolean;
}

const WSL_POWERSHELL_CANDIDATES = [
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe",
] as const;

function pathExists(path: string, exists: (path: string) => boolean): boolean {
  try {
    return exists(path);
  } catch {
    return false;
  }
}

function findOnPath(
  name: string,
  env: NodeJS.Dict<string | undefined>,
  exists: (path: string) => boolean,
): string | undefined {
  const pathEnv = env.PATH ?? env.Path;
  if (!pathEnv) {
    return undefined;
  }

  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, name);
    if (pathExists(candidate, exists)) {
      return candidate;
    }
  }

  return undefined;
}

export function resolvePowershellPath(
  configured: string | undefined,
  lookup: PowershellLookup = {
    platform: process.platform,
    env: process.env,
    exists: existsSync,
  },
): string {
  const exists = lookup.exists ?? existsSync;

  if (configured && configured.trim() !== "") {
    return configured.trim();
  }

  const fromPath = findOnPath("powershell.exe", lookup.env, exists);
  if (fromPath) {
    return fromPath;
  }

  if (lookup.platform === "win32") {
    const root = lookup.env.SystemRoot ?? "C:\\Windows";
    const system32 = join(
      root,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (pathExists(system32, exists)) {
      return system32;
    }
  }

  if (lookup.platform === "linux") {
    for (const candidate of WSL_POWERSHELL_CANDIDATES) {
      if (pathExists(candidate, exists)) {
        return candidate;
      }
    }
  }

  return "powershell.exe";
}

export function encodeNotificationPayload(notification: Notification): string {
  return Buffer.from(
    JSON.stringify({
      title: notification.title,
      message: notification.message,
    }),
    "utf8",
  ).toString("base64");
}

export function buildWindowsToastScript(payloadB64: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payloadB64}')) | ConvertFrom-Json`,
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$template = '<toast><visual><binding template=\"ToastGeneric\"><text id=\"1\"></text><text id=\"2\"></text></binding></visual><audio src=\"ms-winsoundevent:Notification.Default\"/></toast>'",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$xml.LoadXml($template)",
    "$nodes = $xml.GetElementsByTagName('text')",
    "[void]$nodes.Item(0).AppendChild($xml.CreateTextNode([string]$payload.title))",
    "[void]$nodes.Item(1).AppendChild($xml.CreateTextNode([string]$payload.message))",
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)",
  ].join("; ");
}

export function buildWindowsNotifyInvocation(
  notification: Notification,
  powershellPath?: string,
  lookup?: PowershellLookup,
): CommandInvocation {
  const payloadB64 = encodeNotificationPayload(notification);
  return {
    command: resolvePowershellPath(powershellPath, lookup),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      buildWindowsToastScript(payloadB64),
    ],
  };
}
