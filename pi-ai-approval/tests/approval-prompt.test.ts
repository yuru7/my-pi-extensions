import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	APPROVAL_CHOICES,
	ApprovalQueue,
	buildApprovalPrompt,
	EXPANSION_HINT,
	fencedCode,
	ringTerminalBell,
	sanitizeExpandedCommand,
	sanitizePromptField,
	showApprovalPrompt,
} from "../src/approval-prompt.ts";
import { ApprovalDialog } from "../src/approval-dialog.ts";
import type { ReviewAction, RiskAssessment, RiskLevel } from "../src/review.ts";

initTheme("dark");

const action: ReviewAction = {
	tool: "bash",
	cwd: "/repo",
	payload: { command: "git reset --hard HEAD~1" },
};

const assessment: RiskAssessment = {
	risk_level: "medium",
	instruction_alignment: "direct",
	action_summary:
		"Force-resets the current branch one commit back and discards uncommitted changes.",
	rationale:
		"Uncommitted changes may be lost, so recovery costs more than a normal file edit.",
};

const assessor = "openai-codex/gpt-5.6-luna (Primary)";

function ctxWithSelect(
	select: (title: string, options: string[]) => Promise<string | undefined>,
	signal?: AbortSignal,
): ExtensionContext {
	return {
		mode: "rpc",
		ui: {
			select: async (title: string, options: string[]) =>
				select(title, options),
		},
		signal,
	} as unknown as ExtensionContext;
}

interface TuiHarness {
	ctx: ExtensionContext;
	dialog: () => ApprovalDialog;
	decide: (choice: string | undefined) => void;
	opened: () => number;
}

function ctxWithCustom(
	options: { rows?: number; signal?: AbortSignal; fail?: Error } = {},
): TuiHarness {
	let dialog: ApprovalDialog | undefined;
	let decide: ((choice: string | undefined) => void) | undefined;
	let opened = 0;
	const ctx = {
		mode: "tui",
		ui: {
			select: async () => {
				throw new Error("TUI mode must use the custom dialog");
			},
			custom: async (
				factory: (
					tui: TUI,
					theme: unknown,
					keybindings: unknown,
					done: (choice: string | undefined) => void,
				) => ApprovalDialog,
			) => {
				opened++;
				if (options.fail) throw options.fail;
				return new Promise<string | undefined>((resolve) => {
					decide = resolve;
					dialog = factory(
						{
							terminal: { rows: options.rows ?? 24 },
							requestRender: () => {},
						} as unknown as TUI,
						{
							fg: (_color: string, text: string) => text,
							bold: (text: string) => text,
						},
						{},
						resolve,
					);
				});
			},
		},
		signal: options.signal,
	} as unknown as ExtensionContext;
	return {
		ctx,
		dialog: () => dialog as ApprovalDialog,
		decide: (choice) => decide?.(choice),
		opened: () => opened,
	};
}

test("keeps the fixed Deny/Approve choice order with Deny first", async () => {
	assert.deepEqual([...APPROVAL_CHOICES], ["Deny", "Approve"]);
	let seenOptions: string[] | undefined;
	const ctx = ctxWithSelect((_title, options) => {
		seenOptions = options;
		return Promise.resolve(undefined);
	});
	await showApprovalPrompt(action, assessment, assessor, ctx);
	assert.deepEqual(seenOptions, ["Deny", "Approve"]);
});

test("builds the approval prompt title and body document", () => {
	const { title, markdown } = buildApprovalPrompt(
		action,
		assessment,
		assessor,
	);
	assert.equal(title, "Approval Required");
	assert.doesNotMatch(markdown, /Approval Required/);
	assert.equal(
		markdown,
		[
			"**Risk: Medium**",
			"",
			"Review Information:",
			`- Risk Assessor: ${assessor}`,
			"- Instruction Alignment: direct",
			"",
			"Operation (tool: bash):",
			"",
			"```bash",
			"$ git reset --hard HEAD~1",
			"```",
			"",
			"Operation Summary:",
			"Force-resets the current branch one commit back and discards uncommitted changes.",
			"",
			"Reason:",
			"Uncommitted changes may be lost, so recovery costs more than a normal file edit.",
		].join("\n"),
	);
	assert.doesNotMatch(markdown, /Proceed\?/);

	const unattributed = buildApprovalPrompt(action, assessment).markdown;
	assert.doesNotMatch(unattributed, /Risk Assessor:/);
	assert.match(unattributed, /- Instruction Alignment: direct/);
});

