import { readFileSync } from "node:fs";

export type NotifyEnvironment =
  | "windows"
  | "wsl"
  | "linux"
  | "macos"
  | "unsupported";

export type NotifyBackend = "windows" | "linux" | "macos";

export interface EnvironmentProbe {
  platform: NodeJS.Platform;
  env: NodeJS.Dict<string | undefined>;
  readFile?: (path: string) => string;
}

const WSL_RELEASE_FILES = [
  "/proc/sys/kernel/osrelease",
  "/proc/version",
] as const;

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

export function isWsl(probe: EnvironmentProbe): boolean {
  if (probe.platform !== "linux") {
    return false;
  }

  if (probe.env.WSL_DISTRO_NAME || probe.env.WSL_INTEROP) {
    return true;
  }

  const readFile = probe.readFile ?? defaultReadFile;
  for (const path of WSL_RELEASE_FILES) {
    try {
      const text = readFile(path).toLowerCase();
      if (text.includes("microsoft") || text.includes("wsl")) {
        return true;
      }
    } catch {
      // ファイルが読めない場合は次の判定へ
    }
  }

  return false;
}

export function detectEnvironment(
  probe: EnvironmentProbe = {
    platform: process.platform,
    env: process.env,
  },
): NotifyEnvironment {
  switch (probe.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return isWsl(probe) ? "wsl" : "linux";
    default:
      return "unsupported";
  }
}

export function selectBackend(
  environment: NotifyEnvironment,
): NotifyBackend | null {
  switch (environment) {
    case "windows":
    case "wsl":
      return "windows";
    case "linux":
      return "linux";
    case "macos":
      return "macos";
    default:
      return null;
  }
}
