import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	APPROVAL_CHOICES,
	ApprovalQueue,
	buildApprovalPrompt,
	showApprovalPrompt,
} from "../src/approval-prompt.ts";
import type { ReviewAction } from "../src/review.ts";

const action: ReviewAction = {
	tool: "bash",
	cwd: "/repo",
	payload: { command: "git reset --hard HEAD~1" },
};

const assessment = {
	risk_level: "medium" as const,
	instruction_alignment: "direct" as const,
	action_summary: "Force-resets the current branch one commit back and discards uncommitted changes.",
	rationale: "Uncommitted changes may be lost, so recovery costs more than a normal file edit.",
};

function ctxWithSelect(
	select: (title: string, options: string[]) => Promise<string | undefined>,
	signal?: AbortSignal,
): ExtensionContext {
	return {
		ui: {
			select: async (title: string, options: string[]) =>
				select(title, options),
		},
		signal,
	} as unknown as ExtensionContext;
}

test("keeps the fixed No/Yes choice order with No first", async () => {
	assert.deepEqual([...APPROVAL_CHOICES], ["No", "Yes"]);
	let seenOptions: string[] | undefined;
	const ctx = ctxWithSelect((_title, options) => {
		seenOptions = options;
		return Promise.resolve(undefined);
	});
	await showApprovalPrompt(action, assessment, "openai-codex/gpt-5.6-luna (Primary)", ctx);
	assert.deepEqual(seenOptions, ["No", "Yes"]);
});

test("builds the approval prompt with risk, operation, and AI explanation", () => {
	const prompt = buildApprovalPrompt(
		action,
		assessment,
		"openai-codex/gpt-5.6-luna (Primary)",
	);
	const lines = prompt.split("\n");
	assert.equal(lines[0], "Approval Required");
	assert.match(prompt, /^Risk Assessor: openai-codex\/gpt-5\.6-luna \(Primary\)$/m);
	assert.match(prompt, /^Risk: Medium$/m);
	assert.match(prompt, /^Instruction alignment: direct$/m);
	assert.match(prompt, /^Operation:$/m);
	assert.match(prompt, /^\$ git reset --hard HEAD~1$/m);
	assert.match(prompt, /^AI assessment:$/m);
	assert.match(prompt, /Force-resets the current branch one commit back/m);
	assert.match(prompt, /^Reason:$/m);
	assert.match(prompt, /Uncommitted changes may be lost/m);
	assert.match(prompt, /^Proceed\?$/m);

	const unattributed = buildApprovalPrompt(action, assessment);
	assert.doesNotMatch(unattributed, /Risk Assessor:/);
	assert.match(unattributed, /^Risk: Medium$/m);
});

test("Yes approves only after an explicit user selection", async () => {
	const ctx = ctxWithSelect(() => Promise.resolve("Yes"));
	assert.deepEqual(await showApprovalPrompt(action, assessment, "openai-codex/gpt-5.6-luna (Primary)", ctx), {
		kind: "approved",
	});
});

test("No and Esc (undefined) fail closed", async () => {
	const noCtx = ctxWithSelect(() => Promise.resolve("No"));
	assert.deepEqual(await showApprovalPrompt(action, assessment, "openai-codex/gpt-5.6-luna (Primary)", noCtx), {
		kind: "declined",
	});

	const escCtx = ctxWithSelect(() => Promise.resolve(undefined));
	assert.deepEqual(await showApprovalPrompt(action, assessment, "openai-codex/gpt-5.6-luna (Primary)", escCtx), {
		kind: "declined",
	});
});

test("an unavailable UI fails closed with a diagnostic detail", async () => {
	const ctx = ctxWithSelect(() => Promise.reject(new Error("no TTY")));
	assert.deepEqual(await showApprovalPrompt(action, assessment, "openai-codex/gpt-5.6-luna (Primary)", ctx), {
		kind: "declined",
		detail: "Approval UI unavailable: no TTY",
	});
});

test("a signal aborted while queued declines without opening the prompt", async () => {
	const controller = new AbortController();
	controller.abort();
	let selectCalls = 0;
	const ctx = ctxWithSelect(() => {
		selectCalls++;
		return Promise.resolve("Yes");
	}, controller.signal);
	assert.deepEqual(await showApprovalPrompt(action, assessment, "openai-codex/gpt-5.6-luna (Primary)", ctx), {
		kind: "declined",
		detail: "Approval prompt was cancelled before it could be shown.",
	});
	assert.equal(selectCalls, 0);
});

test("long AI text is bounded in the prompt with an explicit truncation marker", () => {
	const bounded = buildApprovalPrompt(action, {
		risk_level: "high",
		instruction_alignment: "unrelated",
		action_summary: "x".repeat(1_000),
		rationale: "y".repeat(1_000),
	});
	assert.match(bounded, /… \[truncated\]/);
	assert.ok(bounded.length < 1_200);
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
