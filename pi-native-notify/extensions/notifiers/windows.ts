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

export const WINDOWS_TOAST_APP_ID = "Pi.NativeNotify";
export const WINDOWS_TOAST_APP_NAME = "Pi";
export const WINDOWS_POWERSHELL_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const WINDOWS_TOAST_ICON_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEABAMAAACuXLVVAAAAFVBMVEUYGBj///8+Pj7t7e2JiYnm5ubQ0NBeLMtNAAAA5UlEQVR42u3cMQrCMBSA4SC9gKB7UXBX616KF1CoBxC9/xXcfS2UEDvU75/zyJc1hKQkSZIkSZIkSZIkjbbaZVYKcDjn1ZQC7Nd5bQAAAAAAAAAAAAAAAAAAAAAAlgx4XUPHWQFtvMu7AQAAAAAAAAAAAAAAAAAAAAD8F6CL77be/XdNXFSXAlzCbo+4WxUW9c/f3RNu4+GquOoEAAAAAAAAAAAAAAAAAAAAALAYwMBTrjQroJ0yBwAAAAAAAAAAAAAAAAAAAACwHMDAp1jTAHHungp9C5Y7VydJkiRJkiRJkiRptA+GzEh6Ofx0gQAAAABJRU5ErkJggg==";

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
    `$appId = '${WINDOWS_POWERSHELL_APP_ID}'`,
    "$iconSrc = $null",
    `try { $iconFile = Join-Path $env:TEMP 'pi-native-notify.png'; if (-not (Test-Path -LiteralPath $iconFile) -or ((Get-Item -LiteralPath $iconFile).LastWriteTime -lt (Get-Date).AddDays(-1))) { [IO.File]::WriteAllBytes($iconFile, [Convert]::FromBase64String('${WINDOWS_TOAST_ICON_PNG_B64}')) }; $regPath = 'HKCU:\\Software\\Classes\\AppUserModelId\\${WINDOWS_TOAST_APP_ID}'; New-Item -Path $regPath -Force | Out-Null; New-ItemProperty -Path $regPath -Name DisplayName -Value '${WINDOWS_TOAST_APP_NAME}' -PropertyType String -Force | Out-Null; New-ItemProperty -Path $regPath -Name IconUri -Value $iconFile -PropertyType ExpandString -Force | Out-Null; $settingsPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${WINDOWS_TOAST_APP_ID}'; New-Item -Path $settingsPath -Force | Out-Null; New-ItemProperty -Path $settingsPath -Name Enabled -Value 1 -PropertyType DWord -Force | Out-Null; $iconSrc = ([Uri]$iconFile).AbsoluteUri; $appId = '${WINDOWS_TOAST_APP_ID}' } catch { }`,
    "$template = '<toast><visual><binding template=\"ToastGeneric\"><text id=\"1\"></text><text id=\"2\"></text></binding></visual><audio src=\"ms-winsoundevent:Notification.Default\"/></toast>'",
    "if ($iconSrc) { $template = $template.Replace('</binding>', ('<image placement=\"appLogoOverride\" src=\"' + $iconSrc + '\"/></binding>')) }",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$xml.LoadXml($template)",
    "$nodes = $xml.GetElementsByTagName('text')",
    "[void]$nodes.Item(0).AppendChild($xml.CreateTextNode([string]$payload.title))",
    "[void]$nodes.Item(1).AppendChild($xml.CreateTextNode([string]$payload.message))",
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
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
