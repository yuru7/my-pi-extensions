import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "../src/config";
import {
	getDenialLedger,
	operationFingerprint,
	resetDenialLedgerForTests,
} from "../src/denial-ledger";
import { PLACEHOLDER_KEYS } from "../src/escalation";
import {
	getEscalationBroker,
	resetEscalationBrokerForTests,
} from "../src/escalation-broker";
import { canonicalizeTarget, isWithinRoots } from "../src/fence";
import {
	createPermissionState,
	processPermissionState,
} from "../src/permission";
import { writableRoots } from "../src/policy";
import {
	createSandboxTools,
	ESCALATION_PROPS,
	resolveCall,
	resolveCallMode,
} from "../src/tools";
import {
	getWritableGrants,
	resetWritableGrantsForTests,
} from "../src/writable-grants";

// T14 revision (Fix 2): replace the confined pwsh ops factory with a recognizable sentinel, so whether
// the operations the builder receives come from the sandbox factory is an assertable identity. If the implementation wires the host's local (unconfined) ops or any other object, the assertion fails.
const { powershellOpsSentinel, createSandboxPowerShellOpsMock } = vi.hoisted(
	() => {
		const sentinel = { exec: vi.fn(async () => ({ exitCode: 0 })) };
		return {
			powershellOpsSentinel: sentinel,
			createSandboxPowerShellOpsMock: vi.fn(() => sentinel),
		};
	},
);
vi.mock("../src/powershell-ops", () => ({
	createSandboxPowerShellOps: createSandboxPowerShellOpsMock,
}));

let dir: string;
let ws: string;
/** A path truly outside the fence (neither in the workspace nor under the injected tmp root). */
let outsideDir: string;
/** Injected tmp root, replacing "/tmp" + os.tmpdir() — otherwise the whole dir sits inside tmpdir() and a path outside the fence cannot be constructed. */
let fakeTmpDir: string;

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = vi.fn(() => {
		process.nextTick(() => child.emit("close", null, "SIGTERM"));
		return true;
	});
	return child;
}

function makeDeps(
	overrides: Partial<Parameters<typeof createSandboxTools>[0]> = {},
) {
	const child = fakeChild();
	const spawnFn = vi.fn(() => child) as never;
	return {
		deps: {
			cwd: ws,
			// Platform injection: pin linux by default so confined-bash cases actually run on a Windows host (on win32
			// createSandboxBashOps rejects bash before spawn; win32 coverage is in tests/win32/* and the
			// "windows tool wiring" cases below, which pass platform: "win32" explicitly via overrides).
			platform: "linux" as const,
			getConfig: () => humanSandboxConfig(),
			permission: createPermissionState(),
			spawnFn,
			selected: { runner: "bwrap" as const, enforcement: "full" as const },
			// Test injection (testing.md parameter injection): pin the tmp writable root inside the test directory,
			// so dir/outside is truly outside the fence — cases never touch the real HOME or /etc.
			_tmpRoots: [fakeTmpDir],
			...overrides,
		},
		child,
		spawnFn,
	};
}

/** Test session id: the denial-first gate records and consumes per session; the default ctx shares it. */
const TEST_SESSION = "test-session";

function toolCtx(hasUI = true, choice: string | undefined = "Allow once") {
	return {
		hasUI,
		sessionManager: {
			getSessionId: () => TEST_SESSION,
			getSessionFile: () => undefined,
		},
		ui: {
			select: vi.fn(async () => choice),
			input: vi.fn(async () => undefined),
			notify: vi.fn(),
		},
	} as never;
}

/** 既存の resolveCall 判例は tool 名を subject のまま使う。execute 判例は実ツール名と引数を渡す。 */
function humanSandboxConfig(): SandboxConfig {
	return {
		...DEFAULT_SANDBOX_CONFIG,
		approvalMode: "human",
		globalApproval: {
			...DEFAULT_SANDBOX_CONFIG.globalApproval,
			approvalMode: "human",
		},
	};
}

