import assert from "node:assert/strict";
import test from "node:test";
import {
	getMarkdownTheme,
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	visibleWidth,
	type MarkdownTheme,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { ApprovalDialog } from "../src/approval-dialog.ts";
import { buildApprovalPrompt } from "../src/approval-prompt.ts";
import type { ReviewAction, RiskAssessment } from "../src/review.ts";

initTheme("dark");

/** Color-free theme stub: assertions target the text, not the styling. */
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const action: ReviewAction = {
	tool: "bash",
	cwd: "/repo",
	payload: { command: "pnpm install --offline" },
};

/** Command whose folded form passes the 300-character preview cut. */
const longCommand: ReviewAction = {
	tool: "bash",
	cwd: "/repo",
	payload: {
		command: [
			"set -e",
			"echo one",
			"rm -rf ./build",
			...Array.from({ length: 30 }, () => "echo padding-line"),
			"tail-marker",
		].join("\n"),
	},
};

const assessment: RiskAssessment = {
	risk_level: "medium",
	instruction_alignment: "implied",
	action_summary: "Runs an offline install and rewrites lockfiles.",
	rationale: `Long body: ${"x".repeat(1_200)}`,
};

const KEY = {
	shiftDown: "\x1b[1;2B",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
};

function mouse(overrides: Partial<TuiMouseEvent>): TuiMouseEvent {
	return {
		type: "move",
		button: "none",
		x: 5,
		y: 1,
		screenX: 5,
		screenY: 20,
		width: 70,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	};
}

interface DialogHarness {
	dialog: ApprovalDialog;
	choices: (string | undefined)[];
	render(width?: number): string[];
}

function harness(
	options: {
		rows?: number;
		action?: ReviewAction;
		assessment?: RiskAssessment;
		expandable?: boolean;
		scrollbarHideDelayMs?: number;
		theme?: Theme;
		markdownTheme?: MarkdownTheme;
		timeoutMs?: number;
		now?: () => number;
		schedule?: (callback: () => void, delayMs: number) => () => void;
	} = {},
): DialogHarness {
	const choices: (string | undefined)[] = [];
	const prompt = buildApprovalPrompt(
		options.action ?? action,
		options.assessment ?? assessment,
		"openai-codex/gpt-5.6-luna (Primary)",
		{ expandable: options.expandable },
	);
	const dialog = new ApprovalDialog({
		markdown: prompt.markdown,
		title: prompt.title,
		emphasis: prompt.emphasis,
		expansion: prompt.expansion,
		choices: ["Deny", "Approve"],
		theme: options.theme ?? theme,
		markdownTheme: options.markdownTheme ?? getMarkdownTheme(),
		rows: () => options.rows ?? 40,
		requestRender: () => {},
		onDecision: (choice) => choices.push(choice),
		scrollbarHideDelayMs: options.scrollbarHideDelayMs,
		timeoutMs: options.timeoutMs,
		now: options.now,
		schedule: options.schedule,
	});
	return {
		dialog,
		choices,
		render: (width = 70) => dialog.render(width),
	};
}

test("renders the prompt document and pinned choices when it fits", () => {
	const { dialog, render } = harness({ rows: 40 });
	const lines = render();
	const text = lines.join("\n");

	// Headings and bold are rendered, not shown as Markdown markers.
	assert.match(text, /Approval Required/);
	assert.doesNotMatch(text, /#/);
	assert.doesNotMatch(text, /\*\*/);
	assert.match(text, /Risk: Medium/);
	assert.match(text, /Review Information:/);
	assert.match(text, /Risk Assessor: openai-codex\/gpt-5\.6-luna \(Primary\)/);
	assert.match(text, /Instruction Alignment: implied/);
	assert.match(text, /Operation \(tool: bash\):/);
	assert.match(text, /```bash/);
	assert.match(text, /\$ pnpm install --offline/);
	assert.match(text, /Operation Summary:/);
	assert.match(text, /Reason:/);
	assert.doesNotMatch(text, /Proceed\?/);

	// "Deny" stays preselected and the controls are pinned to the bottom.
	assert.equal(dialog.selectedChoice, "Deny");
	assert.match(lines[lines.length - 3] ?? "", /→ Deny/);
	assert.match(lines[lines.length - 2] ?? "", /Approve$/);
	assert.match(lines[lines.length - 1] ?? "", /enter confirm/);

	// Nothing overflows: no hint and no scrollbar.
	assert.doesNotMatch(text, /more lines/);
	assert.doesNotMatch(text, /[┃│]/);
});

test("draws a full-width rule carrying the prompt title above the body", () => {
	const { render } = harness({ rows: 40 });
	for (const width of [40, 70, 120]) {
		const rule = stripTerminalSequences(render(width)[0] ?? "");
		assert.equal(visibleWidth(rule), width);
		assert.match(rule, /^─── Approval Required ─+$/);
	}

	// The rule stays fixed on top even when the body is capped and scrolling.
	const short = harness({ rows: 16 });
	const lines = short.render();
	const rule = stripTerminalSequences(lines[0] ?? "");
	assert.equal(visibleWidth(rule), 70);
	assert.match(rule, /^─── Approval Required ─+$/);
	assert.ok(lines.length <= 10, `expected a capped height, got ${lines.length}`);
});

test("draws a plain full-width rule when the dialog has no title", () => {
	const dialog = new ApprovalDialog({
		markdown: "**Risk: Medium**",
		choices: ["Deny", "Approve"],
		theme,
		markdownTheme: getMarkdownTheme(),
		rows: () => 40,
		requestRender: () => {},
		onDecision: () => {},
	});
	for (const width of [40, 70]) {
		const rule = stripTerminalSequences(dialog.render(width)[0] ?? "");
		assert.equal(rule, "─".repeat(width));
	}
});

test("caps the height and scrolls the body when the terminal is short", () => {
	const { dialog, render } = harness({ rows: 16 });
	const first = render();
	assert.ok(first.length <= 10, `expected a capped height, got ${first.length}`);
	assert.match(first.join("\n"), /more lines$/m);

	dialog.handleInput(KEY.shiftDown);
	assert.ok(dialog.scrollTop > 0, "shift+down must scroll the body");

	const scrolled = render();
	assert.notDeepEqual(scrolled, first);
	assert.ok(scrolled.length <= 10);
	assert.match(
		scrolled.join("\n"),
		/┃/,
		"the transient scrollbar is painted while scrolling",
	);
	// The controls stay pinned and visible while the body moves.
	assert.match(scrolled[scrolled.length - 3] ?? "", /→ Deny/);
	assert.match(scrolled[scrolled.length - 2] ?? "", /Approve$/);
	assert.match(scrolled[scrolled.length - 1] ?? "", /enter confirm/);
});

test("scrolls by page and clamps at both ends", () => {
	const { dialog, render } = harness({ rows: 16 });
	render(); // first frame: the app renders before any key arrives
	dialog.handleInput(KEY.pageUp);
	assert.equal(dialog.scrollTop, 0);

	for (let i = 0; i < 50; i++) dialog.handleInput(KEY.pageDown);
	const end = dialog.scrollTop;
	assert.ok(end > 1, "paging must reach the end of the body");

	dialog.handleInput(KEY.pageDown);
	assert.equal(dialog.scrollTop, end, "scrolling past the end is clamped");
	assert.match(render().join("\n"), /0 more lines/);

	dialog.handleInput(KEY.home);
	assert.equal(dialog.scrollTop, 0);
	dialog.handleInput(KEY.end);
	assert.equal(dialog.scrollTop, end, "end reaches the last body line");
});

test("hovering the scrollbar track shows it only transiently", async () => {
	const { dialog, render } = harness({ rows: 16, scrollbarHideDelayMs: 50 });
	assert.doesNotMatch(render().join("\n"), /[┃│]/);

	const hover = dialog.handleMouse(mouse({ type: "move", x: 69, y: 1 }));
	assert.deepEqual(hover, { handled: true, render: true });
	assert.match(render().join("\n"), /[┃│]/);

	// Moving away never latches the scrollbar on.
	assert.equal(dialog.handleMouse(mouse({ type: "move", x: 5, y: 1 })), undefined);
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.doesNotMatch(render().join("\n"), /[┃│]/);
});

test("scrolls with the mouse wheel and ignores other mouse events", () => {
	const { dialog, render } = harness({ rows: 16 });
	render();
	assert.equal(dialog.handleMouse(mouse({ type: "press", button: "left" })), undefined);
	assert.equal(dialog.handleMouse(mouse({ type: "wheel" })), undefined);

	const result = dialog.handleMouse(mouse({ type: "wheel", wheelDelta: 2 }));
	assert.deepEqual(result, { handled: true, render: true });
	assert.equal(dialog.scrollTop, 2);

	const line = dialog.handleMouse(mouse({ type: "wheel", wheelDelta: -1 }));
	assert.deepEqual(line, { handled: true, render: true });
	assert.equal(dialog.scrollTop, 1);
});

/**
 * Harness for the expansion tests: a command long enough to be cut short, with
 * reviewer text short enough that nothing has to be scrolled into view.
 */
function expansionHarness(rows = 80): DialogHarness {
	return harness({
		rows,
		expandable: true,
		action: longCommand,
		assessment: { ...assessment, rationale: "Short reason that fits." },
	});
}

/** Rows that show the truncation marker, which a narrow dialog can split. */
function markerRows(lines: string[]): number[] {
	return lines
		.map((line, index) => ({ line: stripTerminalSequences(line), index }))
		.filter(
			({ line }) => line.includes("(truncated,") || line.includes("expand)"),
		)
		.map(({ index }) => index);
}

/** Column span a marker fragment covers on a rendered row, in plain columns. */
function markerSpan(
	line: string,
	fragment: string,
): { startX: number; endX: number } {
	const plain = stripTerminalSequences(line);
	const at = plain.lastIndexOf(fragment);
	assert.ok(at >= 0, `expected ${fragment} on the rendered row`);
	return {
		startX: visibleWidth(plain.slice(0, at)),
		endX: visibleWidth(plain.slice(0, at + fragment.length)),
	};
}

test("expands a cut-short operation with ctrl+o and collapses it again", () => {
	const { dialog, render } = expansionHarness();
	const rows = () => render(70).map(stripTerminalSequences);
	assert.doesNotMatch(rows().join("\n"), /more lines/);

	// Collapsed: the command is folded, cut, and marked.
	const collapsed = rows();
	assert.ok(
		collapsed.some((line) => line.includes("rm -rf ./build echo padding-line")),
		"the collapsed preview folds the command onto one line",
	);
	assert.ok(collapsed.some((line) => line.includes("(truncated,")));
	assert.ok(
		!collapsed.some((line) => line.includes("tail-marker")),
		"the collapsed preview hides the rest of the command",
	);

	dialog.handleInput("\x0f"); // ctrl+o
	const expanded = rows();
	assert.ok(
		expanded.some((line) => line.trim() === "$ set -e"),
		"the expanded command keeps its own line breaks",
	);
	assert.ok(expanded.some((line) => line.trim() === "rm -rf ./build"));
	assert.ok(expanded.some((line) => line.includes("tail-marker")));
	assert.ok(!expanded.some((line) => line.includes("(truncated,")));
	assert.ok(
		expanded.some((line) => line.includes("ctrl+o collapse")),
		"the help line names the way back while expanded",
	);

	dialog.handleInput("\x0f"); // ctrl+o again
	const recollapsed = rows();
	assert.ok(recollapsed.some((line) => line.includes("(truncated,")));
	assert.ok(!recollapsed.some((line) => line.includes("tail-marker")));
	assert.ok(!recollapsed.some((line) => line.includes("ctrl+o collapse")));
});

test("keeps the selected choice and the scroll offset across expansion", () => {
	const { dialog, render } = expansionHarness(16);
	render();
	dialog.handleInput("\x1b[B"); // down: Approve
	dialog.handleInput(KEY.shiftDown);
	const offset = dialog.scrollTop;
	assert.ok(offset > 0, "the short dialog scrolls");

	dialog.handleInput("\x0f"); // ctrl+o
	assert.equal(dialog.selectedChoice, "Approve");
	assert.equal(dialog.scrollTop, offset);
	render();
	assert.equal(dialog.selectedChoice, "Approve");
});

test("expands when the truncation marker is clicked, and only then", () => {
	const { dialog, render } = expansionHarness();
	const body = () => render(70).map(stripTerminalSequences).join("\n");
	const rows = render(70);
	const markerRow = markerRows(rows)[0];
	assert.ok(markerRow !== undefined, "the marker is rendered");
	const span = markerSpan(rows[markerRow], "(truncated,");
	assert.ok(span.startX > 0, "the marker starts after the cut command text");

	// Clicks that are not a left click on the marker change nothing: the command
	// text next to the marker, another button, and unrelated rows.
	assert.equal(
		dialog.handleMouse(
			mouse({ type: "click", button: "left", x: span.startX - 1, y: markerRow }),
		),
		undefined,
	);
	assert.equal(
		dialog.handleMouse(
			mouse({ type: "click", button: "right", x: span.startX, y: markerRow }),
		),
		undefined,
	);
	assert.equal(
		dialog.handleMouse(mouse({ type: "click", button: "left", x: 4, y: 1 })),
		undefined,
	);
	assert.ok(!body().includes("tail-marker"));

	assert.deepEqual(
		dialog.handleMouse(
			mouse({ type: "click", button: "left", x: span.startX, y: markerRow }),
		),
		{ handled: true, render: true },
	);
	assert.ok(body().includes("tail-marker"));
});

test("finds a truncation marker that a narrow dialog wraps across rows", () => {
	const split = expansionHarness().render(30).map(stripTerminalSequences);
	const headRow = split.findIndex((line) => line.includes("(truncated,"));
	const tailRow = split.findIndex((line) => line.includes("expand)"));
	assert.ok(headRow >= 0, "the narrow dialog still shows the head of the marker");
	assert.ok(
		tailRow > headRow,
		`expected the marker to wrap, got rows ${headRow} and ${tailRow}`,
	);

	// On the row that introduces the marker, the command text before it is inert
	// and the marker itself expands.
	const head = expansionHarness();
	const headSpan = markerSpan(head.render(30)[headRow], "(truncated,");
	assert.ok(headSpan.startX > 0, "the marker follows the cut command text");
	assert.equal(
		head.dialog.handleMouse(
			mouse({
				type: "click",
				button: "left",
				x: headSpan.startX - 1,
				y: headRow,
			}),
		),
		undefined,
	);
	assert.deepEqual(
		head.dialog.handleMouse(
			mouse(
				{ type: "click", button: "left", x: headSpan.startX, y: headRow },
			),
		),
		{ handled: true, render: true },
	);

	// The row the marker wraps onto is marker text from its first column, and one
	// column past its end is outside the marker again.
	const tail = expansionHarness();
	const tailSpan = markerSpan(tail.render(30)[tailRow], "expand)");
	assert.equal(
		tail.dialog.handleMouse(
			mouse({ type: "click", button: "left", x: tailSpan.endX, y: tailRow }),
		),
		undefined,
	);
	assert.deepEqual(
		tail.dialog.handleMouse(
			mouse({ type: "click", button: "left", x: 0, y: tailRow }),
		),
		{ handled: true, render: true },
	);
	assert.ok(
		tail
			.render(30)
			.map(stripTerminalSequences)
			.join("\n")
			.includes("tail-marker"),
		"clicking the wrapped marker expands the operation",
	);
});

test("ignores ctrl+o and marker clicks when there is nothing to expand", () => {
	const { dialog, render } = harness({ rows: 40 });
	const before = render(70);
	assert.ok(
		!before.some((line) => stripTerminalSequences(line).includes("(truncated,")),
		"a command that fits carries no marker",
	);

	dialog.handleInput("\x0f"); // ctrl+o
	assert.deepEqual(render(70), before);
	assert.equal(dialog.selectedChoice, "Deny");

	const rows = render(70);
	assert.equal(
		dialog.handleMouse(
			mouse({ type: "click", button: "left", x: 4, y: rows.length - 3 }),
		),
		undefined,
	);
	assert.deepEqual(render(70), before);
});

test("enter selects the highlighted choice, escape and abort cancel", () => {
	const accepted = harness({ rows: 40 });
	accepted.dialog.handleInput("\x1b[B");
	assert.equal(accepted.dialog.selectedChoice, "Approve");
	accepted.dialog.handleInput("\r");
	assert.deepEqual(accepted.choices, ["Approve"]);
	accepted.dialog.handleInput("\r");
	assert.deepEqual(accepted.choices, ["Approve"], "a decision is delivered once");

	const cancelled = harness({ rows: 40 });
	cancelled.dialog.handleInput("\x1b");
	assert.deepEqual(cancelled.choices, [undefined]);

	const interrupted = harness({ rows: 40 });
	interrupted.dialog.handleInput("\x03"); // ctrl+c cancels like the text selector
	assert.deepEqual(interrupted.choices, [undefined]);

	const aborted = harness({ rows: 40 });
	const controller = new AbortController();
	aborted.dialog.watchAbort(controller.signal);
	controller.abort();
	assert.deepEqual(aborted.choices, [undefined]);

	const preAborted = harness({ rows: 40 });
	const done = new AbortController();
	done.abort();
	preAborted.dialog.watchAbort(done.signal);
	assert.deepEqual(preAborted.choices, [undefined]);
});

test("renders reviewer values as Markdown after sanitizing them", () => {
	const hostile: RiskAssessment = {
		...assessment,
		action_summary: "**bold** and `code` and control\u001b[31mchars",
		rationale: "plain prose",
	};
	const { render } = harness({ rows: 40, assessment: hostile });
	const text = render().join("\n");

	// The value goes through the Markdown renderer like the rest of the document.
	assert.doesNotMatch(text, /\*\*bold\*\*/);
	assert.match(text, /bold/);
	assert.doesNotMatch(text, /`code`/);
	assert.match(text, /code/);
	// Terminal control sequences never survive into the prompt.
	assert.doesNotMatch(text, /\u001b\[31m/);
	assert.match(text, /control \[31mchars/);
});

test("renders the operation as a fenced code block with its language label", () => {
	const highlighted: { code: string; lang?: string }[] = [];
	const markdownTheme: MarkdownTheme = {
		...getMarkdownTheme(),
		highlightCode: (code, lang) => {
			highlighted.push({ code, lang });
			return code.split("\n");
		},
	};
	const bash = harness({ rows: 40, markdownTheme });
	const text = bash.render().join("\n");
	assert.deepEqual(highlighted, [{ code: "$ pnpm install --offline", lang: "bash" }]);
	assert.match(text, /```bash/);
	assert.match(text, /\$ pnpm install --offline/);

	// PowerShell operations are labelled with the PowerShell language.
	highlighted.length = 0;
	const powershell = new ApprovalDialog({
		markdown: buildApprovalPrompt(
			{
				tool: "powershell",
				cwd: "C:\\repo",
				payload: { command: "Get-ChildItem -Force" },
			},
			assessment,
			undefined,
		).markdown,
		title: "Approval Required",
		choices: ["Deny", "Approve"],
		theme,
		markdownTheme,
		rows: () => 40,
		requestRender: () => {},
		onDecision: () => {},
	});
	assert.match(powershell.render(70).join("\n"), /```powershell/);
	assert.deepEqual(highlighted, [
		{ code: "PS> Get-ChildItem -Force", lang: "powershell" },
	]);
});

test("colors the risk line so it survives terminals without bold", () => {
	const colors: string[] = [];
	const tagging = {
		fg: (color: string, text: string) => {
			colors.push(color);
			return `«${color}:${text}»`;
		},
		bold: (text: string) => `**${text}**`,
	} as unknown as Theme;
	const { render } = harness({ rows: 40, theme: tagging });
	const lines = render();
	const riskLine = lines.find((line) => line.includes("Risk: Medium")) ?? "";
	assert.match(riskLine, /«warning:/);
	assert.match(riskLine, /Risk: Medium/);
	assert.ok(colors.includes("warning"));
	assert.doesNotMatch(
		lines.find((line) => line.includes("Approval Required")) ?? "",
		/«warning:/,
		"only the risk line is emphasized",
	);
});

test("a fitting body never scrolls and every line fits the width", () => {
	const { dialog, render } = harness({
		rows: 60,
		assessment: { ...assessment, rationale: "short reason" },
	});
	const before = render();
	dialog.handleInput(KEY.pageDown);
	dialog.handleInput(KEY.shiftDown);
	assert.equal(dialog.scrollTop, 0);
	assert.deepEqual(render(), before);
	assert.doesNotMatch(render().join("\n"), /more lines/);

	for (const width of [40, 70, 120]) {
		for (const line of render(width)) {
			assert.ok(
				visibleWidth(line) <= width,
				`line exceeds width ${width}: ${JSON.stringify(line)}`,
			);
		}
	}
});

test("counts down an ask timeout and declines when it reaches zero", () => {
	let now = 1_000;
	const pending: Array<{ at: number; fn: () => void }> = [];
	const { dialog, choices, render } = harness({
		timeoutMs: 2_500,
		now: () => now,
		schedule: (fn, delay) => {
			const item = { at: now + delay, fn };
			pending.push(item);
			return () => {
				const index = pending.indexOf(item);
				if (index >= 0) pending.splice(index, 1);
			};
		},
	});
	const fire = () => {
		for (const item of pending.filter((entry) => entry.at <= now)) {
			const index = pending.indexOf(item);
			if (index < 0) continue;
			pending.splice(index, 1);
			item.fn();
		}
	};

	assert.match(render().join("\n"), /Times out in 3s/);
	assert.match(render().join("\n"), /enter confirm/);
	now = 1_500;
	fire();
	assert.match(render().join("\n"), /Times out in 2s/);
	assert.deepEqual(choices, []);

	now = 2_500;
	fire();
	assert.match(render().join("\n"), /Times out in 1s/);

	now = 3_500;
	fire();
	assert.deepEqual(choices, [undefined]);
	dialog.dispose();
	assert.equal(pending.length, 0);
});

test("an answer before the ask timeout cancels the countdown", () => {
	let now = 0;
	const pending: Array<{ at: number; fn: () => void }> = [];
	const { dialog, choices } = harness({
		timeoutMs: 5_000,
		now: () => now,
		schedule: (fn, delay) => {
			const item = { at: now + delay, fn };
			pending.push(item);
			return () => {
				const index = pending.indexOf(item);
				if (index >= 0) pending.splice(index, 1);
			};
		},
	});
	dialog.handleInput("\x1b[B");
	dialog.handleInput("\r");
	assert.deepEqual(choices, ["Approve"]);
	assert.equal(pending.length, 0);
	now = 10_000;
	assert.deepEqual(choices, ["Approve"]);
	dialog.dispose();
});