test("labels the operation code block for shell tools only", () => {
	const bash = buildApprovalPrompt(action, assessment, assessor).markdown;
	assert.match(bash, /```bash/);
	assert.match(bash, /Operation \(tool: bash\):/);

	const powershell: ReviewAction = {
		tool: "powershell",
		cwd: "C:\\repo",
		payload: { command: "Get-ChildItem -Force" },
	};
	const ps = buildApprovalPrompt(powershell, assessment, assessor).markdown;
	assert.match(ps, /```powershell\nPS> Get-ChildItem -Force\n```/);
	assert.match(ps, /Operation \(tool: powershell\):/);

	const write: ReviewAction = {
		tool: "write",
		cwd: "/repo",
		payload: { path: "/repo/out.txt" },
	};
	const writePrompt = buildApprovalPrompt(write, assessment, assessor).markdown;
	assert.match(writePrompt, /```\nwrite \/repo\/out\.txt\n```/);
	assert.match(writePrompt, /Operation \(tool: write\):/);
});

/** Command whose folded form crosses the 300-character preview cut. */
const longCommandAction: ReviewAction = {
	tool: "bash",
	cwd: "/repo",
	payload: {
		command: [
			"set -e",
			"echo one",
			...Array.from({ length: 30 }, () => "echo padding-line"),
			"tail-marker",
		].join("\n"),
	},
};

test("offers the whole command only when the preview was cut short", () => {
	// A command that fits keeps the document as it was, with no expansion.
	const fitting = buildApprovalPrompt(action, assessment, assessor, {
		expandable: true,
	});
	assert.equal(fitting.expansion, undefined);
	assert.doesNotMatch(fitting.markdown, /ctrl\+o/);
	assert.match(fitting.markdown, /\$ git reset --hard HEAD~1/);

	const cut = buildApprovalPrompt(longCommandAction, assessment, assessor, {
		expandable: true,
	});
	assert.match(cut.markdown, /\.\.\. \(truncated, ctrl\+o to expand\)/);
	assert.doesNotMatch(cut.markdown, /tail-marker/);

	const expansion = cut.expansion;
	assert.ok(expansion, "a cut command carries the expanded document");
	assert.equal(expansion.marker, EXPANSION_HINT);
	assert.match(expansion.markdown, /\$ set -e\necho one\n/);
	assert.match(expansion.markdown, /tail-marker/);
	assert.doesNotMatch(expansion.markdown, /ctrl\+o/);
	for (const section of [
		"**Risk: Medium**",
		"Review Information:",
		"Operation Summary:",
		"Reason:",
	]) {
		assert.ok(
			expansion.markdown.includes(section),
			`${section} stays in the expanded document`,
		);
	}
});

test("leaves the plain truncation marker where nothing can expand", () => {
	const plain = buildApprovalPrompt(longCommandAction, assessment, assessor);
	assert.match(plain.markdown, /… \[truncated\]/);
	assert.doesNotMatch(plain.markdown, /ctrl\+o/);
	assert.equal(plain.expansion, undefined);

	// Only shell commands have an expanded form, however long a path gets.
	const read: ReviewAction = {
		tool: "read",
		cwd: "/repo",
		payload: { path: `/${"d/".repeat(120)}file.txt` },
	};
	const readPrompt = buildApprovalPrompt(read, assessment, assessor, {
		expandable: true,
	});
	assert.match(readPrompt.markdown, /… \[truncated\]/);
	assert.equal(readPrompt.expansion, undefined);
});

test("sanitizes the expanded command while keeping its line breaks", () => {
	assert.equal(
		sanitizeExpandedCommand(`printf 'a'\u001b[31mb\u0007\nrm -rf /\r\n tail`),
		"printf 'a' [31mb \nrm -rf / \n tail",
	);
	assert.doesNotMatch(sanitizeExpandedCommand("\u001b[2Jrm -rf /"), /\u001b/);
	// Only control characters change: the command keeps its own spacing.
	assert.equal(sanitizeExpandedCommand("\n\n  echo ok  \n"), "\n\n  echo ok  \n");
});

test("expands the command byte for byte", () => {
	const command = `\n  ${["echo padding-line", ...Array.from({ length: 30 }, () => "echo padding-line")].join("\n  ")}\ntail-marker\n`;
	const { expansion } = buildApprovalPrompt(
		{ tool: "bash", cwd: "/repo", payload: { command } },
		assessment,
		assessor,
		{ expandable: true },
	);
	assert.ok(expansion);
	assert.match(expansion.markdown, /\$ \n  echo padding-line\n/);
	assert.match(expansion.markdown, /tail-marker\n\n```/);
});

test("an expanded command cannot close its own code fence", () => {
	const command = [
		"echo ```tick```",
		...Array.from({ length: 20 }, () => "echo padding-line"),
		"echo done",
	].join("\n");
	const { markdown, expansion } = buildApprovalPrompt(
		{ tool: "bash", cwd: "/repo", payload: { command } },
		assessment,
		assessor,
		{ expandable: true },
	);
	assert.ok(expansion);
	assert.match(expansion.markdown, /^````bash$/m);
	assert.match(expansion.markdown, /echo ```tick```/);
	assert.match(markdown, /^````bash$/m, "the collapsed fence is lengthened too");
});

test("offers expansion in the TUI and not to a selector", async () => {
	let selectTitle: string | undefined;
	await showApprovalPrompt(
		longCommandAction,
		assessment,
		assessor,
		ctxWithSelect((title) => {
			selectTitle = title;
			return Promise.resolve("Deny");
		}),
	);
	assert.ok(selectTitle, "the selector was asked");
	assert.match(selectTitle, /… \[truncated\]/);
	assert.doesNotMatch(selectTitle, /ctrl\+o/);

	const tui = ctxWithCustom({ rows: 40 });
	const pending = showApprovalPrompt(
		longCommandAction,
		assessment,
		assessor,
		tui.ctx,
	);
	const rendered = tui.dialog().render(200).join("\n");
	assert.match(rendered, /\(truncated, ctrl\+o to expand\)/);
	tui.decide("Deny");
	assert.deepEqual(await pending, { kind: "declined" });
});

test("keeps a value containing backticks from closing the fence early", () => {
	assert.equal(
		fencedCode("echo ```tick```", "bash"),
		"````bash\necho ```tick```\n````",
	);
	assert.equal(fencedCode("plain", "bash"), "```bash\nplain\n```");
	assert.equal(fencedCode("plain"), "```\nplain\n```");
});

test("sanitizes the tool name in the operation label", () => {
	const hostile: ReviewAction = {
		tool: "evil\n\ttool\u001b[31m",
		cwd: "/repo",
		payload: { path: "/repo/out.txt" },
	};
	const { markdown } = buildApprovalPrompt(hostile, assessment);
	assert.match(markdown, /Operation \(tool: evil tool \[31m\):/);
	assert.doesNotMatch(markdown, /\u001b/);
});

test("routes the same document to the TUI dialog and to ui.select", async () => {
	const expected = buildApprovalPrompt(action, assessment, assessor);

	let selectTitle: string | undefined;
	const selectCtx = ctxWithSelect((title) => {
		selectTitle = title;
		return Promise.resolve("Deny");
	});
	await showApprovalPrompt(action, assessment, assessor, selectCtx);
	assert.equal(selectTitle, `${expected.title}\n\n${expected.markdown}`);

	const tui = ctxWithCustom({ rows: 40 });
	const pending = showApprovalPrompt(action, assessment, assessor, tui.ctx);
	const tuiText = tui.dialog().render(70).join("\n");
	assert.match(tuiText, /Operation Summary:/);
	assert.match(tuiText, /─── Approval Required ─/);
	tui.decide("Deny");
	assert.deepEqual(await pending, { kind: "declined" });
});

test("emphasizes elevated risk with a theme color", () => {
	const emphasis = (level: RiskLevel) =>
		buildApprovalPrompt(action, { ...assessment, risk_level: level }, assessor)
			.emphasis;

	assert.equal(emphasis("medium")?.text, "Risk: Medium");
	assert.equal(emphasis("medium")?.color, "warning");
	assert.equal(emphasis("high")?.color, "warning");
	assert.equal(emphasis("very_high")?.color, "error");
	assert.equal(emphasis("critical")?.color, "error");
	assert.equal(emphasis("low"), undefined);
	assert.equal(emphasis("very_low"), undefined);
});

test("strips control characters and ANSI escapes from interpolated values", () => {
	const hostile = {
		...assessment,
		action_summary: "a\u001b[31mb\u0007c\u001b]8;;https://evil.example\u0007d",
		rationale: "line one\nline two",
	};
	const { markdown } = buildApprovalPrompt(action, hostile);
	assert.doesNotMatch(markdown, /\u001b/);
	assert.match(markdown, /a \[31mb c ]8;;https:\/\/evil\.example d/);
	// Newlines in a value are folded so they cannot invent new Markdown blocks.
	assert.match(markdown, /Reason:\nline one line two/);
	assert.equal(sanitizePromptField("\u0000\u009b"), "");
});

test("bounds interpolated values with an explicit truncation marker", () => {
	const bounded = buildApprovalPrompt(action, {
		risk_level: "high",
		instruction_alignment: "unrelated",
		action_summary: "x".repeat(1_000),
		rationale: "y".repeat(1_000),
	}).markdown;
	assert.match(bounded, /… \[truncated\]/);
	assert.ok(bounded.length < 1_400);

	assert.equal(sanitizePromptField("x".repeat(500)), `${"x".repeat(400)}… [truncated]`);
	assert.equal(sanitizePromptField("y".repeat(400)).endsWith("[truncated]"), false);
});

test("Approve approves only after an explicit user selection", async () => {
	const ctx = ctxWithSelect(() => Promise.resolve("Approve"));
	assert.deepEqual(
		await showApprovalPrompt(action, assessment, assessor, ctx),
		{ kind: "approved" },
	);
});

test("Deny and Esc (undefined) fail closed", async () => {
	const noCtx = ctxWithSelect(() => Promise.resolve("Deny"));
	assert.deepEqual(await showApprovalPrompt(action, assessment, assessor, noCtx), {
		kind: "declined",
	});

	const escCtx = ctxWithSelect(() => Promise.resolve(undefined));
	assert.deepEqual(
		await showApprovalPrompt(action, assessment, assessor, escCtx),
		{ kind: "declined" },
	);
});

test("an unrecognized choice fails closed instead of approving", async () => {
	for (const choice of ["Yes", "No", "approve", ""]) {
		const ctx = ctxWithSelect(() => Promise.resolve(choice));
		assert.deepEqual(
			await showApprovalPrompt(action, assessment, assessor, ctx),
			{ kind: "declined" },
			`choice ${JSON.stringify(choice)} must not approve`,
		);
	}
});

test("an unavailable UI fails closed with a diagnostic detail", async () => {
	const ctx = ctxWithSelect(() => Promise.reject(new Error("no TTY")));
	assert.deepEqual(await showApprovalPrompt(action, assessment, assessor, ctx), {
		kind: "declined",
		detail: "Approval UI unavailable: no TTY",
	});
});

test("TUI mode opens the scrollable dialog and maps its choice", async () => {
	const accepted = ctxWithCustom({ rows: 40 });
	const pending = showApprovalPrompt(action, assessment, assessor, accepted.ctx);
	assert.ok(accepted.dialog() instanceof ApprovalDialog);
	assert.equal(accepted.opened(), 1);
	const text = accepted.dialog().render(70).join("\n");
	assert.match(text, /Approval Required/);
	assert.match(text, /Risk: Medium/);
	assert.match(text, /Risk Assessor: openai-codex\/gpt-5\.6-luna \(Primary\)/);
	assert.match(text, /Operation Summary:/);
	assert.match(text, /git reset --hard HEAD~1/);
	accepted.decide("Approve");
	assert.deepEqual(await pending, { kind: "approved" });

	const cancelled = ctxWithCustom({ rows: 24 });
	const declined = showApprovalPrompt(action, assessment, assessor, cancelled.ctx);
	cancelled.dialog().handleInput("\x1b");
	assert.deepEqual(await declined, { kind: "declined" });
});

test("the TUI dialog fails closed on abort, missing UI, and errors", async () => {
	const controller = new AbortController();
	const aborting = ctxWithCustom({ rows: 24, signal: controller.signal });
	const aborted = showApprovalPrompt(action, assessment, assessor, aborting.ctx);
	controller.abort();
	assert.deepEqual(await aborted, { kind: "declined" });

	const preAborted = ctxWithCustom({
		rows: 24,
		signal: AbortSignal.abort(),
	});
	assert.deepEqual(
		await showApprovalPrompt(action, assessment, assessor, preAborted.ctx),
		{
			kind: "declined",
			detail: "Approval prompt was cancelled before it could be shown.",
		},
	);
	assert.equal(preAborted.opened(), 0);

	const failing = ctxWithCustom({ rows: 24, fail: new Error("no TTY") });
	assert.deepEqual(
		await showApprovalPrompt(action, assessment, assessor, failing.ctx),
		{ kind: "declined", detail: "Approval UI unavailable: no TTY" },
	);

	const unavailable = {
		mode: "tui",
		ui: { custom: async () => undefined },
	} as unknown as ExtensionContext;
	assert.deepEqual(
		await showApprovalPrompt(action, assessment, assessor, unavailable),
		{ kind: "declined" },
	);
});

test("a signal aborted while queued declines without opening the prompt", async () => {
	const controller = new AbortController();
	controller.abort();
	let selectCalls = 0;
	const ctx = ctxWithSelect(() => {
		selectCalls++;
		return Promise.resolve("Approve");
	}, controller.signal);
	assert.deepEqual(await showApprovalPrompt(action, assessment, assessor, ctx), {
		kind: "declined",
		detail: "Approval prompt was cancelled before it could be shown.",
	});
	assert.equal(selectCalls, 0);
});

test("approval queue serializes overlapping prompts", async () => {
	const queue = new ApprovalQueue();
	const events: string[] = [];
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let firstEntered = false;
	let secondEntered = false;

	const first = queue.runExclusive(async () => {
		firstEntered = true;
		events.push("first:start");
		await firstGate;
		events.push("first:end");
	});
	const second = queue.runExclusive(async () => {
		secondEntered = true;
		events.push("second:start");
	});
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(firstEntered, true);
	assert.equal(secondEntered, false, "second prompt must wait for the first");
	releaseFirst();
	await first;
	await second;
	assert.equal(secondEntered, true);
	assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});

test("approval queue keeps running after a failing task", async () => {
	const queue = new ApprovalQueue();
	await assert.rejects(
		queue.runExclusive(async () => {
			throw new Error("boom");
		}),
		/boom/,
	);
	let ran = false;
	await queue.runExclusive(async () => {
		ran = true;
	});
	assert.equal(ran, true);
});

test("ringTerminalBell writes BEL only in TUI mode on a TTY", () => {
	const writes: string[] = [];
	ringTerminalBell("tui", {
		isTTY: true,
		write: (data: string) => {
			writes.push(data);
		},
	});
	assert.deepEqual(writes, ["\x07"]);
});

test("ringTerminalBell stays silent outside TUI mode or without a TTY", () => {
	for (const [mode, isTTY] of [
		["rpc", true],
		["print", true],
		["json", true],
		["tui", false],
		["tui", undefined],
	] as const) {
		let calls = 0;
		ringTerminalBell(mode, {
			isTTY,
			write: () => {
				calls++;
			},
		});
		assert.equal(calls, 0, `mode=${mode} isTTY=${isTTY}`);
	}
});

test("ringTerminalBell never throws when the output fails", () => {
	assert.doesNotThrow(() =>
		ringTerminalBell("tui", {
			isTTY: true,
			write: () => {
				throw new Error("EIO");
			},
		}),
	);
});
