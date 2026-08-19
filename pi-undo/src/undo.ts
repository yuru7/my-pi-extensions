import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UndoConfig } from "./config.ts";
import { maxFileSizeBytes } from "./config.ts";
import type { LeafSnapshotEntry, MutationRecord, SessionJournal } from "./mutation-journal.ts";
import { removeJournalDir } from "./mutation-journal.ts";
import {
  collectToolCallIds,
  shouldRedoMutation,
  shouldUndoMutation,
  stayTurnIds,
  type SessionEntryLike,
} from "./session.ts";
import { formatUndoTransactionAbort } from "./errors.ts";
import { appendJsonl, atomicWriteFile, ObjectStore, readJsonl } from "./store.ts";
import {
  captureFileState,
  fileStateEquals,
  restoreFileState,
  type FileState,
} from "./snapshot.ts";

export type RestoreAction = "modify" | "delete" | "add";

export interface RestoreItem {
  path: string;
  key: string;
  pre: FileState;
  post: FileState;
  coverage: MutationRecord["coverage"];
  action: RestoreAction;
  skipped?: "external-edit" | "missing-object";
}

export interface RestorePlan {
  items: RestoreItem[];
  restored: number;
  skipped: string[];
  partialCoverage: number;
}

export interface JournalEntry {
  path: string;
  key: string;
  state: FileState;
}

export function actionFor(pre: FileState, post: FileState): RestoreAction {
  if (pre.kind === "absent" && post.kind !== "absent") {
    return "delete";
  }
  if (pre.kind !== "absent" && post.kind === "absent") {
    return "add";
  }
  return "modify";
}

export function mutationsForTurns(
  mutations: MutationRecord[],
  turnIds: Set<string> | "all",
): MutationRecord[] {
  const filtered =
    turnIds === "all" ? mutations : mutations.filter((mutation) => turnIds.has(mutation.turnEntryId));
  return [...filtered].sort((a, b) => b.sequence - a.sequence);
}

export function buildRestorePlan(
  mutations: MutationRecord[],
  options: {
    force: boolean;
    safeRestore: boolean;
    store: ObjectStore;
    maxFileBytes: number;
  },
): RestorePlan {
  const items: RestoreItem[] = [];
  const skippedPaths = new Set<string>();
  const latestByKey = new Map<string, RestoreItem>();

  for (const mutation of mutations) {
    if (skippedPaths.has(mutation.key)) {
      continue;
    }
    const existing = latestByKey.get(mutation.key);
    if (existing) {
      existing.pre = mutation.pre;
      existing.action = actionFor(mutation.pre, existing.post);
      existing.coverage = mergeCoverage(existing.coverage, mutation.coverage);
      continue;
    }

    const item: RestoreItem = {
      path: mutation.path,
      key: mutation.key,
      pre: mutation.pre,
      post: mutation.post,
      coverage: mutation.coverage,
      action: actionFor(mutation.pre, mutation.post),
    };

    if (
      !options.force &&
      options.safeRestore &&
      currentDiffersFrom(mutation.path, mutation.post, options.store, options.maxFileBytes)
    ) {
      item.skipped = "external-edit";
      skippedPaths.add(mutation.key);
      items.push(item);
      continue;
    }

    if (mutation.pre.kind === "file" && !options.store.has(mutation.pre.sha256) && !mutation.pre.sha256.startsWith("too-large:")) {
      item.skipped = "missing-object";
      skippedPaths.add(mutation.key);
      items.push(item);
      continue;
    }

    latestByKey.set(mutation.key, item);
    items.push(item);
  }

  return summarizeRestorePlan(items);
}

export function buildRedoPlan(
  mutations: MutationRecord[],
  options: {
    force: boolean;
    safeRestore: boolean;
    store: ObjectStore;
    maxFileBytes: number;
  },
): RestorePlan {
  const items: RestoreItem[] = [];
  const skippedPaths = new Set<string>();
  const latestByKey = new Map<string, RestoreItem>();
  const ordered = [...mutations].sort((left, right) => left.sequence - right.sequence);

  for (const mutation of ordered) {
    if (skippedPaths.has(mutation.key)) {
      continue;
    }
    const existing = latestByKey.get(mutation.key);
    if (existing) {
      existing.pre = mutation.post;
      existing.action = actionFor(mutation.post, existing.post);
      existing.coverage = mergeCoverage(existing.coverage, mutation.coverage);
      continue;
    }

    const item: RestoreItem = {
      path: mutation.path,
      key: mutation.key,
      pre: mutation.post,
      post: mutation.pre,
      coverage: mutation.coverage,
      action: actionFor(mutation.post, mutation.pre),
    };

    if (
      !options.force &&
      options.safeRestore &&
      currentDiffersFrom(mutation.path, mutation.pre, options.store, options.maxFileBytes)
    ) {
      item.skipped = "external-edit";
      skippedPaths.add(mutation.key);
      items.push(item);
      continue;
    }

    if (
      mutation.post.kind === "file" &&
      !options.store.has(mutation.post.sha256) &&
      !mutation.post.sha256.startsWith("too-large:")
    ) {
      item.skipped = "missing-object";
      skippedPaths.add(mutation.key);
      items.push(item);
      continue;
    }

    latestByKey.set(mutation.key, item);
    items.push(item);
  }

  return summarizeRestorePlan(items);
}

