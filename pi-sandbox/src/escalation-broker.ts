/**
 * escalation-broker.ts — forwards escalation approvals for in-process subagents (spec 2026-09-30 §4.2).
 *
 * Facts: pi-subagents creates child sessions in the same Node process (createAgentSession), but pi reinvokes the extension
 * factory for every session—parent and child are separate jiti instances, imported module singletons are not shared,
 * and globalThis is the only shared point (same idea as processPermissionState in src/permission.ts).
 *
 * Strictly fail-closed (spec §2 D3): only a child→parent link established by `subagents:child:session-created`
 * may route an approval. If it cannot be resolved, return null and let the caller fall back to the existing "no approval channel is available"
 * error—never guess "the only interactive session in the process".
 */

import type { DenialReasonPrompt, EscalationDecision } from "./escalation";

/** Process-global slot key: prefixed with the package name so it does not collide with other extensions' use of globalThis. */
const BROKER_KEY = Symbol.for("@yuru7/pi-sandbox:escalation-broker");

/** Depth cap when walking ancestors along the link: bad data must not cause a long walk or an infinite loop. */
const MAX_ANCESTOR_DEPTH = 32;

/** FIFO tail swallows the settled value: it exists only to serialize, and ignores the result. */
function noop(): void {}

/**
 * A channel's `hasUI()` may throw (the host's `assertActive()` on a stale ctx, or a hostile implementation registered
 * by another extension in the same process)—always treat that as "no UI": never let an exception bubble on the fail-closed path (spec §6).
 */
function hasUIOf(channel: ParentApprovalChannel): boolean {
	try {
		return channel.hasUI();
	} catch {
		return false;
	}
}

/**
 * Approval channel registered by the parent session.
 * `hasUI` is a function, not a boolean snapshot: after registration the parent session may lose its UI (reload / session replacement), so every resolve checks it live.
 * `opts.signal` is passed straight through to pi's `ExtensionUIDialogOptions.signal`—when the subagent is interrupted the parent dialog is actually closed,
 * and an already-aborted request never opens a dialog. Host implementations: the TUI's `showExtensionSelector` and RPC mode's
 * `createDialogPromise`. Both close the dialog and resolve `undefined` when the signal aborts.
 * Dist line numbers are not cited here—a line-number citation rots across host versions (Ruling 3).
 */
