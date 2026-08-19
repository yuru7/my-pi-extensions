import type { EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  getConfigPath,
  getStoreRoot,
  loadConfig,
  maxFileSizeBytes,
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
  buildRestorePlan,
  compensatingRestore,
  diffPreview,
  executeFilesystemRestore,
  formatRestoreSummary,
  mutationsForTurns,
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
  const loaded = loadConfig(home ? getConfigPath(home) : undefined);
  const config = loaded.config;
  let runtime: Runtime | undefined;
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

  pi.on("session_tree", async () => {
    // Built-in /tree moves conversation only. Filesystem rollback is /rollback.
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
          "Rollback points (newest first):",
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

      const { plan, transactionId } = executeFilesystemRestore({
        mutations: runtime.journal.mutations(),
        turnIds,
        config: runtime.config,
        store: runtime.store,
        force: parsed.force,
      });
      show(ctx, RESULT_ENTRY, formatRestoreSummary(plan, `/rollback ${parsed.n} --force`).split("\n"));
      const result = await ctx.navigateTree(turn.id, { summarize: false });
      if (result?.cancelled) {
        compensatingRestore(runtime.store, transactionId);
        ctx.ui.notify("pi-rollback: tree navigation was cancelled; filesystem restore was undone.", "warning");
      }
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