function mergeCoverage(
  left: MutationRecord["coverage"],
  right: MutationRecord["coverage"],
): MutationRecord["coverage"] {
  if (left === "partial" || right === "partial") {
    return "partial";
  }
  if (left === "best-effort" || right === "best-effort") {
    return "best-effort";
  }
  return "exact";
}

function summarizeRestorePlan(items: RestoreItem[]): RestorePlan {
  return {
    items,
    restored: items.filter((item) => !item.skipped).length,
    skipped: items.filter((item) => item.skipped === "external-edit").map((item) => item.path),
    partialCoverage: items.filter((item) => item.coverage === "partial").length,
  };
}

function mergeRestorePlans(undo: RestorePlan, redo: RestorePlan): RestorePlan {
  const items: RestoreItem[] = [];
  const seen = new Set<string>();
  for (const item of redo.items) {
    items.push(item);
    seen.add(item.key);
  }
  for (const item of undo.items) {
    if (seen.has(item.key)) {
      continue;
    }
    items.push(item);
  }
  return summarizeRestorePlan(items);
}

function currentDiffersFrom(
  filePath: string,
  expected: FileState,
  store: ObjectStore,
  maxFileBytes: number,
): boolean {
  const current = captureFileState(filePath, { store, persist: false, maxFileBytes });
  if (current.status !== "ok") {
    return true;
  }
  return !fileStateEquals(current.state, expected);
}

export function createUndoJournal(
  store: ObjectStore,
  items: RestoreItem[],
  maxFileBytes: number,
): { transactionId: string; entries: JournalEntry[] } {
  const entries: JournalEntry[] = [];
  for (const item of items) {
    if (item.skipped) {
      continue;
    }
    const captured = captureFileState(item.path, {
      store,
      persist: true,
      maxFileBytes,
    });
    if (captured.status !== "ok") {
      throw new Error(formatUndoTransactionAbort(item.path));
    }
    entries.push({ path: item.path, key: item.key, state: captured.state });
  }

  const transactionId = randomUUID();
  const dir = store.journalDir(transactionId);
  mkdirSync(dir, { recursive: true });
  try {
    for (const entry of entries) {
      appendJsonl(join(dir, "states.jsonl"), entry);
    }
    atomicWriteFile(
      join(dir, "meta.json"),
      `${JSON.stringify({ transactionId, createdAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch (error) {
    removeJournalDir(store, transactionId);
    throw error;
  }
  return { transactionId, entries };
}

export function applyRestore(items: RestoreItem[], store: ObjectStore): void {
  for (const item of items) {
    if (item.skipped) {
      continue;
    }
    restoreFileState(item.path, item.pre, store);
  }
}

export function compensatingRestore(store: ObjectStore, transactionId: string): void {
  const file = join(store.journalDir(transactionId), "states.jsonl");
  if (!existsSync(file)) {
    return;
  }
  const entries = readJsonl<JournalEntry>(file);
  for (const entry of entries.reverse()) {
    restoreFileState(entry.path, entry.state, store);
  }
}

export function formatRestoreSummary(plan: RestorePlan, forceFlag: string): string {
  const lines = [`Restored: ${plan.restored} files`];
  if (plan.skipped.length > 0) {
    lines.push(`Skipped: ${plan.skipped.length} files modified after Pi's last write`);
    lines.push("");
    for (const path of plan.skipped) {
      lines.push(`  ${path}`);
    }
    lines.push("");
    lines.push(`Use ${forceFlag} to overwrite them.`);
  }
  return lines.join("\n");
}

export const OVERWRITE_SELECT_NO = "No (Do not overwrite)";
export const OVERWRITE_SELECT_YES = "Yes (Overwrite)";

export function overwriteSelectOptions(): string[] {
  return [OVERWRITE_SELECT_NO, OVERWRITE_SELECT_YES];
}

export function formatOverwriteSelectTitle(skipped: string[]): string {
  const count = skipped.length;
  const noun = count === 1 ? "file" : "files";
  return [
    `Overwrite ${count} ${noun} modified after Pi's last write?`,
    "",
    ...skipped.map((path) => `  ${path}`),
  ].join("\n");
}

export function restoreActionLabel(action: RestoreAction): string {
  switch (action) {
    case "modify":
      return "M";
    case "delete":
      return "D";
    case "add":
      return "A";
  }
}

export function isMostlyText(data: Uint8Array): boolean {
  if (data.includes(0)) {
    return false;
  }
  try {
    const decoded = new TextDecoder("utf8", { fatal: true }).decode(data);
    return decoded.length < 200_000;
  } catch {
    return false;
  }
}

export function unifiedDiff(path: string, before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const hunks = myersHunks(oldLines, newLines);
  if (hunks.length === 0) {
    return "";
  }
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    lines.push(...hunk);
  }
  return lines.join("\n");
}