/** Seed one prior denial (the allow condition of the denial-first gate). */
function seedDenial(
	kind: "command" | "operation" = "command",
	sessionId = TEST_SESSION,
	operation?: { tool: string; params: Record<string, unknown> },
) {
	getDenialLedger().record({
		sessionId,
		tool: operation?.tool ?? kind,
		fingerprint: operationFingerprint(operation?.params ?? {}),
		cwd: ws,
		workspace: ws,
		sandboxMode: "workspace-write",
		backend: "bwrap",
		target: "",
		writablePaths: [],
		recordedAt: Date.now(),
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tools-"));
	mkdirSync(join(dir, "ws"), { recursive: true });
	mkdirSync(join(dir, "fake-tmp"), { recursive: true });
	mkdirSync(join(dir, "outside"), { recursive: true });
	ws = realpathSync.native(join(dir, "ws"));
	fakeTmpDir = realpathSync.native(join(dir, "fake-tmp"));
	outsideDir = realpathSync.native(join(dir, "outside"));
});
afterEach(() => {
	resetEscalationBrokerForTests();
	resetDenialLedgerForTests();
	resetWritableGrantsForTests();
	rmSync(dir, { recursive: true, force: true });
});

describe("createSandboxTools schemas", () => {
	it('escalation params declare null explicitly: in strict mode the model gets a schema-accepted "no escalation" value (rather than guessing a string)', () => {
		const { deps } = makeDeps();
		const { bash, write, edit } = createSandboxTools(deps);
		// Background (measured on pi 1.0.0): under a strict provider (e.g. deepseek-flash, compat.supportsStrictMode=true) pi
		// puts every property into required, and wraps fields that do not allow null in anyOf[X,{type:"null"}]. After null is declared:
		// (1) the model has an explicit legal value (JSON null) for "no escalation", and does not have to fight the "never null" copy by writing the string "null";
		// (2) pi's strict transform no longer adds a wrapping layer (schemaAllowsNull matches it recursively);
		// (3) JSON null is not stripped by pi's normalizeOptionalNulls; it is delivered to execute as-is (the normalization branch stays reachable).
		for (const tool of [bash, write, edit]) {
			const props = (tool.parameters as { properties: Record<string, unknown> })
				.properties;
			expect(JSON.parse(JSON.stringify(props.sandbox_permissions))).toEqual({
				anyOf: [
					{ type: "string", const: "workspace-write" },
					{ type: "string", const: "danger-full-access" },
					{ type: "null" },
				],
			});
			expect(JSON.parse(JSON.stringify(props.justification))).toEqual({
				anyOf: [{ type: "string" }, { type: "null" }],
			});
		}
		// extendParams must not drop base properties: bash's command is still in the schema
		// (folded in from the deleted "bash keeps command/timeout and gains the escalation pair").
		expect(
			(bash.parameters as { properties: Record<string, unknown> }).properties
				.command,
		).toBeDefined();
		// The declaration stays optional: under a non-strict provider, required omits these two fields, so the model can leave them out entirely.
		const required =
			(bash.parameters as { required?: string[] }).required ?? [];
		expect(required).not.toContain("sandbox_permissions");
		expect(required).not.toContain("justification");
	});
	it("description teaches the escalation contract within the per-tool budget (β′)", () => {
		const { deps } = makeDeps();
		const { bash, write, edit } = createSandboxTools(deps);
		// Cross-tool rules stay a single sentence: when not escalating, omit the fields or pass JSON null, and an escalation that is not a denial retry is ignored.
		// (2026-10-02 second revision: the negative clause `— never the string "null"` was removed; only the positive wording remains.)
		for (const tool of [bash, write, edit]) {
			expect(tool.description).toContain(
				"Unless retrying a denial, omit these fields or send JSON null.",
			);
			expect(tool.description).toContain(
				"workspace-write already allows the workspace and /tmp",
			);
			// The old copy put this protocol into every description (×3 duplication): do not let that come back.
			expect(tool.description).not.toContain(
				"Writes outside the permitted roots are denied",
			);
			expect(tool.description).not.toContain("Pass justification:");
		}
		// /tmp is already bind-mounted from the host (2026-10-01 decision) → the always-on surface no longer needs any /tmp-specific wording.
		for (const tool of [bash, write, edit])
			expect(tool.description).not.toContain("tmpfs");
		// Budget regression gate (β′): the always-on increment across the three tools totals ≤ 560 chars (now 468; was 1281 / first draft 546).
		const added = [bash, write, edit].flatMap((t) =>
			t.description.split("\n").filter((l) => l.startsWith("Sandbox:")),
		);
		expect(added.join("").length).toBeLessThanOrEqual(560);
	});
	it("keeps base promptSnippet/promptGuidelines and schema options (Ruling 15)", () => {
		const { deps } = makeDeps();
		const { bash, write, edit } = createSandboxTools(deps);
		expect(bash.promptSnippet).toBe(
			"Execute bash commands (ls, grep, find, etc.)",
		);
		expect(write.promptGuidelines).toContain(
			"Use write only for new files or complete rewrites.",
		);
		expect(
			write.promptGuidelines?.some((line) =>
				line.includes("sandbox_permissions"),
			),
		).toBe(true);
		expect(
			write.promptGuidelines?.some((line) =>
				line.includes("sandbox_grant_write"),
			),
		).toBe(true);
		// Fact from the pi 0.80.2 dist: editSchema ships with additionalProperties:false, and writeSchema has no such field.
		// The spread form of extendParams keeps base options as they are — pin false for edit (rebuilding with Type.Object drops it),
		// and pin write to the base as-is (undefined). The original ruling assumed write was false too, which disagrees with dist, so pin the fact.
		expect(
			(write.parameters as { additionalProperties?: boolean })
				.additionalProperties,
		).toBeUndefined();
		// Keep additionalProperties from the base schema; do not hard-code one host version's literal.
		const baseEdit = createEditToolDefinition(deps.cwd);
		expect(
			(edit.parameters as { additionalProperties?: boolean })
				.additionalProperties,
		).toBe(
			(baseEdit.parameters as { additionalProperties?: boolean })
				.additionalProperties,
		);
	});
});

describe("prepareArguments (placeholder stripping before pi validation; edit must chain the base hook)", () => {
	it("single source of key names: ESCALATION_PROPS keys == PLACEHOLDER_KEYS in escalation.ts (a rename must not drift silently)", () => {
		expect(Object.keys(ESCALATION_PROPS)).toEqual([...PLACEHOLDER_KEYS]);
	});

	it('bash: the string "null" is stripped (pi ≥0.80.2 no longer hard-rejects it at validation; 0.80.2 was measured to reject it the same way), command/timeout kept as-is', () => {
		const { deps } = makeDeps();
		const { bash } = createSandboxTools(deps);
		expect(
			bash.prepareArguments?.({
				command: "ls",
				timeout: null,
				sandbox_permissions: "null",
				justification: "null",
			}),
		).toEqual({ command: "ls", timeout: null });
	});

	it("write: placeholders are stripped, path/content kept as-is", () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		expect(
			write.prepareArguments?.({
				path: "/ws/a.txt",
				content: "hi",
				sandbox_permissions: "NULL",
				justification: "   ",
			}),
		).toEqual({ path: "/ws/a.txt", content: "hi" });
	});

	it("edit: chains the base prepareEditArguments — legacy oldText/newText is still normalized into edits, and placeholders are stripped at the same time", () => {
		const { deps } = makeDeps();
		const { edit } = createSandboxTools(deps);
		expect(
			edit.prepareArguments?.({
				path: "a.txt",
				oldText: "a",
				newText: "b",
				sandbox_permissions: "null",
				justification: "null",
			}),
		).toEqual({ path: "a.txt", edits: [{ oldText: "a", newText: "b" }] });
	});

	it("edit: a modern edits array and real escalation params pass through the hook unchanged", () => {
		const { deps } = makeDeps();
		const { edit } = createSandboxTools(deps);
		const args = {
			path: "a.txt",
			edits: [{ oldText: "a", newText: "b" }],
			sandbox_permissions: "danger-full-access",
			justification: "need /etc write",
		};
		expect(edit.prepareArguments?.(args)).toEqual(args);
	});

	it("stripped args go through resolveCall: a normal call, no dialog, no malformed error (the noise source is cut off)", async () => {
		const { deps } = makeDeps();
		const { bash } = createSandboxTools(deps);
		const ctx = toolCtx(true, "Allow once") as {
			ui: { select: ReturnType<typeof vi.fn> };
		};
		const prepared = bash.prepareArguments?.({
			command: "ls",
			sandbox_permissions: "null",
			justification: "null",
		}) as never;
		expect(
			await resolveCall(prepared, ctx as never, deps, "command", () => "ls"),
		).toEqual({
			mode: "workspace-write",
			escalated: false,
			ignoredEscalation: false,
		});
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});
});

