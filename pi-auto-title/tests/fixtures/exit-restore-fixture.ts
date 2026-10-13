/**
 * Replays the quit sequence for the exit-time title restore test.
 *
 * Emits `session_start` and `session_shutdown` (quit) against the extension,
 * writes terminal titles to stdout the way the TUI does, then replays Pi's own
 * `π - <dir>` write that follows the shutdown event and exits. The extension's
 * process-exit restore must become the last title write in stdout.
 */

import { writeSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerAutoTitle } from "../../extensions/index.ts";
import { defaultConfig } from "../../src/config.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** Set the terminal title the way Pi's TUI does. */
function setTitle(title: string): void {
	writeSync(1, `\x1b]0;${title}\x07`);
}

const handlers = new Map<string, Handler[]>();

const pi = {
	on(event: string, handler: Handler) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
		return () => {};
	},
	appendEntry() {},
	registerCommand() {},
	registerEntryRenderer() {},
} as unknown as ExtensionAPI;

const ctx = {
	mode: "tui",
	hasUI: true,
	cwd: "/home/user/projects/web-app",
	ui: { setTitle },
	sessionManager: {
		getSessionId: () => "session-1",
		getBranch: () => [],
	},
} as unknown as ExtensionContext;

registerAutoTitle(pi, {
	loadConfig: () => ({ config: defaultConfig() }),
	log: () => {},
});

function emit(event: string, payload: unknown): void {
	for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
}

emit("session_start", { type: "session_start", reason: "startup" });
emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
// Pi writes its own title again while tearing down its UI, after the event.
setTitle("π - web-app");
process.exit(0);
