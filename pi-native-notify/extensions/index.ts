import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  loadConfig,
  parseThresholdInput,
  saveConfig,
  type NotifyConfig,
} from "./config.ts";
import { createFocusTracker, type FocusTracker } from "./focus.ts";
import {
  formatNotificationMessage,
  NOTIFICATION_TITLE,
  notify,
  shouldNotify,
} from "./notifier.ts";
import {
  formatNotifyTestReport,
  runNotifyTest,
  type NotifyTestResult,
} from "./notify-test.ts";

export interface NotifyRuntime {
  capturePrompt: (prompt: string) => void;
  markStart: () => void;
  onSettled: () => Promise<boolean>;
}

export interface NotifyRuntimeDeps {
  now?: () => number;
  getConfig: () => NotifyConfig;
  notify?: (title: string, message: string, config: NotifyConfig) => Promise<void>;
  isUnfocused?: () => boolean;
}

export interface NotifyExtensionDeps {
  focusTracker?: FocusTracker;
  runNotifyTest?: (config: NotifyConfig) => Promise<NotifyTestResult>;
}

export function createNotifyRuntime(deps: NotifyRuntimeDeps): NotifyRuntime {
  let runStartedAt: number | null = null;
  let prompt: string | null = null;
  const now = deps.now ?? Date.now;
  const isUnfocused = deps.isUnfocused ?? (() => false);
  const send =
    deps.notify ??
    (async (title, message, config) => {
      await notify(
        { title, message },
        { powershellPath: config.powershellPath },
      );
    });

  return {
    capturePrompt(nextPrompt) {
      if (prompt === null) {
        prompt = nextPrompt;
      }
    },
    markStart() {
      if (runStartedAt === null) {
        runStartedAt = now();
      }
    },
    async onSettled() {
      const startedAt = runStartedAt;
      const capturedPrompt = prompt;
      runStartedAt = null;
      prompt = null;

      if (startedAt === null) {
        return false;
      }

      const elapsedSeconds = (now() - startedAt) / 1000;
      const config = deps.getConfig();
      if (
        !shouldNotify(
          elapsedSeconds,
          config.thresholdSeconds,
          isUnfocused(),
        )
      ) {
        return false;
      }

      try {
        await send(
          NOTIFICATION_TITLE,
          formatNotificationMessage(capturedPrompt ?? ""),
          config,
        );
      } catch {
        // 通知失敗で Agent 処理を失敗させない
      }
      return true;
    },
  };
}

export default function (pi: ExtensionAPI, deps: NotifyExtensionDeps = {}) {
  const state = {
    config: loadConfig(),
  };
  const focus = deps.focusTracker ?? createFocusTracker();

  const runtime = createNotifyRuntime({
    getConfig: () => state.config,
    isUnfocused: () => focus.isUnfocused(),
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      focus.attach();
    }
  });

  pi.on("session_shutdown", async () => {
    focus.detach();
  });

  pi.on("before_agent_start", async (event) => {
    runtime.capturePrompt(event.prompt);
  });

  pi.on("agent_start", async () => {
    runtime.markStart();
  });

  pi.on("agent_settled", async () => {
    try {
      await runtime.onSettled();
    } catch {
      // 通知処理の例外を Pi のイベントループへ漏らさない
    }
  });

  const runTest = deps.runNotifyTest ?? runNotifyTest;

  pi.registerCommand("notify-test", {
    description: "Send a test native notification and show detection details",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }

      try {
        const result = await runTest(state.config);
        ctx.ui.setWidget("pi-native-notify-test", formatNotifyTestReport(result));
        if (result.sent) {
          ctx.ui.notify(
            "Test notification sent. Check the OS notification.",
            "info",
          );
          return;
        }
        if (result.error) {
          ctx.ui.notify(result.error, "error");
          return;
        }
        ctx.ui.notify("No notification backend for this platform.", "warning");
      } catch {
        ctx.ui.notify("Notification test failed.", "error");
      }
    },
  });

  pi.registerCommand("notify-settings", {
    description: "Set the native notification threshold",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }

      const current = state.config.thresholdSeconds;
      const input = await ctx.ui.input(
        `Notify Settings — threshold (current: ${current}s). Enter a new value in seconds`,
        "Seconds (0 or greater; 0 notifies always)",
      );

      if (input === undefined) {
        return;
      }

      const parsed = parseThresholdInput(input);
      if (parsed === undefined) {
        ctx.ui.notify(
          "Invalid value. Enter a number of 0 or greater.",
          "error",
        );
        return;
      }

      const next = {
        ...state.config,
        thresholdSeconds: parsed,
      };
      try {
        saveConfig(next);
      } catch {
        ctx.ui.notify("Could not save the config file.", "error");
        return;
      }
      state.config = next;
      ctx.ui.notify(`Notification threshold set to ${parsed} seconds.`, "info");
    },
  });
}