export interface ParentApprovalChannel {
	readonly sessionId: string;
	hasUI(): boolean;
	select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	/** Optional: reason input after Deny (second step of the two-step flow). If it is missing or throws, the request still returns Deny (with no reason). */
	input?(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

export interface EscalationBroker {
	/** The parent instance registers this on session_start (and only when ctx.hasUI). */
	registerParent(channel: ParentApprovalChannel): void;
	/** The parent instance unregisters this on session_shutdown. */
	unregisterParent(sessionId: string): void;
	/** Driven by `subagents:child:session-created`; no link is created when parentSessionId is missing. */
	linkChild(childSessionId: string, parentSessionId: string | undefined): void;
	/** Driven by `subagents:child:disposed`. */
	unlinkChild(childSessionId: string): void;
	/** Strict resolve: walk the link upward for the first ancestor channel that is registered and hasUI(); return null if none is found. */
	resolveChannel(childSessionId: string): ParentApprovalChannel | null;
	/**
	 * The channel this session registered itself: the parent session uses it to queue its own escalations on the same FIFO lane (Ruling 17)—
	 * the host's select has a single dialog slot and does not queue, so a second call leaves the previous dialog unable to receive keys and its promise orphaned.
	 */
	resolveOwnChannel(sessionId: string): ParentApprovalChannel | null;
	/** Submit one approval; signal abort → choice is undefined, which falls into the existing "cancelled" branch. */
	request(
		channel: ParentApprovalChannel,
		title: string,
		options: string[],
		signal?: AbortSignal,
		denialReason?: DenialReasonPrompt,
	): Promise<EscalationDecision>;
}

class InProcessEscalationBroker implements EscalationBroker {
	private readonly parents = new Map<string, ParentApprovalChannel>();
	private readonly links = new Map<string, string>();

	/** FIFO tail: each request is chained behind it so the parent TUI opens only one dialog at a time (spec §4.6). */
	private tail: Promise<unknown> = Promise.resolve();

	registerParent(channel: ParentApprovalChannel): void {
		if (!channel.sessionId) return;
		this.parents.set(channel.sessionId, channel);
	}

	unregisterParent(sessionId: string): void {
		this.parents.delete(sessionId);
	}

	linkChild(childSessionId: string, parentSessionId: string | undefined): void {
		// Strict mode (D3): without a parent id there is nothing to route to, so do not create a link and do not fall back to "the only interactive session".
		if (!childSessionId || !parentSessionId) return;
		this.links.set(childSessionId, parentSessionId);
	}

	unlinkChild(childSessionId: string): void {
		this.links.delete(childSessionId);
	}

	resolveChannel(childSessionId: string): ParentApprovalChannel | null {
		const visited = new Set<string>();
		let current: string | undefined = childSessionId;
		for (let depth = 0; current !== undefined && depth < MAX_ANCESTOR_DEPTH; depth++) {
			if (visited.has(current)) return null; // link cycle
			visited.add(current);
			const parentSessionId = this.links.get(current);
			if (parentSessionId === undefined) return null; // link broken: strictly fail-closed
			const channel = this.parents.get(parentSessionId);
			if (channel !== undefined && hasUIOf(channel)) return channel;
			current = parentSessionId; // an intermediate session has no channel (depth ≥ 2): keep walking up
		}
		return null;
	}

	resolveOwnChannel(sessionId: string): ParentApprovalChannel | null {
		const channel = this.parents.get(sessionId);
		if (channel === undefined) return null;
		return hasUIOf(channel) ? channel : null;
	}

	request(
		channel: ParentApprovalChannel,
		title: string,
		options: string[],
		signal?: AbortSignal,
		denialReason?: DenialReasonPrompt,
	): Promise<EscalationDecision> {
		const run = async (): Promise<EscalationDecision> => {
			try {
				// Aborted while queued: do not open a dialog at all, or the user sees a ghost approval whose result nobody receives (Review Focus #2).
				// Reading aborted stays inside the try—if a pathological signal getter throws, request must still never reject.
				// That contract is what lets escalation.ts stay unchanged.
				if (signal?.aborted === true) return { choice: undefined };
				// An abort while in flight is closed by pi's dialog itself, which resolves undefined (opts.signal is already forwarded).
				const choice = await channel.select(title, options, signal === undefined ? undefined : { signal });
				// select and input must finish inside the same FIFO task: the host has only one dialog slot,
				// and if input were outside the task the next queued select would cover the dialog that is waiting for input.
				if (choice !== "Deny" || denialReason === undefined || typeof channel.input !== "function") {
					return { choice };
				}
				try {
					const reason = await channel.input(denialReason.title, denialReason.placeholder, signal === undefined ? undefined : { signal });
					return { choice, reason };
				} catch {
					return { choice }; // a failure in the reason input does not change the denial (fail-closed)
				}
			} catch {
				// A parent-side UI failure is treated as "cancelled" (fail-closed), so the exception does not bubble up and interrupt the subagent's tool call.
				return { choice: undefined };
			}
		};
		// Keep dequeuing even if the previous request rejects, or the queue stays stuck forever.
		const result = this.tail.then(run, run);
		this.tail = result.then(noop, noop);
		return result;
	}
}

/** Process-global singleton: the parent and child sessions' separate jiti instances share this one object. */
export function getEscalationBroker(): EscalationBroker {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[BROKER_KEY] as EscalationBroker | undefined;
	if (existing !== undefined) return existing;
	const broker = new InProcessEscalationBroker();
	store[BROKER_KEY] = broker;
	return broker;
}

/** Test-only reset of the global slot (production code must not call this). */
export function resetEscalationBrokerForTests(): void {
	delete (globalThis as Record<symbol, unknown>)[BROKER_KEY];
}
