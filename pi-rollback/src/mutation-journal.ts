import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { RollbackConfig } from "./config.ts";
import type { FileState } from "./snapshot.ts";
import { appendJsonl, atomicWriteFile, ObjectStore, readJsonl } from "./store.ts";

export type ToolName = "write" | "edit" | "bash";
export type Coverage = "exact" | "best-effort" | "partial";

export interface MutationRecord {
  sequence: number;
  sessionId: string;
  turnEntryId: string;
  toolCallId: string;
  toolName: ToolName;
  path: string;
  key: string;
  pre: FileState;
  post: FileState;
  coverage: Coverage;
  timestamp: string;
}

export interface PendingFile {
  path: string;
  key: string;
  pre: FileState;
}

export interface PendingSnapshot {
  toolCallId: string;
  sessionId: string;
  turnEntryId: string;
  toolName: ToolName;
  timestamp: string;
  coverage: Coverage;
  files: PendingFile[];
  temporaryHashes: string[];
  walkRoots?: string[];
  limitReached?: boolean;
}

export interface LeafSnapshotEntry {
  path: string;
  key: string;
  state: FileState;
}

export interface SessionMeta {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  lastSequence: number;
  bashCommands: number;
  bashPartial: number;
}

export class SessionJournal {
  readonly dir: string;
  readonly sessionId: string;
  private readonly store: ObjectStore;
  private cachedMutations: MutationRecord[] | undefined;
  private meta: SessionMeta;

  constructor(store: ObjectStore, sessionId: string, now: () => number = Date.now) {
    this.store = store;
    this.sessionId = sessionId;
    this.dir = store.sessionDir(sessionId);
    mkdirSync(join(this.dir, "pending"), { recursive: true });
    this.meta = this.readMeta(now);
  }

  mutations(): MutationRecord[] {
    if (!this.cachedMutations) {
      this.cachedMutations = readJsonl<MutationRecord>(this.mutationsPath());
    }
    return this.cachedMutations;
  }

  getMeta(): SessionMeta {
    return this.meta;
  }

  preForTurn(turnEntryId: string, key: string): FileState | undefined {
    for (const pending of this.listPending()) {
      if (pending.turnEntryId !== turnEntryId) {
        continue;
      }
      const file = pending.files.find((item) => item.key === key);
      if (file) {
        return file.pre;
      }
    }
    for (const mutation of this.mutations()) {
      if (mutation.turnEntryId === turnEntryId && mutation.key === key) {
        return mutation.pre;
      }
    }
    return undefined;
  }

  appendMutation(record: Omit<MutationRecord, "sequence">): MutationRecord {
    const full: MutationRecord = {
      ...record,
      sequence: this.meta.lastSequence + 1,
    };
    appendJsonl(this.mutationsPath(), full);
    this.mutations().push(full);
    this.meta.lastSequence = full.sequence;
    if (full.toolName === "bash") {
      this.meta.bashCommands += 1;
      if (full.coverage === "partial") {
        this.meta.bashPartial += 1;
      }
    }
    this.meta.updatedAt = full.timestamp;
    this.writeMeta();
    return full;
  }

  writePending(pending: PendingSnapshot): void {
    atomicWriteFile(this.pendingPath(pending.toolCallId), `${JSON.stringify(pending, null, 2)}\n`);
  }

  readPending(toolCallId: string): PendingSnapshot | undefined {
    try {
      return JSON.parse(readFileSync(this.pendingPath(toolCallId), "utf8")) as PendingSnapshot;
    } catch {
      return undefined;
    }
  }

  deletePending(toolCallId: string): void {
    try {
      unlinkSync(this.pendingPath(toolCallId));
    } catch {
      // already gone
    }
  }

  listPending(): PendingSnapshot[] {
    const dir = join(this.dir, "pending");
    if (!existsSync(dir)) {
      return [];
    }
    const pending: PendingSnapshot[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      try {
        pending.push(JSON.parse(readFileSync(join(dir, entry), "utf8")) as PendingSnapshot);
      } catch {
        // skip corrupt pending files
      }
    }
    return pending;
  }

  saveLeafSnapshot(leafId: string, entries: LeafSnapshotEntry[]): void {
    mkdirSync(join(this.dir, "leaves"), { recursive: true });
    const serialized = entries.map((entry) => JSON.stringify(entry)).join("\n");
    atomicWriteFile(this.leafPath(leafId), serialized === "" ? "" : `${serialized}\n`);
  }

