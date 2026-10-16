import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getRuntimeCompleteSimple, loadCompleteSimple } from "../src/pi-compat.ts";

describe("pi-ai compatibility", () => {
	test("resolves completeSimple from the installed host package", async () => {
		const completeSimple = await loadCompleteSimple();
		assert.equal(typeof completeSimple, "function");
	});

	test("binds the registry runtime method and ignores a missing one", () => {
		assert.equal(getRuntimeCompleteSimple(null), undefined);
		assert.equal(getRuntimeCompleteSimple({}), undefined);
		const runtime = {
			label: "bound",
			completeSimple(this: { label: string }) {
				return this.label;
			},
		};
		const completeSimple = getRuntimeCompleteSimple({ runtime });
		assert.equal(completeSimple?.({} as never, {} as never), "bound");
	});
});
