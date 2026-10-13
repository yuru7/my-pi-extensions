/**
 * Session-scoped title state and persistence for pi-auto-title.
 *
 * The AI title belongs to one Pi session: it is stored with `pi.appendEntry()`
 * inside that session, never in a separate global file, and restored from the
 * session branch on startup. Restored titles go through the same validation as
 * generated ones, so a corrupt stored value falls back to the directory name.
 *
 * Generation results are tied to the session and a generation counter, so a
 * result that comes back after a session switch, reload, or tree navigation is
 * dropped instead of overwriting the new title. {@link GenerationTracker} owns
 * the in-flight bookkeeping and only lets the current run clear it.
 */

import { normalizeTitle } from "./title.ts";

/** Custom entry type that persists the AI title inside the session. */
export const TITLE_ENTRY_TYPE = "pi-auto-title";

/** Custom entry type for warnings shown in the conversation history. */
export const WARNING_ENTRY_TYPE = "pi-auto-title/warning";

/** Data stored in a {@link WARNING_ENTRY_TYPE} entry. */
export interface WarningEntryData {
	message: string;
}

/** Entry payload for {@link WARNING_ENTRY_TYPE}. */
export function warningEntryData(message: string): WarningEntryData {
	return { message };
}

/** Extract the message from a {@link WARNING_ENTRY_TYPE} entry's data. */
export function warningEntryMessage(data: unknown): string | undefined {
	if (
		typeof data === "object" &&
		data !== null &&
		"message" in data &&
		typeof (data as { message: unknown }).message === "string"
	) {
		return (data as { message: string }).message;
	}
	return undefined;
}

/** Data stored in a {@link TITLE_ENTRY_TYPE} entry. */
export interface TitleEntryData {
	title: string;
}

/** Minimal structural view of a session entry, so this module needs no Pi import. */
export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown };
}

/** Entry payload for {@link TITLE_ENTRY_TYPE}. */
export function titleEntryData(title: string): TitleEntryData {
	return { title };
}

function isTitleEntryData(data: unknown): data is TitleEntryData {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as { title?: unknown }).title === "string"
	);
}

function contentText(content: unknown): string | undefined {
	if (typeof content === "string") {
		return content.trim() === "" ? undefined : content;
	}
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") {
			parts.push(candidate.text);
		}
	}
	const text = parts.join("").trim();
	return text === "" ? undefined : text;
}

/**
 * Latest usable AI title persisted on the branch, or undefined when the session
 * has none. Stored values are normalized like generated ones; a value that
 * normalizes to nothing is ignored.
 */
export function findStoredTitle(
	entries: readonly SessionEntryLike[],
): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (
			entry.type === "custom" &&
			entry.customType === TITLE_ENTRY_TYPE &&
			isTitleEntryData(entry.data)
		) {
			const title = normalizeTitle(entry.data.title);
			if (title !== undefined) return title;
		}
	}
	return undefined;
}

/** Text of the first user message on the branch, or undefined when there is none. */
export function findFirstUserText(
	entries: readonly SessionEntryLike[],
): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "user") continue;
		const text = contentText(entry.message.content);
		if (text !== undefined) return text;
	}
	return undefined;
}

/** Identity an outstanding generation result must carry to be accepted. */
export interface GenerationTicket {
	token: number;
	sessionId: string;
}

/**
 * In-flight bookkeeping for title generation.
 *
 * `start()` hands out a token while no run is active; `finish()` clears the
 * busy state only for the run that owns it, so an older run that settles late
 * cannot free the state of a newer one. `reset()` drops whatever is running,
 * for a session switch or reload.
 */
export class GenerationTracker {
	#token = 0;
	#active: number | undefined;

	get busy(): boolean {
		return this.#active !== undefined;
	}

	/** Start a run, or return undefined when one is already active. */
	start(): number | undefined {
		if (this.#active !== undefined) return undefined;
		this.#token += 1;
		this.#active = this.#token;
		return this.#token;
	}

	/** End a run; only the active run clears the busy state. */
	finish(token: number): void {
		if (this.#active === token) this.#active = undefined;
	}

	/** Drop the active run, if any. */
	reset(): void {
		this.#active = undefined;
	}
}

/**
 * Title state for one session.
 *
 * The title body is the AI title when one exists and the startup directory name
 * otherwise. `acceptGeneration` only applies a result whose ticket matches the
 * current session and generation, so late results cannot overwrite it.
 */
export class SessionTitleManager {
	#sessionId: string;
	#directoryTitle: string;
	#aiTitle: string | undefined;
	#generation = 0;

	constructor(
		sessionId: string,
		directoryTitle: string,
		restoredTitle?: string,
	) {
		this.#sessionId = sessionId;
		this.#directoryTitle = directoryTitle;
		this.#aiTitle = restoredTitle;
	}

	get sessionId(): string {
		return this.#sessionId;
	}

	get directoryTitle(): string {
		return this.#directoryTitle;
	}

	/** AI title when one exists; undefined before generation or without one. */
	get aiTitle(): string | undefined {
		return this.#aiTitle;
	}

	/** Title body shown in the tab title. */
	get title(): string {
		return this.#aiTitle ?? this.#directoryTitle;
	}

	/** Start a generation run and return the ticket its result must carry. */
	startGeneration(): GenerationTicket {
		this.#generation += 1;
		return { token: this.#generation, sessionId: this.#sessionId };
	}

	/** Accept a generated title when the ticket is still current. */
	acceptGeneration(ticket: GenerationTicket, title: string): boolean {
		if (
			ticket.token !== this.#generation ||
			ticket.sessionId !== this.#sessionId
		) {
			return false;
		}
		this.#aiTitle = title;
		return true;
	}

	/** Drop every outstanding generation result. */
	invalidate(): void {
		this.#generation += 1;
	}
}
