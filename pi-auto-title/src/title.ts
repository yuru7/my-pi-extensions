/**
 * Tab title composition for pi-auto-title.
 *
 * Pure string handling: the `<status> Pi - <title>` format, the 30-code-point
 * title limit, title text normalization, the startup directory name, and the
 * display object that skips `setTitle()` calls when the rendered title did not
 * change.
 */

/** Agent activity state shown by the status indicator. */
export type TitleStatus = "running" | "stalled" | "idle";

/** Maximum length of the AI-generated title part, in Unicode code points. */
export const MAX_AI_TITLE_LENGTH = 30;

/** Title used when the startup directory has no trailing name. */
export const FALLBACK_DIRECTORY_NAME = "workspace";

export interface TitleFormatOptions {
	/** Whether the status marker is part of the title at all. */
	statusEnabled: boolean;
	/** Marker for {@link TitleStatus} "running"; may be empty. */
	running: string;
	/** Marker for {@link TitleStatus} "stalled"; may be empty. */
	stalled: string;
	/** Marker for {@link TitleStatus} "idle"; may be empty. */
	idle: string;
	/** Current agent activity. */
	status: TitleStatus;
	/** Title body, either the AI title or the directory name. */
	title: string;
}

/**
 * Compose the tab title.
 *
 * With the status indicator enabled: `<status> Pi - <title>`; without it (or
 * with an empty marker string): `Pi - <title>`.
 */
export function formatTitle(options: TitleFormatOptions): string {
	const marker = options.statusEnabled
		? options.status === "running"
			? options.running
			: options.status === "stalled"
				? options.stalled
				: options.idle
		: "";
	const prefix = marker === "" ? "" : `${marker} `;
	return `${prefix}Pi - ${options.title}`;
}

/**
 * Last path segment of a POSIX, Windows, or WSL path.
 *
 * Trailing separators are ignored and drive roots (or `/`) fall back to
 * {@link FALLBACK_DIRECTORY_NAME}, because they carry no directory name.
 */
export function workspaceNameFromPath(path: string): string {
	const segments = path
		.split(/[\\/]+/)
		.filter((segment) => segment !== "" && !/^[A-Za-z]:$/.test(segment));
	return segments.at(-1) ?? FALLBACK_DIRECTORY_NAME;
}

/**
 * Limit a title to `maxLength` Unicode code points, keeping a word boundary
 * when one is available in the second half of the kept range.
 *
 * Slicing by code point keeps surrogate pairs intact. Titles without spaces
 * (for example Japanese) are cut at the limit directly.
 */
export function truncateTitle(
	text: string,
	maxLength = MAX_AI_TITLE_LENGTH,
): string {
	const points = Array.from(text);
	if (points.length <= maxLength) return text;

	let boundary = -1;
	for (let index = Math.floor(maxLength / 2); index < maxLength; index += 1) {
		if (/\s/.test(points[index])) boundary = index;
	}
	const atBoundary =
		boundary > 0 ? points.slice(0, boundary).join("").replace(/\s+$/, "") : "";
	return atBoundary !== "" ? atBoundary : points.slice(0, maxLength).join("");
}

const CONTROL_CHARACTERS = /\p{Cc}/gu;
const LEADING_DECORATION = /^(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)]\s+)/;
const WRAPPING: readonly (readonly [string, string])[] = [
	["**", "**"],
	["__", "__"],
	["`", "`"],
	['"', '"'],
	["'", "'"],
	["「", "」"],
	["『", "』"],
];

function stripWrapping(text: string): string {
	for (const [open, close] of WRAPPING) {
		if (
			text.length >= open.length + close.length &&
			text.startsWith(open) &&
			text.endsWith(close)
		) {
			return text.slice(open.length, text.length - close.length).trim();
		}
	}
	return text;
}

/**
 * Turn raw title text into a usable title.
 *
 * Removes control characters (newlines included), collapses whitespace, strips
 * wrapping quotes and Markdown decoration, and applies the 30-code-point limit.
 * Returns undefined when nothing usable remains. Both generated titles and
 * titles restored from a session go through it, so both are equally safe to
 * show in a terminal title.
 */
export function normalizeTitle(raw: string): string | undefined {
	let text = raw.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
	for (let pass = 0; pass < 3; pass += 1) {
		const stripped = stripWrapping(
			text.replace(LEADING_DECORATION, "").trim(),
		).trim();
		if (stripped === text) break;
		text = stripped;
	}
	if (text === "") return undefined;
	return truncateTitle(text, MAX_AI_TITLE_LENGTH);
}

/**
 * Renders titles through Pi's `setTitle`, skipping calls when the rendered
 * title is identical to the one already shown.
 */
export class TitleDisplay {
	#setTitle: (title: string) => void;
	#last: string | undefined;

	constructor(setTitle: (title: string) => void) {
		this.#setTitle = setTitle;
	}

	/** The title currently shown, or undefined before the first {@link show}. */
	get last(): string | undefined {
		return this.#last;
	}

	show(title: string, force = false): void {
		if (!force && this.#last === title) return;
		this.#last = title;
		this.#setTitle(title);
	}
}
