import { describe, expect, it, vi } from "vitest";
import {
	approveEscalation,
	DENIAL_REASON_PROMPT,
	denialFollowupHint,
	escalationAppliedMarker,
	escalationIgnoredMarker,
	isStrictlyWider,
	normalizeEscalationValue,
	sandboxDenialMarker,
	sanitizeDenialReason,
	stripEscalationPlaceholders,
	validateEscalationArgs,
	WIDER_MODES,
} from "../src/escalation";

const base = {
	justification: "need to install a global npm package",
	effectiveMode: "workspace-write" as const,
	subject: "command" as const,
	summary: "npm i -g foo",
};

/** Approval-dialog fake: ask records the call and returns a fixed outcome (choice + optional Deny reason). */
function ui(hasUI: boolean, choice: string | undefined, reason?: string) {
	const ask = vi.fn(async () => ({ choice, reason }));
	return { hasUI, ask };
}

describe("validateEscalationArgs", () => {
	it("both present and non-empty: ok", () => {
		expect(() =>
			validateEscalationArgs("danger-full-access", "because"),
		).not.toThrow();
	});
	it("permissions without justification: malformed + actionable (nothing ran, fix recipe)", () => {
		expect(() =>
			validateEscalationArgs("danger-full-access", undefined),
		).toThrow(
			/nothing ran.*Cause: sandbox_permissions was sent without justification.*omit BOTH fields/s,
		);
	});
	it("justification without permissions: malformed (the null-placeholder failure mode)", () => {
		expect(() => validateEscalationArgs(undefined, "because")).toThrow(
			/nothing ran.*Cause: justification was sent without sandbox_permissions.*omit BOTH fields/s,
		);
	});
	it("blank justification: malformed", () => {
		expect(() => validateEscalationArgs("danger-full-access", "   ")).toThrow(
			/nothing ran.*Cause: justification was empty/,
		);
	});
	// 2026-10-02 second revision: the recipe gives only positive wording and no longer lists a negative clause (removed `never the string "null" or ""`).
	it('fix recipe gives only the positive recipe: omit or JSON null (no "never null" that contradicts the strict schema)', () => {
		expect(() =>
			validateEscalationArgs("danger-full-access", undefined),
		).toThrow(/omit BOTH fields or send JSON null for BOTH/);
		expect(() =>
			validateEscalationArgs("danger-full-access", undefined),
		).not.toThrow(/never null/);
		expect(() =>
			validateEscalationArgs("danger-full-access", undefined),
		).not.toThrow(/never the string/);
	});
	it("both absent: ok (a plain call)", () => {
		expect(() => validateEscalationArgs(undefined, undefined)).not.toThrow();
	});
});

describe("normalizeEscalationValue (placeholder normalization; field reachability decides whether it is load-bearing)", () => {
	// Measured on pi ≥1.0.0: validateToolArguments (against the declared schema) runs before execute.
	// 2026-10-02 third revision: the tool-side prepareArguments (stripEscalationPlaceholders) strips string placeholders before validation,
	// so on the real tool path "null" / "" never get here; this function is the resolveCall-layer backstop, load-bearing on call paths that skip the hook
	// (subagent forwarding, and future tool entry points).
	// - justification's string arm is Type.String() (the field itself is string | null): "null" / "NULL" / "" are all legal strings
	//   → if the hook is absent they really do reach execute, and normalization is load-bearing (otherwise a normal call is misjudged MALFORMED,
	//   or an approval dialog opens with Reason: null);
	// - sandbox_permissions is a two-literal enum: the string form is rejected at validation if it is not stripped (execute does not run); only JSON null
	//   (already declared in the schema) and "omitted" can arrive — this function handles those two branches too.
	it("null / non-string (including JSON null) → omitted", () => {
		expect(normalizeEscalationValue(null)).toBeUndefined();
		expect(normalizeEscalationValue(undefined)).toBeUndefined();
		expect(normalizeEscalationValue(42)).toBeUndefined();
		expect(normalizeEscalationValue({})).toBeUndefined();
	});
	it('the string "null" (any case, with surrounding whitespace) → omitted', () => {
		expect(normalizeEscalationValue("null")).toBeUndefined();
		expect(normalizeEscalationValue("NULL")).toBeUndefined();
		expect(normalizeEscalationValue("  Null  ")).toBeUndefined();
	});
	it("empty string / whitespace only → omitted", () => {
		expect(normalizeEscalationValue("")).toBeUndefined();
		expect(normalizeEscalationValue("   ")).toBeUndefined();
	});
	it("a real value → returned trimmed, otherwise unchanged", () => {
		expect(normalizeEscalationValue("danger-full-access")).toBe(
			"danger-full-access",
		);
		expect(normalizeEscalationValue("  workspace-write  ")).toBe(
			"workspace-write",
		);
	});
});

