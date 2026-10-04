/**
 * pi-metrics: print one dim metrics line when a run settles and show a live
 * elapsed time in Pi's streaming indicator.
 *
 * A run spans `agent_start` through `agent_settled`, including any tool loops,
 * retries, and queued continuations in between. Nothing is shown per turn or
 * persisted to the session. Non-TUI modes keep their behavior: state is still
 * reset, but the line and the indicator are only driven when the mode is TUI.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { performance } from "node:perf_hooks";
import { loadConfig, type LoadConfigResult } from "../src/config.ts";
import { formatWorkingMessage, renderMetrics } from "../src/format.ts";
import { isAssistantMessage, MetricsTracker } from "../src/metrics.ts";

/** Handle returned by the injected scheduler. */
type TimerHandle = ReturnType<typeof setInterval>;

/** How often the live elapsed time in the working indicator is refreshed. */
const WORKING_TICK_MS = 1_000;

/** Injectable dependencies for tests; production uses the defaults. */
export interface MetricsExtensionDeps {
  /** Monotonic clock for elapsed time and stream windows. */
  now?: () => number;
  /** Configuration loader; defaults to reading the user config file. */
  loadConfig?: () => LoadConfigResult;
  /** Repeating scheduler for the live working indicator; defaults to `setInterval`. */
  setInterval?: (callback: () => void, intervalMs: number) => TimerHandle;
  /** Cancels a handle from {@link MetricsExtensionDeps.setInterval}; defaults to `clearInterval`. */
  clearInterval?: (handle: TimerHandle) => void;
}

/** Register the metrics lifecycle handlers on a Pi extension API. */
export function registerMetrics(pi: ExtensionAPI, deps: MetricsExtensionDeps = {}): void {
  const now = deps.now ?? (() => performance.now());
  const schedule = deps.setInterval ?? setInterval;
  const cancel = deps.clearInterval ?? clearInterval;
  const { config, warning } = (deps.loadConfig ?? (() => loadConfig()))();
  const tracker = new MetricsTracker({ now });

  // Live elapsed time for the streaming indicator. It shares the run's send
  // anchor with the settled `{elapsed}`: `input` records the send and
  // `before_agent_start` fixes it for the run that follows.
  let inputAtMs: number | null = null;
  let promptAtMs: number | null = null;
  let workingTimer: TimerHandle | undefined;
  let workingCtx: ExtensionContext | undefined;

  function updateWorkingMessage(): void {
    const ctx = workingCtx;
    const elapsedMs = tracker.elapsedMs();
    if (!ctx || elapsedMs === null) return;
    ctx.ui.setWorkingMessage(formatWorkingMessage(elapsedMs));
  }

  function startWorking(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    // A continuation or retry emits `agent_start` again; keep a single timer.
    clearWorkingTimer();
    workingCtx = ctx;
    updateWorkingMessage();
    workingTimer = schedule(updateWorkingMessage, WORKING_TICK_MS);
  }

  /** Stop the timer and restore Pi's default working message. */
  function stopWorkingIndicator(): void {
    const ctx = workingCtx;
    clearWorkingTimer();
    ctx?.ui.setWorkingMessage(undefined);
  }

  /** Cancel the pending timer and forget its owner without touching Pi's UI. */
  function clearWorkingTimer(): void {
    if (workingTimer !== undefined) {
      cancel(workingTimer);
      workingTimer = undefined;
    }
    workingCtx = undefined;
  }

  function resetRunTiming(): void {
    inputAtMs = null;
    promptAtMs = null;
  }

  // Surface a broken configuration once, without letting it stop Pi.
  let warningShown = false;
  if (warning !== undefined) {
    pi.on("session_start", (_event, ctx: ExtensionContext) => {
      if (warningShown) return;
      warningShown = true;
      ctx.ui.notify(warning, "warning");
    });
  }

  // The live indicator counts from the prompt's `input`. Recording only while
  // idle keeps a steer or follow-up from restarting the timer.
  pi.on("input", () => {
    if (tracker.elapsedMs() === null) inputAtMs = now();
  });

  // `before_agent_start` fires for a prompt that will actually run, after auth
  // and pre-prompt compaction. It fixes the send time for that run; a prompt it
  // never sees (extension command, rejection, handled input) cannot leak here.
  pi.on("before_agent_start", () => {
    promptAtMs = inputAtMs ?? now();
    inputAtMs = null;
  });

  // Anchor the run at the send time so the live indicator and the settled
  // `{elapsed}` share one origin. A continuation or retry emits `agent_start`
  // again, but `startRun` keeps the original anchor.
  pi.on("agent_start", (_event, ctx: ExtensionContext) => {
    tracker.startRun(promptAtMs ?? now());
    promptAtMs = null;
    startWorking(ctx);
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
    stopWorkingIndicator();
    resetRunTiming();
    const metrics = tracker.finish();
    if (metrics === null || ctx.mode !== "tui") return;
    ctx.ui.notify(renderMetrics(config.format, metrics), "info");
  });

  pi.on("session_start", () => {
    stopWorkingIndicator();
    resetRunTiming();
    tracker.reset();
  });

  pi.on("session_shutdown", () => {
    stopWorkingIndicator();
    resetRunTiming();
    tracker.reset();
  });
}

export default function (pi: ExtensionAPI): void {
  registerMetrics(pi);
}
