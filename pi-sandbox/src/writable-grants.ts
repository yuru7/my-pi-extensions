/**
 * Session-scoped extra writable roots. An approved directory applies only to later
 * tool calls in this session. It is not written into the writableRoots default and is
 * not shared with other sessions (a child session uses its own id and sees an empty list).
 * Parent and child are separate jiti instances, so the slot lives on globalThis.
 * clear removes directories created for this grant that are still empty (newly created
 * parents that become empty are removed too).
 */

import { removeEmptyCreatedDirectories } from "./grant-path";

const GRANTS_KEY = Symbol.for("@yuru7/pi-sandbox:writable-grants");

/**
 * New directories one user request may add. A no-op (already writable or already granted) and a
 * failed/denied request do not consume it; `clear` on the request boundary resets it.
 */
export const GRANT_LIMIT_PER_TURN = 5;

interface StoredGrant {
	path: string;
	created: readonly string[];
}

export type GrantResult = "added" | "exists" | "limit";

export interface WritableGrants {
	list(sessionId: string): readonly string[];
	has(sessionId: string, path: string): boolean;
	count(sessionId: string): number;
	grant(
		sessionId: string,
		path: string,
		created?: readonly string[],
	): GrantResult;
	clear(sessionId: string): void;
}

class InProcessWritableGrants implements WritableGrants {
	private readonly bySession = new Map<string, StoredGrant[]>();

	list(sessionId: string): readonly string[] {
		return (this.bySession.get(sessionId) ?? []).map((grant) => grant.path);
	}

	has(sessionId: string, path: string): boolean {
		return (this.bySession.get(sessionId) ?? []).some(
			(grant) => grant.path === path,
		);
	}

	count(sessionId: string): number {
		return this.bySession.get(sessionId)?.length ?? 0;
	}

	grant(
		sessionId: string,
		path: string,
		created: readonly string[] = [],
	): GrantResult {
		if (!sessionId || path.length === 0) return "exists";
		const list = this.bySession.get(sessionId) ?? [];
		if (list.some((grant) => grant.path === path)) return "exists";
		if (list.length >= GRANT_LIMIT_PER_TURN) return "limit";
		list.push({ path, created: [...created] });
		this.bySession.set(sessionId, list);
		return "added";
	}

	clear(sessionId: string): void {
		const list = this.bySession.get(sessionId);
		this.bySession.delete(sessionId);
		if (list === undefined) return;
		removeEmptyCreatedDirectories(list.flatMap((grant) => grant.created));
	}
}

export function getWritableGrants(): WritableGrants {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[GRANTS_KEY] as WritableGrants | undefined;
	if (existing !== undefined) return existing;
	const grants = new InProcessWritableGrants();
	store[GRANTS_KEY] = grants;
	return grants;
}

/** Test-only reset of the global slot (production code must not call this). */
export function resetWritableGrantsForTests(): void {
	delete (globalThis as Record<symbol, unknown>)[GRANTS_KEY];
}
