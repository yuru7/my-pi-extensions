import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { extractBashTargets } from "./bash/extract-paths.ts";
import { canonicalizePathKey } from "./bash/windows-path.ts";
import type { UndoConfig } from "./config.ts";
import { maxBytesPerCall, maxFileSizeBytes } from "./config.ts";
import {
  bytesToMb,
  formatBashLimitWarning,
  formatLargeFileWarning,
  formatPostSnapshotWarning,
  formatSnapshotError,
  formatStoreLimitWarning,
  NotificationDeduper,
  type NotifyFn,
} from "./errors.ts";
import {
  isExcluded,
  isInsideDir,
  isSpecialFile,
  isVirtualFsPath,
  type PathContext,
  type SnapshotBackend,
} from "./platform.ts";
import type { Coverage, PendingSnapshot, SessionJournal, ToolName } from "./mutation-journal.ts";
import { atomicWriteFile, ObjectStore, sha256 } from "./store.ts";

export type FileState =
  | { kind: "absent" }
  | { kind: "file"; sha256: string; size: number; mode?: number }
  | { kind: "symlink"; target: string };

export function fileStateEquals(left: FileState, right: FileState): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "absent") {
    return true;
  }
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target;
  }
  if (left.kind === "file" && right.kind === "file") {
    return left.sha256 === right.sha256 && left.size === right.size && (left.mode ?? 0) === (right.mode ?? 0);
  }
  return false;
}

export type CaptureStatus =
  | { status: "ok"; state: FileState; hash?: string }
  | { status: "skip"; reason: "large" | "special" | "limit" | "error"; error?: unknown; size?: number };

class PathLock {
  private readonly locks = new Map<string, Promise<void>>();

  async run(key: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => next);
    this.locks.set(key, tail);
    await previous;
    try {
      await fn();
    } finally {
      release();
      if (this.locks.get(key) === tail) {
        this.locks.delete(key);
      }
    }
  }
}

function posixMode(mode: number): number {
  return mode & 0o777;
}

export function captureFileState(
  filePath: string,
  options: {
    store?: ObjectStore;
    persist?: boolean;
    maxFileBytes: number;
  },
): CaptureStatus {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return { status: "ok", state: { kind: "absent" } };
    }
    return { status: "skip", reason: "error", error };
  }

  if (stat.isSymbolicLink()) {
    try {
      return { status: "ok", state: { kind: "symlink", target: readlinkSync(filePath) } };
    } catch (error) {
      return { status: "skip", reason: "error", error };
    }
  }

  if (!stat.isFile()) {
    return { status: "skip", reason: "special" };
  }

  if (stat.size > options.maxFileBytes) {
    if (options.persist) {
      return { status: "skip", reason: "large", size: stat.size };
    }
    return {
      status: "ok",
      state: {
        kind: "file",
        sha256: `too-large:${stat.size}:${Math.trunc(stat.mtimeMs)}`,
        size: stat.size,
        mode: posixMode(stat.mode),
      },
    };
  }

  try {
    const data = readFileSync(filePath);
    const hash = sha256(data);
    if (options.persist && options.store) {
      const put = options.store.put(data);
      if (put.status === "skipped-limit") {
        return { status: "skip", reason: "limit", size: stat.size };
      }
    }
    return {
      status: "ok",
      state: {
        kind: "file",
        sha256: hash,
        size: stat.size,
        mode: posixMode(stat.mode),
      },
      hash,
    };
  } catch (error) {
    return { status: "skip", reason: "error", error };
  }
}

