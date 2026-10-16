import assert from "node:assert/strict";
import test from "node:test";
import type { DeadlineClock } from "../src/idle-deadline.ts";
import { formatRemaining, IdleDeadline } from "../src/idle-deadline.ts";

interface FakeClock extends DeadlineClock {
	advance(ms: number): void;
}

function fakeClock(): FakeClock {
	let now = 0;
	const timers: { at: number; cb: () => void }[] = [];
	return {
		now: () => now,
		setTimeout(callback, ms) {
			const timer = { at: now + ms, cb: callback };
			timers.push(timer);
			return timer as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout(handle) {
			const index = timers.indexOf(handle as unknown as { at: number; cb: () => void });
			if (index >= 0) timers.splice(index, 1);
		},
		advance(ms) {
			const target = now + ms;
			for (;;) {
				const next = [...timers].sort((left, right) => left.at - right.at)[0];
				if (!next || next.at > target) break;
				now = next.at;
				timers.splice(timers.indexOf(next), 1);
				next.cb();
			}
			now = target;
		},
	};
}

test("formats the countdown in MM:SS and HH:MM:SS", () => {
	assert.equal(formatRemaining(600_000), "10:00");
	assert.equal(formatRemaining(599_000), "09:59");
	assert.equal(formatRemaining(3_600_000), "01:00:00");
	assert.equal(formatRemaining(0), "00:00");
});

test("fires from the monotonic deadline, not from tick count", () => {
	const clock = fakeClock();
	let fires = 0;
	let ticks = 0;
	const deadline = new IdleDeadline({
		timeoutMs: 5_000,
		tickMs: 10,
		clock,
		onFire: () => {
			fires += 1;
		},
		onChange: () => {
			ticks += 1;
		},
	});
	deadline.start();
	clock.advance(4_999);
	assert.equal(fires, 0);
	assert.ok(ticks > 10);
	clock.advance(1);
	assert.equal(fires, 1);
	clock.advance(10_000);
	assert.equal(fires, 1);
	assert.equal(deadline.state, "fired");
});

test("the first activity lifts the deadline for good", () => {
	const clock = fakeClock();
	let fires = 0;
	const deadline = new IdleDeadline({
		timeoutMs: 5_000,
		tickMs: 1_000,
		clock,
		onFire: () => {
			fires += 1;
		},
	});
	deadline.start();
	clock.advance(3_000);
	deadline.lift();
	assert.equal(deadline.state, "lifted");
	clock.advance(60_000);
	assert.equal(fires, 0);
	deadline.lift();
	assert.equal(deadline.state, "lifted");
});

test("a fired deadline ignores a later activity", () => {
	const clock = fakeClock();
	const deadline = new IdleDeadline({ timeoutMs: 100, tickMs: 1_000, clock, onFire: () => undefined });
	deadline.start();
	clock.advance(100);
	deadline.lift();
	assert.equal(deadline.state, "fired");
});

test("unlimited waits do not create a deadline", () => {
	const clock = fakeClock();
	let fires = 0;
	const deadline = new IdleDeadline({
		timeoutMs: null,
		clock,
		onFire: () => {
			fires += 1;
		},
	});
	deadline.start();
	clock.advance(1_000_000);
	assert.equal(fires, 0);
	assert.equal(deadline.state, "unlimited");
	assert.equal(deadline.hostTimeoutMs(), undefined);
});

test("dispose cancels an armed deadline", () => {
	const clock = fakeClock();
	let fires = 0;
	const deadline = new IdleDeadline({
		timeoutMs: 1_000,
		tickMs: 1_000,
		clock,
		onFire: () => {
			fires += 1;
		},
	});
	deadline.start();
	deadline.dispose();
	clock.advance(5_000);
	assert.equal(fires, 0);
});
