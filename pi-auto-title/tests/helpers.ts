/** Shared fakes for pi-auto-title tests. */

import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StopReason,
} from "@earendil-works/pi-ai";
import type { AiClient, CompleteOptions } from "../src/generator.ts";

export function fakeModel(
	provider: string,
	id: string,
	reasoning = false,
): Model<Api> {
	return { provider, id, reasoning } as unknown as Model<Api>;
}

export function assistant(
	text: string,
	stopReason: StopReason = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: text === "" ? [] : [{ type: "text", text }],
		stopReason,
		errorMessage: stopReason === "error" ? "boom" : undefined,
	} as unknown as AssistantMessage;
}

export interface RecordedCall {
	model: Model<Api>;
	context: Context;
	options: CompleteOptions;
}

export type Responder = (
	call: RecordedCall,
) => Promise<AssistantMessage> | AssistantMessage;

export interface RecordingClient {
	client: AiClient;
	calls: RecordedCall[];
}

/** AI client that records every request and answers from a queue of responders. */
export function recordingClient(responders: Responder[]): RecordingClient {
	const calls: RecordedCall[] = [];
	const client: AiClient = {
		complete(model, context, options) {
			const call = { model, context, options };
			calls.push(call);
			const responder = responders.shift();
			if (responder === undefined)
				return Promise.reject(new Error("unexpected AI request"));
			return Promise.resolve(responder(call));
		},
	};
	return { client, calls };
}

/** Await pending microtasks and immediate callbacks. */
export function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

interface StallFakeTimer {
	at: number;
	callback: () => void;
	isCancelled: boolean;
}

/**
 * Manual clock and timer queue for deadline-driven logic (stall detection), so
 * tests move time by hand instead of waiting. Due timers fire in deadline
 * order, including ones scheduled while a callback runs. Cancellations are
 * counted, and cancelled callbacks can be force-run to prove generation guards.
 */
export function createStallClock() {
	let now = 0;
	const timers: StallFakeTimer[] = [];
	let cancels = 0;
	return {
		now: (): number => now,
		setTimeout(callback: () => void, delayMs: number): unknown {
			const timer: StallFakeTimer = {
				at: now + delayMs,
				callback,
				isCancelled: false,
			};
			timers.push(timer);
			return timer;
		},
		clearTimeout(handle: unknown): void {
			cancels += 1;
			(handle as StallFakeTimer).isCancelled = true;
		},
		/** Advance the clock and fire every timer that has come due. */
		advance(ms: number): void {
			now += ms;
			for (;;) {
				const due = timers
					.filter((timer) => !timer.isCancelled && timer.at <= now)
					.sort((a, b) => a.at - b.at)[0];
				if (due === undefined) return;
				due.isCancelled = true;
				due.callback();
			}
		},
		/** Run every callback scheduled so far, including cancelled ones (a real timer cannot be un-fired). */
		forceRunAll(): void {
			for (const timer of [...timers]) timer.callback();
		},
		/** Number of timers still armed. */
		pendingCount(): number {
			return timers.filter((timer) => !timer.isCancelled).length;
		},
		/** Number of cancel calls routed to this clock. */
		cancelCount(): number {
			return cancels;
		},
	};
}

export type StallClock = ReturnType<typeof createStallClock>;
