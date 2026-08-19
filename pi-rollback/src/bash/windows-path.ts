const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const DRIVE_ROOT = /^[A-Za-z]:$/;
const MSYS_DRIVE = /^\/([A-Za-z])(?:\/(.*))?$/;
const WSL_DRIVE = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/;
const UNC = /^\\\\[^\\]+\\[^\\]/;
const DEVICE_NAMESPACE = /^\\\\[.?]\\/;

export function isWindowsDrivePath(value: string): boolean {
  return DRIVE_PATH.test(value) || DRIVE_ROOT.test(value);
}

export function isUncPath(value: string): boolean {
  return UNC.test(value) || value.startsWith("//");
}

export function isDeviceNamespacePath(value: string): boolean {
  return DEVICE_NAMESPACE.test(value);
}

export function convertMsysPath(value: string): string | undefined {
  const match = MSYS_DRIVE.exec(value);
  if (!match || value.startsWith("/mnt/")) {
    return undefined;
  }
  const drive = match[1].toUpperCase();
  const rest = (match[2] ?? "").replaceAll("/", "\\");
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

export function convertWslPath(value: string): string | undefined {
  const match = WSL_DRIVE.exec(value);
  if (!match) {
    return undefined;
  }
  const drive = match[1].toUpperCase();
  const rest = (match[2] ?? "").replaceAll("/", "\\");
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

export function windowsPathToPosix(value: string): string {
  if (isUncPath(value)) {
    return value.replaceAll("\\", "/");
  }
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(value);
  if (!drive) {
    return value.replaceAll("\\", "/");
  }
  const rest = drive[2].replaceAll("\\", "/");
  return rest ? `/mnt/${drive[1].toLowerCase()}/${rest}` : `/mnt/${drive[1].toLowerCase()}`;
}

export function normalizeWindowsSeparators(value: string): string {
  if (isUncPath(value)) {
    return value.replaceAll("/", "\\");
  }
  if (isWindowsDrivePath(value)) {
    const drive = value[0].toUpperCase();
    const rest = value.slice(2).replaceAll("/", "\\");
    return `${drive}:${rest.startsWith("\\") ? rest : `\\${rest}`}`;
  }
  return value.replaceAll("/", "\\");
}

export function canonicalizePathKey(value: string, platform: NodeJS.Platform): string {
  const normalized = platform === "win32" ? normalizeWindowsSeparators(value) : value;
  if (platform === "win32") {
    return normalized.replaceAll("/", "\\").toLowerCase();
  }
  return normalized;
}

export function looksLikeWindowsPath(value: string): boolean {
  return (
    isWindowsDrivePath(value) ||
    isUncPath(value) ||
    convertMsysPath(value) !== undefined ||
    convertWslPath(value) !== undefined
  );
}
