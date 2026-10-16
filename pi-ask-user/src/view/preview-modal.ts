import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	sliceByColumn,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { t } from "../state/i18n-bridge.ts";
import {
	BORDER_HORIZONTAL_OVERHEAD,
	BORDER_INNER_PADDING_HORIZONTAL,
	BORDER_VERTICAL_OVERHEAD,
	renderBorderedBox,
	stripFenceMarkers,
} from "./components/preview/preview-box-renderer.ts";

const TITLE_ROWS = 1;
const HINT_ROWS = 1;
const PAN_STEP = 8;

/** Host surface the modal needs. A real Pi `TUI` satisfies this. */
export interface PreviewModalHost {
	terminal: { readonly rows: number };
	requestRender(): void;
}

export interface PreviewModalConfig {
	host: PreviewModalHost;
	theme: Theme;
	markdownTheme: MarkdownTheme;
	label: string;
	preview: string;
	/** Extra key spec that also closes the modal, such as the collapse shortcut. */
	closeKey?: string;
	onClose: () => void;
}

/**
 * Large scrollable view of one option's preview. The overlay clips whatever `render`
 * returns, so this component windows the lines itself: ↑↓ and PageUp/PageDown move
 * vertically, ←→ pans wide diagrams, the wheel scrolls.
 */
export class PreviewModal {
	private readonly host: PreviewModalHost;
	private readonly theme: Theme;
	private readonly label: string;
	private readonly closeKey: string | undefined;
	private readonly onClose: () => void;
	private readonly markdown: Markdown;
	private row = 0;
	private col = 0;
	private page = 1;
	private maxRow = 0;
	private maxCol = 0;
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(config: PreviewModalConfig) {
		this.host = config.host;
		this.theme = config.theme;
		this.label = config.label;
		this.closeKey = config.closeKey;
		this.onClose = config.onClose;
		this.markdown = new Markdown(config.preview, 0, 0, config.markdownTheme);
	}

	invalidate(): void {
		this.markdown.invalidate();
		this.cachedWidth = -1;
	}

	handleInput(data: string): void {
		if (this.isClose(data)) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.up)) this.row -= 1;
		else if (matchesKey(data, Key.down)) this.row += 1;
		else if (matchesKey(data, Key.pageUp)) this.row -= this.page;
		else if (matchesKey(data, Key.pageDown)) this.row += this.page;
		else if (matchesKey(data, Key.home)) this.row = 0;
		else if (matchesKey(data, Key.end)) this.row = this.maxRow;
		else if (matchesKey(data, Key.left)) this.col -= PAN_STEP;
		else if (matchesKey(data, Key.right)) this.col += PAN_STEP;
		else return;
		this.host.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (
			event.type !== "wheel" ||
			event.wheelDelta === undefined ||
			event.wheelDelta === 0
		)
			return undefined;
		if (event.shift) this.col += event.wheelDelta * PAN_STEP;
		else this.row += event.wheelDelta;
		this.host.requestRender();
		return { handled: true };
	}

	render(width: number): string[] {
		const inner = Math.max(
			1,
			width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL,
		);
		const lines = this.body(inner);
		const budget = Math.max(
			TITLE_ROWS + HINT_ROWS + BORDER_VERTICAL_OVERHEAD + 1,
			this.host.terminal.rows - 2,
		);
		const contentRows = Math.max(
			1,
			budget - TITLE_ROWS - HINT_ROWS - BORDER_VERTICAL_OVERHEAD,
		);
		this.page = contentRows;
		this.maxRow = Math.max(0, lines.length - contentRows);
		this.maxCol = Math.max(0, widest(lines) - inner);
		this.row = clamp(this.row, 0, this.maxRow);
		this.col = clamp(this.col, 0, this.maxCol);
		const visible = lines
			.slice(this.row, this.row + contentRows)
			.map((line) => sliceByColumn(line, this.col, inner));
		const boxed = renderBorderedBox(visible, width, (text) =>
			this.theme.fg("accent", text),
		);
		const title = this.theme.bold(this.theme.fg("accent", this.label));
		return [
			title,
			...boxed,
			this.theme.fg("muted", this.hint(lines.length, contentRows)),
		];
	}

	private body(innerWidth: number): string[] {
		if (this.cachedWidth !== innerWidth) {
			this.markdown.invalidate();
			this.cachedLines = stripFenceMarkers(this.markdown.render(innerWidth));
			this.cachedWidth = innerWidth;
		}
		return this.cachedLines.length > 0 ? this.cachedLines : [""];
	}

	private hint(total: number, visible: number): string {
		const base = t("preview.modal_hint", "↑↓ ←→ scroll · Esc close");
		if (total <= visible && this.maxCol === 0) return base;
		const end = Math.min(total, this.row + visible);
		return `${base} · ${this.row + 1}-${end}/${total}`;
	}

	private isClose(data: string): boolean {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("p")))
			return true;
		return (
			this.closeKey !== undefined &&
			this.closeKey !== "off" &&
			matchesKey(data, this.closeKey as Parameters<typeof matchesKey>[1])
		);
	}
}

function widest(lines: readonly string[]): number {
	let width = 0;
	for (const line of lines) width = Math.max(width, visibleWidth(line));
	return width;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
