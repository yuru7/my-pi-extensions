export type DeadlinePhase = "armed" | "lifted" | "unlimited" | "fired";

export interface DeadlineClock {
	now(): number;
	setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export const systemClock: DeadlineClock = {
	now: () => performance.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle),
};

export interface IdleDeadlineOptions {
	/** Positive milliseconds, or `null` for no limit. */
	timeoutMs: number | null;
	onFire: () => void;
	onChange?: () => void;
	clock?: DeadlineClock;
	/** Display refresh while armed. The deadline itself does not depend on this interval. */
	tickMs?: number;
}

/**
 * One questionnaire's idle limit. The deadline is an absolute monotonic
 * timestamp. Display ticks never decide expiry, and the first terminal
 * transition (user activity, or the deadline) sticks for the rest of the wait.
 */
export class IdleDeadline {
	readonly phaseStart: DeadlinePhase;
	private phase: DeadlinePhase;
	private readonly deadlineAt: number | null;
	private readonly onFire: () => void;
	private readonly onChange: (() => void) | undefined;
	private readonly clock: DeadlineClock;
	private readonly tickMs: number;
	private firedCallback = false;
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	private tickTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: IdleDeadlineOptions) {
		this.onFire = options.onFire;
		this.onChange = options.onChange;
		this.clock = options.clock ?? systemClock;
		this.tickMs = options.tickMs ?? 1000;
		if (options.timeoutMs === null) {
			this.phase = "unlimited";
			this.deadlineAt = null;
		} else {
			this.phase = "armed";
			this.deadlineAt = this.clock.now() + options.timeoutMs;
		}
		this.phaseStart = this.phase;
	}

	get state(): DeadlinePhase {
		return this.phase;
	}

	remainingMs(now = this.clock.now()): number | null {
		if (this.phase !== "armed" || this.deadlineAt === null) return null;
		return Math.max(0, this.deadlineAt - now);
	}

	/** Host dialogs should not receive a timeout once the limit is gone. */
	hostTimeoutMs(now = this.clock.now()): number | undefined {
		const remaining = this.remainingMs(now);
		if (remaining === null) return undefined;
		return Math.max(1, Math.ceil(remaining));
	}

	start(): void {
		if (this.phase !== "armed" || this.deadlineTimer !== undefined) return;
		this.scheduleDeadline();
		this.scheduleTick();
	}

	/** User activity. Does nothing after the deadline has already fired. */
	lift(): void {
		if (this.phase !== "armed") return;
		this.phase = "lifted";
		this.clearTimers();
		this.onChange?.();
	}

	dispose(): void {
		this.clearTimers();
		if (this.phase === "armed") this.phase = "lifted";
	}

	private scheduleDeadline(): void {
		const remaining = this.remainingMs();
		if (remaining === null) return;
		this.deadlineTimer = this.clock.setTimeout(() => this.expire(), Math.max(0, remaining));
	}

	private scheduleTick(): void {
		this.tickTimer = this.clock.setTimeout(() => {
			this.tickTimer = undefined;
			if (this.phase !== "armed") return;
			this.onChange?.();
			this.scheduleTick();
		}, this.tickMs);
	}

	private expire(): void {
		this.deadlineTimer = undefined;
		if (this.phase !== "armed" || this.deadlineAt === null) return;
		const remaining = this.deadlineAt - this.clock.now();
		if (remaining > 1) {
			this.scheduleDeadline();
			return;
		}
		this.phase = "fired";
		this.clearTimers();
		if (this.firedCallback) return;
		this.firedCallback = true;
		this.onFire();
	}

	private clearTimers(): void {
		if (this.deadlineTimer !== undefined) this.clock.clearTimeout(this.deadlineTimer);
		if (this.tickTimer !== undefined) this.clock.clearTimeout(this.tickTimer);
		this.deadlineTimer = undefined;
		this.tickTimer = undefined;
	}
}

export function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const mm = String(minutes).padStart(2, "0");
	const ss = String(seconds).padStart(2, "0");
	if (hours > 0) return `${String(hours).padStart(2, "0")}:${mm}:${ss}`;
	return `${mm}:${ss}`;
}

export function isUrgent(remainingMs: number | null): boolean {
	return remainingMs !== null && remainingMs <= 60_000;
}
