import type { EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  applyConfig,
  DEFAULT_CONFIG,
  getConfigPath,
  getStoreRoot,
  loadConfig,
  maxFileSizeBytes,
  saveConfig,
  shouldRestoreOnTree,
  type UndoConfig,
} from "../src/config.ts";
import {
  bytesToMb,
  formatMb,
  formatPendingRecovery,
  type NotifyFn,
} from "../src/errors.ts";
import { runMaintenance, removeJournalDir, SessionJournal } from "../src/mutation-journal.ts";
import { createLocalSnapshotBackend, defaultPathContext, isWsl } from "../src/platform.ts";
import {
  captureTrackedStates,
  compensatingRestore,
  diffPreview,
  executeFilesystemRestore,
  executeTreeRestore,
  formatRestoreSummary,
  mutationsForTurns,
  buildRestorePlan,
} from "../src/undo.ts";
import {
  chronologicalUserIds,
  findTurnEntryId,
  formatClock,
  indexFileChangingTurns,
  listUserTurns,
  parseOptionalForce,
  parseRequiredTurn,
  parseUndoArgs,
  type SessionEntryLike,
} from "../src/session.ts";
import { Snapshotter } from "../src/snapshot.ts";
import { ObjectStore } from "../src/store.ts";

const LIST_ENTRY = "pi-undo/list";
const STATUS_ENTRY = "pi-undo/status";
const DIFF_ENTRY = "pi-undo/diff";
const RESULT_ENTRY = "pi-undo/result";

interface LineItem {
  text: string;
  dim?: boolean;
}

interface LinesData {
  lines: LineItem[];
}

function isLineItem(value: unknown): value is LineItem {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof (value as LineItem).text === "string" &&
    ((value as LineItem).dim === undefined || typeof (value as LineItem).dim === "boolean")
  );
}

function isLinesData(data: unknown): data is LinesData {
  return (
    typeof data === "object" &&
    data !== null &&
    "lines" in data &&
    Array.isArray((data as LinesData).lines) &&
    (data as LinesData).lines.every(isLineItem)
  );
}

function toLineItems(lines: Array<string | LineItem>): LineItem[] {
  return lines.map((line) => (typeof line === "string" ? { text: line } : line));
}

const renderLines: EntryRenderer = (entry, _options, theme) => {
  const lines = isLinesData(entry.data) ? entry.data.lines : [];
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  for (const [index, line] of lines.entries()) {
    let styled = line.text;
    if (line.dim) {
      styled = theme.fg("dim", styled);
    } else if (index === 0) {
      styled = theme.bold(theme.fg("accent", styled));
    }
    box.addChild(new Text(styled, 0, 0));
  }
  return box;
};

export interface UndoExtensionDeps {
  home?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  isWsl?: boolean;
}

interface Runtime {
  config: UndoConfig;
  store: ObjectStore;
  journal: SessionJournal;
  snapshotter: Snapshotter;
  sessionId: string;
}

