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
	it("globalThis 单例：重复调用同一对象，reset 后换新对象", () => {
		const first = getDenialLedger();
		expect(getDenialLedger()).toBe(first);
		resetDenialLedgerForTests();
		expect(getDenialLedger()).not.toBe(first);
	});
});

describe("record/consume（同一操作、一次性）", () => {
	it("未记录 → consume undefined", () => {
		expect(getDenialLedger().consume(matchOf(entry()))).toBeUndefined();
	});

	it("记录后 consume 返回该记录，且一次性", () => {
		const ledger = getDenialLedger();
		const recorded = entry();
		ledger.record(recorded);
		expect(ledger.consume(matchOf(recorded), 1_000)).toEqual(recorded);
		expect(ledger.consume(matchOf(recorded), 1_000)).toBeUndefined();
	});

	it("工具隔离：bash 的拒绝不放行 powershell", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ tool: "bash" });
		ledger.record(recorded);
		expect(ledger.consume({ ...matchOf(recorded), tool: "powershell" }, 1_000)).toBeUndefined();
		expect(ledger.consume(matchOf(recorded), 1_000)).toEqual(recorded);
	});

	it("操作隔离：另一条命令的指纹对不上", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ fingerprint: operationFingerprint({ command: "echo a" }) });
		ledger.record(recorded);
		expect(ledger.consume({
			...matchOf(recorded),
			fingerprint: operationFingerprint({ command: "echo b" }),
		}, 1_000)).toBeUndefined();
	});

	it("提权字段不进指纹", () => {
		const plain = operationFingerprint({ command: "pnpm install", sandbox_permissions: "danger-full-access", justification: "store" });
		const bare = operationFingerprint({ command: "pnpm install" });
		expect(plain).toBe(bare);
		expect(plain).not.toContain("justification");
	});

	it("cwd 不同则不能消费", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ cwd: "/work" });
		ledger.record(recorded);
		expect(ledger.consume({ ...matchOf(recorded), cwd: "/other" }, 1_000)).toBeUndefined();
	});

	it("会话隔离", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ sessionId: "s1" });
		ledger.record(recorded);
		expect(ledger.consume({ ...matchOf(recorded), sessionId: "s2" }, 1_000)).toBeUndefined();
		expect(ledger.consume(matchOf(recorded), 1_000)).toEqual(recorded);
	});

	it("同一操作重复 record 只消费一次，内容是最新的", () => {
		const ledger = getDenialLedger();
		const first = entry({ stderr: "old", recordedAt: 1_000 });
		const second = entry({ stderr: "new", recordedAt: 2_000 });
		ledger.record(first);
		ledger.record(second);
		expect(ledger.consume(matchOf(first), 2_000)?.stderr).toBe("new");
		expect(ledger.consume(matchOf(first), 2_000)).toBeUndefined();
	});

	it("不同操作可以各自消费", () => {
		const ledger = getDenialLedger();
		const bash = entry({ tool: "bash" });
		const write = entry({ tool: "write", fingerprint: operationFingerprint({ path: "/etc/a" }) });
		ledger.record(bash);
		ledger.record(write);
		expect(ledger.consume(matchOf(write), 1_000)?.tool).toBe("write");
		expect(ledger.consume(matchOf(bash), 1_000)?.tool).toBe("bash");
	});

	it("空 sessionId 不记账", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ sessionId: "" });
		ledger.record(recorded);
		expect(ledger.consume(matchOf(recorded), 1_000)).toBeUndefined();
	});

	it("forget 清掉会话的全部未消费记录", () => {
		const ledger = getDenialLedger();
		const bash = entry();
		const write = entry({ tool: "write" });
		ledger.record(bash);
		ledger.record(write);
		ledger.forget("s1");
		expect(ledger.consume(matchOf(bash), 1_000)).toBeUndefined();
		expect(ledger.consume(matchOf(write), 1_000)).toBeUndefined();
	});

	it("过期记录不能消费", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ recordedAt: 0 });
		ledger.record(recorded);
		expect(ledger.consume(matchOf(recorded), DENIAL_TTL_MS)).toBeUndefined();
	});

	it("期限内可以消费", () => {
		const ledger = getDenialLedger();
		const recorded = entry({ recordedAt: 0 });
		ledger.record(recorded);
		expect(ledger.consume(matchOf(recorded), DENIAL_TTL_MS - 1)).toEqual(recorded);
	});

	it("并行的两次 consume 只有一次成功", () => {
		const ledger = getDenialLedger();
		const recorded = entry();
		ledger.record(recorded);
		const first = ledger.consume(matchOf(recorded), 1_000);
		const second = ledger.consume(matchOf(recorded), 1_000);
		expect(first).toEqual(recorded);
		expect(second).toBeUndefined();
	});
});
