import { Renderer } from "./renderer.ts";
import { RunStats, type UsageLike } from "./stats.ts";

export interface ProcessorOptions {
  now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parse one JSONL line without ever throwing. */
export function parseJsonLine(line: string):
  | { ok: true; event: unknown }
  | { ok: false; error: string } {
  try {
    return { ok: true, event: JSON.parse(line) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { ok: false, error: message };
  }
}

/**
 * Maps Pi `--mode json` events onto the renderer and stats.
 *
 * Only the events needed for streaming display are handled; everything else
 * is ignored so future Pi event additions cannot break the output.
 */
export class StreamProcessor {
  private readonly renderer: Renderer;
  private readonly stats: RunStats;
  private readonly toolStartedAt = new Map<string, number>();
  private readonly now: () => number;
  private assistantError = false;

  constructor(renderer: Renderer, stats: RunStats, options: ProcessorOptions = {}) {
    this.renderer = renderer;
    this.stats = stats;
    this.now = options.now ?? (() => performance.now());
  }

  hasError(): boolean {
    return this.assistantError;
  }

  handle(event: unknown): void {
    const record = asRecord(event);
    if (!record) {
      return;
    }
    const type = asString(record.type);
    if (!type) {
      return;
    }
    switch (type) {
      case "message_start": {
        const message = asRecord(record.message);
        const role = message ? asString(message.role) : undefined;
        if (role === undefined || role === "assistant") {
          this.stats.startGeneration();
        }
        // Tool-only message boundaries must not drop the thinking session;
        // it survives until answer text takes over.
        break;
      }
      case "message_update": {
        this.handleMessageUpdate(asRecord(record.assistantMessageEvent));
        break;
      }
      case "tool_execution_start": {
        const toolCallId = asString(record.toolCallId) ?? "";
        const toolName = asString(record.toolName) ?? "unknown";
        if (toolCallId) {
          this.toolStartedAt.set(toolCallId, this.now());
        }
        this.renderer.writeToolEvent({
          type: "tool_start",
          id: toolCallId,
          name: toolName,
          args: record.args,
        });
        break;
      }
      case "tool_execution_end": {
        const toolCallId = asString(record.toolCallId) ?? "";
        const toolName = asString(record.toolName) ?? "unknown";
        const startedAt = toolCallId
          ? this.toolStartedAt.get(toolCallId)
          : undefined;
        if (toolCallId) {
          this.toolStartedAt.delete(toolCallId);
        }
        const elapsedMs =
          startedAt === undefined
            ? 0
            : Math.max(0, Math.round(this.now() - startedAt));
        this.renderer.writeToolEvent({
          type: "tool_end",
          id: toolCallId,
          name: toolName,
          status: record.isError === true ? "error" : "success",
          elapsed_ms: elapsedMs,
        });
        break;
      }
      case "message_end": {
        const message = asRecord(record.message);
        const role = message ? asString(message.role) : undefined;
        if (role === "assistant" || role === undefined) {
          const usage = message
            ? (message.usage as UsageLike | undefined)
            : undefined;
          this.stats.endGeneration(usage);
          if (message && message.stopReason === "error") {
            this.assistantError = true;
          }
        }
        // Same as message_start: only answer text ends the thinking
        // session, so tool-only boundaries leave the view intact.
        break;
      }
      default: {
        break;
      }
    }
  }

  private handleMessageUpdate(assistantEvent: Record<string, unknown> | undefined): void {
    if (!assistantEvent) {
      return;
    }
    const type = asString(assistantEvent.type);
    switch (type) {
      case "text_start": {
        this.renderer.clearThinking();
        break;
      }
      case "text_delta": {
        const delta = asString(assistantEvent.delta) ?? "";
        this.renderer.writeText(delta);
        break;
      }
      case "thinking_delta": {
        const delta = asString(assistantEvent.delta) ?? "";
        this.renderer.appendThinking(delta);
        break;
      }
      case "thinking_start":
      case "thinking_end":
      case "text_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
      case "start":
      case "done":
      case "error": {
        break;
      }
      default: {
        break;
      }
    }
  }

  /** Close an open generation interval (abort / signal paths). */
  abortGeneration(): void {
    this.stats.abortGeneration();
  }
}