describe("stripEscalationPlaceholders (strips placeholders before pi validation; attached to the tool prepareArguments)", () => {
	it('both placeholder strings are stripped (main case: the model fills an optional field with "null")', () => {
		expect(
			stripEscalationPlaceholders({
				command: "ls",
				sandbox_permissions: "null",
				justification: "null",
			}),
		).toEqual({ command: "ls" });
	});
	it("case-insensitive + surrounding whitespace + empty string / whitespace-only are all placeholders", () => {
		expect(
			stripEscalationPlaceholders({ sandbox_permissions: "NULL" }),
		).toEqual({});
		expect(
			stripEscalationPlaceholders({ sandbox_permissions: "  Null  " }),
		).toEqual({});
		expect(stripEscalationPlaceholders({ justification: "" })).toEqual({});
		expect(stripEscalationPlaceholders({ justification: "   " })).toEqual({});
	});
	it("JSON null is kept as-is: a legal Type.Null() value still goes through resolveCall normalization; this hook does not change that path", () => {
		const args = { sandbox_permissions: null, justification: null };
		expect(stripEscalationPlaceholders(args)).toEqual({
			sandbox_permissions: null,
			justification: null,
		});
	});
	it("a real escalation is kept as-is (not stripped by mistake); an illegal value is kept as-is (left for pi validation to reject)", () => {
		const real = {
			sandbox_permissions: "danger-full-access",
			justification: "need /etc write",
		};
		expect(stripEscalationPlaceholders(real)).toBe(real);
		expect(
			stripEscalationPlaceholders({ sandbox_permissions: "read-only" }),
		).toEqual({ sandbox_permissions: "read-only" });
		expect(stripEscalationPlaceholders({ justification: 42 })).toEqual({
			justification: 42,
		});
	});
	it("non-object input is returned as-is (guards against the model emitting null / an array / a scalar)", () => {
		expect(stripEscalationPlaceholders(null)).toBeNull();
		expect(stripEscalationPlaceholders([1, 2])).toEqual([1, 2]);
		expect(stripEscalationPlaceholders('"null"')).toBe('"null"');
		expect(stripEscalationPlaceholders(undefined)).toBeUndefined();
	});
	it("does not mutate the original object: the session log and the UI keep the model's raw output", () => {
		const args = {
			command: "ls",
			sandbox_permissions: "null",
			justification: "null",
		};
		stripEscalationPlaceholders(args);
		expect(args).toEqual({
			command: "ls",
			sandbox_permissions: "null",
			justification: "null",
		});
	});
	it("returns the same reference when there is no placeholder: pi's prepareToolCallArguments skips replacement on that (no perturbation)", () => {
		const args = { command: "ls" };
		expect(stripEscalationPlaceholders(args)).toBe(args);
	});
});

describe("isStrictlyWider (the denial-first gate and approveEscalation share the same table)", () => {
	it("read-only → both modes are wider", () => {
		// Constant pin (folded in from the old WIDER_MODES table-restatement case): the table shared by the gate and approval is itself pinned —
		// read-only has exactly two wider targets, and read-only is not among them ("nothing widens to read-only").
		expect(WIDER_MODES["read-only"]).toEqual([
			"workspace-write",
			"danger-full-access",
		]);
		expect(isStrictlyWider("read-only", "workspace-write")).toBe(true);
		expect(isStrictlyWider("read-only", "danger-full-access")).toBe(true);
	});
	it("workspace-write → only danger-full-access", () => {
		expect(isStrictlyWider("workspace-write", "danger-full-access")).toBe(true);
		expect(isStrictlyWider("workspace-write", "workspace-write")).toBe(false);
		expect(isStrictlyWider("workspace-write", "read-only")).toBe(false);
		expect(isStrictlyWider("workspace-write", "banana")).toBe(false);
	});
	it("danger-full-access → no wider target", () => {
		expect(isStrictlyWider("danger-full-access", "workspace-write")).toBe(
			false,
		);
		expect(isStrictlyWider("danger-full-access", "danger-full-access")).toBe(
			false,
		);
	});
});

describe("sanitizeDenialReason", () => {
	it("collapses whitespace and trims (a multiline reason becomes one line, without breaking the error-text format)", () => {
		expect(sanitizeDenialReason("  don't   touch\n\n~/.aws ")).toBe(
			"don't touch ~/.aws",
		);
	});
	it("empty / whitespace-only / non-string → undefined (denial text falls back to the original, verbatim)", () => {
		expect(sanitizeDenialReason("")).toBeUndefined();
		expect(sanitizeDenialReason("   \n ")).toBeUndefined();
		expect(sanitizeDenialReason(undefined)).toBeUndefined();
	});
	it("truncates to 500 characters plus an ellipsis (the reason enters context via the error, so the budget stays bounded)", () => {
		const out = sanitizeDenialReason("x".repeat(600));
		expect(out?.length).toBe(501);
		expect(out?.endsWith("…")).toBe(true);
	});
});

