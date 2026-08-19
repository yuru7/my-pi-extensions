import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { UndoConfig } from "./config.ts";
import { maxTotalSizeBytes } from "./config.ts";

const COMPRESS_MIN_BYTES = 4 * 1024;
const DEFLATE_LEVEL = 1;
const DEFLATE_EXT = ".deflate";
const LEGACY_MAGIC = Buffer.from("PUO1");
const LEGACY_HEADER_SIZE = 9;

export interface MaintenanceState {
  lastGcAt?: string;
  storeSizeBytes?: number;
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function atomicWriteFile(filePath: string, data: string | Uint8Array): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, filePath);
  } catch {
    copyFileSync(tmp, filePath);
    unlinkSync(tmp);
  }
}

export function objectPath(root: string, hash: string): string {
  return join(root, "objects", "sha256", hash.slice(0, 2), hash);
}

function objectPaths(root: string, hash: string): { raw: string; deflate: string } {
  const raw = objectPath(root, hash);
  return { raw, deflate: `${raw}${DEFLATE_EXT}` };
}

function objectHashFromName(name: string): string {
  return name.endsWith(DEFLATE_EXT) ? name.slice(0, -DEFLATE_EXT.length) : name;
}

function compressIfWorthIt(data: Uint8Array): { bytes: Uint8Array; deflate: boolean } {
  if (data.byteLength >= COMPRESS_MIN_BYTES) {
    const compressed = deflateSync(data, { level: DEFLATE_LEVEL });
    if (compressed.byteLength < data.byteLength) {
      return { bytes: compressed, deflate: true };
    }
  }
  return { bytes: data, deflate: false };
}

function decodeLegacyHeaderIfPresent(stored: Buffer): Buffer {
  if (stored.byteLength < LEGACY_HEADER_SIZE || stored.subarray(0, 4).compare(LEGACY_MAGIC) !== 0) {
    return stored;
  }
  const codec = stored[4];
  const originalSize = stored.readUInt32BE(5);
  const payload = stored.subarray(LEGACY_HEADER_SIZE);
  if (codec === 0) {
    if (payload.byteLength !== originalSize) {
      return stored;
    }
    return payload;
  }
  if (codec === 1) {
    const inflated = inflateSync(payload);
    if (inflated.byteLength !== originalSize) {
      throw new Error("Corrupt CAS object: inflated size mismatch");
    }
    return inflated;
  }
  return stored;
}

export type PutResult =
  | { status: "stored"; sha256: string; bytes: number }
  | { status: "exists"; sha256: string; bytes: number }
  | { status: "skipped-limit"; sha256: string; bytes: number };

export class ObjectStore {
  readonly root: string;
  private readonly config: UndoConfig;

  constructor(root: string, config: UndoConfig) {
    this.root = root;
    this.config = config;
    this.ensureLayout();
  }

  sessionDir(sessionId: string): string {
    return join(this.root, "sessions", sessionId);
  }

  journalDir(transactionId: string): string {
    return join(this.root, "undo-journals", transactionId);
  }

  has(hash: string): boolean {
    const paths = objectPaths(this.root, hash);
    return existsSync(paths.raw) || existsSync(paths.deflate);
  }

  get(hash: string): Buffer | undefined {
    const paths = objectPaths(this.root, hash);
    if (existsSync(paths.deflate)) {
      return inflateSync(readFileSync(paths.deflate));
    }
    if (existsSync(paths.raw)) {
      return decodeLegacyHeaderIfPresent(readFileSync(paths.raw));
    }
    return undefined;
  }

  put(data: Uint8Array): PutResult {
    const hash = sha256(data);
    if (this.has(hash)) {
      return { status: "exists", sha256: hash, bytes: data.byteLength };
    }
    const stored = compressIfWorthIt(data);
    const current = this.sizeBytes();
    if (current + stored.bytes.byteLength > maxTotalSizeBytes(this.config)) {
      return { status: "skipped-limit", sha256: hash, bytes: data.byteLength };
    }
    const paths = objectPaths(this.root, hash);
    atomicWriteFile(stored.deflate ? paths.deflate : paths.raw, stored.bytes);
    this.addSize(stored.bytes.byteLength);
    return { status: "stored", sha256: hash, bytes: data.byteLength };
  }

  deleteObject(hash: string): void {
    const paths = objectPaths(this.root, objectHashFromName(hash));
    for (const dest of [paths.raw, paths.deflate]) {
      if (!existsSync(dest)) {
        continue;
      }
      const size = statSync(dest).size;
      unlinkSync(dest);
      this.addSize(-size);
    }
  }

