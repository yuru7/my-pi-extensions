import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type RollbackConfig } from "../src/config.ts";
import { SessionJournal } from "../src/mutation-journal.ts";
import { createLocalSnapshotBackend, defaultPathContext } from "../src/platform.ts";
import { Snapshotter } from "../src/snapshot.ts";
import { ObjectStore } from "../src/store.ts";
import type { NotifyMessage } from "../src/errors.ts";

export interface Harness {
  root: string;
  cwd: string;
  storeRoot: string;
  store: ObjectStore;
  journal: SessionJournal;
  snapshotter: Snapshotter;
  notifications: NotifyMessage[];
  config: RollbackConfig;
}

const tempDirs: string[] = [];

export function tempDir(prefix = "pi-rollback-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function createHarness(options: {
  sessionId?: string;
  config?: Partial<Omit<RollbackConfig, "bash">> & { bash?: Partial<RollbackConfig["bash"]> };
  platform?: NodeJS.Platform;
  isWsl?: boolean;
} = {}): Harness {
  const root = tempDir();
  const cwd = join(root, "work");
  const storeRoot = join(root, "store");
  mkdirSync(cwd, { recursive: true });
  const config: RollbackConfig = {
    ...DEFAULT_CONFIG,
    ...options.config,
    bash: { ...DEFAULT_CONFIG.bash, ...options.config?.bash },
    excludeGlobs: options.config?.excludeGlobs ?? [],
  };
  const store = new ObjectStore(storeRoot, config);
  const journal = new SessionJournal(store, options.sessionId ?? "session-1");
  const notifications: NotifyMessage[] = [];
  const snapshotter = new Snapshotter({
    store,
    journal,
    config,
    pathContext: defaultPathContext({
      cwd,
      home: root,
      platform: options.platform ?? process.platform,
      isWsl: options.isWsl ?? false,
      storeRoot,
      excludeGlobs: config.excludeGlobs,
    }),
    backend: createLocalSnapshotBackend(),
    notify: (message) => {
      notifications.push(message);
    },
  });
  return {
    root,
    cwd,
    storeRoot,
    store,
    journal,
    snapshotter,
    notifications,
    config,
  };
}
