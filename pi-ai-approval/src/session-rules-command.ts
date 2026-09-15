import {
	sessionRuleRejectionMessage,
	type SessionApprovalRule,
	type SessionRuleStore,
} from "./session-rules.ts";

/** Notification levels used by the rule manager. */
export type SessionRulesNoticeType = "info" | "warning" | "error";

/**
 * The subset of `ctx.ui` the session-rule manager needs. `select`, `input`, and
 * `editor` all resolve `undefined` on Esc, so cancellation never changes state.
 * No custom component is used, which keeps the manager usable in RPC mode too.
 */
export interface SessionRulesUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	notify(message: string, type?: SessionRulesNoticeType): void;
}

export const SESSION_RULES_MANAGER_TITLE =
	"Session approval rules (this session only)";

const ADD_CHOICE = "Add a rule";
const CLOSE_CHOICE = "Close";
const EDIT_CHOICE = "Edit rule";
const DELETE_CHOICE = "Delete rule";
const BACK_CHOICE = "Back";
const RULE_INPUT_PLACEHOLDER =
	"Describe the operation this session may run without asking";

function ruleLabel(rule: SessionApprovalRule): string {
	return `${rule.id}: ${rule.text}`;
}

/**
 * Interactive manager behind `/ai-approval session-rules`: list the rules that
 * apply to this session, then add, edit, or remove one. Every step treats an
 * undefined answer (Esc) as "leave everything unchanged".
 */
export async function manageSessionRules(
	store: SessionRuleStore,
	ui: SessionRulesUi,
): Promise<void> {
	for (;;) {
		const rules = store.list();
		const labels = rules.map(ruleLabel);
		const choice = await ui.select(
			rules.length === 0
				? `${SESSION_RULES_MANAGER_TITLE}\nNo session approval rules have been added yet.`
				: `${SESSION_RULES_MANAGER_TITLE}\n${rules.length} active rule${rules.length === 1 ? "" : "s"}; choose one to change it.`,
			[...labels, ADD_CHOICE, CLOSE_CHOICE],
		);
		if (choice === undefined || choice === CLOSE_CHOICE) return;
		if (choice === ADD_CHOICE) {
			await addRule(store, ui);
			continue;
		}
		const index = labels.indexOf(choice);
		if (index < 0) continue;
		await changeRule(store, ui, rules[index]);
	}
}

async function addRule(
	store: SessionRuleStore,
	ui: SessionRulesUi,
): Promise<void> {
	const text = await ui.input("New session approval rule", RULE_INPUT_PLACEHOLDER);
	if (text === undefined) return;
	const added = store.add(text);
	ui.notify(
		added.ok
			? `Session rule ${added.rule.id} added: ${added.rule.text}`
			: sessionRuleRejectionMessage(added.reason),
		added.ok ? "info" : "warning",
	);
}

async function changeRule(
	store: SessionRuleStore,
	ui: SessionRulesUi,
	rule: SessionApprovalRule,
): Promise<void> {
	const choice = await ui.select(
		[`Session rule ${rule.id}`, rule.text, "What do you want to do?"].join("\n"),
		[EDIT_CHOICE, DELETE_CHOICE, BACK_CHOICE],
	);
	if (choice === EDIT_CHOICE) {
		// The editor is prefilled with the current text so editing never means
		// retyping the whole rule.
		const text = await ui.editor(`Edit session rule ${rule.id}`, rule.text);
		if (text === undefined) return;
		const updated = store.update(rule.id, text);
		ui.notify(
			updated.ok
				? `Session rule ${updated.rule.id} updated: ${updated.rule.text}`
				: sessionRuleRejectionMessage(updated.reason),
			updated.ok ? "info" : "warning",
		);
		return;
	}
	if (choice === DELETE_CHOICE) {
		const removed = store.remove(rule.id);
		ui.notify(
			removed.ok
				? `Session rule ${rule.id} removed.`
				: sessionRuleRejectionMessage(removed.reason),
			removed.ok ? "info" : "warning",
		);
	}
}
