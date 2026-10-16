import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { isUserActivity, observeTerminalInput } from "./activity.ts";
import { type DeadlinePhase, IdleDeadline } from "./idle-deadline.ts";

export interface WaitPhaseView {
	phase: DeadlinePhase;
	remainingMs: number | null;
}

/**
 * Starts when the questionnaire can accept input. The first real terminal
 * event lifts the deadline for the rest of this call. Rendering the countdown
 * does not, because those updates never enter the terminal listener.
 */
export function createQuestionWait(options: {
	timeoutMs: number | null;
	ctx: ExtensionContext;
	onFire: () => void;
	onChange: () => void;
}): {
	signal: AbortSignal;
	begin(tui?: TUI): void;
	dispose(): void;
	phase(): WaitPhaseView;
	hostTimeoutMs(): number | undefined;
	lift(): void;
} {
	const abort = new AbortController();
	const deadline = new IdleDeadline({
		timeoutMs: options.timeoutMs,
		onFire: () => {
			abort.abort();
			options.onFire();
		},
		onChange: options.onChange,
	});
	let remove: (() => void) | undefined;
	let started = false;
	const note = (data: string) => {
		if (isUserActivity(data)) deadline.lift();
	};
	return {
		signal: abort.signal,
		begin(tui) {
			if (started) return;
			started = true;
			deadline.start();
			if (tui) {
				remove = observeTerminalInput(tui, note);
				return;
			}
			if (typeof options.ctx.ui.onTerminalInput === "function") {
				remove = options.ctx.ui.onTerminalInput((data) => {
					note(data);
					return undefined;
				});
			}
		},
		dispose() {
			deadline.dispose();
			remove?.();
			remove = undefined;
		},
		phase: () => ({ phase: deadline.state, remainingMs: deadline.remainingMs() }),
		hostTimeoutMs: () => deadline.hostTimeoutMs(),
		lift: () => deadline.lift(),
	};
}
