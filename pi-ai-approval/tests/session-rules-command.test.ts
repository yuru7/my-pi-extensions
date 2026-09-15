import assert from "node:assert/strict";
import test from "node:test";
import { SessionRuleStore } from "../src/session-rules.ts";
import {
	manageSessionRules,
	SESSION_RULES_MANAGER_TITLE,
	type SessionRulesUi,
} from "../src/session-rules-command.ts";

interface Script {
	selects?: Array<string | undefined>;
	inputs?: Array<string | undefined>;
	editors?: Array<string | undefined>;
}

function scriptedUi(script: Script) {
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const inputCalls: Array<{ title: string; placeholder?: string }> = [];
	const editorCalls: Array<{ title: string; prefill?: string }> = [];
	const notices: Array<{ message: string; type?: string }> = [];
	const ui: SessionRulesUi = {
		select: async (title, options) => {
			selectCalls.push({ title, options });
			return script.selects?.shift();
		},
		input: async (title, placeholder) => {
			inputCalls.push({ title, placeholder });
			return script.inputs?.shift();
		},
		editor: async (title, prefill) => {
			editorCalls.push({ title, prefill });
			return script.editors?.shift();
		},
		notify: (message, type) => notices.push({ message, type }),
	};
	return { ui, selectCalls, inputCalls, editorCalls, notices };
}

test("lists rules with ids and text and closes on Esc", async () => {
	const store = new SessionRuleStore();
	store.add("Allow pnpm test");
	store.add("Allow git status");
	const harness = scriptedUi({ selects: [undefined] });
	await manageSessionRules(store, harness.ui);
	assert.equal(harness.selectCalls.length, 1);
	assert.match(harness.selectCalls[0].title, /2 active rules/);
	assert.equal(
		harness.selectCalls[0].title.includes(SESSION_RULES_MANAGER_TITLE),
		true,
	);
	assert.deepEqual(harness.selectCalls[0].options, [
		"rule-1: Allow pnpm test",
		"rule-2: Allow git status",
		"Add a rule",
		"Close",
	]);
	assert.equal(store.list().length, 2);
	assert.deepEqual(harness.notices, []);
});

test("shows the empty state when no rules exist", async () => {
	const store = new SessionRuleStore();
	const harness = scriptedUi({ selects: ["Close"] });
	await manageSessionRules(store, harness.ui);
	assert.match(harness.selectCalls[0].title, /No session approval rules/);
	assert.deepEqual(harness.selectCalls[0].options, ["Add a rule", "Close"]);
});

test("adds a sanitized rule after Enter", async () => {
	const store = new SessionRuleStore();
	const harness = scriptedUi({
		selects: ["Add a rule", undefined],
		inputs: ["  Allow\npnpm test  "],
	});
	await manageSessionRules(store, harness.ui);
	assert.deepEqual(
		store.list().map(({ id, text }) => ({ id, text })),
		[{ id: "rule-1", text: "Allow pnpm test" }],
	);
	assert.match(
		harness.notices[0].message,
		/Session rule rule-1 added: Allow pnpm test/,
	);
	assert.equal(harness.notices[0].type, "info");
});

test("Esc on the add input changes nothing", async () => {
	const store = new SessionRuleStore();
	const harness = scriptedUi({
		selects: ["Add a rule", undefined],
		inputs: [undefined],
	});
	await manageSessionRules(store, harness.ui);
	assert.deepEqual(store.list(), []);
	assert.deepEqual(harness.notices, []);
});

test("reports a rejected rule and keeps the store unchanged", async () => {
	const store = new SessionRuleStore();
	const harness = scriptedUi({
		selects: ["Add a rule", undefined],
		inputs: ["   "],
	});
	await manageSessionRules(store, harness.ui);
	assert.deepEqual(store.list(), []);
	assert.match(harness.notices[0].message, /Rule text cannot be empty/);
	assert.equal(harness.notices[0].type, "warning");
});

test("edits a rule with the current text prefilled", async () => {
	const store = new SessionRuleStore();
	store.add("Allow pnpm test");
	const harness = scriptedUi({
		selects: ["rule-1: Allow pnpm test", "Edit rule", undefined],
		editors: ["Allow pnpm test -- --run"],
	});
	await manageSessionRules(store, harness.ui);
	assert.equal(store.find("rule-1")?.text, "Allow pnpm test -- --run");
	assert.equal(harness.editorCalls[0].prefill, "Allow pnpm test");
	assert.match(harness.notices[0].message, /Session rule rule-1 updated/);
	assert.equal(harness.notices[0].type, "info");
});

test("Esc in the editor leaves the rule unchanged", async () => {
	const store = new SessionRuleStore();
	store.add("Allow pnpm test");
	const harness = scriptedUi({
		selects: ["rule-1: Allow pnpm test", "Edit rule", undefined],
		editors: [undefined],
	});
	await manageSessionRules(store, harness.ui);
	assert.equal(store.find("rule-1")?.text, "Allow pnpm test");
	assert.deepEqual(harness.notices, []);
});

test("deletes the selected rule", async () => {
	const store = new SessionRuleStore();
	store.add("Allow pnpm test");
	const harness = scriptedUi({
		selects: ["rule-1: Allow pnpm test", "Delete rule", undefined],
	});
	await manageSessionRules(store, harness.ui);
	assert.deepEqual(store.list(), []);
	assert.match(harness.notices[0].message, /Session rule rule-1 removed/);
	assert.equal(harness.notices[0].type, "info");
});

test("Back and unknown choices change nothing", async () => {
	const store = new SessionRuleStore();
	store.add("Allow pnpm test");
	const harness = scriptedUi({
		selects: [
			"rule-1: Allow pnpm test",
			"Back",
			"unknown choice",
			undefined,
		],
	});
	await manageSessionRules(store, harness.ui);
	assert.equal(store.find("rule-1")?.text, "Allow pnpm test");
	assert.equal(harness.editorCalls.length, 0);
	assert.deepEqual(harness.notices, []);
});
