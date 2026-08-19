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
  type RollbackConfig,
} from "../src/config.ts";
import {
  bytesToMb,
  formatMb,
  formatPendingRecovery,
  type NotifyFn,
} from "../src/errors.ts";
import { runMaintenance, SessionJournal } from "../src/mutation-journal.ts";
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
} from "../src/rollback.ts";
import {
  chronologicalUserIds,
  findTurnEntryId,
  formatClock,
  listUserTurns,
  parseRollbackArgs,
  type SessionEntryLike,
} from "../src/session.ts";
import { Snapshotter } from "../src/snapshot.ts";
import { ObjectStore } from "../src/store.ts";

const LIST_ENTRY = "pi-rollback/list";
const STATUS_ENTRY = "pi-rollback/status";
const DIFF_ENTRY = "pi-rollback/diff";
const RESULT_ENTRY = "pi-rollback/result";

interface LinesData {
  lines: string[];
}

function isLinesData(data: unknown): data is LinesData {
  return (
    typeof data === "object" &&
    data !== null &&
    "lines" in data &&
    Array.isArray((data as LinesData).lines) &&
    (data as LinesData).lines.every((line) => typeof line === "string")
  );
}

const renderLines: EntryRenderer = (entry, _options, theme) => {
  const lines = isLinesData(entry.data) ? entry.data.lines : [];
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  for (const [index, line] of lines.entries()) {
    const styled = index === 0 ? theme.bold(theme.fg("accent", line)) : line;
    box.addChild(new Text(styled, 0, 0));
  }
  return box;
};

export interface RollbackExtensionDeps {
  home?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  isWsl?: boolean;
}

interface Runtime {
  config: RollbackConfig;
  store: ObjectStore;
  journal: SessionJournal;
  snapshotter: Snapshotter;
  sessionId: string;
}

