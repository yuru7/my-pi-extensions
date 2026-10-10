import { afterEach, describe, expect, it } from "vitest";
import {
	DENIAL_TTL_MS,
	type DenialRecord,
	getDenialLedger,
	operationFingerprint,
	resetDenialLedgerForTests,
} from "../src/denial-ledger";

afterEach(() => {
	resetDenialLedgerForTests();
});

function entry(overrides: Partial<DenialRecord> = {}): DenialRecord {
	const params = overrides.fingerprint === undefined ? { command: "echo hi" } : {};
	return {
		sessionId: "s1",
		tool: "bash",
		fingerprint: operationFingerprint(params),
		cwd: "/work",
		workspace: "/work",
		sandboxMode: "workspace-write",
		backend: "bwrap",
		target: "echo hi",
		writablePaths: ["/work"],
		recordedAt: 1_000,
		...overrides,
	};
}

function matchOf(record: DenialRecord) {
	return {
		sessionId: record.sessionId,
		tool: record.tool,
		fingerprint: record.fingerprint,
		cwd: record.cwd,
	};
}

describe("getDenialLedger", () => {
	it("globalThis singleton: repeated calls return the same object, and reset replaces it", () => {
		const first = getDenialLedger();
		expect(getDenialLedger()).toBe(first);
		resetDenialLedgerForTests();
		expect(getDenialLedger()).not.toBe(first);
	});
});

describe("record/consume (same operation, one-shot)", () => {
	it("nothing recorded → consume returns undefined", () => {
		expect(getDenialLedger().consume(matchOf(entry()))).toBeUndefined();
	});

	it("after record, consume returns that record, and only once", () => {
		const ledger = getDenialLedger();
		const recorded = entry();
		ledger.record(recorded);
		expect(ledger.consume(matchOf(recorded), 1_000)).toEqual(recorded);
		expect(ledger.consume(matchOf(recorded), 1_000)).toBeUndefined();
	});

	it("tool isolation: a bash denial does not authorize powershell", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ tool: "bash" });
		ledger.record(recorded);
		expect(ledger.consume({ ...matchOf(recorded), tool: "powershell" }, 1_000)).toBeUndefined();
		expect(ledger.consume(matchOf(recorded), 1_000)).toEqual(recorded);
	});

	it("operation isolation: another command's fingerprint does not match", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ fingerprint: operationFingerprint({ command: "echo a" }) });
		ledger.record(recorded);
		expect(ledger.consume({
			...matchOf(recorded),
			fingerprint: operationFingerprint({ command: "echo b" }),
		}, 1_000)).toBeUndefined();
	});

	it("escalation fields are not part of the fingerprint", () => {
		const plain = operationFingerprint({ command: "pnpm install", sandbox_permissions: "danger-full-access", justification: "store" });
		const bare = operationFingerprint({ command: "pnpm install" });
		expect(plain).toBe(bare);
		expect(plain).not.toContain("justification");
	});

	it("a different cwd cannot be consumed", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ cwd: "/work" });
		ledger.record(recorded);
		expect(ledger.consume({ ...matchOf(recorded), cwd: "/other" }, 1_000)).toBeUndefined();
	});

	it("session isolation", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ sessionId: "s1" });
		ledger.record(recorded);
		expect(ledger.consume({ ...matchOf(recorded), sessionId: "s2" }, 1_000)).toBeUndefined();
		expect(ledger.consume(matchOf(recorded), 1_000)).toEqual(recorded);
	});

	it("recording the same operation twice is consumed only once, and the content is the latest", () => {
		const ledger = getDenialLedger();
		const first = entry({ stderr: "old", recordedAt: 1_000 });
		const second = entry({ stderr: "new", recordedAt: 2_000 });
		ledger.record(first);
		ledger.record(second);
		expect(ledger.consume(matchOf(first), 2_000)?.stderr).toBe("new");
		expect(ledger.consume(matchOf(first), 2_000)).toBeUndefined();
	});

	it("different operations can each be consumed", () => {
		const ledger = getDenialLedger();
		const bash = entry({ tool: "bash" });
		const write = entry({ tool: "write", fingerprint: operationFingerprint({ path: "/etc/a" }) });
		ledger.record(bash);
		ledger.record(write);
		expect(ledger.consume(matchOf(write), 1_000)?.tool).toBe("write");
		expect(ledger.consume(matchOf(bash), 1_000)?.tool).toBe("bash");
	});

	it("an empty sessionId is not recorded", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ sessionId: "" });
		ledger.record(recorded);
		expect(ledger.consume(matchOf(recorded), 1_000)).toBeUndefined();
	});

	it("forget clears every unconsumed record for the session", () => {
		const ledger = getDenialLedger();
		const bash = entry();
		const write = entry({ tool: "write" });
		ledger.record(bash);
		ledger.record(write);
		ledger.forget("s1");
		expect(ledger.consume(matchOf(bash), 1_000)).toBeUndefined();
		expect(ledger.consume(matchOf(write), 1_000)).toBeUndefined();
	});

	it("an expired record cannot be consumed", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ recordedAt: 0 });
		ledger.record(recorded);
		expect(ledger.consume(matchOf(recorded), DENIAL_TTL_MS)).toBeUndefined();
	});

	it("a record can be consumed within the TTL", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ recordedAt: 0 });
		ledger.record(recorded);
		expect(ledger.consume(matchOf(recorded), DENIAL_TTL_MS - 1)).toEqual(recorded);
	});

	it("of two concurrent consumes, only one succeeds", () => {
		const ledger = getDenialLedger();
		const recorded = entry();
		ledger.record(recorded);
		const first = ledger.consume(matchOf(recorded), 1_000);
		const second = ledger.consume(matchOf(recorded), 1_000);
		expect(first).toEqual(recorded);
		expect(second).toBeUndefined();
	});
});
