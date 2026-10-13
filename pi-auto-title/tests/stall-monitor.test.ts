import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { StallMonitor } from "../src/stall-monitor.ts";
import { createStallClock, type StallClock } from "./helpers.ts";

/** Default threshold used by most tests, in seconds. */
const THRESHOLD_SECONDS = 30;
const THRESHOLD_MS = THRESHOLD_SECONDS * 1_000;

function createMonitor(
	clock: StallClock,
	options: {
		thresholdMs?: () => number;
		onStalledChange?: (stalled: boolean) => void;
	} = {},
): StallMonitor {
	return new StallMonitor({
		thresholdMs: options.thresholdMs ?? (() => THRESHOLD_MS),
		now: clock.now,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		onStalledChange: options.onStalledChange,
	});
}

describe("StallMonitor", () => {
	test("a tool below the threshold is not stalled and arms one timer", () => {
		const clock = createStallClock();
		const monitor = createMonitor(clock);
		monitor.start("t1", "bash");
		clock.advance(THRESHOLD_MS - 1);
		assert.equal(monitor.stalled, false);
		assert.equal(clock.pendingCount(), 1);
	});

	test("a tool silent for the threshold becomes stalled", () => {
		const clock = createStallClock();
		const changes: boolean[] = [];
		const monitor = createMonitor(clock, {
			onStalledChange: (stalled) => changes.push(stalled),
		});
		monitor.start("t1", "bash");
		clock.advance(THRESHOLD_MS);
		assert.equal(monitor.stalled, true);
		assert.deepEqual(changes, [true]);
		// A stalled tool keeps no timer until an update or end arrives.
		assert.equal(clock.pendingCount(), 0);
	});

	test("an update resets the silence clock", () => {
		const clock = createStallClock();
		const monitor = createMonitor(clock);
		monitor.start("t1", "bash");
		clock.advance(20_000);
		monitor.update("t1");
		clock.advance(THRESHOLD_MS - 1);
		assert.equal(monitor.stalled, false);
		clock.advance(1);
		assert.equal(monitor.stalled, true);
	});

	test("an update recovers a stalled tool to running", () => {
		const clock = createStallClock();
		const changes: boolean[] = [];
		const monitor = createMonitor(clock, {
			onStalledChange: (stalled) => changes.push(stalled),
		});
		monitor.start("t1", "bash");
		clock.advance(THRESHOLD_MS);
		monitor.update("t1");
		assert.equal(monitor.stalled, false);
		assert.deepEqual(changes, [true, false]);
		// The recovered tool is watched again on a fresh deadline.
		clock.advance(THRESHOLD_MS);
		assert.equal(monitor.stalled, true);
		assert.deepEqual(changes, [true, false, true]);
	});

	test("an end removes the tool and stops watching", () => {
		const clock = createStallClock();
		const changes: boolean[] = [];
		const monitor = createMonitor(clock, {
			onStalledChange: (stalled) => changes.push(stalled),
		});
		monitor.start("t1", "bash");
		clock.advance(THRESHOLD_MS);
		monitor.end("t1");
		assert.equal(monitor.stalled, false);
		assert.deepEqual(changes, [true, false]);
		assert.equal(clock.pendingCount(), 0);
		clock.advance(10 * THRESHOLD_MS);
		assert.equal(monitor.stalled, false);
	});

	test("an error ending is treated like a normal ending", () => {
		const clock = createStallClock();
		const monitor = createMonitor(clock);
		monitor.start("t1", "bash");
		clock.advance(THRESHOLD_MS);
		// The end event carries the outcome; the monitor only needs the id.
		monitor.end("t1");
		assert.equal(monitor.stalled, false);
		assert.equal(clock.pendingCount(), 0);
	});

	test("updates and ends for unknown ids are ignored", () => {
		const clock = createStallClock();
		const monitor = createMonitor(clock);
		monitor.update("ghost");
		monitor.end("ghost");
		assert.equal(monitor.stalled, false);
		assert.equal(clock.pendingCount(), 0);
	});

	test("a duplicate start restarts the watch", () => {
		const clock = createStallClock();
		const monitor = createMonitor(clock);
		monitor.start("t1", "bash");
		clock.advance(20_000);
		monitor.start("t1", "bash");
		clock.advance(THRESHOLD_MS - 1);
		assert.equal(monitor.stalled, false);
		clock.advance(1);
		assert.equal(monitor.stalled, true);
	});

	test("parallel tools are judged independently", () => {
		const clock = createStallClock();
		const monitor = createMonitor(clock);
		monitor.start("a", "bash");
		clock.advance(20_000);
		monitor.start("b", "read");
		// Tool a stalls while b is still fresh.
		clock.advance(10_000);
		assert.equal(monitor.stalled, true);
		// A b update does not clear a's stalled state.
		monitor.update("b");
		assert.equal(monitor.stalled, true);
		// Once a ends, b (not stalled) brings the overall state back.
		monitor.end("a");
		assert.equal(monitor.stalled, false);
		assert.equal(clock.pendingCount(), 1);
	});

	test("the timer targets the earliest deadline and stays single", () => {
		const clock = createStallClock();
		const monitor = createMonitor(clock);
		monitor.start("a", "bash");
		clock.advance(10_000);
		monitor.start("b", "read");
		assert.equal(clock.pendingCount(), 1);
		// At 30s a reaches the threshold while b (started at 10s) does not.
		clock.advance(20_000);
		assert.equal(monitor.stalled, true);
		// b's later deadline stays armed, still as a single timer.
		assert.equal(clock.pendingCount(), 1);
		// Once a ends, b (not stalled) brings the overall state back.
		monitor.end("a");
		assert.equal(monitor.stalled, false);
	});

	test("a rescheduled timer replaces the previous deadline", () => {
		const clock = createStallClock();
		const monitor = createMonitor(clock);
		monitor.start("t1", "bash");
		clock.advance(10_000);
		monitor.update("t1");
		// The update moved the deadline to 40s on the clock.
		clock.advance(THRESHOLD_MS - 10_000);
		assert.equal(monitor.stalled, false);
		clock.advance(10_000);
		assert.equal(monitor.stalled, true);
	});

	test("clear drops the watches and the timer, and stale timers are inert", () => {
		const clock = createStallClock();
		const changes: boolean[] = [];
		const monitor = createMonitor(clock, {
			onStalledChange: (stalled) => changes.push(stalled),
		});
		monitor.start("t1", "bash");
		clock.advance(20_000);
		monitor.clear();
		assert.equal(monitor.stalled, false);
		assert.equal(clock.pendingCount(), 0);
		clock.advance(THRESHOLD_MS);
		assert.equal(monitor.stalled, false);
		assert.deepEqual(changes, []);
	});

	test("clear while stalled reports the recovery once", () => {
		const clock = createStallClock();
		const changes: boolean[] = [];
		const monitor = createMonitor(clock, {
			onStalledChange: (stalled) => changes.push(stalled),
		});
		monitor.start("t1", "bash");
		clock.advance(THRESHOLD_MS);
		monitor.clear();
		assert.deepEqual(changes, [true, false]);
	});

	test("a threshold change applies on the next refresh", () => {
		const clock = createStallClock();
		let thresholdMs = THRESHOLD_MS;
		const monitor = createMonitor(clock, {
			thresholdMs: () => thresholdMs,
		});
		monitor.start("t1", "bash");
		clock.advance(15_000);
		thresholdMs = 10_000;
		monitor.refresh();
		clock.advance(5_000);
		assert.equal(monitor.stalled, true);
	});

	test("a raised threshold recovers a stalled tool on refresh", () => {
		const clock = createStallClock();
		const changes: boolean[] = [];
		let thresholdMs = 5_000;
		const monitor = createMonitor(clock, {
			thresholdMs: () => thresholdMs,
			onStalledChange: (stalled) => changes.push(stalled),
		});
		monitor.start("t1", "bash");
		clock.advance(5_000);
		assert.equal(monitor.stalled, true);
		// Raising the threshold makes the same silence shorter than it.
		thresholdMs = THRESHOLD_MS;
		monitor.refresh();
		assert.equal(monitor.stalled, false);
		assert.deepEqual(changes, [true, false]);
		// The deadline is re-armed for the remaining silence.
		clock.advance(THRESHOLD_MS - 5_000 - 1);
		assert.equal(monitor.stalled, false);
		clock.advance(1);
		assert.equal(monitor.stalled, true);
	});

	test("cancellations go through the injected clearTimeout", () => {
		const scheduled: { callback: () => void }[] = [];
		const cancelled: unknown[] = [];
		let now = 0;
		const monitor = new StallMonitor({
			thresholdMs: () => THRESHOLD_MS,
			now: () => now,
			setTimeout: (callback) => {
				const timer = { callback };
				scheduled.push(timer);
				return timer;
			},
			clearTimeout: (handle) => {
				cancelled.push(handle);
			},
		});
		monitor.start("t1", "bash");
		monitor.end("t1");
		assert.equal(scheduled.length, 1);
		assert.deepEqual(cancelled, [scheduled[0]]);
	});

	test("a stale callback forced after clear cannot act", () => {
		const clock = createStallClock();
		const changes: boolean[] = [];
		const monitor = createMonitor(clock, {
			onStalledChange: (stalled) => changes.push(stalled),
		});
		monitor.start("t1", "bash");
		clock.advance(20_000);
		monitor.clear();
		// A real timer cannot be un-fired; the callback must guard itself.
		clock.forceRunAll();
		clock.advance(THRESHOLD_MS);
		assert.equal(monitor.stalled, false);
		assert.deepEqual(changes, []);
	});

	test("a stale callback forced after a reschedule cannot act", () => {
		const clock = createStallClock();
		const monitor = createMonitor(clock);
		monitor.start("t1", "bash");
		clock.advance(10_000);
		monitor.update("t1");
		// The cancelled 30s callback fires anyway; the deadline is now 40s.
		clock.forceRunAll();
		clock.advance(THRESHOLD_MS - 10_000);
		assert.equal(monitor.stalled, false);
		clock.advance(10_000);
		assert.equal(monitor.stalled, true);
	});

	test("a huge threshold does not exceed the timer delay limit", () => {
		const clock = createStallClock();
		const monitor = createMonitor(clock, {
			thresholdMs: () => Number.MAX_SAFE_INTEGER,
		});
		monitor.start("t1", "bash");
		assert.equal(clock.pendingCount(), 1);
		assert.equal(monitor.stalled, false);
	});

	test("a fresh monitor arms no timer", () => {
		const clock = createStallClock();
		const monitor = createMonitor(clock);
		assert.equal(monitor.stalled, false);
		assert.equal(clock.pendingCount(), 0);
	});
});
