import assert from "node:assert/strict";
import test from "node:test";
import {
	getMarkdownTheme,
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
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
		assessment?: RiskAssessment;
		scrollbarHideDelayMs?: number;
		theme?: Theme;
		markdownTheme?: MarkdownTheme;
	} = {},
): DialogHarness {
	const choices: (string | undefined)[] = [];
	const prompt = buildApprovalPrompt(
		action,
		options.assessment ?? assessment,
		"openai-codex/gpt-5.6-luna (Primary)",
	);
	const dialog = new ApprovalDialog({
		markdown: prompt.markdown,
		emphasis: prompt.emphasis,
		choices: ["No", "Yes"],
		theme: options.theme ?? theme,
		markdownTheme: options.markdownTheme ?? getMarkdownTheme(),
		rows: () => options.rows ?? 40,
		requestRender: () => {},
		onDecision: (choice) => choices.push(choice),
		scrollbarHideDelayMs: options.scrollbarHideDelayMs,
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
	assert.match(text, /Operation:/);
	assert.match(text, /```bash/);
	assert.match(text, /\$ pnpm install --offline/);
	assert.match(text, /Action Summary:/);
	assert.match(text, /Reason:/);
	assert.doesNotMatch(text, /Proceed\?/);

	// "No" stays preselected and the controls are pinned to the bottom.
	assert.equal(dialog.selectedChoice, "No");
	assert.match(lines[lines.length - 3] ?? "", /→ No/);
	assert.match(lines[lines.length - 2] ?? "", /Yes$/);
	assert.match(lines[lines.length - 1] ?? "", /enter confirm/);

	// Nothing overflows: no hint and no scrollbar.
	assert.doesNotMatch(text, /more lines/);
	assert.doesNotMatch(text, /[┃│]/);
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
	assert.match(scrolled[scrolled.length - 3] ?? "", /→ No/);
	assert.match(scrolled[scrolled.length - 2] ?? "", /Yes$/);
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

test("enter selects the highlighted choice, escape and abort cancel", () => {
	const accepted = harness({ rows: 40 });
	accepted.dialog.handleInput("\x1b[B");
	assert.equal(accepted.dialog.selectedChoice, "Yes");
	accepted.dialog.handleInput("\r");
	assert.deepEqual(accepted.choices, ["Yes"]);
	accepted.dialog.handleInput("\r");
	assert.deepEqual(accepted.choices, ["Yes"], "a decision is delivered once");

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
		choices: ["No", "Yes"],
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