interface Edit {
  type: "equal" | "delete" | "insert";
  line: string;
}

function myersHunks(oldLines: string[], newLines: string[]): string[][] {
  const edits = shortestEdit(oldLines, newLines);
  const hunks: string[][] = [];
  let i = 0;
  while (i < edits.length) {
    while (i < edits.length && edits[i].type === "equal") {
      i += 1;
    }
    if (i >= edits.length) {
      break;
    }
    const start = Math.max(0, i - 3);
    let end = i;
    let oldStart = 0;
    let newStart = 0;
    for (let j = 0; j < start; j += 1) {
      if (edits[j].type !== "insert") {
        oldStart += 1;
      }
      if (edits[j].type !== "delete") {
        newStart += 1;
      }
    }
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let j = start; j < edits.length; j += 1) {
      const edit = edits[j];
      const inChange = edit.type !== "equal";
      if (!inChange && j > end + 3) {
        break;
      }
      if (inChange) {
        end = j;
      }
      if (edit.type !== "insert") {
        oldCount += 1;
      }
      if (edit.type !== "delete") {
        newCount += 1;
      }
      const prefix = edit.type === "insert" ? "+" : edit.type === "delete" ? "-" : " ";
      body.push(`${prefix}${edit.line}`);
      i = j + 1;
    }
    hunks.push([`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`, ...body]);
  }
  return hunks;
}

function shortestEdit(oldLines: string[], newLines: string[]): Edit[] {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;
  const v = new Map<number, number>();
  v.set(1, 0);
  const trace: Array<Map<number, number>> = [];
  let dFound = 0;

  outer: for (let d = 0; d <= max; d += 1) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }
      v.set(k, x);
      if (x >= n && y >= m) {
        dFound = d;
        break outer;
      }
    }
  }

  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = dFound; d > 0; d -= 1) {
    const prev = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (prev.get(k - 1) ?? 0) < (prev.get(k + 1) ?? 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prev.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      edits.push({ type: "equal", line: oldLines[x] });
    }
    if (x === prevX) {
      y -= 1;
      edits.push({ type: "insert", line: newLines[y] });
    } else {
      x -= 1;
      edits.push({ type: "delete", line: oldLines[x] });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    edits.push({ type: "equal", line: oldLines[x] });
  }
  while (x > 0) {
    x -= 1;
    edits.push({ type: "delete", line: oldLines[x] });
  }
  while (y > 0) {
    y -= 1;
    edits.push({ type: "insert", line: newLines[y] });
  }
  return edits.reverse();
}