describe("resolveCallMode", () => {
	it("no escalation params: permission override > config default", async () => {
		const { deps } = makeDeps();
		deps.permission.override = "read-only";
		expect(
			await resolveCallMode({}, toolCtx(), deps, "command", () => "x"),
		).toBe("read-only");
		deps.permission.override = null;
		expect(
			await resolveCallMode({}, toolCtx(), deps, "command", () => "x"),
		).toBe("workspace-write");
	});
	it("malformed pair throws", async () => {
		const { deps } = makeDeps();
		await expect(
			resolveCallMode(
				{ sandbox_permissions: "danger-full-access" },
				toolCtx(),
				deps,
				"command",
				() => "x",
			),
		).rejects.toThrow(/nothing ran.*omit BOTH fields/s);
	});
	it("resolveCall flags a genuine one-shot escalation only (same-mode request stays escalated:false)", async () => {
		const { deps } = makeDeps();
		expect(
			await resolveCall({}, toolCtx(), deps, "command", () => "x"),
		).toEqual({
			mode: "workspace-write",
			escalated: false,
			ignoredEscalation: false,
		});
		// Requested mode == effective: run without approval; this is not an escalation (otherwise the model gets a fake "special approval" signal).
		expect(
			await resolveCall(
				{
					sandbox_permissions: "workspace-write",
					justification: "same as effective",
				},
				toolCtx(),
				deps,
				"command",
				() => "x",
			),
		).toEqual({
			mode: "workspace-write",
			escalated: false,
			ignoredEscalation: false,
		});
		// Strictly wider + a prior denial on record (the allow condition of the denial-first hard gate) → a real escalation
		seedDenial("command");
		expect(
			await resolveCall(
				{
					sandbox_permissions: "danger-full-access",
					justification: "need /etc write",
				},
				toolCtx(true, "Allow once"),
				deps,
				"command",
				() => "x",
			),
		).toEqual({
			mode: "danger-full-access",
			escalated: true,
			ignoredEscalation: false,
		});
	});
	it("approved escalation is one-shot: override state untouched (Review Focus #5)", async () => {
		const { deps } = makeDeps();
		seedDenial("command");
		const mode = await resolveCallMode(
			{
				sandbox_permissions: "danger-full-access",
				justification: "need /etc write",
			},
			toolCtx(true, "Allow once"),
			deps,
			"command",
			() => "x",
		);
		expect(mode).toBe("danger-full-access");
		expect(deps.permission.override).toBeNull();
	});
	it("headless: escalation fails closed", async () => {
		const { deps } = makeDeps();
		seedDenial("command");
		// Has a session identity (can reach the next stage of the gate) but no approval channel: still fail-closed with the existing error.
		const headless = {
			hasUI: false,
			sessionManager: { getSessionId: () => TEST_SESSION },
			ui: { select: vi.fn() },
		} as never;
		await expect(
			resolveCallMode(
				{ sandbox_permissions: "danger-full-access", justification: "x" },
				headless,
				deps,
				"command",
				() => "x",
			),
		).rejects.toThrow(/no approval channel is available/);
	});
});

describe("write tool fence + escalation wiring", () => {
	it("write inside workspace delegates to the base tool", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const result = (await write.execute(
			"call-1",
			{ path: join(ws, "ok.txt"), content: "hi" },
			undefined,
			undefined,
			toolCtx(),
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("Successfully wrote");
		const { readFile } = await import("node:fs/promises");
		expect(await readFile(join(ws, "ok.txt"), "utf-8")).toBe("hi");
	});
	it("write outside workspace: throws carrying marker + hint", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		// After _tmpRoots is injected, dir/outside is truly outside the fence; assertWriteAllowed throws before any write,
		// so no file is actually created here (the trailing filename is deliberately nonexistent).
		const outside = join(outsideDir, `denied-${process.pid}.txt`);
		let message = "";
		try {
			await write.execute(
				"call-2",
				{ path: outside, content: "x" },
				undefined,
				undefined,
				toolCtx(),
			);
		} catch (error) {
			message = error instanceof Error ? error.message : "";
		}
		expect(message).toContain(`to change only ${outside},`);
		expect(message).toContain("Do not grant a wider directory");
		expect(message).not.toContain(`to change only ${outsideDir},`);
		expect(getDenialLedger().list(TEST_SESSION)[0]?.target).toBe(outside);
	});
	it("escalated retry with Allow once writes outside and carries the one-shot marker", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const outside = join(
			outsideDir,
			`tools-test-${process.pid}-${Date.now()}.txt`,
		);
		// Self-checking pair: the same path without escalation must be denied — if the target were actually inside the fence, this case would fail loudly instead of passing falsely.
		await expect(
			write.execute(
				"call-3-pre",
				{ path: outside, content: "ok" },
				undefined,
				undefined,
				toolCtx(),
			),
		).rejects.toThrow(/file access denied under workspace-write mode/);
		// After escalation (Allow once) the write really lands on disk, and the result carries the once-only marker. The content must match the denied attempt.
		const result = (await write.execute(
			"call-3",
			{
				path: outside,
				content: "ok",
				sandbox_permissions: "danger-full-access",
				justification: "user-approved external write",
			},
			undefined,
			undefined,
			toolCtx(true, "Allow once"),
		)) as { content: { text: string }[] };
		expect(
			await (await import("node:fs/promises")).readFile(outside, "utf-8"),
		).toBe("ok");
		expect(result.content.map((c) => c.text).join("\n")).toContain(
			'one-shot escalation to "danger-full-access"',
		);
	});
	it("plain call carries no escalation marker (no false one-shot signal)", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const result = (await write.execute(
			"call-3b",
			{ path: join(ws, "plain.txt"), content: "x" },
			undefined,
			undefined,
			toolCtx(),
		)) as { content: { text: string }[] };
		expect(result.content.map((c) => c.text).join("\n")).not.toContain(
			"one-shot escalation",
		);
	});
	it("Deny: error tells the model to stop and explain", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const outside = join(outsideDir, "denied.txt");
		// denial-first: there must be one real denial first (recorded on the ledger) before escalation enters the approval dialog
		await expect(
			write.execute(
				"call-4-pre",
				{ path: outside, content: "x" },
				undefined,
				undefined,
				toolCtx(),
			),
		).rejects.toThrow(/file access denied under workspace-write mode/);
		await expect(
			write.execute(
				"call-4",
				{
					path: outside,
					content: "x",
					sandbox_permissions: "danger-full-access",
					justification: "reason",
				},
				undefined,
				undefined,
				toolCtx(true, "Deny"),
			),
		).rejects.toThrow(/stop and explain instead of working around it/);
	});
	it("fence sees pi-resolved paths: ~-form path escaping the workspace is denied (Ruling 14)", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		// ~ must expand to the real HOME (that ~ form is what the case wants): after _tmpRoots is injected, tmpdir() is no longer writable by default,
		// so HOME is outside the fence no matter where it lands. The write is denied and nothing is written to disk.
		const name = `sbx-tilde-${process.pid}-${Date.now()}.txt`;
		await expect(
			write.execute(
				"call-6",
				{ path: `~/${name}`, content: "x" },
				undefined,
				undefined,
				toolCtx(),
			),
		).rejects.toThrow(/file access denied under workspace-write mode/);
		expect(existsSync(join(homedir(), name))).toBe(false);
	});
	it("derives the fence root per call from ctx.cwd (C2)", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const other = mkdtempSync(join(outsideDir, "c2-")); // truly outside the fence (beyond the tmp root)
		try {
			const otherCtx = { ...(toolCtx() as object), cwd: other } as never;
			await write.execute(
				"c-9",
				{ path: join(other, "f.txt"), content: "x" },
				undefined,
				undefined,
				otherCtx,
			);
			expect(existsSync(join(other, "f.txt"))).toBe(true); // under the old behavior (frozen ws) this write would be denied
			const escape = join(
				outsideDir,
				`c2-escape-${process.pid}-${Date.now()}.txt`,
			);
			await expect(
				write.execute(
					"c-10",
					{ path: escape, content: "x" },
					undefined,
					undefined,
					otherCtx,
				),
			).rejects.toThrow(/file access denied under workspace-write mode/);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});

