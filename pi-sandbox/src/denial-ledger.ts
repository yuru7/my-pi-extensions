import type { SandboxMode } from "./policy";

/**
 * denial-ledger.ts — session-scoped denial ledger for the denial-first escalation gate.
 *
 * Only an unconsumed record for the same session, the same tool, and the same operation
 * (cwd + parameter fingerprint with escalation fields removed) can allow one escalation.
 * A different command, write target, or tool cannot reuse it.
 * Each record is consumed once. Expired records, ended sessions, and consumed records are dropped.
 *
 * Across jiti instances: parent and child sessions are separate module instances, so globalThis is the only shared point.
 */

/** Lifetime of a denial record. A retry in the conversation should follow the denial immediately. */
export const DENIAL_TTL_MS = 10 * 60 * 1000;

const ESCALATION_PARAM_KEYS = new Set(["sandbox_permissions", "justification"]);

/** Escalation fields are left out of the fingerprint, so "retry as-is and add approval params" still matches the denial just recorded. */
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
	/** Command text or write path. Used by the reviewer; not a match key on its own. */
	target: string;
	writablePaths: readonly string[];
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	/** Original text of a write/edit fence denial. */
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
	/** Record a denial waiting to be consumed. A repeat for the same match key overwrites the contents and still keeps a single entry. */
	record(entry: DenialRecord): void;
	/** Consume the matching unexpired record. Returns undefined when there is none. One-shot, and atomic with the lookup. */
	consume(match: DenialMatch, now?: number): DenialRecord | undefined;
	/** Unconsumed, unexpired records. Does not consume them. Directory grants use this to check denied paths. */
	list(sessionId: string, now?: number): readonly DenialRecord[];
	/** Drop records when the session is destroyed. */
	forget(sessionId: string): void;
}

const LEDGER_KEY = Symbol.for("@yuru7/pi-sandbox:denial-ledger");

function sameOperation(
	entry: DenialRecord,
	match: Pick<DenialRecord, "tool" | "fingerprint" | "cwd">,
): boolean {
	return (
		entry.tool === match.tool &&
		entry.fingerprint === match.fingerprint &&
		entry.cwd === match.cwd
	);
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

	list(sessionId: string, now = Date.now()): readonly DenialRecord[] {
		if (!sessionId) return [];
		this.purge(sessionId, now);
		return [...(this.pending.get(sessionId) ?? [])];
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

/** Test-only reset of the global slot (production code must not call this). */
export function resetDenialLedgerForTests(): void {
	delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
}
