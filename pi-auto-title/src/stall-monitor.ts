/**
 * Inactivity-based stall detection for running tools.
 *
 * Every tool execution is registered as a watch keyed by its `toolCallId`; an
 * update refreshes the watch's last-activity time and an end removes it. A
 * watch is stalled once it has been silent for at least the configured
 * threshold. One one-shot timer is kept armed for the earliest outstanding
 * deadline; it is cancelled and re-armed whenever the watches change, and
 * dropped entirely when nothing is left to wait for. Stalled watches stay
 * stalled — and keep no timer — until an update or end arrives for them.
 *
 * The clock and the timer pair are injectable so tests can drive time by hand;
 * the defaults use the monotonic `performance.now` and `setTimeout`.
 */

export type NowFn = () => number;
export type ScheduleTimer = (callback: () => void, delayMs: number) => unknown;
export type CancelTimer = (handle: unknown) => void;

/** Watch state for one in-flight tool execution. */
export interface ToolWatch {
	toolCallId: string;
	toolName: string;
	lastActivityAt: number;
	stalled: boolean;
}

export interface StallMonitorDeps {
	/**
	 * Threshold getter, re-read on every evaluation so a config change applies
	 * on the next refresh instead of leaving a stale deadline armed.
	 */
	thresholdMs: () => number;
	/** Clock; defaults to `performance.now`. */
	now?: NowFn;
	/** One-shot timer scheduler; defaults to `setTimeout`. */
	setTimeout?: ScheduleTimer;
	/** Cancels a handle from `setTimeout`; defaults to `clearTimeout`. */
	clearTimeout?: CancelTimer;
	/** Notified whenever the any-watched-tool-stalled flag changes. */
	onStalledChange?: (stalled: boolean) => void;
}

/** Node clamps timer delays below 2^31 ms; longer waits re-arm from the fired timer. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const defaultNow: NowFn = () => performance.now();
const defaultSchedule: ScheduleTimer = (callback, delayMs) =>
	setTimeout(callback, delayMs);
const defaultCancel: CancelTimer = (handle) => {
	clearTimeout(handle as ReturnType<typeof setTimeout>);
};

export class StallMonitor {
	#thresholdMs: () => number;
	#now: NowFn;
	#schedule: ScheduleTimer;
	#cancel: CancelTimer;
	#onStalledChange: ((stalled: boolean) => void) | undefined;
	#watches = new Map<string, ToolWatch>();
	#timer: unknown;
	#timerGeneration = 0;
	#anyStalled = false;

	constructor(deps: StallMonitorDeps) {
		this.#thresholdMs = deps.thresholdMs;
		this.#now = deps.now ?? defaultNow;
		this.#schedule = deps.setTimeout ?? defaultSchedule;
		this.#cancel = deps.clearTimeout ?? defaultCancel;
		this.#onStalledChange = deps.onStalledChange;
	}

	/** Whether any watched tool is currently stalled. */
	get stalled(): boolean {
		return this.#anyStalled;
	}

	/**
	 * Register a tool execution as watched; its silence clock starts now.
	 *
	 * A duplicate `toolCallId` restarts the watch, treating the second start as
	 * fresh activity.
	 */
	start(toolCallId: string, toolName: string): void {
		this.#watches.set(toolCallId, {
			toolCallId,
			toolName,
			lastActivityAt: this.#now(),
			stalled: false,
		});
		this.#refresh();
	}

	/**
	 * Record progress on a tool: resets its silence clock and recovers it from
	 * stalled, no matter whether the progress content differs from before.
	 * Unknown ids are ignored — late events for an ended or cleared tool must
	 * not create state.
	 */
	update(toolCallId: string): void {
		const watch = this.#watches.get(toolCallId);
		if (watch === undefined) return;
		watch.lastActivityAt = this.#now();
		watch.stalled = false;
		this.#refresh();
	}

	/**
	 * Remove a finished tool, whether it ended normally or with an error. A
	 * stalled flag on the other watches survives this, so one stalled tool
	 * keeps the overall state stalled until it is also done or updated.
	 */
	end(toolCallId: string): void {
		if (!this.#watches.delete(toolCallId)) return;
		this.#refresh();
	}

	/**
	 * Drop every watch and cancel the timer.
	 *
	 * Timer callbacks are generation-guarded, so one scheduled before a cancel
	 * or reschedule can no longer act; late update/end events for removed tools
	 * are ignored by the map lookup.
	 */
	clear(): void {
		this.#watches.clear();
		this.#cancelTimer();
		this.#setAnyStalled(false);
	}

	/** Re-evaluate every watch against the current threshold and re-arm the timer. */
	refresh(): void {
		this.#refresh();
	}

	#cancelTimer(): void {
		this.#timerGeneration += 1;
		if (this.#timer !== undefined) {
			this.#cancel(this.#timer);
			this.#timer = undefined;
		}
	}
	#setAnyStalled(stalled: boolean): void {
		if (this.#anyStalled === stalled) return;
		this.#anyStalled = stalled;
		this.#onStalledChange?.(stalled);
	}

	/**
	 * Re-judge every watch against the current threshold — stalled ones too, so
	 * a raised threshold (a config reset, say) recovers a tool whose silence no
	 * longer exceeds it — and arm the timer for the next deadline.
	 */
	#refresh(): void {
		const now = this.#now();
		const thresholdMs = this.#thresholdMs();
		for (const watch of this.#watches.values()) {
			watch.stalled = now - watch.lastActivityAt >= thresholdMs;
		}
		let anyStalled = false;
		let earliest: number | undefined;
		for (const watch of this.#watches.values()) {
			if (watch.stalled) {
				anyStalled = true;
				continue;
			}
			const deadline = watch.lastActivityAt + thresholdMs;
			if (earliest === undefined || deadline < earliest) earliest = deadline;
		}
		this.#setAnyStalled(anyStalled);

		this.#cancelTimer();
		if (earliest === undefined) return;
		const delayMs = Math.min(Math.max(earliest - now, 0), MAX_TIMER_DELAY_MS);
		const generation = this.#timerGeneration;
		this.#timer = this.#schedule(() => {
			if (generation !== this.#timerGeneration) return;
			this.#timer = undefined;
			this.#refresh();
		}, delayMs);
	}
}