describe("edit tool fence", () => {
	it("edit inside workspace applies the replacement", async () => {
		const { deps } = makeDeps();
		const { edit } = createSandboxTools(deps);
		const target = join(ws, "edit-me.txt");
		writeFileSync(target, "hello world");
		await edit.execute(
			"call-7",
			{ path: target, edits: [{ oldText: "hello", newText: "goodbye" }] },
			undefined,
			undefined,
			toolCtx(),
		);
		const { readFile } = await import("node:fs/promises");
		expect(await readFile(target, "utf-8")).toBe("goodbye world");
	});
	it("edit outside workspace is denied", async () => {
		const { deps } = makeDeps();
		const { edit } = createSandboxTools(deps);
		const outside = join(
			outsideDir,
			`edit-test-${process.pid}-${Date.now()}.txt`,
		);
		writeFileSync(outside, "x");
		try {
			await expect(
				edit.execute(
					"call-8",
					{ path: outside, edits: [{ oldText: "x", newText: "y" }] },
					undefined,
					undefined,
					toolCtx(),
				),
			).rejects.toThrow(/file access denied under workspace-write mode/);
		} finally {
			rmSync(outside, { force: true });
		}
	});
});

describe("bash tool wiring", () => {
	it("spawns the confined argv through injected spawnFn", async () => {
		const { deps, child, spawnFn } = makeDeps();
		const { bash } = createSandboxTools(deps);
		const p = bash.execute(
			"call-5",
			{ command: "echo hi" },
			undefined,
			undefined,
			toolCtx(),
		);
		// M4: exec awaits the cwd preflight before spawn and before attaching listeners — feed data and close the streams only after spawn (listeners are attached synchronously right after it).
		await vi.waitFor(() => {
			expect(spawnFn).toHaveBeenCalled();
		});
		child.stdout.write("hi");
		child.emit("close", 0, undefined);
		await p;
		expect(spawnFn).toHaveBeenCalledWith(
			"bwrap",
			expect.arrayContaining(["--"]),
			expect.objectContaining({ cwd: ws }),
		);
	});
});

describe("resolveCallMode approval-channel routing (spec 2026-09-30)", () => {
	/** Child-session ctx: hasUI=false; if select is called locally it fails loudly (approval must use the parent channel). */
	function subagentCtx(sessionId: string) {
		return {
			hasUI: false,
			sessionManager: { getSessionId: () => sessionId },
			ui: {
				select: vi.fn(async () => {
					throw new Error("child session must not prompt locally");
				}),
			},
		} as never;
	}

	function registerParent(
		sessionId: string,
		choice: string | undefined = "Allow once",
	) {
		const select = vi.fn(async () => choice);
		getEscalationBroker().registerParent({
			sessionId,
			hasUI: () => true,
			select,
		});
		return select;
	}

	it("child session + registered parent channel → uses the parent select, returns the approved mode, and does not change the process mode", async () => {
		const { deps } = makeDeps();
		const parentSelect = registerParent("parent-1");
		getEscalationBroker().linkChild("child-1", "parent-1");
		seedDenial("command", "child-1");
		const mode = await resolveCallMode(
			{
				sandbox_permissions: "danger-full-access",
				justification: "need /etc write",
			},
			subagentCtx("child-1"),
			deps,
			"command",
			() => "cat /etc/shadow",
		);
		expect(mode).toBe("danger-full-access");
		expect(parentSelect).toHaveBeenCalledTimes(1);
		expect(parentSelect.mock.calls[0][1]).toEqual(["Allow once", "Deny"]);
		// D4: the title copy matches the direct path exactly (including justification and the summary), with no subagent marker
		const title = parentSelect.mock.calls[0][0] as string;
		expect(title).toContain("need /etc write");
		expect(title).toContain("cat /etc/shadow");
		expect(title).not.toContain("child-1");
		expect(deps.permission.override).toBeNull();
	});

	it("child session, parent-side Deny → reuses the existing denial copy", async () => {
		const { deps } = makeDeps();
		registerParent("parent-2", "Deny");
		getEscalationBroker().linkChild("child-2", "parent-2");
		seedDenial("command", "child-2");
		await expect(
			resolveCallMode(
				{ sandbox_permissions: "danger-full-access", justification: "j" },
				subagentCtx("child-2"),
				deps,
				"command",
				() => "x",
			),
		).rejects.toThrow(
			/rejected escalating this command to "danger-full-access".*stop and explain/s,
		);
	});

	it("child session with no link → fail-closed (Review Focus #4)", async () => {
		const { deps } = makeDeps();
		registerParent("parent-3");
		seedDenial("command", "orphan");
		await expect(
			resolveCallMode(
				{ sandbox_permissions: "danger-full-access", justification: "j" },
				subagentCtx("orphan"),
				deps,
				"command",
				() => "x",
			),
		).rejects.toThrow(/no approval channel is available/);
	});

	it("ctx without sessionManager → the gate ignores the escalation (no session identity, so a prior denial cannot be proven) and does not throw TypeError (Review Focus #1)", async () => {
		const { deps } = makeDeps();
		registerParent("parent-4");
		getEscalationBroker().linkChild("child-4", "parent-4");
		// Narrow ctx: no sessionManager — the gate runs before channel resolution and ignores the request as "no prior denial" (no dialog, no TypeError)
		const narrowCtx = {
			hasUI: false,
			ui: { select: vi.fn(async () => "Allow once") },
		} as never;
		const result = await resolveCall(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			narrowCtx,
			deps,
			"command",
			() => "x",
		);
		expect(result).toEqual({
			mode: "workspace-write",
			escalated: false,
			ignoredEscalation: true,
		});
	});

	it("child session, signal already aborted → no dialog, throws as a cancellation (Review Focus #2)", async () => {
		const { deps } = makeDeps();
		const parentSelect = registerParent("parent-5");
		getEscalationBroker().linkChild("child-5", "parent-5");
		seedDenial("command", "child-5");
		const ac = new AbortController();
		ac.abort();
		await expect(
			resolveCallMode(
				{ sandbox_permissions: "danger-full-access", justification: "j" },
				subagentCtx("child-5"),
				deps,
				"command",
				() => "x",
				ac.signal,
			),
		).rejects.toThrow(/cancelled/);
		expect(parentSelect).not.toHaveBeenCalled();
	});

	it("direct path passes signal through (D6)", async () => {
		const { deps } = makeDeps();
		const ctx = toolCtx(true, "Allow once") as {
			ui: { select: ReturnType<typeof vi.fn> };
		};
		const ac = new AbortController();
		seedDenial("command");
		await resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx as never,
			deps,
			"command",
			() => "x",
			ac.signal,
		);
		expect(ctx.ui.select.mock.calls[0][2]).toEqual({ signal: ac.signal });
	});

	it("direct path with no signal → the third argument is undefined (headless behavior is unchanged, verbatim, D6)", async () => {
		const { deps } = makeDeps();
		const ctx = toolCtx(true, "Allow once") as {
			ui: { select: ReturnType<typeof vi.fn> };
		};
		seedDenial("command");
		await resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx as never,
			deps,
			"command",
			() => "x",
		);
		expect(ctx.ui.select.mock.calls[0][2]).toBeUndefined();
	});

	it("the direct path also joins the FIFO lane: when this session has a registered channel it goes through broker.request (Ruling 17)", async () => {
		const { deps } = makeDeps();
		const ownSelect = vi.fn(async () => "Allow once");
		getEscalationBroker().registerParent({
			sessionId: "self",
			hasUI: () => true,
			select: ownSelect,
		});
		seedDenial("command", "self");
		const ctx = {
			hasUI: true,
			sessionManager: { getSessionId: () => "self" },
			ui: {
				select: vi.fn(async () => {
					throw new Error("must go through the broker lane");
				}),
			},
		} as never;
		const mode = await resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx,
			deps,
			"command",
			() => "x",
		);
		expect(mode).toBe("danger-full-access");
		expect(ownSelect).toHaveBeenCalledTimes(1);
	});

	it("hasUI but this session has no registered channel → falls back to a direct ctx.ui.select (behavior matches before the change)", async () => {
		const { deps } = makeDeps();
		const select = vi.fn(async () => "Allow once");
		const ctx = {
			hasUI: true,
			sessionManager: { getSessionId: () => "unregistered" },
			ui: { select },
		} as never;
		seedDenial("command", "unregistered");
		const mode = await resolveCallMode(
			{ sandbox_permissions: "danger-full-access", justification: "j" },
			ctx,
			deps,
			"command",
			() => "x",
		);
		expect(mode).toBe("danger-full-access");
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("execute passes signal through: already aborted → no dialog, throws as a cancellation (bash, Important #2)", async () => {
		const { deps } = makeDeps();
		const parentSelect = registerParent("parent-e1");
		getEscalationBroker().linkChild("child-e1", "parent-e1");
		seedDenial("command", "child-e1", {
			tool: "bash",
			params: { command: "touch ./x" },
		});
		const { bash } = createSandboxTools(deps);
		const ac = new AbortController();
		ac.abort();
		await expect(
			bash.execute(
				"call-e1",
				{
					command: "touch ./x",
					sandbox_permissions: "danger-full-access",
					justification: "probe",
				},
				ac.signal,
				undefined,
				subagentCtx("child-e1"),
			),
		).rejects.toThrow(/cancelled/);
		expect(parentSelect).not.toHaveBeenCalled();
	});

	it("execute passes signal through: already aborted → no dialog (write, Important #2)", async () => {
		const { deps } = makeDeps();
		const parentSelect = registerParent("parent-e2");
		getEscalationBroker().linkChild("child-e2", "parent-e2");
		const deniedPath = join(outsideDir, `e2-${process.pid}-${Date.now()}.txt`);
		seedDenial("operation", "child-e2", {
			tool: "write",
			params: { path: deniedPath, content: "x" },
		});
		const { write } = createSandboxTools(deps);
		const ac = new AbortController();
		ac.abort();
		await expect(
			write.execute(
				"call-e2",
				{
					path: deniedPath,
					content: "x",
					sandbox_permissions: "danger-full-access",
					justification: "probe",
				},
				ac.signal,
				undefined,
				subagentCtx("child-e2"),
			),
		).rejects.toThrow(/cancelled/);
		expect(parentSelect).not.toHaveBeenCalled();
	});

	it("execute passes signal through: already aborted → no dialog (edit, Important #2)", async () => {
		const { deps } = makeDeps();
		const parentSelect = registerParent("parent-e3");
		getEscalationBroker().linkChild("child-e3", "parent-e3");
		const deniedEdit = join(outsideDir, `e3-${process.pid}-${Date.now()}.txt`);
		seedDenial("operation", "child-e3", {
			tool: "edit",
			params: { path: deniedEdit, edits: [{ oldText: "x", newText: "y" }] },
		});
		const { edit } = createSandboxTools(deps);
		const ac = new AbortController();
		ac.abort();
		await expect(
			edit.execute(
				"call-e3",
				{
					path: deniedEdit,
					edits: [{ oldText: "x", newText: "y" }],
					sandbox_permissions: "danger-full-access",
					justification: "probe",
				},
				ac.signal,
				undefined,
				subagentCtx("child-e3"),
			),
		).rejects.toThrow(/cancelled/);
		expect(parentSelect).not.toHaveBeenCalled();
	});
});