  sizeBytes(): number {
    const maintenance = this.readMaintenance();
    if (typeof maintenance.storeSizeBytes === "number") {
      return maintenance.storeSizeBytes;
    }
    const scanned = this.scanSize();
    this.writeMaintenance({ ...maintenance, storeSizeBytes: scanned });
    return scanned;
  }

  approachingLimit(extraBytes = 0): boolean {
    return this.sizeBytes() + extraBytes >= maxTotalSizeBytes(this.config);
  }

  readMaintenance(): MaintenanceState {
    const file = join(this.root, "maintenance.json");
    try {
      return JSON.parse(readFileSync(file, "utf8")) as MaintenanceState;
    } catch {
      return {};
    }
  }

  writeMaintenance(state: MaintenanceState): void {
    atomicWriteFile(join(this.root, "maintenance.json"), `${JSON.stringify(state, null, 2)}\n`);
  }

  listSessionIds(): string[] {
    const dir = join(this.root, "sessions");
    if (!existsSync(dir)) {
      return [];
    }
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  deleteSession(sessionId: string): void {
    const dir = this.sessionDir(sessionId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  wipe(): void {
    rmSync(this.root, { recursive: true, force: true });
    this.ensureLayout();
  }

  sweepUnreferenced(referenced: Set<string>): number {
    const objectsRoot = join(this.root, "objects", "sha256");
    if (!existsSync(objectsRoot)) {
      return 0;
    }
    let deleted = 0;
    for (const bucket of readdirSync(objectsRoot, { withFileTypes: true })) {
      if (!bucket.isDirectory()) {
        continue;
      }
      const bucketDir = join(objectsRoot, bucket.name);
      for (const entry of readdirSync(bucketDir, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.includes(".tmp.")) {
          continue;
        }
        const hash = objectHashFromName(entry.name);
        if (!referenced.has(hash)) {
          this.deleteObject(hash);
          deleted += 1;
        }
      }
    }
    this.writeMaintenance({
      ...this.readMaintenance(),
      storeSizeBytes: this.scanSize(),
    });
    return deleted;
  }

  cleanupTempFiles(): void {
    this.cleanupTemps(join(this.root, "objects"));
    this.cleanupTemps(join(this.root, "sessions"));
    this.cleanupTemps(join(this.root, "undo-journals"));
  }

  referencedHashesFromSessions(): Set<string> {
    const hashes = new Set<string>();
    for (const sessionId of this.listSessionIds()) {
      this.collectHashesFromDir(this.sessionDir(sessionId), hashes);
    }
    const journals = join(this.root, "undo-journals");
    if (existsSync(journals)) {
      this.collectHashesFromDir(journals, hashes);
    }
    return hashes;
  }

  private ensureLayout(): void {
    mkdirSync(join(this.root, "objects", "sha256"), { recursive: true });
    mkdirSync(join(this.root, "sessions"), { recursive: true });
    mkdirSync(join(this.root, "undo-journals"), { recursive: true });
  }

  private collectHashesFromDir(dir: string, hashes: Set<string>): void {
    if (!existsSync(dir)) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.collectHashesFromDir(full, hashes);
        continue;
      }
      if (!entry.isFile() || (!entry.name.endsWith(".json") && !entry.name.endsWith(".jsonl"))) {
        continue;
      }
      try {
        const text = readFileSync(full, "utf8");
        for (const match of text.matchAll(/"sha256"\s*:\s*"([a-f0-9]{64})"/g)) {
          hashes.add(match[1]);
        }
      } catch {
        // ignore unreadable manifests
      }
    }
  }

  private addSize(delta: number): void {
    const maintenance = this.readMaintenance();
    const current =
      typeof maintenance.storeSizeBytes === "number" ? maintenance.storeSizeBytes : this.scanSize();
    this.writeMaintenance({
      ...maintenance,
      storeSizeBytes: Math.max(0, current + delta),
    });
  }

  private scanSize(): number {
    return this.dirSize(join(this.root, "objects"));
  }

  private dirSize(dir: string): number {
    if (!existsSync(dir)) {
      return 0;
    }
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += this.dirSize(full);
      } else if (entry.isFile() && !entry.name.includes(".tmp.")) {
        total += statSync(full).size;
      }
    }
    return total;
  }

  private cleanupTemps(dir: string): void {
    if (!existsSync(dir)) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.cleanupTemps(full);
      } else if (entry.isFile() && entry.name.includes(".tmp.")) {
        try {
          unlinkSync(full);
        } catch {
          // ignore
        }
      }
    }
  }
}

export function appendJsonl(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const lines = readFileSync(filePath, "utf8").split("\n");
  const rows: T[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      // skip corrupt line
    }
  }
  return rows;
}
