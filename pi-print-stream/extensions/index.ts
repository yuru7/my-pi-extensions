import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildChildArgs,
  CHILD_GUARD,
  flagOn,
  isChildGuardSet,
  runChildStream,
  STREAM_FLAG,
  swallowedPrompt,
} from "../src/child.ts";

const STREAM_DESCRIPTION =
  "Stream the turn (thinking, text, tool activity) to stdout as plain text; non-interactive only. Wraps `pi --mode json -p`.";

export default function registerPrintStream(pi: ExtensionAPI): void {
  pi.registerFlag(STREAM_FLAG, {
    description: STREAM_DESCRIPTION,
    type: "boolean",
    default: false,
  });

  // Guard so the prompt is streamed once: the `input` path handles the normal
  // case; the `session_start` path handles the flag-first swallow case where
  // no `input` event ever fires. Whichever runs first claims the turn.
  let handled = false;

  const wrap = async (
    prompt: string,
    swallowed: string | undefined,
  ): Promise<void> => {
    handled = true;
    const childArgs = buildChildArgs(process.argv.slice(2), prompt, swallowed);
    const code = await runChildStream(childArgs);
    if (code !== 0) {
      process.exitCode = code;
    }
  };

  pi.on("input", async (event: { text: string }, ctx: ExtensionContext) => {
    if (isChildGuardSet()) {
      return undefined;
    }
    if (handled) {
      return undefined;
    }
    if (ctx.hasUI) {
      return undefined;
    }
    if (ctx.mode !== "print") {
      return undefined;
    }
    if (!flagOn(pi.getFlag(STREAM_FLAG))) {
      return undefined;
    }

    const swallowed = swallowedPrompt(process.argv.slice(2));
    const prompt =
      event.text && event.text.trim().length > 0
        ? event.text
        : (swallowed ?? "");
    if (!prompt.trim()) {
      return undefined;
    }

    await wrap(prompt, swallowed);
    return { action: "handled" };
  });

  // Flag-first fallback: `pi --stream "prompt"` — Pi's arg parser swallows the
  // prompt into --stream's value, so print mode gets no initial message and no
  // `input` event ever fires. Recover the prompt from argv and drive the
  // child here.
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (isChildGuardSet()) {
      return;
    }
    if (handled) {
      return;
    }
    if (ctx.hasUI) {
      return;
    }
    if (ctx.mode !== "print") {
      return;
    }
    if (!flagOn(pi.getFlag(STREAM_FLAG))) {
      return;
    }

    const swallowed = swallowedPrompt(process.argv.slice(2));
    if (swallowed === undefined || !swallowed.trim()) {
      return;
    }
    await wrap(swallowed, swallowed);
  });
}
