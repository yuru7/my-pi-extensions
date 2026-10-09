import type { SandboxMode } from "./policy";

/**
 * denial-ledger.ts — denial-first 提权门禁的会话级拒绝账本。
 *
 * 同一会话、同一工具、同一操作（cwd + 去掉提权字段后的参数指纹）的未消费记录
 * 才能放行一次提权。不同命令、不同写入目标、不同工具不能串用。
 * 一条记录只消费一次；过期、会话结束、消费后都丢弃。
 *
 * 跨 jiti 实例：父子会话是各自独立的模块实例，globalThis 是唯一共享点。
 */

/** 拒绝记录的有效期。对话里的重试应紧挨着拒绝发生。 */
export const DENIAL_TTL_MS = 10 * 60 * 1000;

const ESCALATION_PARAM_KEYS = new Set(["sandbox_permissions", "justification"]);

/** 提权字段不进指纹，这样“原样重试并带上审批参数”仍能对上刚才的拒绝。 */
export function operationFingerprint(params: Record<string, unknown>): string {
	const rest: Record<string, unknown> = {};
	for (const key of Object.keys(params).sort()) {
		if (ESCALATION_PARAM_KEYS.has(key)) continue;
		rest[key] = params[key];
	}
	return JSON.stringify(rest);
}

export interface DenialRecord {
	sessionId: string;
	tool: string;
	fingerprint: string;
	cwd: string;
	workspace: string;
	sandboxMode: SandboxMode;
	backend: string;
	/** 命令文本或写入路径。Reviewer 用，不单独当匹配键。 */
	target: string;
	writablePaths: readonly string[];
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	/** write/edit 围栏拒绝的原文。 */
	error?: string;
	recordedAt: number;
}

export interface DenialMatch {
	sessionId: string;
	tool: string;
	fingerprint: string;
	cwd: string;
}

export interface DenialLedger {
	/** 记一笔待消费的拒绝。同一匹配键重复记时覆盖内容，仍只保留一条。 */
	record(entry: DenialRecord): void;
	/** 消费匹配的未过期记录。没有则返回 undefined。一次性，且与查找同步完成。 */
	consume(match: DenialMatch, now?: number): DenialRecord | undefined;
	/** 会话销毁时清理。 */
	forget(sessionId: string): void;
}

const LEDGER_KEY = Symbol.for("@yandy0725/pi-sandbox:denial-ledger");

function sameOperation(entry: DenialRecord, match: Pick<DenialRecord, "tool" | "fingerprint" | "cwd">): boolean {
	return entry.tool === match.tool && entry.fingerprint === match.fingerprint && entry.cwd === match.cwd;
}

function expired(entry: DenialRecord, now: number): boolean {
	return now - entry.recordedAt >= DENIAL_TTL_MS;
}

class InProcessDenialLedger implements DenialLedger {
	private readonly pending = new Map<string, DenialRecord[]>();

	record(entry: DenialRecord): void {
		if (!entry.sessionId) return;
		this.purge(entry.sessionId, entry.recordedAt);
		const list = this.pending.get(entry.sessionId) ?? [];
		const index = list.findIndex((existing) => sameOperation(existing, entry));
		if (index >= 0) list[index] = entry;
		else list.push(entry);
		this.pending.set(entry.sessionId, list);
	}

	consume(match: DenialMatch, now = Date.now()): DenialRecord | undefined {
		if (!match.sessionId) return undefined;
		this.purge(match.sessionId, now);
		const list = this.pending.get(match.sessionId);
		if (list === undefined) return undefined;
		const index = list.findIndex((entry) => sameOperation(entry, match));
		if (index < 0) return undefined;
		const [found] = list.splice(index, 1);
		if (list.length === 0) this.pending.delete(match.sessionId);
		return found;
	}

	forget(sessionId: string): void {
		this.pending.delete(sessionId);
	}

	private purge(sessionId: string, now: number): void {
		const list = this.pending.get(sessionId);
		if (list === undefined) return;
		const live = list.filter((entry) => !expired(entry, now));
		if (live.length === 0) this.pending.delete(sessionId);
		else if (live.length !== list.length) this.pending.set(sessionId, live);
	}
}

export function getDenialLedger(): DenialLedger {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[LEDGER_KEY] as DenialLedger | undefined;
	if (existing !== undefined) return existing;
	const ledger = new InProcessDenialLedger();
	store[LEDGER_KEY] = ledger;
	return ledger;
}

/** 仅供测试复位全局槽位（生产代码不得调用）。 */
export function resetDenialLedgerForTests(): void {
	delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
}
