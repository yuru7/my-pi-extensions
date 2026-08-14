import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  loadConfig,
  parseThresholdInput,
  saveConfig,
  type NotifyConfig,
} from "./config.ts";
import {
  formatNotificationMessage,
  NOTIFICATION_TITLE,
  notify,
  shouldNotify,
} from "./notifier.ts";

export interface NotifyRuntime {
  capturePrompt: (prompt: string) => void;
  markStart: () => void;
  onSettled: () => Promise<boolean>;
}

export interface NotifyRuntimeDeps {
  now?: () => number;
  getConfig: () => NotifyConfig;
  notify?: (title: string, message: string, config: NotifyConfig) => Promise<void>;
}

export function createNotifyRuntime(deps: NotifyRuntimeDeps): NotifyRuntime {
  let runStartedAt: number | null = null;
  let prompt: string | null = null;
  const now = deps.now ?? Date.now;
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
      if (!shouldNotify(elapsedSeconds, config.thresholdSeconds)) {
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

export default function (pi: ExtensionAPI) {
  const state = {
    config: loadConfig(),
  };

  const runtime = createNotifyRuntime({
    getConfig: () => state.config,
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

  pi.registerCommand("notify-settings", {
    description: "ネイティブ通知の閾値を設定する",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }

      const current = state.config.thresholdSeconds;
      const input = await ctx.ui.input(
        `Notify Settings — 通知閾値（現在: ${current}秒）。新しい秒数を入力`,
        "0 以上の秒数（0 で常に通知）",
      );

      if (input === undefined) {
        return;
      }

      const parsed = parseThresholdInput(input);
      if (parsed === undefined) {
        ctx.ui.notify(
          "無効な値です。0以上の数値を入力してください。",
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
        ctx.ui.notify("設定ファイルを保存できませんでした。", "error");
        return;
      }
      state.config = next;
      ctx.ui.notify(`通知閾値を ${parsed} 秒に設定しました。`, "info");
    },
  });
}