describe("markers", () => {
	it("denial marker names the mode verbatim", () => {
		expect(sandboxDenialMarker("read-only")).toBe(
			"[sandbox: file access denied under read-only mode]",
		);
	});
	it("names one directory when every denied path sits in it, and withholds the grant otherwise", () => {
		expect(
			denialFollowupHint({
				subject: "operation",
				grantDirectory: "/home/dev/work/20261010/fuga/fuga",
				targetPath: "/home/dev/work/20261010/fuga/fuga",
			}),
		).toBe(
			'[sandbox: to change only /home/dev/work/20261010/fuga/fuga, retry this exact call once with sandbox_permissions "danger-full-access" and a justification. If later calls in this request will write in /home/dev/work/20261010/fuga/fuga again, call sandbox_grant_write alone with that directory and a one-sentence justification, then retry. Do not grant a wider directory.]',
		);
		expect(
			denialFollowupHint({
				subject: "command",
				grantDirectory: "/home/dev/work/20261010/fuga/fuga",
			}),
		).toContain("writes in /home/dev/work/20261010/fuga/fuga only once");
		expect(denialFollowupHint({ subject: "command" })).toContain(
			"this denial names no directory",
		);
		expect(
			denialFollowupHint({
				subject: "command",
				refusedDirectory: "/home/dev",
			}),
		).toContain("refuses /home/dev");
		expect(denialFollowupHint({ subject: "command", split: true })).toContain(
			"not in one directory",
		);
		expect(
			denialFollowupHint({ subject: "command", customRunner: true }),
		).toContain("custom runnerCommand cannot accept a directory grant");
	});
	it("applied marker says the approval covered this call only", () => {
		expect(escalationAppliedMarker("danger-full-access")).toBe(
			'[sandbox: this call ran with a one-shot escalation to "danger-full-access"; the approval covered this call only — later calls are confined again]',
		);
	});
	it("ignored marker names the mode and points at the denial-first contract", () => {
		expect(escalationIgnoredMarker("workspace-write")).toBe(
			'[sandbox: escalation fields were ignored — no sandbox denial was recorded for this session, so this call ran under "workspace-write" mode. Send escalation fields only when retrying a call that just returned a denial marker.]',
		);
	});
});

describe("approveEscalation", () => {
	it("same mode as effective: no approval needed", async () => {
		const u = ui(true, "Deny");
		await expect(
			approveEscalation({ ...base, requestedMode: "workspace-write" }, u),
		).resolves.toBe("workspace-write");
		expect(u.ask).not.toHaveBeenCalled();
	});
	it("strictly wider + Allow once → granted mode (one-shot)", async () => {
		const u = ui(true, "Allow once");
		await expect(
			approveEscalation({ ...base, requestedMode: "danger-full-access" }, u),
		).resolves.toBe("danger-full-access");
		const title = u.ask.mock.calls[0][0] as string;
		expect(title).toContain("danger-full-access");
		expect(title).toContain(base.justification);
		expect(title).toContain(base.summary);
		expect(u.ask.mock.calls[0][1]).toEqual(["Allow once", "Deny"]);
		// Step two of the two-step flow: the Deny-reason prompt is sent with the dialog (ask's third argument).
		expect(u.ask.mock.calls[0][2]).toEqual(DENIAL_REASON_PROMPT);
	});
	it("Deny → rejected error telling the model to stop", async () => {
		await expect(
			approveEscalation(
				{ ...base, requestedMode: "danger-full-access" },
				ui(true, "Deny"),
			),
		).rejects.toThrow(
			/rejected escalating this command to "danger-full-access".*stop and explain instead of working around it/s,
		);
	});
	it("Deny + reason → the reason is appended to the error text (visible to the model, so it knows why it was refused)", async () => {
		await expect(
			approveEscalation(
				{ ...base, requestedMode: "danger-full-access" },
				ui(true, "Deny", "never touch ~/.aws"),
			),
		).rejects.toThrow(
			/stop and explain instead of working around it.*The user's reason: never touch ~\/\.aws/s,
		);
	});
	it("Deny + blank reason → no suffix (denial text falls back to the original, verbatim)", async () => {
		await expect(
			approveEscalation(
				{ ...base, requestedMode: "danger-full-access" },
				ui(true, "Deny", "   "),
			),
		).rejects.toThrow(/rewritten command$/s);
	});
	it("ask returned undefined → cancelled error", async () => {
		await expect(
			approveEscalation(
				{ ...base, requestedMode: "danger-full-access" },
				ui(true, undefined),
			),
		).rejects.toThrow(/cancelled/);
	});
	it("narrower target → not-strictly-wider error, no prompt", async () => {
		const u = ui(true, "Allow once");
		await expect(
			approveEscalation(
				{
					...base,
					effectiveMode: "danger-full-access",
					requestedMode: "workspace-write",
				},
				u,
			),
		).rejects.toThrow(/not strictly wider.*nothing was executed/s);
		expect(u.ask).not.toHaveBeenCalled();
	});
	it("hasUI=false → unavailable error BEFORE any ask (Review Focus #4), with the /permission rescue path", async () => {
		const u = ui(false, "Allow once");
		await expect(
			approveEscalation({ ...base, requestedMode: "danger-full-access" }, u),
		).rejects.toThrow(
			/no approval channel is available.*nothing was executed.*\/permission danger-full-access/s,
		);
		expect(u.ask).not.toHaveBeenCalled();
	});
});
