import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  canonicalizePathKey,
  convertMsysPath,
  convertWslPath,
  isDeviceNamespacePath,
  isUncPath,
  isWindowsDrivePath,
  looksLikeWindowsPath,
  normalizeWindowsSeparators,
  windowsPathToPosix,
} from "./bash/windows-path.ts";

export interface SnapshotBackend {
  readonly kind: "local";
  resolve(raw: string, ctx: PathContext): ResolvedPath;
}

export interface PathContext {
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  isWsl: boolean;
  storeRoot: string;
  excludeGlobs: string[];
}

export type ResolvedPath =
  | { ok: true; path: string; key: string }
  | {
      ok: false;
      reason: "virtual" | "device" | "unresolvable" | "excluded" | "store";
      path?: string;
    };

const POSIX_VIRTUAL_PREFIXES = ["/proc", "/sys", "/dev", "/run"];

export function isWsl(env: NodeJS.Dict<string | undefined> = process.env, platform = process.platform): boolean {
  if (platform !== "linux") {
    return false;
  }
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return true;
  }
  for (const file of ["/proc/sys/kernel/osrelease", "/proc/version"]) {
    try {
      const text = readFileSync(file, "utf8").toLowerCase();
      if (text.includes("microsoft") || text.includes("wsl")) {
        return true;
      }
    } catch {
      // try the next probe
    }
  }
  return false;
}

export function expandHome(raw: string, home: string): string {
  if (raw === "~") {
    return home;
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return home + raw.slice(1);
  }
  return raw;
}

export function stripAtPrefix(raw: string): string {
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let i = 0;
  let out = "^";
  while (i < normalized.length) {
    if (normalized.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (normalized.startsWith("**", i)) {
      out += ".*";
      i += 2;
      continue;
    }
    const ch = normalized[i];
    if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(ch);
    }
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

export function matchGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const regex = globToRegExp(pattern);
  if (regex.test(normalizedPath)) {
    return true;
  }
  if (normalizedPath.startsWith("/")) {
    return regex.test(normalizedPath.slice(1));
  }
  return false;
}

export function isExcluded(filePath: string, globs: string[]): boolean {
  return globs.some(
    (glob) => matchGlob(filePath, glob) || matchGlob(`${filePath.replaceAll("\\", "/")}/`, glob),
  );
}

export function isInsideDir(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function isVirtualFsPath(filePath: string): boolean {
  const posix = filePath.replaceAll("\\", "/");
  return POSIX_VIRTUAL_PREFIXES.some(
    (prefix) => posix === prefix || posix.startsWith(`${prefix}/`),
  );
}

export function isSpecialFile(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath);
    return (
      !stat.isFile() &&
      !stat.isDirectory() &&
      !stat.isSymbolicLink()
    );
  } catch {
    return false;
  }
}

function nativeResolve(raw: string, cwd: string, platform: NodeJS.Platform): string {
  const impl = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    return impl.resolve(cwd, raw);
  }
  if (path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)) {
    return raw;
  }
  return impl.resolve(cwd, raw);
}

export function translateInputPath(raw: string, ctx: PathContext): string | { unresolvable: true } {
  const trimmed = stripAtPrefix(raw.trim());
  if (trimmed === "") {
    return { unresolvable: true };
  }

  if (isDeviceNamespacePath(trimmed)) {
    return { unresolvable: true };
  }

  if (ctx.platform === "win32") {
    const msys = convertMsysPath(trimmed);
    if (msys) {
      return msys;
    }
    const wsl = convertWslPath(trimmed);
    if (wsl) {
      return wsl;
    }
    if (trimmed.startsWith("/") && !isUncPath(trimmed) && !convertMsysPath(trimmed)) {
      // WSL-native paths like /home/user are not reachable from Windows Node.
      return { unresolvable: true };
    }
    if (isWindowsDrivePath(trimmed) || isUncPath(trimmed)) {
      return normalizeWindowsSeparators(trimmed);
    }
    return trimmed;
  }

  if (ctx.isWsl && looksLikeWindowsPath(trimmed)) {
    if (isUncPath(trimmed)) {
      return { unresolvable: true };
    }
    const msys = convertMsysPath(trimmed);
    if (msys) {
      return windowsPathToPosix(msys);
    }
    const wsl = convertWslPath(trimmed);
    if (wsl) {
      return windowsPathToPosix(wsl);
    }
    if (isWindowsDrivePath(trimmed)) {
      return windowsPathToPosix(trimmed);
    }
  }

  if (!ctx.isWsl && looksLikeWindowsPath(trimmed)) {
    return { unresolvable: true };
  }

  return trimmed;
}

export function resolveCanonicalPath(raw: string, ctx: PathContext): ResolvedPath {
  const translated = translateInputPath(expandHome(raw, ctx.home), ctx);
  if (typeof translated !== "string") {
    return { ok: false, reason: "unresolvable", path: raw };
  }

  if (isDeviceNamespacePath(translated)) {
    return { ok: false, reason: "device", path: translated };
  }

  const absolute = nativeResolve(translated, ctx.cwd, ctx.platform);
  if (isVirtualFsPath(absolute)) {
    return { ok: false, reason: "virtual", path: absolute };
  }
  if (isInsideDir(ctx.storeRoot, absolute)) {
    return { ok: false, reason: "store", path: absolute };
  }
  if (isExcluded(absolute, ctx.excludeGlobs)) {
    return { ok: false, reason: "excluded", path: absolute };
  }

  return {
    ok: true,
    path: absolute,
    key: canonicalizePathKey(absolute, ctx.platform),
  };
}

export function createLocalSnapshotBackend(): SnapshotBackend {
  return {
    kind: "local",
    resolve(raw, ctx) {
      return resolveCanonicalPath(raw, ctx);
    },
  };
}

export function defaultPathContext(overrides: Partial<PathContext> & { storeRoot: string }): PathContext {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    home: overrides.home ?? homedir(),
    platform: overrides.platform ?? process.platform,
    isWsl: overrides.isWsl ?? isWsl(),
    storeRoot: overrides.storeRoot,
    excludeGlobs: overrides.excludeGlobs ?? [],
  };
}