export function diffPreview(
  plan: RestorePlan,
  store: ObjectStore,
  options: { maxDiffBytes?: number } = {},
): string[] {
  const maxDiffBytes = options.maxDiffBytes ?? 100 * 1024;
  const lines = [
    ...plan.items
      .filter((item) => !item.skipped)
      .map((item) => `${restoreActionLabel(item.action)} ${item.path}`),
    "",
    `${plan.restored} files will be restored`,
  ];
  if (plan.skipped.length > 0) {
    lines.push(`${plan.skipped.length} user-edited file${plan.skipped.length === 1 ? "" : "s"} will be skipped`);
  }
  if (plan.partialCoverage > 0) {
    lines.push(`${plan.partialCoverage} bash changes had partial coverage`);
  }

  for (const item of plan.items) {
    if (item.skipped) {
      continue;
    }
    if (item.pre.kind !== "file") {
      continue;
    }
    const restoredBytes = store.get(item.pre.sha256);
    const currentBytes = currentFileBytes(item.path, maxDiffBytes);
    if (!restoredBytes || !currentBytes || !isMostlyText(restoredBytes) || !isMostlyText(currentBytes)) {
      const fromSize = currentBytes?.byteLength ?? (item.post.kind === "file" ? item.post.size : 0);
      lines.push("", `binary changed: ${formatSize(fromSize)} -> ${formatSize(item.pre.size)}`);
      continue;
    }
    if (restoredBytes.length > maxDiffBytes || currentBytes.length > maxDiffBytes) {
      lines.push("", `binary changed: ${formatSize(currentBytes.length)} -> ${formatSize(restoredBytes.length)}`);
      continue;
    }
    const diff = unifiedDiff(
      item.path,
      new TextDecoder().decode(currentBytes),
      new TextDecoder().decode(restoredBytes),
    );
    if (diff) {
      lines.push("", diff);
    }
  }
  return lines;
}

