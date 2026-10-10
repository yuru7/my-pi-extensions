/**
 * 会话级额外可写根。批准后的目录只在本会话的后续工具调用里生效，
 * 不写入 writableRoots 的缺省值，也不传给别的会话（子会话用自己的 id，读到的是空列表）。
 * 父子是各自的 jiti 实例，所以槽位挂在 globalThis 上。
 * clear 时把这次新建且仍为空的目录删掉（因此变空的新建父目录也一起删）。
 */

import { removeEmptyCreatedDirectories } from "./grant-path";

const GRANTS_KEY = Symbol.for("@yuru7/pi-sandbox:writable-grants");

interface StoredGrant {
	path: string;
	created: readonly string[];
}

export interface WritableGrants {
	list(sessionId: string): readonly string[];
	has(sessionId: string, path: string): boolean;
	grant(sessionId: string, path: string, created?: readonly string[]): void;
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

	grant(
		sessionId: string,
		path: string,
		created: readonly string[] = [],
	): void {
		if (!sessionId || path.length === 0) return;
		const list = this.bySession.get(sessionId) ?? [];
		if (list.some((grant) => grant.path === path)) return;
		list.push({ path, created: [...created] });
		this.bySession.set(sessionId, list);
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

/** 仅供测试复位全局槽位（生产代码不得调用）。 */
export function resetWritableGrantsForTests(): void {
	delete (globalThis as Record<symbol, unknown>)[GRANTS_KEY];
}
