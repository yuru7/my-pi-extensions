import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_CONFIG, resetSandboxConfigCache } from "../src/config";
import { getEscalationBroker, resetEscalationBrokerForTests } from "../src/escalation-broker";
import { resetDenialLedgerForTests } from "../src/denial-ledger";
import { createPermissionState, processPermissionState } from "../src/permission";
import { createSandboxTools } from "../src/tools";

/**
 * In-package composition case (Ruling 18): a fake host drives index.ts activate + real createSandboxTools + a fake child-session ctx,
 * walking "session_start registration → session-created event link → child execute → parent select → returned mode →
 * real write → disposed unlinks → back to fail-closed", pinning the seams between unit cases (broker / tools / index-smoke
 * each tested in isolation). Real TUI verification is still done by the user (plan Task 5 Step 8).
 */

let dir: string;
let ws: string;
let outsideDir: string;
let fakeTmpDir: string;

function makeFakePi() {
	const hooks: Record<string, (event: unknown, ctx: unknown) => void> = {};
	const channels: Record<string, (data: unknown) => void> = {};
	const fakePi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
			hooks[event] = handler;
		},
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				channels[channel] = handler;
				return () => {
					delete channels[channel];
				};
			},
			emit: vi.fn(),
		},
	};
	return { fakePi, hooks, channels };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fwd-"));
	mkdirSync(join(dir, "agent"), { recursive: true });
	mkdirSync(join(dir, "ws"), { recursive: true });
	mkdirSync(join(dir, "fake-tmp"), { recursive: true });
	mkdirSync(join(dir, "outside"), { recursive: true });
	ws = realpathSync.native(join(dir, "ws"));
	fakeTmpDir = realpathSync.native(join(dir, "fake-tmp"));
	outsideDir = realpathSync.native(join(dir, "outside"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
});

afterEach(() => {
	processPermissionState.override = null;
	resetEscalationBrokerForTests();
	resetDenialLedgerForTests();
	resetSandboxConfigCache();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("end to end (in-package): child-session escalation → parent-session prompt → one-shot allow", () => {
	it("walks event→link→child execute→parent select→write, approves once, and returns to fail-closed after disposed", async () => {
		const { fakePi, hooks, channels } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);

		// Parent session comes online: register the approval channel (the user clicks "Allow once" on the parent TUI)
		const parentSelect = vi.fn(async () => "Allow once");
		hooks.session_start?.({ type: "session_start" }, {
			hasUI: true,
			sessionManager: { getSessionId: () => "parent-1" },
			ui: { select: parentSelect },
		});

		// pi-subagents dispatches a child session: the parent instance receives session-created (emitted synchronously before the child bindExtensions)
		channels["subagents:child:session-created"]?.({ sessionId: "child-1", parentSessionId: "parent-1" });

		const deps = {
			cwd: ws,
			getConfig: () => ({
				...DEFAULT_SANDBOX_CONFIG,
				approvalMode: "human" as const,
				globalApproval: { ...DEFAULT_SANDBOX_CONFIG.globalApproval, approvalMode: "human" as const },
			}),
			permission: createPermissionState(),
			spawnFn: vi.fn(() => {
				throw new Error("this case must not spawn any process");
			}) as never,
			selected: { runner: "bwrap" as const, enforcement: "full" as const },
			// testing.md parameter injection: pin the tmp writable root inside the test directory, so dir/outside is truly outside the fence
			_tmpRoots: [fakeTmpDir],
		};
		const { write } = createSandboxTools(deps);

		const childCtx = {
			hasUI: false,
			cwd: ws,
			sessionManager: { getSessionId: () => "child-1" },
			ui: {
				select: vi.fn(async () => {
					throw new Error("child session must not prompt locally");
				}),
			},
		} as never;

		// 1) no escalation: the fence denies (proves the target is really outside the fence, so the case cannot pass green by accident)
		const target = join(outsideDir, `fwd-${process.pid}-${Date.now()}.txt`);
		await expect(write.execute("c-1", { path: target, content: "ok" }, undefined, undefined, childCtx))
			.rejects.toThrow(/file access denied under workspace-write mode/);

		// 2) retry unchanged with escalation params: the parent session prompts and allows, then a real write happens
		await write.execute("c-2", {
			path: target,
			content: "ok",
			sandbox_permissions: "danger-full-access",
			justification: "user-approved external write",
		}, undefined, undefined, childCtx);

		expect(await readFile(target, "utf-8")).toBe("ok");
		expect(parentSelect).toHaveBeenCalledTimes(1);
		expect(parentSelect.mock.calls[0][0] as string).toContain("user-approved external write");
		// D4: the title contains no child-agent source identifier
		expect(parentSelect.mock.calls[0][0] as string).not.toContain("child-1");
		expect(parentSelect.mock.calls[0][1]).toEqual(["Allow once", "Deny"]);
		// Approval applies only to that one call: neither the process mode nor this deps override was rewritten
		expect(processPermissionState.override).toBeNull();
		expect(deps.permission.override).toBeNull();
		expect(getEscalationBroker().resolveChannel("child-1")).not.toBeNull();

		// 3) child session ends: disposed unlinks (and clears unconsumed denial-ledger entries)
		channels["subagents:child:disposed"]?.({ sessionId: "child-1" });
		const afterTarget = join(outsideDir, `fwd-after-${process.pid}-${Date.now()}.txt`);
		// 3a) ledger cleared + escalation params still present → the gate ignores them and runs as workspace-write → the fence denies (and records again)
		await expect(write.execute("c-3", {
			path: afterTarget,
			content: "x",
			sandbox_permissions: "danger-full-access",
			justification: "after dispose",
		}, undefined, undefined, childCtx)).rejects.toThrow(/file access denied under workspace-write mode/);
		// 3b) retry unchanged: the ledger has a record and the link is gone → strict fail-closed (no approval channel)
		await expect(write.execute("c-4", {
			path: afterTarget,
			content: "x",
			sandbox_permissions: "danger-full-access",
			justification: "after dispose",
		}, undefined, undefined, childCtx)).rejects.toThrow(/no approval channel is available/);
	});
});