  loadLeafSnapshot(leafId: string): LeafSnapshotEntry[] | undefined {
    const file = this.leafPath(leafId);
    if (!existsSync(file)) {
      return undefined;
    }
    return readJsonl<LeafSnapshotEntry>(file);
  }

  private leafPath(leafId: string): string {
    const safe = leafId.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(this.dir, "leaves", `${safe}.jsonl`);
  }

  private mutationsPath(): string {
    return join(this.dir, "mutations.jsonl");
  }

  private pendingPath(toolCallId: string): string {
    return join(this.dir, "pending", `${toolCallId}.json`);
  }

  private metaPath(): string {
    return join(this.dir, "meta.json");
  }

  private readMeta(now: () => number): SessionMeta {
    try {
      return JSON.parse(readFileSync(this.metaPath(), "utf8")) as SessionMeta;
    } catch {
      const timestamp = new Date(now()).toISOString();
      const meta: SessionMeta = {
        sessionId: this.sessionId,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSequence: 0,
        bashCommands: 0,
        bashPartial: 0,
      };
      this.meta = meta;
      this.writeMeta();
      return meta;
    }
  }

  private writeMeta(): void {
    atomicWriteFile(this.metaPath(), `${JSON.stringify(this.meta, null, 2)}\n`);
  }
}

export function readSessionMeta(store: ObjectStore, sessionId: string): SessionMeta | undefined {
  try {
    return JSON.parse(readFileSync(join(store.sessionDir(sessionId), "meta.json"), "utf8")) as SessionMeta;
  } catch {
    return undefined;
  }
}

export function runMaintenance(
  store: ObjectStore,
  config: RollbackConfig,
  options: {
    activeSessionId?: string;
    now?: number;
    reason: "startup" | "cap" | "shutdown";
  },
): { ranGc: boolean; deletedSessions: number; deletedObjects: number } {
  if (options.reason === "shutdown") {
    store.cleanupTempFiles();
    return { ranGc: false, deletedSessions: 0, deletedObjects: 0 };
  }

  const now = options.now ?? Date.now();
  const maintenance = store.readMaintenance();
  const lastGcAt = maintenance.lastGcAt ? Date.parse(maintenance.lastGcAt) : 0;
  const dueByTime = !lastGcAt || now - lastGcAt >= 24 * 60 * 60 * 1000;
  if (options.reason === "startup" && !dueByTime && !store.approachingLimit()) {
    return { ranGc: false, deletedSessions: 0, deletedObjects: 0 };
  }

  let deletedSessions = 0;
  const retentionMs = config.retentionDays * 24 * 60 * 60 * 1000;
  const inactive = store
    .listSessionIds()
    .filter((id) => id !== options.activeSessionId)
    .map((id) => {
      const meta = readSessionMeta(store, id);
      const updatedAt = meta ? Date.parse(meta.updatedAt) : 0;
      return { id, updatedAt };
    })
    .sort((a, b) => a.updatedAt - b.updatedAt);

  for (const session of inactive) {
    if (retentionMs > 0 && now - session.updatedAt >= retentionMs) {
      store.deleteSession(session.id);
      deletedSessions += 1;
    }
  }

  const remainingInactive = store
    .listSessionIds()
    .filter((id) => id !== options.activeSessionId)
    .map((id) => {
      const meta = readSessionMeta(store, id);
      return { id, updatedAt: meta ? Date.parse(meta.updatedAt) : 0 };
    })
    .sort((a, b) => a.updatedAt - b.updatedAt);

  const target = Math.floor(config.maxTotalSizeMB * 1024 * 1024 * 0.8);
  for (const session of remainingInactive) {
    if (store.sizeBytes() <= target) {
      break;
    }
    store.deleteSession(session.id);
    deletedSessions += 1;
  }

  const deletedObjects = store.sweepUnreferenced(store.referencedHashesFromSessions());
  store.writeMaintenance({
    lastGcAt: new Date(now).toISOString(),
    storeSizeBytes: store.sizeBytes(),
  });

  return { ranGc: true, deletedSessions, deletedObjects };
}

export function removeJournalDir(store: ObjectStore, transactionId: string): void {
  rmSync(store.journalDir(transactionId), { recursive: true, force: true });
}