export default function (pi: ExtensionAPI, deps: UndoExtensionDeps = {}) {
  const home = deps.home;
  const configPath = getConfigPath(home);
  const loaded = loadConfig(configPath);
  const config = loaded.config;
  let runtime: Runtime | undefined;
  let pendingTreeForce = false;
  let pendingUndoNav = false;
  let pendingForceFlag = "/undo <N> --force";
  const notifyFallback: string[] = [];

  const show = (
    ctx: { hasUI?: boolean; ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } },
    type: string,
    lines: Array<string | LineItem>,
    level: "info" | "warning" | "error" = "info",
  ) => {
    const items = toLineItems(lines);
    if (ctx.hasUI) {
      pi.appendEntry(type, { lines: items } satisfies LinesData);
      return;
    }
    ctx.ui?.notify?.(items.map((item) => item.text).join("\n"), level);
  };

  const makeNotify = (ctx: {
    hasUI?: boolean;
    ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
  }): NotifyFn => {
    return (message) => {
      if (ctx.ui?.notify) {
        ctx.ui.notify(message.text, message.level);
        return;
      }
      notifyFallback.push(message.text);
    };
  };

  const bindRuntime = (sessionId: string, cwd: string, notify: NotifyFn): Runtime => {
    const storeRoot = getStoreRoot(home);
    const store = new ObjectStore(storeRoot, config);
    const journal = new SessionJournal(store, sessionId, deps.now);
    const pathContext = defaultPathContext({
      cwd,
      home: home ?? undefined,
      platform: deps.platform,
      isWsl: deps.isWsl ?? isWsl(),
      storeRoot,
      excludeGlobs: config.excludeGlobs,
    });
    const snapshotter = new Snapshotter({
      store,
      journal,
      config,
      pathContext,
      backend: createLocalSnapshotBackend(),
      notify,
      now: deps.now,
    });
    return { config, store, journal, snapshotter, sessionId };
  };

  pi.registerEntryRenderer(LIST_ENTRY, renderLines);
  pi.registerEntryRenderer(STATUS_ENTRY, renderLines);
  pi.registerEntryRenderer(DIFF_ENTRY, renderLines);
  pi.registerEntryRenderer(RESULT_ENTRY, renderLines);

  pi.on("session_start", async (_event, ctx) => {
    if (loaded.warning) {
      ctx.ui.notify(loaded.warning, "warning");
    }
    if (loaded.created) {
      ctx.ui.notify("pi-undo: wrote default configuration.", "info");
    }
    const sessionId = ctx.sessionManager.getSessionId();
    runtime = bindRuntime(sessionId, ctx.cwd, makeNotify(ctx));
    const recovered = runtime.snapshotter.recoverPending();
    if (recovered > 0) {
      ctx.ui.notify(formatPendingRecovery(recovered), "warning");
    }
    runMaintenance(runtime.store, runtime.config, {
      activeSessionId: sessionId,
      now: deps.now?.(),
      reason: "startup",
    });
  });

  pi.on("session_shutdown", async () => {
    if (runtime) {
      runMaintenance(runtime.store, runtime.config, { reason: "shutdown" });
    }
    runtime = undefined;
  });

  pi.on("session_before_tree", async (event) => {
    try {
      if (!runtime?.config.enabled) {
        return;
      }
      if (!shouldRestoreOnTree(runtime.config, { fromUndoCommand: pendingUndoNav })) {
        return;
      }
      const oldLeafId = event.preparation?.oldLeafId;
      if (!oldLeafId) {
        return;
      }
      const entries = captureTrackedStates(
        runtime.journal.mutations(),
        runtime.store,
        maxFileSizeBytes(runtime.config),
      );
      runtime.journal.saveLeafSnapshot(oldLeafId, entries);
    } catch {
      // tree navigation must not fail because snapshot bookkeeping failed
    }
  });

  pi.on("session_tree", async (event, ctx) => {
    const force = pendingTreeForce;
    const forceFlag = pendingForceFlag;
    try {
      if (!runtime?.config.enabled) {
        return;
      }
      if (
        !shouldRestoreOnTree(runtime.config, {
          fromExtension: event.fromExtension,
          fromUndoCommand: pendingUndoNav,
        })
      ) {
        return;
      }
      const newLeafId = event.newLeafId ?? null;
      const oldLeafId = event.oldLeafId ?? null;
      if (newLeafId === oldLeafId) {
        return;
      }
      const sessionManager = ctx.sessionManager as {
        getBranch: (fromId?: string) => SessionEntryLike[];
      };
      const newBranch = (newLeafId ? sessionManager.getBranch(newLeafId) : sessionManager.getBranch()) as SessionEntryLike[];
      const oldBranch = (oldLeafId ? sessionManager.getBranch(oldLeafId) : []) as SessionEntryLike[];
      const { plan, via } = executeTreeRestore({
        mutations: runtime.journal.mutations(),
        oldBranch,
        newBranch,
        newLeafId,
        journal: runtime.journal,
        store: runtime.store,
        config: runtime.config,
        force,
        useLeafCache: !pendingUndoNav,
      });
      if (via !== "noop" && (plan.restored > 0 || plan.skipped.length > 0)) {
        show(
          ctx,
          RESULT_ENTRY,
          formatRestoreSummary(plan, forceFlag).split("\n"),
        );
      }
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error
          ? `pi-undo: Could not restore files for /tree: ${error.message}`
          : "pi-undo: Could not restore files for /tree.",
        "warning",
      );
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!runtime?.config.enabled) {
        return undefined;
      }
      const turnEntryId =
        findTurnEntryId(ctx.sessionManager.getBranch() as SessionEntryLike[]) ?? "__session__";
      const sessionId = runtime.sessionId;
      if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
        const path = typeof event.input.path === "string" ? event.input.path : "";
        if (path === "") {
          return undefined;
        }
        await runtime.snapshotter.beginWriteEdit({
          toolName: event.toolName as "write" | "edit",
          toolCallId: event.toolCallId,
          path,
          sessionId,
          turnEntryId,
        });
        return undefined;
      }
      if (isToolCallEventType("bash", event)) {
        const command = typeof event.input.command === "string" ? event.input.command : "";
        if (command === "") {
          return undefined;
        }
        await runtime.snapshotter.beginBash({
          toolCallId: event.toolCallId,
          command,
          sessionId,
          turnEntryId,
        });
      }
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? `pi-undo: ${error.message}` : "pi-undo: snapshot failed",
        "warning",
      );
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    try {
      if (!runtime?.config.enabled) {
        return;
      }
      if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash") {
        await runtime.snapshotter.finish(event.toolCallId);
      }
    } catch (error) {
      ctx.ui?.notify?.(
        error instanceof Error
          ? `pi-undo: Could not record this change: ${error.message}`
          : "pi-undo: Could not record this change; undo coverage may be missing.",
        "warning",
      );
    }
    return undefined;
  });

  const ensureRuntime = (ctx: {
    cwd: string;
    sessionManager: { getSessionId: () => string };
    ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
  }): Runtime => {
    if (!runtime) {
      runtime = bindRuntime(ctx.sessionManager.getSessionId(), ctx.cwd, makeNotify(ctx));
    }
    return runtime;
  };

  const currentTurns = (
    current: Runtime,
    ctx: { sessionManager: { getBranch: () => SessionEntryLike[] } },
  ) => {
    const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
    return {
      branch,
      turns: indexFileChangingTurns(listUserTurns(branch), current.journal.mutations()),
    };
  };

  const showUndoList = (ctx: {
    hasUI?: boolean;
    cwd: string;
    sessionManager: { getSessionId: () => string; getBranch: () => SessionEntryLike[] };
    ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
  }) => {
    const current = ensureRuntime(ctx);
    const { turns } = currentTurns(current, ctx);
    if (turns.length === 0) {
      show(ctx, LIST_ENTRY, ["No user turns in the current session."]);
      return;
    }
    show(ctx, LIST_ENTRY, [
      "Undo points (1 = newest):",
      ...formatUndoTurnLines(turns, current.journal.mutations()),
    ]);
  };

  const navigateToLeaf = async (
    ctx: {
      sessionManager: { getBranch: () => SessionEntryLike[] };
      navigateTree: (id: string, options?: { summarize?: boolean }) => Promise<{ cancelled?: boolean } | undefined>;
      ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
    },
    current: Runtime,
    leafId: string,
    force: boolean,
    forceFlag: string,
  ) => {
    pendingUndoNav = true;
    pendingTreeForce = force;
    pendingForceFlag = forceFlag;
    try {
      const currentLeafId = (ctx.sessionManager.getBranch() as SessionEntryLike[]).at(-1)?.id;
      if (currentLeafId) {
        current.journal.saveLeafSnapshot(
          currentLeafId,
          captureTrackedStates(
            current.journal.mutations(),
            current.store,
            maxFileSizeBytes(current.config),
          ),
        );
      }
      return await ctx.navigateTree(leafId, { summarize: false });
    } finally {
      pendingUndoNav = false;
      pendingTreeForce = false;
      pendingForceFlag = "/undo <N> --force";
    }
  };

  pi.registerCommand("undo", {
    description: "Undo files and conversation to a previous user turn",
    handler: async (args, ctx) => {
      const parsed = parseUndoArgs(args);
      if (parsed.kind === "error") {
        ctx.ui.notify(parsed.message, "error");
        return;
      }
      if (parsed.kind === "help") {
        show(ctx, LIST_ENTRY, [
          "/undo",
          "/undo <N> [--force]",
          "/undo-list",
          "/undo-diff [N]",
          "/undo-start [--force]",
          "/undo-status",
          "/redo [--force]",
          "/undo:reset-setting",
          "/undo:clear-undo-store",
        ]);
        return;
      }
      const current = ensureRuntime(ctx);
      const { turns } = currentTurns(current, ctx);

      await ctx.waitForIdle();

      const turn = turns.find((item) => item.index === parsed.n);
      if (!turn) {
        ctx.ui.notify(`No undo point ${parsed.n}.`, "error");
        return;
      }

      const currentLeafId = (ctx.sessionManager.getBranch() as SessionEntryLike[]).at(-1)?.id;
      const result = await navigateToLeaf(
        ctx,
        current,
        turn.id,
        parsed.force,
        "/undo <N> --force",
      );
      if (result?.cancelled) {
        ctx.ui.notify("pi-undo: tree navigation was cancelled.", "warning");
        return;
      }
      if (currentLeafId && currentLeafId !== turn.id) {
        current.journal.setRedoLeafId(currentLeafId);
      }
    },
  });

  pi.registerCommand("redo", {
    description: "Restore conversation and files to the state before the last /undo",
    handler: async (args, ctx) => {
      const parsed = parseOptionalForce(args, "Usage: /redo [--force]");
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }
      const current = ensureRuntime(ctx);
      const target = current.journal.getRedoLeafId();
      const currentLeafId = (ctx.sessionManager.getBranch() as SessionEntryLike[]).at(-1)?.id;
      if (!target || target === currentLeafId) {
        ctx.ui.notify("Nothing to redo.", "error");
        return;
      }
      await ctx.waitForIdle();
      const result = await navigateToLeaf(ctx, current, target, parsed.force, "/redo --force");
      if (result?.cancelled) {
        ctx.ui.notify("pi-undo: tree navigation was cancelled.", "warning");
        return;
      }
      current.journal.setRedoLeafId(undefined);
    },
  });

  pi.registerCommand("undo-list", {
    description: "List undo points in the current session",
    handler: async (_args, ctx) => {
      showUndoList(ctx);
    },
  });

  pi.registerCommand("undo-diff", {
    description: "Preview files that /undo <N> would restore",
    handler: async (args, ctx) => {
      const parsed = parseRequiredTurn(args, "Usage: /undo-diff [N]");
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }
      const current = ensureRuntime(ctx);
      const { branch, turns } = currentTurns(current, ctx);
      const turn = turns.find((item) => item.index === parsed.n);
      if (!turn) {
        ctx.ui.notify(`No undo point ${parsed.n}.`, "error");
        return;
      }
      await ctx.waitForIdle();
      const turnIds = new Set(
        chronologicalUserIds(branch).slice(chronologicalUserIds(branch).indexOf(turn.id)),
      );
      const selected = mutationsForTurns(current.journal.mutations(), turnIds);
      const plan = buildRestorePlan(selected, {
        force: false,
        safeRestore: current.config.safeRestore,
        store: current.store,
        maxFileBytes: maxFileSizeBytes(current.config),
      });
      show(ctx, DIFF_ENTRY, [`Undo to turn ${parsed.n}`, "", ...diffPreview(plan, current.store)]);
    },
  });

  pi.registerCommand("undo-start", {
    description: "Restore this session's files and start a new empty session",
    handler: async (args, ctx) => {
      const parsed = parseOptionalForce(args, "Usage: /undo-start [--force]");
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }
      const current = ensureRuntime(ctx);
      await ctx.waitForIdle();
      let transactionId = "";
      try {
        const restored = executeFilesystemRestore({
          mutations: current.journal.mutations(),
          turnIds: "all",
          config: current.config,
          store: current.store,
          force: parsed.force,
        });
        transactionId = restored.transactionId;
        show(ctx, RESULT_ENTRY, formatRestoreSummary(restored.plan, "/undo-start --force").split("\n"));
        const parentSession = ctx.sessionManager.getSessionFile();
        const result = await ctx.newSession({ parentSession });
        if (result?.cancelled) {
          compensatingRestore(current.store, transactionId);
          ctx.ui.notify("pi-undo: new session was cancelled; filesystem restore was undone.", "warning");
        }
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "pi-undo: Could not restore files.",
          "error",
        );
      } finally {
        if (transactionId !== "") {
          removeJournalDir(current.store, transactionId);
        }
      }
    },
  });

  pi.registerCommand("undo-status", {
    description: "Show pi-undo status for the current session",
    handler: async (_args, ctx) => {
      show(ctx, STATUS_ENTRY, statusLines(ensureRuntime(ctx)));
    },
  });

  pi.registerCommand("undo:reset-setting", {
    description: "Reset pi-undo configuration to the built-in defaults",
    handler: async (_args, ctx) => {
      if (ctx.hasUI && ctx.ui.confirm) {
        const ok = await ctx.ui.confirm(
          "Reset pi-undo configuration?",
          "This replaces the config file with the default settings.",
        );
        if (!ok) {
          return;
        }
      }
      const next = structuredClone(DEFAULT_CONFIG);
      try {
        saveConfig(next, configPath);
      } catch {
        ctx.ui.notify("pi-undo: Could not write the config file.", "error");
        return;
      }
      applyConfig(config, next);
      ctx.ui.notify("pi-undo: configuration reset to defaults.", "info");
    },
  });

  pi.registerCommand("undo:clear-undo-store", {
    description: "Permanently delete all stored undo snapshots",
    handler: async (_args, ctx) => {
      if (ctx.hasUI && ctx.ui.confirm) {
        const ok = await ctx.ui.confirm(
          "Remove all stored undo data?",
          "This permanently deletes snapshots and undo history. The conversation is kept. The configuration file is also kept.",
        );
        if (!ok) {
          return;
        }
      }
      await ctx.waitForIdle();
      try {
        if (runtime) {
          runtime.store.wipe();
        } else {
          new ObjectStore(getStoreRoot(home), config).wipe();
        }
      } catch {
        ctx.ui.notify("pi-undo: Could not remove stored undo data.", "error");
        return;
      }
      runtime = bindRuntime(ctx.sessionManager.getSessionId(), ctx.cwd, makeNotify(ctx));
      ctx.ui.notify("pi-undo: stored undo data was removed.", "info");
    },
  });
}

