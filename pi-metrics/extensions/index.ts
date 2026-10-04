/**
 * pi-metrics: print one dim metrics line when a run settles.
 *
 * A run spans `agent_start` through `agent_settled`, including any tool loops,
 * retries, and queued continuations in between. Nothing is shown per turn or
 * persisted to the session. Non-TUI modes keep their behavior: state is still
 * reset, but the line is only rendered when `ctx.mode === "tui"`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type LoadConfigResult } from "../src/config.ts";
import { renderMetrics } from "../src/format.ts";
import { isAssistantMessage, MetricsTracker } from "../src/metrics.ts";

/** Injectable dependencies for tests; production uses the defaults. */
export interface MetricsExtensionDeps {
  /** Monotonic clock for elapsed time and stream windows. */
  now?: () => number;
  /** Configuration loader; defaults to reading the user config file. */
  loadConfig?: () => LoadConfigResult;
}

/** Register the metrics lifecycle handlers on a Pi extension API. */
export function registerMetrics(pi: ExtensionAPI, deps: MetricsExtensionDeps = {}): void {
  const { config, warning } = (deps.loadConfig ?? (() => loadConfig()))();
  const tracker = new MetricsTracker({ now: deps.now });

  // Surface a broken configuration once, without letting it stop Pi.
  let warningShown = false;
  if (warning !== undefined) {
    pi.on("session_start", (_event, ctx: ExtensionContext) => {
      if (warningShown) return;
      warningShown = true;
      ctx.ui.notify(warning, "warning");
    });
  }

  // A run is measured from `agent_start`, the first event guaranteed to be
  // followed by `agent_settled`. Starting here means a prompt that never becomes
  // a run (rejected auth, another extension handling it) leaves nothing behind.
  pi.on("agent_start", () => {
    tracker.startRun();
  });

  pi.on("turn_start", () => {
    tracker.startTurn();
  });

  pi.on("message_start", (event) => {
    if (isAssistantMessage(event.message)) tracker.startMessage();
  });

  pi.on("message_update", (event) => {
    if (!isAssistantMessage(event.message)) return;
    // `message_update` also carries empty block start/end events and empty
    // deltas; only a non-empty token delta sets TTFT or widens the TPS window.
    const streamEvent = event.assistantMessageEvent;
    switch (streamEvent.type) {
      case "text_delta":
      case "thinking_delta":
      case "toolcall_delta":
        if (streamEvent.delta.length > 0) tracker.recordUpdate();
        break;
    }
  });

  // Tokens are taken from the finalized message once, never from stream updates.
  pi.on("message_end", (event) => {
    if (isAssistantMessage(event.message)) tracker.recordAssistantMessage(event.message);
  });

  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    const metrics = tracker.finish();
    if (metrics === null || ctx.mode !== "tui") return;
    ctx.ui.notify(renderMetrics(config.format, metrics), "info");
  });

  pi.on("session_start", () => {
    tracker.reset();
  });

  pi.on("session_shutdown", () => {
    tracker.reset();
  });
}

export default function (pi: ExtensionAPI): void {
  registerMetrics(pi);
}
