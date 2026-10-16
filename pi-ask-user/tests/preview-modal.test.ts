import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, type MarkdownTheme, matchesKey } from "@earendil-works/pi-tui";
import { routeKey } from "../src/state/key-router.ts";
import { reduce } from "../src/state/state-reducer.ts";
import type {
	QuestionnaireRuntime,
	QuestionnaireState,
} from "../src/state/state.ts";
import type { QuestionData } from "../src/tool/types.ts";
import { PreviewModal } from "../src/view/preview-modal.ts";

const CTRL_P = "\x10";

function identityMarkdownTheme(): MarkdownTheme {
	const id = (text: string) => text;
	return {
		heading: id,
		link: id,
		linkUrl: id,
		code: id,
		codeBlock: id,
		codeBlockBorder: id,
		quote: id,
		quoteBorder: id,
		hr: id,
		listBullet: id,
		bold: id,
		italic: id,
		strikethrough: id,
		underline: id,
	};
}

const question: QuestionData = {
	question: "Which layout?",
	header: "Layout",
	options: [
		{
			label: "Wide",
			description: "Side by side",
			preview: "```\n+---+\n| A |\n+---+\n```",
		},
		{ label: "Narrow", description: "Stacked" },
	],
};

function state(patch: Partial<QuestionnaireState> = {}): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		notesByTab: new Map(),
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
		...patch,
	};
}

function runtime(
	optionIndex: number,
	patch: Partial<QuestionnaireRuntime> = {},
): QuestionnaireRuntime {
	const option = question.options[optionIndex];
	return {
		keybindings: { matches: () => false },
		inputBuffer: "",
		canMoveInputUp: false,
		canMoveInputDown: false,
		questions: [question],
		isMulti: false,
		currentItem: option
			? { kind: "option", label: option.label, description: option.description }
			: undefined,
		items: question.options.map((item) => ({
			kind: "option" as const,
			label: item.label,
		})),
		collapseKey: "ctrl+o",
		...patch,
	};
}

test("ctrl+p opens the focused option preview", () => {
	assert.equal(matchesKey(CTRL_P, Key.ctrl("p")), true);
	const action = routeKey(CTRL_P, state(), runtime(0));
	assert.deepEqual(action, {
		kind: "open_preview",
		label: "Wide",
		preview: question.options[0]?.preview,
	});
	const applied = reduce(state(), action, {
		questions: [question],
		itemsByTab: [runtime(0).items],
	});
	assert.equal(applied.state.optionIndex, 0);
	assert.deepEqual(applied.effects, [
		{
			kind: "open_preview",
			label: "Wide",
			preview: question.options[0]?.preview,
		},
	]);
});

test("ctrl+p does nothing without a preview, while typing, or while collapsed", () => {
	assert.equal(
		routeKey(CTRL_P, state({ optionIndex: 1 }), runtime(1)).kind,
		"ignore",
	);
	assert.equal(
		routeKey(CTRL_P, state({ notesVisible: true }), runtime(0)).kind,
		"notes_forward",
	);
	assert.equal(
		routeKey(CTRL_P, state({ collapsed: true }), runtime(0)).kind,
		"ignore",
	);
});

test("the preview modal scrolls vertically and closes on esc", () => {
	const rows = Array.from({ length: 30 }, (_, index) => `row-${index}`).join(
		"\n",
	);
	let renders = 0;
	let closed = false;
	const modal = new PreviewModal({
		host: {
			terminal: { rows: 16 },
			requestRender: () => {
				renders += 1;
			},
		},
		theme: {
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		} as Theme,
		markdownTheme: identityMarkdownTheme(),
		label: "Wide",
		preview: `\`\`\`\n${rows}\n\`\`\``,
		onClose: () => {
			closed = true;
		},
	});
	const first = modal.render(40).join("\n");
	assert.match(first, /row-0/);
	assert.doesNotMatch(first, /row-29/);
	modal.handleInput("\x1b[B");
	assert.equal(renders, 1);
	const next = modal.render(40).join("\n");
	assert.notEqual(next, first);
	assert.match(next, /1-|\d+-\d+\/\d+/);
	modal.handleInput("\x1b");
	assert.equal(closed, true);
});