describe("denial-first hard gate (no escalation without a real denial)", () => {
	it("no prior denial → ignore the escalation params: no dialog, run at the current mode, ignoredEscalation:true", async () => {
		const { deps } = makeDeps();
		const ctx = toolCtx(true, "Allow once") as {
			ui: { select: ReturnType<typeof vi.fn> };
		};
		const result = await resolveCall(
			{
				sandbox_permissions: "danger-full-access",
				justification: "preemptive",
			},
			ctx as never,
			deps,
			"command",
			() => "ls",
		);
		expect(result).toEqual({
			mode: "workspace-write",
			escalated: false,
			ignoredEscalation: true,
		});
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("one-shot consumption: one denial allows one escalation, and the second is ignored again", async () => {
		const { deps } = makeDeps();
		seedDenial("command");
		expect(
			await resolveCall(
				{ sandbox_permissions: "danger-full-access", justification: "j" },
				toolCtx(true, "Allow once"),
				deps,
				"command",
				() => "x",
			),
		).toEqual({
			mode: "danger-full-access",
			escalated: true,
			ignoredEscalation: false,
		});
		expect(
			await resolveCall(
				{ sandbox_permissions: "danger-full-access", justification: "j" },
				toolCtx(true, "Allow once"),
				deps,
				"command",
				() => "x",
			),
		).toEqual({
			mode: "workspace-write",
			escalated: false,
			ignoredEscalation: true,
		});
	});

	it("kind isolation: an operation denial does not allow a command escalation (and the reverse)", async () => {
		const { deps } = makeDeps();
		seedDenial("operation");
		expect(
			await resolveCall(
				{ sandbox_permissions: "danger-full-access", justification: "j" },
				toolCtx(),
				deps,
				"command",
				() => "x",
			),
		).toEqual({
			mode: "workspace-write",
			escalated: false,
			ignoredEscalation: true,
		});
		// the operation record is still there: write/edit escalation is available
		expect(
			await resolveCall(
				{ sandbox_permissions: "danger-full-access", justification: "j" },
				toolCtx(true, "Allow once"),
				deps,
				"operation",
				() => "x",
			),
		).toEqual({
			mode: "danger-full-access",
			escalated: true,
			ignoredEscalation: false,
		});
	});

	it("same-mode requests are not subject to the gate: under /permission danger-full-access a same-mode request is allowed directly", async () => {
		const { deps } = makeDeps();
		deps.permission.override = "danger-full-access";
		const ctx = toolCtx(true, "Deny") as {
			ui: { select: ReturnType<typeof vi.fn> };
		};
		expect(
			await resolveCall(
				{ sandbox_permissions: "danger-full-access", justification: "same" },
				ctx as never,
				deps,
				"command",
				() => "x",
			),
		).toEqual({
			mode: "danger-full-access",
			escalated: false,
			ignoredEscalation: false,
		});
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("illegal requests are not subject to the gate: a narrower target still reports not strictly wider (no silent downgrade into execution)", async () => {
		const { deps } = makeDeps();
		deps.permission.override = "danger-full-access";
		await expect(
			resolveCall(
				{ sandbox_permissions: "workspace-write", justification: "narrower" },
				toolCtx(),
				deps,
				"command",
				() => "x",
			),
		).rejects.toThrow(/not strictly wider/);
	});

	it("placeholder normalization follows field reachability: JSON null and the string form of justification are real inputs", async () => {
		const { deps } = makeDeps();
		const plain = {
			mode: "workspace-write" as const,
			escalated: false,
			ignoredEscalation: false,
		};
		// JSON null: after Type.Null() is declared, a strict provider delivers it to execute as-is (pi no longer strips it) → treat as omitted.
		expect(
			await resolveCall(
				{ sandbox_permissions: null, justification: null },
				toolCtx(),
				deps,
				"command",
				() => "x",
			),
		).toEqual(plain);
		// justification's string arm is Type.String() (the field itself is string | null): the strings "null"/"" reach execute on a direct
		// resolveCall path that did not go through the hook → they must count as omitted, or a normal call is judged MALFORMED
		// ("justification was sent without sandbox_permissions"). On the real tool path, prepareArguments has already stripped them (see the prepareArguments cases).
		expect(
			await resolveCall(
				{ justification: "null" },
				toolCtx(),
				deps,
				"command",
				() => "x",
			),
		).toEqual(plain);
		expect(
			await resolveCall(
				{ justification: "  NULL  " },
				toolCtx(),
				deps,
				"command",
				() => "x",
			),
		).toEqual(plain);
	});

	it("a placeholder reason is not a reason: real escalation + a justification placeholder → MALFORMED, and no approval dialog", async () => {
		const { deps } = makeDeps();
		// Seed a prior denial so the "no approval dialog" assertion is actually load-bearing: without normalization this request would pass the pair check, hit the gate,
		// and enter the approval dialog with Reason: null (the dialog itself is the failure signal).
		seedDenial("command");
		const ctx = toolCtx(true, "Allow once") as {
			ui: { select: ReturnType<typeof vi.fn> };
		};
		await expect(
			resolveCall(
				{ sandbox_permissions: "danger-full-access", justification: "null" },
				ctx as never,
				deps,
				"command",
				() => "x",
			),
		).rejects.toThrow(/nothing ran.*sent without justification/s);
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("write tool: inside the fence + no prior denial → writes as usual, appends the ignored marker, and shows no dialog", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const ctx = toolCtx(true, "Allow once") as {
			ui: { select: ReturnType<typeof vi.fn> };
		};
		const target = join(ws, "ignored-write.txt");
		const result = (await write.execute(
			"c-ignored",
			{
				path: target,
				content: "ok",
				sandbox_permissions: "danger-full-access",
				justification: "preemptive",
			},
			undefined,
			undefined,
			ctx as never,
		)) as { content: { text: string }[] };
		const { readFile } = await import("node:fs/promises");
		expect(await readFile(target, "utf-8")).toBe("ok");
		expect(result.content.map((c) => c.text).join("\n")).toContain(
			"escalation fields were ignored",
		);
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("ignored, then really denied → recorded on the ledger; the next escalation of the same kind returns to standard approval (denial → retry, full path)", async () => {
		const { deps } = makeDeps();
		const { write } = createSandboxTools(deps);
		const outside = join(outsideDir, `gate-${process.pid}-${Date.now()}.txt`);
		// Fence self-check (a first live run once saw a win32 host allow this by mistake): outside must really be outside the fence. The runner TMP is an 8.3
		// short name (RUNNER~1) while realpath is the long name; if the decision path mixes the two forms it drifts — on failure the message
		// carries every decision input (canonical target, effective roots, tmpdir, platform) and pins the allow to a single layer.
		const canonical = canonicalizeTarget(outside);
		const roots = writableRoots("workspace-write", deps.cwd, deps._tmpRoots);
		const verdict = isWithinRoots(
			canonical,
			roots,
			process.platform !== "win32",
		);
		// Identity evidence on failure: dev:ino of the roots and of the target ancestor chain — a shared identity means the identity fallback hit,
		// and distinct identities mean the decision came from the lexical branch. Expose this before the tool call so it can still be reproduced afterward.
		const statId = (p: string): string => {
			try {
				const s = statSync(p);
				return `${s.dev}:${s.ino}`;
			} catch {
				return "ENOENT";
			}
		};
		const ancestorIds: string[] = [];
		for (let a = canonical; ; ) {
			ancestorIds.push(`${a} [${statId(a)}]`);
			const parent = dirname(a);
			if (parent === a) break;
			a = parent;
		}
		expect(
			verdict,
			`fence self-check: target=${canonical} verdict=${verdict} roots=${JSON.stringify(roots.map((r) => `${r} [${statId(r)}]`))} ancestors=${JSON.stringify(ancestorIds)} _tmpRoots=${JSON.stringify(deps._tmpRoots)} tmpdir=${tmpdir()} platform=${process.platform}`,
		).toBe(false);
		const ctx = toolCtx(true, "Allow once") as {
			ui: { select: ReturnType<typeof vi.fn> };
		};
		// 1) no prior denial + escalation params → ignore, run as workspace-write → fence denial (and record it on the ledger)
		await expect(
			write.execute(
				"g-1",
				{
					path: outside,
					content: "x",
					sandbox_permissions: "danger-full-access",
					justification: "preemptive",
				},
				undefined,
				undefined,
				ctx as never,
			),
		).rejects.toThrow(/file access denied under workspace-write mode/);
		expect(ctx.ui.select).not.toHaveBeenCalled();
		// 2) retry with the same arguments: a denial is now on record → dialog → the write really lands on disk
		await write.execute(
			"g-2",
			{
				path: outside,
				content: "x",
				sandbox_permissions: "danger-full-access",
				justification: "retry after denial",
			},
			undefined,
			undefined,
			ctx as never,
		);
		expect(ctx.ui.select).toHaveBeenCalledTimes(1);
		const { readFile } = await import("node:fs/promises");
		expect(await readFile(outside, "utf-8")).toBe("x");
	});
});

describe("windows tool wiring", () => {
	/** Test pwsh tool factory: records calls (once for base metadata, once at execute with ops); execute echoes the input back. */
	function fakePowerShellBuilder(
		calls: { cwd: string; opts?: unknown }[] = [],
	) {
		return vi.fn((cwd: string, opts?: unknown) => {
			calls.push({ cwd, opts });
			return {
				name: "powershell",
				label: "PowerShell",
				description: "Run PowerShell commands",
				parameters: {
					type: "object",
					properties: { command: { type: "string" } },
				},
				async execute(_id: string, params: { command?: string }) {
					return {
						content: [
							{
								type: "text" as const,
								text: `ran ${String(params.command ?? "")}`,
							},
						],
					};
				},
			};
		});
	}

	it("builds the tool set on win32 and exposes a powershell tool when the host provides the builder", () => {
		const tools = createSandboxTools({
			cwd: process.cwd(),
			permission: processPermissionState,
			platform: "win32",
		});
		for (const name of ["bash", "write", "edit"] as const)
			expect(tools[name]).toBeDefined();
		if (tools.powershell === undefined) {
			// On a host <1.0.0 (this repo's devDependency 0.80.2 is one) the legal default is: no error, and do not block
			expect(typeof tools.powershell).toBe("undefined");
			return;
		}
		expect((tools.powershell as { name?: string }).name).toBe("powershell");
	});

	it("registers bash with exposure:hidden on win32 and leaves the key unset elsewhere", () => {
		// win32 tool wiring (D3, third revision): pi 1.0.0's default active list activates ["read","bash","edit","write"] by **name**,
		// and the meaning of `defaultActive: false` is exactly "named means activated" → it cannot block the default list (disproved on a real machine). So switch to
		// `exposure: "hidden"`: _applyToolLoadout drops hidden, and named activation does not take effect either (registered but unreachable).
		// Skipping registration is not an option (that would expose pi's built-in unconfined bash, and explicitly enabling it is fail-open), so this is "register + hidden".
		const win32 = createSandboxTools({
			cwd: process.cwd(),
			permission: processPermissionState,
			platform: "win32",
		});
		expect((win32.bash as { exposure?: string }).exposure).toBe("hidden");
		// Non-win32 does not set that key (existing behavior stays: bash must be active by default) — test own properties, so a truthiness check does not miss undefined.
		const linux = createSandboxTools({
			cwd: process.cwd(),
			permission: processPermissionState,
			platform: "linux",
		});
		expect(Object.hasOwn(linux.bash, "exposure")).toBe(false);
		expect((linux.bash as { exposure?: string }).exposure).toBeUndefined();
	});

	it("does not register a powershell tool on POSIX platforms (builder present or not)", () => {
		const build = vi.fn();
		const tools = createSandboxTools({
			cwd: process.cwd(),
			permission: processPermissionState,
			platform: "linux",
			_hostCreatePowerShellToolDefinition: build,
		});
		expect(tools.powershell).toBeUndefined();
		// The platform gate runs before host probing and construction: on non-win32 the builder must not even be touched (on an old host that key does not exist anyway).
		expect(build).not.toHaveBeenCalled();
	});

	it("passes the win32 platform through to the bash ops builder", async () => {
		// bash's own denial behavior is pinned by the Task 12 shell-ops cases; here we only assert that the tools layer does not swallow this injection point.
		// ops are built per call (mode comes from that resolveCall), so platform pass-through is observable only by actually running execute once.
		const build = vi.fn(() => ({ exec: vi.fn(async () => ({ exitCode: 0 })) }));
		const { deps } = makeDeps({
			platform: "win32",
			_buildBashOps: build as never,
		});
		const { bash } = createSandboxTools(deps);
		await bash.execute(
			"call-win32",
			{ command: "echo hi" },
			undefined,
			undefined,
			toolCtx(),
		);
		expect(build).toHaveBeenCalledWith(
			expect.objectContaining({ platform: "win32" }),
		);
	});

	it("win32 + host builder: powershell carries the same escalation surface and builds ops per call", async () => {
		// Host 0.80.2 has no createPowerShellToolDefinition → the positive branch is reached via test injection;
		// the injected value uses the same `typeof === "function"` check as production namespace probing.
		const calls: { cwd: string; opts?: unknown }[] = [];
		const builder = fakePowerShellBuilder(calls);
		const { deps } = makeDeps({
			platform: "win32",
			_hostCreatePowerShellToolDefinition: builder,
		});
		const { powershell } = createSandboxTools(deps);
		expect(powershell?.name).toBe("powershell");
		// The same escalation surface as bash (extendParams) and the same prepareArguments chain (placeholder stripping).
		const props = (
			powershell?.parameters as { properties: Record<string, unknown> }
		).properties;
		expect(props.sandbox_permissions).toBeDefined();
		expect(props.justification).toBeDefined();
		expect(
			powershell?.prepareArguments?.({
				command: "Get-ChildItem",
				sandbox_permissions: "null",
				justification: "null",
			}),
		).toEqual({ command: "Get-ChildItem" });
		// Fetch base metadata once at creation; at execute, build another definition with confined ops for that mode (same shape as bash).
		expect(calls.length).toBe(1);
		const result = await powershell!.execute(
			"pwsh-1",
			{ command: "Get-ChildItem" },
			undefined,
			undefined,
			toolCtx(),
		);
		expect(calls.length).toBe(2);
		expect(calls[0].opts).toBeUndefined();
		// Identity pin (T14 revision): what is passed to the builder at build time must be the confined factory's product **itself**, not the host's local (unconfined) ops
		// or any copy or wrapper (those are also "an operations object", but they would run pwsh outside the sandbox, fail-open).
		// Must use toBe (reference equality): toEqual/objectContaining compare structure, so a shallow copy would slip through.
		const executeOpts = calls[1].opts as { operations?: unknown } | undefined;
		expect(executeOpts?.operations).toBe(powershellOpsSentinel);
		expect(createSandboxPowerShellOpsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				platform: "win32",
				onDenial: expect.any(Function),
			}),
		);
		expect((result.content[0] as { text: string }).text).toBe(
			"ran Get-ChildItem",
		);
	});

	it("a throwing host pwsh builder degrades to no powershell tool without breaking bash/write/edit", () => {
		// I2 fail-open regression gate: if a throw during construction escapes createSandboxTools, pi nulls out the whole extension,
		// and bash/write/edit then run with no sandbox. It must degrade to "no pwsh override", and the three base tools still register as usual.
		const builder = vi.fn(() => {
			throw new Error("host builder exploded");
		});
		const { deps } = makeDeps({
			platform: "win32",
			_hostCreatePowerShellToolDefinition: builder,
		});
		const tools = createSandboxTools(deps);
		expect(builder).toHaveBeenCalledTimes(1);
		for (const name of ["bash", "write", "edit"] as const)
			expect(tools[name]).toBeDefined();
		expect(tools.powershell).toBeUndefined();
	});

	it("powershell escalates only a matching command denial and keeps the one-shot marker", async () => {
		const { deps } = makeDeps({
			platform: "win32",
			_hostCreatePowerShellToolDefinition: fakePowerShellBuilder(),
		});
		const { powershell } = createSandboxTools(deps);
		const ctx = toolCtx(true, "Allow once") as {
			ui: { select: ReturnType<typeof vi.fn> };
		};
		// No prior denial: the command-kind gate ignores the escalation (same ledger as bash), shows no dialog, and the result carries the ignored marker.
		const ignored = (await powershell!.execute(
			"pwsh-g1",
			{
				command: "Set-Content C:\\outside.txt x",
				sandbox_permissions: "danger-full-access",
				justification: "preemptive",
			},
			undefined,
			undefined,
			ctx as never,
		)) as { content: { text: string }[] };
		expect(ctx.ui.select).not.toHaveBeenCalled();
		expect(ignored.content.map((c) => c.text).join("\n")).toContain(
			"escalation fields were ignored",
		);
		// After seeding a command-kind prior denial, retry with the same arguments: it enters approval with subject command (same copy as bash), and carries the one-shot marker once approved.
		seedDenial("command", TEST_SESSION, {
			tool: "powershell",
			params: { command: "Set-Content C:\\outside.txt x" },
		});
		const escalated = (await powershell!.execute(
			"pwsh-g2",
			{
				command: "Set-Content C:\\outside.txt x",
				sandbox_permissions: "danger-full-access",
				justification: "retry after denial",
			},
			undefined,
			undefined,
			ctx as never,
		)) as { content: { text: string }[] };
		expect(ctx.ui.select).toHaveBeenCalledTimes(1);
		expect(ctx.ui.select.mock.calls[0][0]).toContain("this command");
		expect(escalated.content.map((c) => c.text).join("\n")).toContain(
			'one-shot escalation to "danger-full-access"',
		);
	});
});

describe("sandbox_grant_write", () => {
	function seedPathDenial(path: string, sessionId = TEST_SESSION) {
		getDenialLedger().record({
			sessionId,
			tool: "write",
			fingerprint: operationFingerprint({ path }),
			cwd: ws,
			workspace: ws,
			sandboxMode: "workspace-write",
			backend: "bwrap",
			target: path,
			writablePaths: [],
			recordedAt: Date.now(),
		});
	}

	it("asks once, then later writes under that directory succeed without consuming the denial", async () => {
		const { deps } = makeDeps();
		const { grantWrite, write } = createSandboxTools(deps);
		const grantDir = join(outsideDir, "app");
		const target = join(grantDir, "file.txt");
		seedPathDenial(target);
		const ctx = toolCtx(true, "Allow once") as {
			ui: { select: ReturnType<typeof vi.fn> };
		};
		const granted = (await grantWrite.execute(
			"g1",
			{ path: grantDir, justification: "the skill writes its data here" },
			undefined,
			undefined,
			ctx as never,
		)) as { content: { text: string }[] };
		expect(ctx.ui.select).toHaveBeenCalledTimes(1);
		expect(ctx.ui.select.mock.calls[0][0]).toContain("until this request ends");
		expect(granted.content.map((part) => part.text).join("\n")).toContain(
			grantDir,
		);
		expect(getDenialLedger().list(TEST_SESSION)).toHaveLength(1);
		const written = (await write.execute(
			"g2",
			{ path: target, content: "ok" },
			undefined,
			undefined,
			toolCtx(),
		)) as { content: { text: string }[] };
		expect(written.content[0]?.text).toContain("Successfully wrote");
		await grantWrite.execute(
			"g3",
			{ path: grantDir, justification: "again" },
			undefined,
			undefined,
			ctx as never,
		);
		expect(ctx.ui.select).toHaveBeenCalledTimes(1);
	});

	it("refuses when no denial names a path inside the directory", async () => {
		const { deps } = makeDeps();
		const { grantWrite } = createSandboxTools(deps);
		const ctx = toolCtx(true, "Allow once") as {
			ui: { select: ReturnType<typeof vi.fn> };
		};
		await expect(
			grantWrite.execute(
				"g4",
				{ path: join(outsideDir, "other"), justification: "guess" },
				undefined,
				undefined,
				ctx as never,
			),
		).rejects.toThrow(/no sandbox denial/);
		expect(ctx.ui.select).not.toHaveBeenCalled();
		expect(getWritableGrants().list(TEST_SESSION)).toEqual([]);
	});

	it("refuses / and the home directory before asking", async () => {
		const { deps } = makeDeps();
		const { grantWrite } = createSandboxTools(deps);
		seedPathDenial(join(homedir(), "x"));
		const ctx = toolCtx(true, "Allow once") as {
			ui: { select: ReturnType<typeof vi.fn> };
		};
		await expect(
			grantWrite.execute(
				"g5",
				{ path: homedir(), justification: "home" },
				undefined,
				undefined,
				ctx as never,
			),
		).rejects.toThrow(/home directory/);
		await expect(
			grantWrite.execute(
				"g6",
				{ path: "/", justification: "root" },
				undefined,
				undefined,
				ctx as never,
			),
		).rejects.toThrow(/home directory/);
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("does not apply a grant from another session", async () => {
		const { deps } = makeDeps();
		const { grantWrite, write } = createSandboxTools(deps);
		const grantDir = join(outsideDir, "session-a");
		const target = join(grantDir, "file.txt");
		seedPathDenial(target, "session-a");
		const ctx = {
			hasUI: true,
			sessionManager: { getSessionId: () => "session-a" },
			ui: {
				select: vi.fn(async () => "Allow once"),
				input: vi.fn(async () => undefined),
				notify: vi.fn(),
			},
		};
		await grantWrite.execute(
			"g7",
			{ path: grantDir, justification: "skill data" },
			undefined,
			undefined,
			ctx as never,
		);
		await expect(
			write.execute(
				"g8",
				{ path: target, content: "x" },
				undefined,
				undefined,
				toolCtx(),
			),
		).rejects.toThrow(/file access denied/);
	});

	it("binds the granted directory into the confined bash argv", async () => {
		const { deps, child, spawnFn } = makeDeps();
		const { grantWrite, bash } = createSandboxTools(deps);
		const grantDir = join(outsideDir, "bash-app");
		seedPathDenial(join(grantDir, "x"));
		await grantWrite.execute(
			"g9",
			{ path: grantDir, justification: "skill data" },
			undefined,
			undefined,
			toolCtx(),
		);
		const pending = bash.execute(
			"g10",
			{ command: "echo hi" },
			undefined,
			undefined,
			toolCtx(),
		);
		await vi.waitFor(() => {
			expect(spawnFn).toHaveBeenCalled();
		});
		child.stdout.write("ok");
		child.emit("close", 0, undefined);
		await pending;
		const argv = spawnFn.mock.calls[0]?.[1] as string[];
		expect(argv).toEqual(
			expect.arrayContaining(["--bind", grantDir, grantDir]),
		);
	});

	it("removes empty directories it created when the grant is cleared", async () => {
		const { deps } = makeDeps();
		const { grantWrite } = createSandboxTools(deps);
		const grantDir = join(outsideDir, "share", "app");
		seedPathDenial(join(grantDir, "file.txt"));
		await grantWrite.execute(
			"g11",
			{ path: grantDir, justification: "skill data" },
			undefined,
			undefined,
			toolCtx(),
		);
		expect(existsSync(grantDir)).toBe(true);

		getWritableGrants().clear(TEST_SESSION);

		expect(existsSync(grantDir)).toBe(false);
		expect(existsSync(join(outsideDir, "share"))).toBe(false);
		expect(existsSync(outsideDir)).toBe(true);
	});

	it("keeps a created directory that received a file when the grant is cleared", async () => {
		const { deps } = makeDeps();
		const { grantWrite, write } = createSandboxTools(deps);
		const grantDir = join(outsideDir, "share", "kept");
		const target = join(grantDir, "file.txt");
		seedPathDenial(target);
		await grantWrite.execute(
			"g12",
			{ path: grantDir, justification: "skill data" },
			undefined,
			undefined,
			toolCtx(),
		);
		await write.execute(
			"g13",
			{ path: target, content: "ok" },
			undefined,
			undefined,
			toolCtx(),
		);

		getWritableGrants().clear(TEST_SESSION);

		expect(existsSync(target)).toBe(true);
		expect(existsSync(join(outsideDir, "share"))).toBe(true);
	});
});