export default function (pi: ExtensionAPI, deps: RollbackExtensionDeps = {}) {
  const home = deps.home;
  const configPath = getConfigPath(home);
  const loaded = loadConfig(configPath);
  const config = loaded.config;
  let runtime: Runtime | undefined;
  let pendingTreeForce = false;
  let pendingRollbackNav = false;
  const notifyFallback: string[] = [];

  const show = (
    ctx: { hasUI?: boolean; ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } },
    type: string,
    lines: string[],
    level: "info" | "warning" | "error" = "info",
  ) => {
    if (ctx.hasUI) {
      pi.appendEntry(type, { lines } satisfies LinesData);
      return;
    }
    ctx.ui?.notify?.(lines.join("\n"), level);
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
      ctx.ui.notify("pi-rollback: wrote default configuration.", "info");
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
      if (!shouldRestoreOnTree(runtime.config, { fromRollbackCommand: pendingRollbackNav })) {
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
    try {
      if (!runtime?.config.enabled) {
        return;
      }
      if (
        !shouldRestoreOnTree(runtime.config, {
          fromExtension: event.fromExtension,
          fromRollbackCommand: pendingRollbackNav,
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
      });
      if (newLeafId) {
        runtime.journal.saveLeafSnapshot(
          newLeafId,
          captureTrackedStates(
            runtime.journal.mutations(),
            runtime.store,
            maxFileSizeBytes(runtime.config),
          ),
        );
      }
      if (via !== "noop" && (plan.restored > 0 || plan.skipped.length > 0)) {
        show(
          ctx,
          RESULT_ENTRY,
          formatRestoreSummary(plan, "/rollback <N> --force").split("\n"),
        );
      }
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error
          ? `pi-rollback: Could not restore files for /tree: ${error.message}`
          : "pi-rollback: Could not restore files for /tree.",
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
        error instanceof Error ? `pi-rollback: ${error.message}` : "pi-rollback: snapshot failed",
        "warning",
      );
    }
    return undefined;
  });

  pi.on("tool_result", async (event) => {
    try {
      if (!runtime?.config.enabled) {
        return;
      }
      if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash") {
        await runtime.snapshotter.finish(event.toolCallId);
      }
    } catch {
      // snapshot errors must not affect the tool result
    }
    return undefined;
  });

  pi.registerCommand("rollback", {
    description: "Rollback files and conversation to a previous user turn",
    handler: async (args, ctx) => {
      const parsed = parseRollbackArgs(args);
      if (parsed.kind === "error") {
        ctx.ui.notify(parsed.message, "error");
        return;
      }
      if (parsed.kind === "help") {
        show(ctx, LIST_ENTRY, [
          "/rollback",
          "/rollback <N> [--force]",
          "/rollback diff <N>",
          "/rollback start [--force]",
          "/rollback status",
          "/reset-rollback-setting",
          "/clear-rollback-store",
        ]);
        return;
      }
      if (!runtime) {
        runtime = bindRuntime(ctx.sessionManager.getSessionId(), ctx.cwd, makeNotify(ctx));
      }

      if (parsed.kind === "status") {
        show(ctx, STATUS_ENTRY, statusLines(runtime));
        return;
      }

      const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
      const turns = listUserTurns(branch);

      if (parsed.kind === "list") {
        if (turns.length === 0) {
          show(ctx, LIST_ENTRY, ["No user turns in the current session."]);
          return;
        }
        show(ctx, LIST_ENTRY, [
          "Rollback points (1 = newest):",
          ...turns.map((turn) => {
            const files = describeTurnFiles(runtime!.journal.mutations(), turn.id);
            return `${turn.index}  ${formatClock(turn.timestamp)}  ${turn.preview}       ${files}`;
          }),
        ]);
        return;
      }

      await ctx.waitForIdle();

      if (parsed.kind === "start") {
        const { plan, transactionId } = executeFilesystemRestore({
          mutations: runtime.journal.mutations(),
          turnIds: "all",
          config: runtime.config,
          store: runtime.store,
          force: parsed.force,
        });
        show(ctx, RESULT_ENTRY, formatRestoreSummary(plan, "/rollback start --force").split("\n"));
        const parentSession = ctx.sessionManager.getSessionFile();
        const result = await ctx.newSession({ parentSession });
        if (result?.cancelled) {
          compensatingRestore(runtime.store, transactionId);
          ctx.ui.notify("pi-rollback: new session was cancelled; filesystem restore was undone.", "warning");
        }
        return;
      }

      const turn = turns.find((item) => item.index === parsed.n);
      if (!turn) {
        ctx.ui.notify(`No rollback point ${parsed.n}.`, "error");
        return;
      }
      const turnIds = new Set(
        chronologicalUserIds(branch).slice(
          chronologicalUserIds(branch).indexOf(turn.id),
        ),
      );

      if (parsed.kind === "diff") {
        const selected = mutationsForTurns(runtime.journal.mutations(), turnIds);
        const plan = buildRestorePlan(selected, {
          force: false,
          safeRestore: runtime.config.safeRestore,
          store: runtime.store,
          maxFileBytes: maxFileSizeBytes(runtime.config),
        });
        show(ctx, DIFF_ENTRY, [`Rollback to turn ${parsed.n}`, "", ...diffPreview(plan, runtime.store)]);
        return;
      }

      pendingRollbackNav = true;
      pendingTreeForce = parsed.force;
      try {
        const result = await ctx.navigateTree(turn.id, { summarize: false });
        if (result?.cancelled) {
          ctx.ui.notify("pi-rollback: tree navigation was cancelled.", "warning");
        }
      } finally {
        pendingRollbackNav = false;
        pendingTreeForce = false;
      }
    },
  });

  pi.registerCommand("reset-rollback-setting", {
    description: "Reset pi-rollback configuration to the built-in defaults",
    handler: async (_args, ctx) => {
      if (ctx.hasUI && ctx.ui.confirm) {
        const ok = await ctx.ui.confirm(
          "Reset pi-rollback configuration?",
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
        ctx.ui.notify("pi-rollback: Could not write the config file.", "error");
        return;
      }
      applyConfig(config, next);
      ctx.ui.notify("pi-rollback: configuration reset to defaults.", "info");
    },
  });

  pi.registerCommand("clear-rollback-store", {
    description: "Permanently delete all stored rollback snapshots",
    handler: async (_args, ctx) => {
      if (ctx.hasUI && ctx.ui.confirm) {
        const ok = await ctx.ui.confirm(
          "Remove all stored rollback data?",
          "This permanently deletes snapshots and rollback history. The conversation is kept. The configuration file is also kept.",
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
        ctx.ui.notify("pi-rollback: Could not remove stored rollback data.", "error");
        return;
      }
      runtime = bindRuntime(ctx.sessionManager.getSessionId(), ctx.cwd, makeNotify(ctx));
      ctx.ui.notify("pi-rollback: stored rollback data was removed.", "info");
    },
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
    runtime.config.enabled ? "pi-rollback enabled" : "pi-rollback disabled",
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