function formatUndoTurnLines(
  turns: { id: string; index: number | null; timestamp: number; preview: string }[],
  mutations: { turnEntryId: string; key: string; coverage: string }[],
): LineItem[] {
  const selectable = turns.map((turn) => turn.index).filter((index): index is number => index !== null);
  const indexWidth = selectable.length === 0 ? 1 : String(Math.max(...selectable)).length;
  return turns.map((turn) => {
    const files = describeTurnFiles(mutations, turn.id);
    const body = `${formatClock(turn.timestamp)}  ${turn.preview}       ${files}`;
    if (turn.index === null) {
      return { text: `${" ".repeat(indexWidth)}  ${body}`, dim: true };
    }
    return { text: `${String(turn.index).padStart(indexWidth)}  ${body}` };
  });
}

function describeTurnFiles(mutations: { turnEntryId: string; key: string; coverage: string }[], turnId: string): string {
  const files = new Set(
    mutations.filter((mutation) => mutation.turnEntryId === turnId).map((mutation) => mutation.key),
  );
  if (files.size === 0) {
    return "no file changes";
  }
  const partial = mutations.some(
    (mutation) => mutation.turnEntryId === turnId && mutation.coverage === "partial",
  );
  return `${files.size} file${files.size === 1 ? "" : "s"}${partial ? " (partial)" : ""}`;
}

function statusLines(runtime: Runtime): string[] {
  const mutations = runtime.journal.mutations();
  const turns = new Set(mutations.map((mutation) => mutation.turnEntryId));
  const files = new Set(mutations.map((mutation) => mutation.key));
  const used = runtime.store.sizeBytes();
  const cap = runtime.config.maxTotalSizeMB;
  return [
    runtime.config.enabled ? "pi-undo enabled" : "pi-undo disabled",
    `  /tree restore: ${runtime.config.syncTree ? "on" : "off"}`,
    "",
    "Session:",
    `  tracked turns: ${turns.size}`,
    `  tracked files: ${files.size}`,
    "",
    "Store:",
    `  ${formatMb(bytesToMb(used))} MB / ${cap} MB`,
    "",
    "Coverage:",
    "  write/edit: exact",
    `  bash: ${new Set(mutations.filter((mutation) => mutation.toolName === "bash").map((mutation) => mutation.toolCallId)).size} commands tracked`,
    `  bash partial: ${new Set(mutations.filter((mutation) => mutation.toolName === "bash" && mutation.coverage === "partial").map((mutation) => mutation.toolCallId)).size}`,
  ];
}