function currentFileBytes(filePath: string, maxFileBytes: number): Buffer | undefined {
  try {
    const data = readFileSync(filePath);
    if (data.length > maxFileBytes * 4) {
      return undefined;
    }
    return data;
  } catch {
    return undefined;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function executeFilesystemRestore(options: {
  mutations: MutationRecord[];
  turnIds: Set<string> | "all";
  config: UndoConfig;
  store: ObjectStore;
  force: boolean;
}): { plan: RestorePlan; transactionId: string } {
  const selected = mutationsForTurns(options.mutations, options.turnIds);
  const plan = buildRestorePlan(selected, {
    force: options.force,
    safeRestore: options.config.safeRestore,
    store: options.store,
    maxFileBytes: maxFileSizeBytes(options.config),
  });
  return commitRestorePlan(plan, options.store, options.config, { keepJournal: true });
}

export function captureTrackedStates(
  mutations: MutationRecord[],
  store: ObjectStore,
  maxFileBytes: number,
): LeafSnapshotEntry[] {
  const seen = new Set<string>();
  const entries: LeafSnapshotEntry[] = [];
  for (const mutation of mutations) {
    if (seen.has(mutation.key)) {
      continue;
    }
    seen.add(mutation.key);
    const captured = captureFileState(mutation.path, {
      store,
      persist: true,
      maxFileBytes,
    });
    if (captured.status !== "ok") {
      continue;
    }
    entries.push({
      path: mutation.path,
      key: mutation.key,
      state: captured.state,
    });
  }
  return entries;
}

export function mutationsForTreeUndo(
  mutations: MutationRecord[],
  oldBranch: SessionEntryLike[],
  newBranch: SessionEntryLike[],
  newLeafId: string | null,
): MutationRecord[] {
  const oldToolCallIds = collectToolCallIds(oldBranch);
  const newToolCallIds = collectToolCallIds(newBranch);
  const oldStayTurns = stayTurnIds(oldBranch, oldBranch.at(-1)?.id ?? null);
  const newStayTurns = stayTurnIds(newBranch, newLeafId);
  return mutations
    .filter((mutation) =>
      shouldUndoMutation(mutation, oldToolCallIds, newToolCallIds, oldStayTurns, newStayTurns),
    )
    .sort((left, right) => right.sequence - left.sequence);
}

export function mutationsForTreeRedo(
  mutations: MutationRecord[],
  oldBranch: SessionEntryLike[],
  newBranch: SessionEntryLike[],
  newLeafId: string | null,
): MutationRecord[] {
  const oldToolCallIds = collectToolCallIds(oldBranch);
  const newToolCallIds = collectToolCallIds(newBranch);
  const oldStayTurns = stayTurnIds(oldBranch, oldBranch.at(-1)?.id ?? null);
  const newStayTurns = stayTurnIds(newBranch, newLeafId);
  return mutations
    .filter((mutation) =>
      shouldRedoMutation(mutation, oldToolCallIds, newToolCallIds, oldStayTurns, newStayTurns),
    )
    .sort((left, right) => left.sequence - right.sequence);
}

function commitRestorePlan(
  plan: RestorePlan,
  store: ObjectStore,
  config: UndoConfig,
  options: { keepJournal?: boolean } = {},
): { plan: RestorePlan; transactionId: string } {
  const pending = plan.items.filter((item) => !item.skipped);
  if (pending.length === 0) {
    return { plan, transactionId: "" };
  }
  const { transactionId } = createUndoJournal(
    store,
    plan.items,
    maxFileSizeBytes(config),
  );
  try {
    applyRestore(plan.items, store);
  } catch (error) {
    compensatingRestore(store, transactionId);
    removeJournalDir(store, transactionId);
    throw error;
  }
  if (!options.keepJournal) {
    removeJournalDir(store, transactionId);
  }
  return { plan, transactionId };
}

function mutationAppliesToBranch(
  mutation: MutationRecord,
  toolCallIds: Set<string>,
): boolean {
  return toolCallIds.has(mutation.toolCallId);
}

function piFileStatesOnBranch(
  mutations: MutationRecord[],
  branch: SessionEntryLike[],
): Map<string, FileState> {
  const toolCallIds = collectToolCallIds(branch);
  const states = new Map<string, FileState>();
  for (const mutation of [...mutations].sort((left, right) => left.sequence - right.sequence)) {
    if (!states.has(mutation.key)) {
      states.set(mutation.key, mutation.pre);
    }
    if (mutationAppliesToBranch(mutation, toolCallIds)) {
      states.set(mutation.key, mutation.post);
    }
  }
  return states;
}

function buildLeafCachePlan(
  cached: LeafSnapshotEntry[],
  expectedByKey: Map<string, FileState>,
  options: {
    force: boolean;
    safeRestore: boolean;
    store: ObjectStore;
    maxFileBytes: number;
  },
): RestorePlan {
  const items: RestoreItem[] = cached.map((entry) => {
    const expected = expectedByKey.get(entry.key) ?? { kind: "absent" };
    const item: RestoreItem = {
      path: entry.path,
      key: entry.key,
      pre: entry.state,
      post: expected,
      coverage: "exact",
      action: actionFor(entry.state, expected),
    };
    if (
      !options.force &&
      options.safeRestore &&
      currentDiffersFrom(entry.path, expected, options.store, options.maxFileBytes)
    ) {
      item.skipped = "external-edit";
    } else if (
      entry.state.kind === "file" &&
      !options.store.has(entry.state.sha256) &&
      !entry.state.sha256.startsWith("too-large:")
    ) {
      item.skipped = "missing-object";
    }
    return item;
  });
  return summarizeRestorePlan(items);
}

export function planTreeRestore(options: {
  mutations: MutationRecord[];
  oldBranch: SessionEntryLike[];
  newBranch: SessionEntryLike[];
  newLeafId: string | null;
  journal: SessionJournal;
  store: ObjectStore;
  config: UndoConfig;
  force: boolean;
  useLeafCache?: boolean;
}): { plan: RestorePlan; via: "cache" | "mutations" | "noop" } {
  const empty: RestorePlan = { items: [], restored: 0, skipped: [], partialCoverage: 0 };
  const planOptions = {
    force: options.force,
    safeRestore: options.config.safeRestore,
    store: options.store,
    maxFileBytes: maxFileSizeBytes(options.config),
  };
  const useLeafCache = options.useLeafCache ?? true;
  if (useLeafCache && options.newLeafId && !options.force) {
    const cached = options.journal.loadLeafSnapshot(options.newLeafId);
    if (cached && cached.length > 0) {
      const expectedByKey = piFileStatesOnBranch(options.mutations, options.oldBranch);
      return { plan: buildLeafCachePlan(cached, expectedByKey, planOptions), via: "cache" };
    }
  }

  const undoPlan = buildRestorePlan(
    mutationsForTreeUndo(options.mutations, options.oldBranch, options.newBranch, options.newLeafId),
    planOptions,
  );
  const redoPlan = buildRedoPlan(
    mutationsForTreeRedo(options.mutations, options.oldBranch, options.newBranch, options.newLeafId),
    planOptions,
  );
  const plan = mergeRestorePlans(undoPlan, redoPlan);
  if (plan.items.length === 0) {
    return { plan: empty, via: "noop" };
  }
  return { plan, via: "mutations" };
}

export function executeTreeRestore(options: {
  mutations: MutationRecord[];
  oldBranch: SessionEntryLike[];
  newBranch: SessionEntryLike[];
  newLeafId: string | null;
  journal: SessionJournal;
  store: ObjectStore;
  config: UndoConfig;
  force: boolean;
  useLeafCache?: boolean;
}): { plan: RestorePlan; transactionId: string; via: "cache" | "mutations" | "noop" } {
  const planned = planTreeRestore(options);
  if (planned.via === "noop") {
    return { ...planned, transactionId: "" };
  }
  return { ...commitRestorePlan(planned.plan, options.store, options.config), via: planned.via };
}
