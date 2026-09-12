import assert from "node:assert/strict";
import test from "node:test";
import {
	formatActionPreview,
	shellCommandPreview,
} from "../src/review-presentation.ts";
import type { ReviewAction } from "../src/review.ts";

const shell = (value: string): ReviewAction => ({
	tool: "bash",
	cwd: "/repo",
	payload: { command: value },
});

/** Command whose folded form crosses the 300-character preview cut. */
const LONG_COMMAND = [
	"set -e",
	"echo one",
	...Array.from({ length: 30 }, () => "echo padding-line"),
	"tail-marker",
].join("\n");

const FOLDED = LONG_COMMAND.replace(/\s+/g, " ").trim();

test("describes the collapsed and expanded forms of a shell command", () => {
	assert.deepEqual(shellCommandPreview(shell("git status --short")), {
		collapsed: "$ git status --short",
		expanded: "$ git status --short",
		truncated: false,
	});

	const cut = shellCommandPreview(shell(LONG_COMMAND));
	assert.ok(cut, "a shell command has a preview");
	assert.equal(cut.truncated, true);
	assert.equal(cut.collapsed, `$ ${FOLDED.slice(0, 300)}`);
	assert.equal(cut.expanded, `$ ${LONG_COMMAND}`);
	assert.ok(!cut.collapsed.includes("tail-marker"), "the preview is cut short");
	assert.ok(cut.expanded.includes("tail-marker"), "the expanded form is whole");
	assert.ok(!cut.collapsed.includes("\n"), "the preview is folded onto one line");
	assert.ok(cut.expanded.includes("\n"), "the expanded form keeps line breaks");

	// PowerShell mirrors pi's own prompt prefix.
	assert.deepEqual(
		shellCommandPreview({
			tool: "powershell",
			cwd: "C:\\repo",
			payload: { command: "Get-ChildItem -Force" },
		}),
		{
			collapsed: "PS> Get-ChildItem -Force",
			expanded: "PS> Get-ChildItem -Force",
			truncated: false,
		},
	);
});

test("expands shell commands only", () => {
	for (const tool of ["write", "read", "grep", "ls"]) {
		assert.equal(
			shellCommandPreview({ tool, cwd: "/repo", payload: { path: "/repo/src" } }),
			undefined,
			`${tool} has no expanded command form`,
		);
	}
});

test("keeps the command untouched in the expanded form", () => {
	// Indentation and trailing newlines are part of what the user is judging.
	assert.deepEqual(shellCommandPreview(shell("\n\n  git status  \n")), {
		collapsed: "$ git status",
		expanded: "$ \n\n  git status  \n",
		truncated: false,
	});
});

test("marks a cut command in the transcript preview without promising a key", () => {
	const marked = formatActionPreview(shell(LONG_COMMAND));
	assert.equal(marked, `$ ${FOLDED.slice(0, 300)}… [truncated]`);
	assert.doesNotMatch(marked, /ctrl\+o/);
	assert.equal(
		formatActionPreview(shell("git status --short")),
		"$ git status --short",
	);
});
