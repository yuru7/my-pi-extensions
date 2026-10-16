import assert from "node:assert/strict";
import test from "node:test";
import { isUserActivity, isWheelSequence } from "../src/activity.ts";

test("keys and wheel sequences are user activity", () => {
	assert.equal(isUserActivity("\x1b[A"), true);
	assert.equal(isUserActivity("a"), true);
	assert.equal(isUserActivity("\x1b[5~"), true);
	assert.equal(isWheelSequence("\x1b[<64;10;20M"), true);
	assert.equal(isUserActivity("\x1b[<64;10;20M"), true);
	assert.equal(isWheelSequence("\x1b[<0;1;1M"), false);
});

test("focus reports and device replies are not activity", () => {
	assert.equal(isUserActivity(""), false);
	assert.equal(isUserActivity("\x1b[I"), false);
	assert.equal(isUserActivity("\x1b[O"), false);
	assert.equal(isUserActivity("\x1b[?1;2c"), false);
});
