import type {
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	compositeTuiLine,
	Key,
	Markdown,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
	type MarkdownTheme,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/**
 * Rows kept free below the dialog for the app's fixed dock (footer, status
 * indicators, widgets). The dock mounts extension components as a layout leaf,
 * so the dialog cannot learn its allocated height; capping the rendered height
 * keeps the pinned choices on screen instead of letting them be clipped. Extra
 * dock content (widgets, queued messages) on a very short terminal can still
 * squeeze the dialog; Escape then remains the fail-closed way out.
 */
const DOCK_RESERVE_ROWS = 6;
const MIN_BODY_ROWS = 1;
/** Rows taken by the rule that marks the prompt as separate from the session view. */
const RULE_ROWS = 1;
/** Fallback width used only when a key reaches the dialog before its first render. */
const FALLBACK_WIDTH = 80;
const SCROLLBAR_HIDE_DELAY_MS = 1_200;
const CHOICE_CHARS = 40;
const HELP_TEXT = "\u2191\u2193 select \u00b7 enter confirm \u00b7 esc cancel";
/** Node's setTimeout delay is a 32-bit signed integer. Longer waits are sliced. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Added to the help line while the expanded document is on screen. */
const COLLAPSE_HINT = "ctrl+o collapse";

/** Clickable columns of the expansion marker on one rendered body row. */
interface ExpansionTarget {
	row: number;
	/** First clickable column, inclusive. */
	startX: number;
	/** Last clickable column, exclusive. */
	endX: number;
}

/**
 * Click targets for the expansion marker in the rendered body rows. The marker
 * ends the collapsed code block, so its last occurrence is the one that counts,
 * and a narrow dialog can wrap it: the target then covers the end of the row the
 * marker starts on, every row it passes through, and the start of the row it
 * ends on.
 */
function markerTargets(
	marker: string,
	rows: readonly string[],
): ExpansionTarget[] {
	const words = marker.split(" ").filter((word) => word.length > 0);
	if (words.length < 2) return [];
	const head = words[0];
	const tail = words[words.length - 1];
	const plain = rows.map((row) => stripTerminalSequences(row));

	let tailRow = -1;
	let tailEnd = 0;
	for (const [index, row] of plain.entries()) {
		const at = row.lastIndexOf(tail);
		if (at < 0) continue;
		tailRow = index;
		tailEnd = visibleWidth(row.slice(0, at)) + visibleWidth(tail);
	}
	if (tailRow < 0) return [];

	let headRow = -1;
	let headStart = 0;
	for (let index = 0; index <= tailRow; index++) {
		const at = plain[index].lastIndexOf(head);
		if (at < 0) continue;
		headRow = index;
		headStart = visibleWidth(plain[index].slice(0, at));
	}
	if (headRow < 0) return [];

	const targets: ExpansionTarget[] = [];
	for (let row = headRow; row <= tailRow; row++) {
		targets.push({
			row,
			startX: row === headRow ? headStart : 0,
			endX: row === tailRow ? tailEnd : visibleWidth(plain[row]),
		});
	}
	return targets;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
	const timer = setTimeout(callback, delayMs);
	timer.unref?.();
	return () => clearTimeout(timer);
}

/** Alternate rendering of the prompt with the Operation block shown in full. */
export interface ApprovalExpansion {
	/** Document rendered while the block is expanded. */
	markdown: string;
	/** Text marking the collapsed block; clicking it expands. */
	marker: string;
}

export interface ApprovalDialogRequest {
	/** The prompt as a Markdown document without its title. */
	markdown: string;
	/** Title embedded in the rule above the body, for example `── Title ──`. */
	title?: string;
	/**
	 * Line to color with a theme color, matched by its plain text. Used for the
	 * risk line so the level stays visible without relying on bold.
	 */
	emphasis?: { text: string; color: ThemeColor };
	/** Choice labels; the first entry is selected initially (fail closed). */
	choices: readonly string[];
	/**
	 * Present when the Operation block was cut short. `ctrl+o` and a click on the
	 * marker then swap the body between the collapsed and the expanded document.
	 */
	expansion?: ApprovalExpansion;
	/**
	 * Ask-prompt limit in milliseconds. Omitted or not positive means the dialog
	 * waits until the user answers. While it is open, the remaining whole seconds
	 * count down above the help line, and reaching zero declines.
	 */
	timeoutMs?: number;
	/** Abort that declines the dialog, including an ask-timeout signal. */
	signal?: AbortSignal;
	/** Clock for the countdown. Defaults to `Date.now`. */
	now?: () => number;
	/** Schedules the next countdown tick. Defaults to `setTimeout`. */
	schedule?: (callback: () => void, delayMs: number) => () => void;
}

export interface ApprovalDialogOptions extends ApprovalDialogRequest {
	theme: Theme;
	markdownTheme: MarkdownTheme;
	/** Terminal height source, injected so the viewport math stays testable. */
	rows: () => number;
	requestRender: () => void;
	onDecision: (choice: string | undefined) => void;
	/** How long the transient scrollbar keeps showing after the last scroll. */
	scrollbarHideDelayMs?: number;
}

/**
 * TUI approval dialog: a rule carrying the prompt title, then a scrollable body
 * of prompt text with the choice rows pinned below it. The rule keeps the prompt
 * visibly separate from the session transcript above. The body viewport is sized
 * from the terminal height and scrolls with shift+arrow keys and the mouse
 * wheel; a transient scrollbar shows only while the body does not fit. When the
 * prompt carries an expansion, `ctrl+o` and a click on the truncation marker
 * swap in the document that shows the whole operation.
 */
export class ApprovalDialog implements Component {
	private readonly markdown: string;
	private readonly title?: string;
	private readonly emphasis?: { text: string; color: ThemeColor };
	private readonly expansion?: ApprovalExpansion;
	private readonly markdownTheme: MarkdownTheme;
	private readonly theme: Theme;
	private readonly choices: readonly string[];
	private readonly rows: () => number;
	private readonly requestRender: () => void;
	private readonly onDecision: (choice: string | undefined) => void;
	private readonly scrollbarHideDelayMs: number;

	private body: Markdown;
	private selectedIndex = 0;
	private offset = 0;
	private expanded = false;
	private lastWidth?: number;
	private bodyCache?: { width: number; lines: string[] };
	/** Marker columns of the last render, for the expansion click hit test. */
	private markerTargets: readonly ExpansionTarget[] = [];
	private bodyRows = 0;
	private viewportRows = 0;
	private barVisibleUntil = 0;
	private hideTimer?: NodeJS.Timeout;
	private abortSignal?: AbortSignal;
	private abortHandler?: () => void;
	private closed = false;
	private readonly now: () => number;
	private readonly schedule: (callback: () => void, delayMs: number) => () => void;
	private deadline?: number;
	private remainingSeconds?: number;
	private cancelTimeout?: () => void;

	constructor(options: ApprovalDialogOptions) {
		this.markdown = options.markdown;
		this.title = options.title;
		this.emphasis = options.emphasis;
		this.expansion = options.expansion;
		this.markdownTheme = options.markdownTheme;
		this.theme = options.theme;
		this.choices = options.choices;
		this.rows = options.rows;
		this.requestRender = options.requestRender;
		this.onDecision = options.onDecision;
		this.scrollbarHideDelayMs =
			options.scrollbarHideDelayMs ?? SCROLLBAR_HIDE_DELAY_MS;
		this.now = options.now ?? Date.now;
		this.schedule = options.schedule ?? defaultSchedule;
		this.body = this.createBody();
		this.armTimeout(options.timeoutMs);
	}

	/** Current scroll offset of the body, in lines. */
	get scrollTop(): number {
		return this.offset;
	}

	get selectedChoice(): string | undefined {
		return this.choices[this.selectedIndex];
	}

	/**
	 * Closes the dialog as declined when the turn is aborted. `ui.custom()` does
	 * not accept an AbortSignal, so the dialog watches it itself.
	 */
	watchAbort(signal: AbortSignal | undefined): void {
		if (!signal) return;
		this.abortSignal = signal;
		this.abortHandler = () => this.cancel();
		if (signal.aborted) {
			this.cancel();
			return;
		}
		signal.addEventListener("abort", this.abortHandler, { once: true });
	}

	handleInput(data: string): void {
		this.ensureMetrics();
		if (this.expansion && matchesKey(data, Key.ctrl("o"))) {
			this.toggleExpansion();
		} else if (matchesKey(data, Key.up) || data === "k") {
			this.moveSelection(-1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.moveSelection(1);
		} else if (matchesKey(data, Key.enter) || data === "\n") {
			this.decide(this.choices[this.selectedIndex]);
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
		} else if (matchesKey(data, Key.shift("up"))) {
			this.scrollBy(-1);
		} else if (matchesKey(data, Key.shift("down"))) {
			this.scrollBy(1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.scrollBy(-this.pageRows());
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(this.pageRows());
		} else if (matchesKey(data, Key.home)) {
			this.scrollTo(0);
		} else if (matchesKey(data, Key.end)) {
			this.scrollTo(Number.MAX_SAFE_INTEGER);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		this.ensureMetrics();
		if (this.hitsExpansionMarker(event)) {
			this.toggleExpansion();
			return { handled: true, render: true };
		}
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			if (delta === 0) return undefined;
			this.scrollBy(delta);
			return { handled: true, render: true };
		}
		if (event.type !== "move" && event.type !== "drag") return undefined;
		// Hovering the track keeps the transient scrollbar alive; leaving it lets
		// the timer hide the scrollbar again, so no state can stay stuck.
		if (
			event.x !== event.width - 1 ||
			event.y < RULE_ROWS ||
			event.y >= RULE_ROWS + this.viewportRows
		) {
			return undefined;
		}
		this.markBarActivity();
		return { handled: true, render: true };
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		this.lastWidth = safeWidth;
		const { body, pinned, overflow, viewport } = this.layout(safeWidth);
		this.offset = Math.min(
			this.offset,
			Math.max(0, body.length - viewport),
		);

		const visible = body.slice(this.offset, this.offset + viewport);
		const lines =
			overflow && this.isBarVisible()
				? this.paintScrollbar(visible, safeWidth, body.length, viewport)
				: visible;
		this.markerTargets =
			this.expansion && !this.expanded
				? markerTargets(this.expansion.marker, lines)
				: [];
		const hint = overflow
			? [this.hintLine(body.length - (this.offset + viewport))]
			: [];
		return [
			this.ruleLine(safeWidth),
			...lines,
			...hint.map((line) => truncateToWidth(line, safeWidth, "")),
			...pinned.map((line) => truncateToWidth(line, safeWidth, "")),
		];
	}

	/** Theme changes rebuild the body so no styled string is cached stale. */
	invalidate(): void {
		this.body = this.createBody();
	}

	dispose(): void {
		if (this.hideTimer) clearTimeout(this.hideTimer);
		this.hideTimer = undefined;
		this.clearTimeoutTimer();
		this.detachAbort();
	}

	private createBody(): Markdown {
		this.bodyCache = undefined;
		return new Markdown(this.document(), 0, 0, this.markdownTheme);
	}

	/** Collapsed document, or the expanded one while the user has it open. */
	private document(): string {
		return this.expanded && this.expansion
			? this.expansion.markdown
			: this.markdown;
	}

	/**
	 * Swaps the body for the document that shows the whole operation, or back.
	 * The selected choice and the scroll offset stay untouched: the Operation
	 * block keeps its place and only gains or loses the lines it was hiding.
	 */
	private toggleExpansion(): void {
		if (!this.expansion) return;
		this.expanded = !this.expanded;
		this.body = this.createBody();
		this.requestRender();
	}

	/**
	 * True when a left click lands on the row showing the expansion marker, which
	 * is the only click that toggles the body. The rows are the ones the last
	 * render produced, so the hit test uses the very text the user sees.
	 */
	/**
	 * True when a left click lands inside the expansion marker, which is the only
	 * click that toggles the body. Other rows, other columns of the same row, and
	 * other buttons stay inert.
	 */
	private hitsExpansionMarker(event: TuiMouseEvent): boolean {
		// The marker only exists in the collapsed document, so a click that lands
		// where it used to be cannot fold the body straight back.
		if (this.expanded) return false;
		if (event.type !== "click" || event.button !== "left") return false;
		const row = event.y - RULE_ROWS;
		return this.markerTargets.some(
			(target) =>
				target.row === row &&
				event.x >= target.startX &&
				event.x < target.endX,
		);
	}

	/**
	 * Full-width rule above the body, with the prompt title embedded:
	 * `─── Title ─────`. The rule makes the prompt read as its own area and not
	 * as another line of the session transcript.
	 */
	private ruleLine(width: number): string {
		const title = this.title;
		if (!title) return this.theme.fg("border", "\u2500".repeat(width));
		const lead = "\u2500\u2500\u2500 ";
		// The label keeps one space on each side (lead ends with one already).
		const label = truncateToWidth(
			title,
			Math.max(1, width - visibleWidth(lead) - 1),
			"\u2026",
		);
		const tail = "\u2500".repeat(
			Math.max(0, width - visibleWidth(lead) - visibleWidth(label) - 1),
		);
		return truncateToWidth(
			[
				this.theme.fg("border", lead),
				this.theme.fg("accent", label),
				this.theme.fg("border", ` ${tail}`),
			].join(""),
			width,
			"",
		);
	}

	private cancel(): void {
		this.decide(undefined);
	}

	private decide(choice: string | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.clearTimeoutTimer();
		this.onDecision(choice);
	}

	/**
	 * Starts the visible countdown. The tick lands when the displayed second
	 * changes, and zero declines. No timer is armed when there is no timeout.
	 */
	private armTimeout(timeoutMs: number | undefined): void {
		if (timeoutMs === undefined || !(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
			return;
		}
		this.deadline = this.now() + timeoutMs;
		this.syncTimeout();
	}

	private syncTimeout(): void {
		if (this.closed || this.deadline === undefined) return;
		const remainingMs = this.deadline - this.now();
		const seconds = Math.ceil(remainingMs / 1000);
		if (seconds <= 0) {
			this.clearTimeoutTimer();
			this.cancel();
			return;
		}
		const changed = seconds !== this.remainingSeconds;
		this.remainingSeconds = seconds;
		if (changed && this.lastWidth !== undefined) this.requestRender();
		const untilNextSecond = remainingMs - (seconds - 1) * 1000;
		const delay = Math.min(
			untilNextSecond > 0 ? untilNextSecond : 1000,
			MAX_TIMER_DELAY_MS,
		);
		this.clearTimeoutTimer();
		this.cancelTimeout = this.schedule(() => this.syncTimeout(), delay);
	}

	private clearTimeoutTimer(): void {
		this.cancelTimeout?.();
		this.cancelTimeout = undefined;
	}

	private detachAbort(): void {
		if (this.abortSignal && this.abortHandler) {
			this.abortSignal.removeEventListener("abort", this.abortHandler);
		}
		this.abortSignal = undefined;
		this.abortHandler = undefined;
	}

	/**
	 * Body lines, pinned controls, and the viewport they leave for the body. The
	 * body viewport is what keeps an overlong prompt readable on a short screen.
	 */
	private layout(width: number): {
		body: string[];
		pinned: string[];
		overflow: boolean;
		viewport: number;
	} {
		const body = this.bodyLines(width);
		const pinned = this.choiceLines();
		const fixed = RULE_ROWS + pinned.length;
		const maxTotal = Math.max(
			fixed + MIN_BODY_ROWS,
			this.rows() - DOCK_RESERVE_ROWS,
		);
		const overflow = body.length > maxTotal - fixed;
		const viewport = Math.max(
			MIN_BODY_ROWS,
			maxTotal - fixed - (overflow ? 1 : 0),
		);
		this.bodyRows = body.length;
		this.viewportRows = viewport;
		return { body, pinned, overflow, viewport };
	}

	private bodyLines(width: number): string[] {
		if (this.bodyCache?.width === width) return this.bodyCache.lines;
		const lines = this.body.render(width).map((line) => this.emphasize(line));
		this.bodyCache = { width, lines };
		return lines;
	}

	/**
	 * Rebuilds the emphasized line with its theme color. The Markdown renderer
	 * already colored that text with the default text color, so wrapping the line
	 * would not tint it; rebuilding keeps the requested color visible.
	 */
	private emphasize(line: string): string {
		const emphasis = this.emphasis;
		if (!emphasis) return line;
		if (stripTerminalSequences(line).trimEnd() !== emphasis.text) return line;
		const width = visibleWidth(line);
		const styled = this.theme.fg(emphasis.color, this.theme.bold(emphasis.text));
		return styled + " ".repeat(Math.max(0, width - visibleWidth(styled)));
	}

	private choiceLines(): string[] {
		const rows = this.choices.map((choice, index) => {
			const label = truncateToWidth(choice, CHOICE_CHARS, "");
			return index === this.selectedIndex
				? `${this.theme.fg("accent", "\u2192 ")}${this.theme.fg("accent", label)}`
				: `  ${this.theme.fg("text", label)}`;
		});
		const timeout =
			this.remainingSeconds === undefined
				? []
				: [this.theme.fg("dim", `Times out in ${this.remainingSeconds}s`)];
		return ["", ...rows, ...timeout, this.theme.fg("dim", this.helpText())];
	}

	/** Help line, which also names the way back out of the expanded body. */
	private helpText(): string {
		return this.expanded && this.expansion
			? `${HELP_TEXT} \u00b7 ${COLLAPSE_HINT}`
			: HELP_TEXT;
	}

	private hintLine(more: number): string {
		const lines = more === 1 ? "line" : "lines";
		return this.theme.fg(
			"dim",
			`shift+\u2191/\u2193 or wheel to scroll \u00b7 ${more} more ${lines}`,
		);
	}

	private pageRows(): number {
		return Math.max(1, this.viewportRows - 1);
	}

	private moveSelection(delta: number): void {
		const next = Math.min(
			this.choices.length - 1,
			Math.max(0, this.selectedIndex + delta),
		);
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		this.requestRender();
	}

	private scrollBy(rows: number): void {
		this.scrollTo(this.offset + rows);
	}

	/**
	 * Fills in the viewport metrics before the first render, so keys that arrive
	 * earlier still scroll by a full page. In the app the first render happens
	 * before any key; tests and direct component use rely on this fallback.
	 */
	private ensureMetrics(): void {
		if (this.lastWidth === undefined) this.layout(FALLBACK_WIDTH);
	}

	private scrollTo(rows: number): void {
		this.ensureMetrics();
		const limit = Math.max(0, this.bodyRows - this.viewportRows);
		const requested = Number.isFinite(rows) ? Math.trunc(rows) : this.offset;
		const next = Math.max(0, Math.min(limit, requested));
		if (next === this.offset) return;
		this.offset = next;
		this.markBarActivity();
		this.requestRender();
	}

	private markBarActivity(): void {
		this.barVisibleUntil = Date.now() + this.scrollbarHideDelayMs;
		if (this.hideTimer) clearTimeout(this.hideTimer);
		this.hideTimer = setTimeout(() => {
			this.hideTimer = undefined;
			this.requestRender();
		}, this.scrollbarHideDelayMs);
		this.hideTimer.unref?.();
	}

	private isBarVisible(): boolean {
		return Date.now() < this.barVisibleUntil;
	}

	private paintScrollbar(
		lines: string[],
		width: number,
		contentHeight: number,
		viewport: number,
	): string[] {
		const trackHeight = lines.length;
		if (trackHeight === 0 || width <= 1) return lines;
		const thumbHeight = Math.max(
			Math.min(2, trackHeight),
			Math.min(
				trackHeight,
				Math.round((trackHeight * trackHeight) / contentHeight),
			),
		);
		const maxScrollTop = Math.max(0, contentHeight - viewport);
		const maxThumbTop = trackHeight - thumbHeight;
		const thumbTop =
			maxScrollTop === 0
				? 0
				: Math.round((this.offset / maxScrollTop) * maxThumbTop);
		const column = width - 1;
		return lines.map((line, index) => {
			const isThumb = index >= thumbTop && index < thumbTop + thumbHeight;
			const glyph = isThumb
				? this.theme.fg("scrollbarThumb", "\u2503")
				: this.theme.fg("scrollbarTrack", "\u2502");
			return compositeTuiLine(line, glyph, column, 1, width);
		});
	}
}

/**
 * Shows the approval dialog and resolves with the chosen label, or undefined
 * when the user cancels or the turn is aborted.
 */
export function showApprovalDialog(
	request: ApprovalDialogRequest,
	ctx: ExtensionContext,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) => {
			const dialog = new ApprovalDialog({
				...request,
				theme,
				markdownTheme: getMarkdownTheme(),
				rows: () => tui.terminal.rows,
				requestRender: () => tui.requestRender(),
				onDecision: (choice) => done(choice),
			});
			dialog.watchAbort(request.signal ?? ctx.signal);
			return dialog;
		},
	);
}