export function restoreFileState(filePath: string, state: FileState, store: ObjectStore): void {
  if (state.kind === "absent") {
    try {
      unlinkSync(filePath);
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    }
    return;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  try {
    unlinkSync(filePath);
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  if (state.kind === "symlink") {
    symlinkSync(state.target, filePath);
    return;
  }

  const data = store.get(state.sha256);
  if (!data) {
    throw new Error(`Missing CAS object ${state.sha256} for ${filePath}`);
  }
  atomicWriteFile(filePath, data);
  if (state.mode !== undefined) {
    try {
      chmodSync(filePath, state.mode);
    } catch {
      // Windows may ignore POSIX modes.
    }
  }
}

export interface WalkLimits {
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
}

export interface WalkResult {
  paths: string[];
  bytes: number;
  limitReached: boolean;
}

export function walkCandidates(
  root: string,
  ctx: PathContext,
  limits: WalkLimits,
): WalkResult {
  const paths: string[] = [];
  let files = 0;
  let bytes = 0;
  let limitReached = false;

  const visit = (current: string): void => {
    if (limitReached) {
      return;
    }
    if (isVirtualFsPath(current) || isInsideDir(ctx.storeRoot, current) || isExcluded(current, ctx.excludeGlobs)) {
      return;
    }
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      paths.push(current);
      return;
    }
    if (stat.isDirectory()) {
      let entries;
      try {
        entries = readdirSorted(current);
      } catch {
        return;
      }
      for (const entry of entries) {
        visit(join(current, entry));
        if (limitReached) {
          return;
        }
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      paths.push(current);
      return;
    }
    if (!stat.isFile() || isSpecialFile(current)) {
      return;
    }
    if (stat.size > limits.maxFileBytes) {
      return;
    }
    if (files + 1 > limits.maxFiles || bytes + stat.size > limits.maxBytes) {
      limitReached = true;
      return;
    }
    files += 1;
    bytes += stat.size;
    paths.push(current);
  };

  visit(root);
  return { paths, bytes, limitReached };
}

function readdirSorted(dir: string): string[] {
  return readdirSync(dir).sort();
}

export interface SnapshotterOptions {
  store: ObjectStore;
  journal: SessionJournal;
  config: UndoConfig;
  pathContext: PathContext;
  backend: SnapshotBackend;
  notify: NotifyFn;
  now?: () => number;
}

export class Snapshotter {
  private readonly locks = new PathLock();
  private readonly deduper: NotificationDeduper;
  private storeLimitWarned = false;
  private readonly now: () => number;
  private readonly options: SnapshotterOptions;

  constructor(options: SnapshotterOptions) {
    this.options = options;
    this.deduper = new NotificationDeduper(options.notify);
    this.now = options.now ?? Date.now;
  }

  async beginWriteEdit(input: {
    toolName: "write" | "edit";
    toolCallId: string;
    path: string;
    sessionId: string;
    turnEntryId: string;
  }): Promise<void> {
    try {
      if (!this.options.config.enabled) {
        return;
      }
      const resolved = this.resolveForWriteEdit(input.path);
      if (!resolved) {
        return;
      }
      await this.locks.run(resolved.key, async () => {
        await this.snapshotPaths({
          toolName: input.toolName,
          toolCallId: input.toolCallId,
          sessionId: input.sessionId,
          turnEntryId: input.turnEntryId,
          coverage: "exact",
          files: [resolved],
        });
      });
    } catch (error) {
      this.deduper.notify(input.sessionId, input.turnEntryId, "snapshot", {
        text: formatSnapshotError(input.path, error),
        level: "warning",
      });
    }
  }

  async beginBash(input: {
    toolCallId: string;
    command: string;
    sessionId: string;
    turnEntryId: string;
  }): Promise<void> {
    try {
      await this.beginBashUnchecked(input);
    } catch (error) {
      this.deduper.notify(input.sessionId, input.turnEntryId, "snapshot", {
        text: formatSnapshotError("<bash>", error),
        level: "warning",
      });
    }
  }

  private async beginBashUnchecked(input: {
    toolCallId: string;
    command: string;
    sessionId: string;
    turnEntryId: string;
  }): Promise<void> {
    if (!this.options.config.enabled || !this.options.config.bash.enabled) {
      return;
    }
    const extracted = extractBashTargets(input.command);
    if (!extracted.mutating && extracted.paths.length === 0 && !extracted.interpreter) {
      return;
    }
    if (extracted.unresolved && this.options.config.bash.warnOnUnresolvedMutation) {
      this.deduper.notify(input.sessionId, input.turnEntryId, "bash", {
        text: "pi-undo: bash undo coverage: partial",
        level: "warning",
      });
    }

    const candidates: Array<{ path: string; key: string }> = [];
    const walkRoots: string[] = [];
    let usedBytes = 0;
    let limitReached = false;
    let coverage: Coverage = extracted.coverage;
    const limits: WalkLimits = {
      maxFiles: this.options.config.bash.maxFilesPerCall,
      maxBytes: maxBytesPerCall(this.options.config),
      maxFileBytes: maxFileSizeBytes(this.options.config),
    };

    for (const raw of extracted.paths) {
      const resolved = this.options.backend.resolve(raw, this.options.pathContext);
      if (!resolved.ok) {
        coverage = "partial";
        continue;
      }
      let isDirectory = false;
      try {
        isDirectory = lstatSync(resolved.path).isDirectory();
      } catch {
        // path may be created by the command
      }
      const walked = walkCandidates(resolved.path, this.options.pathContext, {
        ...limits,
        maxFiles: limits.maxFiles - candidates.length,
        maxBytes: limits.maxBytes - usedBytes,
      });
      if (isDirectory && walked.limitReached) {
        limitReached = true;
        coverage = "partial";
        continue;
      }
      if (walked.limitReached) {
        limitReached = true;
        coverage = "partial";
      }
      if (isDirectory) {
        walkRoots.push(resolved.path);
      }
      usedBytes += walked.bytes;
      for (const filePath of walked.paths) {
        candidates.push({
          path: filePath,
          key: canonicalizePathKey(filePath, this.options.pathContext.platform),
        });
      }
    }

    if (limitReached) {
      this.deduper.notify(input.sessionId, input.turnEntryId, "limit", {
        text: formatBashLimitWarning(),
        level: "warning",
      });
    }

    const unique = uniqueByKey(candidates);
    await this.snapshotPaths({
      toolName: "bash",
      toolCallId: input.toolCallId,
      sessionId: input.sessionId,
      turnEntryId: input.turnEntryId,
      coverage,
      files: unique,
      walkRoots,
      limitReached,
    });
  }

  async finish(toolCallId: string): Promise<void> {
    try {
      const pending = this.options.journal.readPending(toolCallId);
      if (!pending) {
        return;
      }
      for (const file of pending.files) {
        await this.locks.run(file.key, async () => {
          this.commitFile(pending, file);
        });
      }
      this.commitNewFiles(pending);
      this.options.journal.deletePending(toolCallId);
    } catch {
      this.options.notify({
        text: formatPostSnapshotWarning(),
        level: "warning",
      });
    }
  }

  recoverPending(): number {
    const pendingList = this.options.journal.listPending();
    let files = 0;
    for (const pending of pendingList) {
      files += pending.files.length;
      for (const file of pending.files) {
        this.commitFile(pending, file);
      }
      this.commitNewFiles(pending);
      this.options.journal.deletePending(pending.toolCallId);
    }
    return files;
  }

  private commitFile(pending: PendingSnapshot, file: { path: string; key: string; pre: FileState }): void {
    const captured = captureFileState(file.path, {
      maxFileBytes: maxFileSizeBytes(this.options.config),
      persist: false,
    });
    const post: FileState = captured.status === "ok" ? captured.state : file.pre;
    if (fileStateEquals(file.pre, post)) {
      this.maybeDeleteTemporary(file.pre, pending.temporaryHashes);
      return;
    }
    this.options.journal.appendMutation({
      sessionId: pending.sessionId,
      turnEntryId: pending.turnEntryId,
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      path: file.path,
      key: file.key,
      pre: file.pre,
      post,
      coverage: pending.coverage,
      timestamp: new Date(this.now()).toISOString(),
    });
  }

  private maybeDeleteTemporary(pre: FileState, temporaryHashes: string[]): void {
    if (pre.kind !== "file" || !temporaryHashes.includes(pre.sha256)) {
      return;
    }
    const stillReferenced = this.options.journal.mutations().some(
      (mutation) =>
        (mutation.pre.kind === "file" && mutation.pre.sha256 === pre.sha256) ||
        (mutation.post.kind === "file" && mutation.post.sha256 === pre.sha256),
    );
    const pendingRefs = this.options.journal.listPending().some((pending) =>
      pending.files.some((file) => file.pre.kind === "file" && file.pre.sha256 === pre.sha256),
    );
    if (!stillReferenced && !pendingRefs) {
      this.options.store.deleteObject(pre.sha256);
    }
  }

  private commitNewFiles(pending: PendingSnapshot): void {
    if (!pending.walkRoots || pending.walkRoots.length === 0) {
      return;
    }
    const known = new Set(pending.files.map((file) => file.key));
    const limits: WalkLimits = {
      maxFiles: this.options.config.bash.maxFilesPerCall,
      maxBytes: maxBytesPerCall(this.options.config),
      maxFileBytes: maxFileSizeBytes(this.options.config),
    };
    for (const root of pending.walkRoots) {
      const walked = walkCandidates(root, this.options.pathContext, limits);
      for (const filePath of walked.paths) {
        const key = canonicalizePathKey(filePath, this.options.pathContext.platform);
        if (known.has(key)) {
          continue;
        }
        known.add(key);
        this.commitFile(pending, { path: filePath, key, pre: { kind: "absent" } });
      }
    }
  }

  private async snapshotPaths(input: {
    toolName: ToolName;
    toolCallId: string;
    sessionId: string;
    turnEntryId: string;
    coverage: Coverage;
    files: Array<{ path: string; key: string }>;
    walkRoots?: string[];
    limitReached?: boolean;
  }): Promise<void> {
    const pendingFiles: PendingSnapshot["files"] = [];
    const temporaryHashes: string[] = [];

    for (const file of input.files) {
      const existing = this.options.journal.preForTurn(input.turnEntryId, file.key);
      if (existing) {
        pendingFiles.push({ path: file.path, key: file.key, pre: existing });
        continue;
      }
      if (this.options.store.approachingLimit()) {
        this.warnStoreLimit(input.sessionId, input.turnEntryId);
        continue;
      }
      const captured = captureFileState(file.path, {
        store: this.options.store,
        persist: true,
        maxFileBytes: maxFileSizeBytes(this.options.config),
      });
      if (captured.status === "skip") {
        this.notifyCaptureSkip(input.sessionId, input.turnEntryId, file.path, captured);
        continue;
      }
      pendingFiles.push({ path: file.path, key: file.key, pre: captured.state });
      if (captured.hash) {
        temporaryHashes.push(captured.hash);
      }
    }

    if (pendingFiles.length === 0 && (!input.walkRoots || input.walkRoots.length === 0)) {
      return;
    }

    this.options.journal.writePending({
      toolCallId: input.toolCallId,
      sessionId: input.sessionId,
      turnEntryId: input.turnEntryId,
      toolName: input.toolName,
      timestamp: new Date(this.now()).toISOString(),
      coverage: input.coverage,
      files: pendingFiles,
      temporaryHashes,
      walkRoots: input.walkRoots,
      limitReached: input.limitReached,
    });
  }

  private resolveForWriteEdit(raw: string): { path: string; key: string } | undefined {
    const resolved = this.options.backend.resolve(raw, this.options.pathContext);
    if (!resolved.ok) {
      return undefined;
    }
    try {
      const real = realpathSync(resolved.path);
      return {
        path: real,
        key: canonicalizePathKey(real, this.options.pathContext.platform),
      };
    } catch {
      return resolved;
    }
  }

  private notifyCaptureSkip(
    sessionId: string,
    turnEntryId: string,
    filePath: string,
    captured: Extract<CaptureStatus, { status: "skip" }>,
  ): void {
    if (captured.reason === "large") {
      this.deduper.notify(sessionId, turnEntryId, "limit", {
        text: formatLargeFileWarning(
          filePath,
          bytesToMb(captured.size ?? 0),
          this.options.config.maxFileSizeMB,
        ),
        level: "warning",
      });
      return;
    }
    if (captured.reason === "limit") {
      this.warnStoreLimit(sessionId, turnEntryId);
      return;
    }
    if (captured.reason === "error") {
      this.deduper.notify(sessionId, turnEntryId, "snapshot", {
        text: formatSnapshotError(filePath, captured.error),
        level: "warning",
      });
    }
  }

  private warnStoreLimit(sessionId: string, turnEntryId: string): void {
    if (this.storeLimitWarned) {
      return;
    }
    this.storeLimitWarned = true;
    this.deduper.notify(sessionId, turnEntryId, "store", {
      text: formatStoreLimitWarning(),
      level: "warning",
    });
  }
}

function uniqueByKey(files: Array<{ path: string; key: string }>): Array<{ path: string; key: string }> {
  const seen = new Set<string>();
  const unique: Array<{ path: string; key: string }> = [];
  for (const file of files) {
    if (seen.has(file.key)) {
      continue;
    }
    seen.add(file.key);
    unique.push(file);
  }
  return unique;
}
