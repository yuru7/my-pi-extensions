import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSandboxConfigCache } from "../src/config";
import {
	getEscalationBroker,
	resetEscalationBrokerForTests,
} from "../src/escalation-broker";
import {
	type PermissionState,
	processPermissionState,
} from "../src/permission";
import { aclSkillPaths } from "../src/win32/skill-paths";
import {
	getWritableGrants,
	resetWritableGrantsForTests,
} from "../src/writable-grants";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "idx-"));
	mkdirSync(join(dir, "agent"), { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
});
afterEach(() => {
	processPermissionState.override = null; // C1: reset the module singleton across tests
	for (const state of freshPermissionStates.splice(0)) state.override = null; // T15 revision: the new instance re-fetched after resetModules is reset the same way
	resetEscalationBrokerForTests(); // the approval-channel registry is also a process-level singleton and must be reset
	resetWritableGrantsForTests();
	resetSandboxConfigCache();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

/**
 * T15 revision (test isolation): after `vi.resetModules()`, `await import("../index")` in a status-line case re-evaluates
 * the whole module graph. The command handler reads the `src/permission` singleton inside the **new** module instance, while the static import at the top of the file
 * binds `processPermissionState` to the initial instance. This repo currently stores the singleton on globalThis (`PERMISSION_STATE_KEY`),
 * so the two instances happen to be the same object and the override does take effect; that sharing is implicit — if the singleton moves back to a module-level variable,
 * the override fails silently, status falls back to the config default mode, and a real runner probe runs (`selectRunner`). So this explicitly does
 * "resetModules → re-fetch the new singleton → set the override → then import the extension", and registers the new instance for afterEach to reset.
 */
const freshPermissionStates: PermissionState[] = [];
async function importIndexWithDangerFullAccessOverride() {
	vi.resetModules();
	const { processPermissionState: fresh } = await import("../src/permission");
	fresh.override = "danger-full-access";
	freshPermissionStates.push(fresh);
	return (await import("../index")).default;
}

type CommandHandler = (
	args: string,
	ctx: { ui: { notify: ReturnType<typeof vi.fn> }; cwd?: string },
) => Promise<void>;
type HookHandler = (event: unknown, ctx: unknown) => void;

/**
 * Fake pi: records registered tools, commands, hooks, and event subscriptions.
 * Since 2026-09-30, index.ts registers a lifecycle hook and two child-session event subscriptions,
 * so the old assertion "throw as soon as pi.on is called" is obsolete (the registerFlag ban stays).
 */
function makeFakePi() {
	const tools: string[] = [];
	const commands: string[] = [];
	const commandHandlers: Record<string, { handler: CommandHandler }> = {};
	const hooks: Record<string, HookHandler> = {};
	const channels: Record<string, (data: unknown) => void> = {};
	const fakePi = {
		registerTool: (t: { name: string }) => {
			tools.push(t.name);
		},
		registerCommand: (name: string, cmd: { handler: CommandHandler }) => {
			commands.push(name);
			commandHandlers[name] = cmd;
		},
		registerFlag: vi.fn(() => {
			throw new Error("2.0 must not register flags");
		}),
		on: (event: string, handler: HookHandler) => {
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
	return { fakePi, tools, commands, commandHandlers, hooks, channels };
}

function parentCtx(sessionId: string, hasUI = true) {
	return {
		hasUI,
		sessionManager: { getSessionId: () => sessionId },
		ui: { select: async () => "Allow once", input: async () => "because" },
	};
}

describe("extension activate", () => {
	it("registers sandboxed bash/write/edit tools, the /permission command and the lifecycle hooks, no flags", async () => {
		const { fakePi, tools, commands, hooks, channels } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		expect(tools.sort()).toEqual([
			"bash",
			"edit",
			"sandbox_grant_write",
			"write",
		]);
		expect(commands).toEqual(["permission", "pi-sandbox"]);
		// Since T15 there is one more resources_discover (skill platform gate); the directory-grant lifecycle hooks are here too.
		expect(Object.keys(hooks).sort()).toEqual([
			"agent_settled",
			"before_agent_start",
			"message_start",
			"resources_discover",
			"session_shutdown",
			"session_start",
		]);
		expect(Object.keys(channels).sort()).toEqual([
			"subagents:child:disposed",
			"subagents:child:session-created",
		]);
	});

	it("clears a directory grant on the next user message, on settle, and before the next prompt", async () => {
		const { fakePi, hooks } = makeFakePi();
		(await import("../index")).default(fakePi as never);
		const ctx = { sessionManager: { getSessionId: () => "sess" } };
		getWritableGrants().grant("sess", "/tmp/granted");
		hooks.message_start?.({ message: { role: "assistant" } }, ctx);
		expect(getWritableGrants().list("sess")).toEqual(["/tmp/granted"]);
		hooks.message_start?.({ message: { role: "user" } }, ctx);
		expect(getWritableGrants().list("sess")).toEqual([]);
		getWritableGrants().grant("sess", "/tmp/granted");
		hooks.agent_settled?.({}, ctx);
		expect(getWritableGrants().list("sess")).toEqual([]);
		getWritableGrants().grant("sess", "/tmp/granted");
		hooks.before_agent_start?.({}, ctx);
		expect(getWritableGrants().list("sess")).toEqual([]);
	});

	it("/permission override is shared across activates via the module singleton (C1)", async () => {
		// Background: pi calls the extension factory again for every session (including subagent child sessions) — two activate calls
		// stand in for a parent and a child session; the override must be visible across sessions via the module-level processPermissionState.
		const first = makeFakePi();
		const second = makeFakePi();
		const activate = (await import("../index")).default;
		activate(first.fakePi as never); // session #1 (parent)
		activate(second.fakePi as never); // session #2 (child; the factory is called again)

		// Session #1 sets the override (danger-full-access: status takes the bypassed branch and does not probe a real runner)
		const notify1 = vi.fn();
		await first.commandHandlers.permission.handler("danger-full-access", {
			ui: { notify: notify1 },
		});
		expect(notify1).toHaveBeenCalledWith(
			expect.stringContaining("danger-full-access"),
			"info",
		);

		// Session #2's status must see that override (no cwd → describeStatus("") falls back to the activate cwd)
		const notify2 = vi.fn();
		await second.commandHandlers.permission.handler("", {
			ui: { notify: notify2 },
		});
		const status = String(notify2.mock.calls[0]?.[0]);
		expect(status).toContain("danger-full-access");
		expect(status).toContain("/permission");
		expect(processPermissionState.override).toBe("danger-full-access");
	});

	it("corrupt project config: activate does not throw, falls back to defaults, still registers everything (I2)", async () => {
		// Invalid config (runnerCommand with no paired signatures → validateSandboxConfig throws) is written into a temp project,
		// and chdir there so activate's process.cwd() hits it; PI_CODING_AGENT_DIR is already isolated by beforeEach.
		const projectDir = join(dir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			join(projectDir, ".pi", "sandbox.json"),
			JSON.stringify({ runnerCommand: ["myrunner"] }),
		);
		const { fakePi, tools, commands } = makeFakePi();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const prevCwd = process.cwd();
		process.chdir(projectDir);
		try {
			const activate = (await import("../index")).default;
			expect(() => activate(fakePi as never)).not.toThrow();
			expect(tools.sort()).toEqual([
				"bash",
				"edit",
				"sandbox_grant_write",
				"write",
			]);
			expect(commands).toEqual(["permission", "pi-sandbox"]);
			expect(warn.mock.calls.flat().join(" ")).toMatch(
				/falling back to defaults/u,
			);
		} finally {
			process.chdir(prevCwd);
			warn.mockRestore();
		}
	});

	it("status shows bypassed before custom runner when mode is danger-full-access (Ruling 19)", async () => {
		const proj = mkdtempSync(join(tmpdir(), "proj-"));
		mkdirSync(join(proj, ".pi"), { recursive: true });
		writeFileSync(
			join(proj, ".pi", "sandbox.json"),
			JSON.stringify({
				mode: "danger-full-access",
				runnerCommand: ["myrunner"],
				runnerFailureSignatures: ["myrunner: "],
			}),
		);
		try {
			const { fakePi, commandHandlers } = makeFakePi();
			const activate = (await import("../index")).default;
			activate(fakePi as never);
			const notify = vi.fn();
			await commandHandlers.permission.handler("", {
				ui: { notify },
				cwd: proj,
			});
			const text = notify.mock.calls[0][0] as string;
			expect(text).toContain("bypassed");
			expect(text).not.toContain("custom command");
		} finally {
			rmSync(proj, { recursive: true, force: true });
		}
	});
});

describe("escalation approval forwarding wiring (spec 2026-09-30 §4.5)", () => {
	it("session_start registers the parent approval channel, and session_shutdown unregisters it (Review Focus #4)", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		const broker = getEscalationBroker();
		broker.linkChild("child-1", "parent-1");
		expect(broker.resolveChannel("child-1")).toBeNull(); // session_start has not happened yet
		hooks.session_start?.({ type: "session_start" }, parentCtx("parent-1"));
		expect(broker.resolveChannel("child-1")).not.toBeNull();
		hooks.session_shutdown?.(
			{ type: "session_shutdown" },
			parentCtx("parent-1"),
		);
		expect(broker.resolveChannel("child-1")).toBeNull(); // parent channel unregistered; the child session is fail-closed again
	});

	it("a session with hasUI=false is not registered as an approval endpoint (positive control: deleting the guard turns this case red)", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		const broker = getEscalationBroker();
		broker.linkChild("child-1", "headless-parent");
		const ctx = {
			hasUI: false,
			sessionManager: { getSessionId: () => "headless-parent" },
			ui: { select: async () => "Allow once" },
		};
		hooks.session_start?.({ type: "session_start" }, ctx);
		expect(broker.resolveChannel("child-1")).toBeNull();
		// Positive control: if registration ignored hasUI, a live check would surface the channel after it flips to true → this assertion goes red
		ctx.hasUI = true;
		expect(broker.resolveChannel("child-1")).toBeNull();
	});

	it("parent session loses UI after registration → the channel fails immediately (hasUI is checked live, not snapshotted)", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		const ctx = {
			hasUI: true,
			sessionManager: { getSessionId: () => "p" },
			ui: { select: async () => "Allow once" },
		};
		hooks.session_start?.({ type: "session_start" }, ctx);
		getEscalationBroker().linkChild("c", "p");
		expect(getEscalationBroker().resolveChannel("c")).not.toBeNull();
		ctx.hasUI = false; // e.g. lost dialog capability after reload / session replacement
		expect(getEscalationBroker().resolveChannel("c")).toBeNull();
	});

	it("child-session lifecycle events create and clear the link; a payload missing fields must not throw", async () => {
		const { fakePi, hooks, channels } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		hooks.session_start?.({ type: "session_start" }, parentCtx("p"));
		const broker = getEscalationBroker();
		channels["subagents:child:session-created"]?.({
			sessionId: "c1",
			parentSessionId: "p",
		});
		expect(broker.resolveChannel("c1")).not.toBeNull();
		channels["subagents:child:disposed"]?.({ sessionId: "c1" });
		expect(broker.resolveChannel("c1")).toBeNull();
		// Upstream contract drift (missing fields / wrong types) → no link, no throw; the child session stays fail-closed
		expect(() =>
			channels["subagents:child:session-created"]?.({}),
		).not.toThrow();
		expect(() =>
			channels["subagents:child:session-created"]?.({
				sessionId: 42,
				parentSessionId: "p",
			}),
		).not.toThrow();
		// A numeric payload is stopped by the typeof guard: it neither creates a link nor pollutes a later valid link (positive control)
		channels["subagents:child:session-created"]?.({
			sessionId: "c2",
			parentSessionId: "p",
		});
		expect(broker.resolveChannel("c2")).not.toBeNull();
		expect(broker.resolveChannel("42")).toBeNull();
	});

	it("the registered parent channel passes opts through to ctx.ui.select", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		const select = vi.fn(async () => "Allow once");
		const ctx = {
			hasUI: true,
			sessionManager: { getSessionId: () => "p" },
			ui: { select },
		};
		hooks.session_start?.({ type: "session_start" }, ctx);
		const channel = getEscalationBroker().resolveChannel("c");
		expect(channel).toBeNull(); // no link yet
		getEscalationBroker().linkChild("c", "p");
		const resolved = getEscalationBroker().resolveChannel("c");
		expect(resolved).not.toBeNull();
		const ac = new AbortController();
		await resolved?.select("T", ["Allow once", "Deny"], { signal: ac.signal });
		expect(select).toHaveBeenCalledWith("T", ["Allow once", "Deny"], {
			signal: ac.signal,
		});
	});

	it("the registered parent channel passes opts through to ctx.ui.input (step two of the two-step Deny reason)", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		const input = vi.fn(async () => "because");
		const ctx = {
			hasUI: true,
			sessionManager: { getSessionId: () => "p" },
			ui: { select: async () => "Allow once", input },
		};
		hooks.session_start?.({ type: "session_start" }, ctx);
		getEscalationBroker().linkChild("c", "p");
		const resolved = getEscalationBroker().resolveChannel("c");
		expect(resolved).not.toBeNull();
		const ac = new AbortController();
		await resolved?.input?.("Why deny?", "optional", { signal: ac.signal });
		expect(input).toHaveBeenCalledWith("Why deny?", "optional", {
			signal: ac.signal,
		});
	});

	it("old host ctx.ui has no input → channel input is undefined (the broker skips the reason prompt)", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		const ctx = {
			hasUI: true,
			sessionManager: { getSessionId: () => "p" },
			ui: { select: async () => "Allow once" },
		};
		hooks.session_start?.({ type: "session_start" }, ctx);
		getEscalationBroker().linkChild("c", "p");
		const resolved = getEscalationBroker().resolveChannel("c");
		expect(resolved).not.toBeNull();
		expect(resolved?.input).toBeUndefined();
	});

	it("stale ctx (the hasUI getter throws) → the channel fails closed and does not propagate the host error", async () => {
		const { fakePi, hooks } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		let stale = false;
		const ctx = {
			get hasUI() {
				if (stale)
					throw new Error(
						"This extension ctx is stale after session replacement or reload.",
					);
				return true;
			},
			sessionManager: { getSessionId: () => "p" },
			ui: { select: async () => "Allow once" },
		};
		hooks.session_start?.({ type: "session_start" }, ctx);
		getEscalationBroker().linkChild("c", "p");
		expect(getEscalationBroker().resolveChannel("c")).not.toBeNull();
		stale = true; // simulate the host assertActive() throwing after session replacement / reload
		expect(getEscalationBroker().resolveChannel("c")).toBeNull();
	});

	it("session_shutdown unsubscribes both event channels (a host reload reuses the same bus; without unsubscribe, listeners accumulate)", async () => {
		const { fakePi, hooks, channels } = makeFakePi();
		const activate = (await import("../index")).default;
		activate(fakePi as never);
		expect(Object.keys(channels)).toHaveLength(2);
		hooks.session_shutdown?.({ type: "session_shutdown" }, parentCtx("p"));
		expect(Object.keys(channels)).toEqual([]);
	});
});

/**
 * T15: the skill platform gate (Ruling 9) and the notice when pwsh is not activated (Ruling 8).
 * The notice is a module-level flag, **once per process**, so every case that needs a "first notice" calls `vi.resetModules()` first
 * and then imports index; the fires-once case uses two activate calls to pin that it does not repeat across sessions.
 */
describe("T15: platform gate and the pwsh-not-activated notice (Ruling 8/9)", () => {
	/** On Node, process.platform is a configurable data property: restore the original descriptor after a temporary rewrite. */
	async function withPlatform<T>(
		platform: string,
		run: () => Promise<T> | T,
	): Promise<T> {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: platform });
		try {
			return await run();
		} finally {
			if (original) Object.defineProperty(process, "platform", original);
		}
	}

	/** Fake pi with getActiveTools (Ruling 8's probe surface); pass a function to simulate a getter that throws (stale host). */
	function makeFakePiWithActiveTools(active: string[] | (() => string[])) {
		const made = makeFakePi();
		(
			made.fakePi as unknown as { getActiveTools: () => string[] }
		).getActiveTools = typeof active === "function" ? active : () => active;
		return made;
	}

	function uiCtx(sessionId: string, notify: ReturnType<typeof vi.fn>) {
		return {
			hasUI: true,
			sessionManager: { getSessionId: () => sessionId },
			ui: {
				select: async () => "Allow once",
				input: async () => "because",
				notify,
			},
		};
	}

	it("contributes the ACL skill path only on win32", async () => {
		const handlers: Record<
			string,
			Array<(event: unknown, ctx: unknown) => unknown>
		> = {};
		const fakePi = {
			on: (name: string, handler: never) => {
				(handlers[name] ??= []).push(handler);
				return () => {};
			},
			registerTool: () => {},
			registerCommand: () => {},
			events: { on: () => () => {} },
		};
		(await import("../index")).default(fakePi as never);
		const discovery = handlers.resources_discover?.[0];
		expect(discovery).toBeDefined();
		await withPlatform("win32", async () => {
			await expect(
				Promise.resolve(
					discovery?.(
						{
							type: "resources_discover",
							cwd: process.cwd(),
							reason: "startup",
						},
						{},
					),
				),
			).resolves.toEqual({
				skillPaths: aclSkillPaths("win32"),
			});
		});
		await withPlatform("linux", async () => {
			await expect(
				Promise.resolve(
					discovery?.(
						{
							type: "resources_discover",
							cwd: process.cwd(),
							reason: "reload",
						},
						{},
					),
				),
			).resolves.toEqual({ skillPaths: [] });
		});
	});

	it("registers the powershell tool only when createSandboxTools provides one", async () => {
		// Host 0.80.2 has no createPowerShellToolDefinition, so the win32 positive branch cannot be reached naturally in a unit test;
		// mock the return value of ../src/tools here and pin only index.ts's `!== undefined` gate itself.
		// (The default branch is covered by the exact tools set in this file's first case: undefined must skip registration rather than register undefined.)
		vi.doMock("../src/tools", () => ({
			createSandboxTools: () => ({
				bash: { name: "bash" },
				write: { name: "write" },
				edit: { name: "edit" },
				powershell: { name: "powershell" },
			}),
		}));
		vi.resetModules();
		try {
			const { fakePi, tools } = makeFakePi();
			const activate = (await import("../index")).default;
			activate(fakePi as never);
			expect(tools.sort()).toEqual(["bash", "edit", "powershell", "write"]);
		} finally {
			vi.doUnmock("../src/tools");
			vi.resetModules();
		}
	});

	it("/permission status line marks not activated on win32 when pwsh is inactive (Ruling 8)", async () => {
		const { fakePi, commandHandlers } = makeFakePiWithActiveTools(["bash"]);
		// T15 revision: the override must be set on the singleton re-fetched after resetModules (bypassed branch: no runner probe)
		const activate = await importIndexWithDangerFullAccessOverride();
		activate(fakePi as never);
		const notify = vi.fn();
		await withPlatform("win32", async () => {
			await commandHandlers.permission.handler("", { ui: { notify } });
		});
		expect(notify).toHaveBeenCalledTimes(1);
		const text = String(notify.mock.calls[0]?.[0]);
		expect(text).toContain(
			"sandbox mode: danger-full-access (/permission override)",
		); // isolation holds: status really read the override set by this case
		expect(text).toContain("shell: powershell only (not activated)");
	});

	it("/permission status line on win32 with pwsh active only notes the shell dialect", async () => {
		const { fakePi, commandHandlers } = makeFakePiWithActiveTools([
			"bash",
			"powershell",
		]);
		const activate = await importIndexWithDangerFullAccessOverride();
		activate(fakePi as never);
		const notify = vi.fn();
		await withPlatform("win32", async () => {
			await commandHandlers.permission.handler("", { ui: { notify } });
		});
		expect(notify).toHaveBeenCalledTimes(1);
		const text = String(notify.mock.calls[0]?.[0]);
		expect(text).toContain(
			"sandbox mode: danger-full-access (/permission override)",
		);
		expect(text).toContain("shell: powershell only");
		expect(text).not.toContain("not activated");
	});

	it("/permission status line on non-win32 does not include a PowerShell line", async () => {
		const { fakePi, commandHandlers } = makeFakePiWithActiveTools(["bash"]);
		const activate = await importIndexWithDangerFullAccessOverride();
		activate(fakePi as never);
		const notify = vi.fn();
		// Platform gate: this case asserts **non-win32** behavior and must pin platform; otherwise on a Windows host
		// process.platform takes the win32 branch (the status line gains a PowerShell line) and the case fails spuriously.
		await withPlatform("linux", async () => {
			await commandHandlers.permission.handler("", { ui: { notify } });
		});
		expect(notify).toHaveBeenCalledTimes(1);
		const text = String(notify.mock.calls[0]?.[0]);
		expect(text).toContain(
			"sandbox mode: danger-full-access (/permission override)",
		);
		expect(text).not.toContain("shell: powershell");
	});

	it("/permission status line marks activation unknown on win32 when activation cannot be determined (T15 revision)", async () => {
		// An old host (the same shape as this repo's devDependency 0.80.2) has no getActiveTools: on such a host the pwsh
		// tool does not exist at all, and a bare "shell: powershell only" would be read as "enabled", so the unknown state must be marked explicitly.
		const { fakePi, commandHandlers } = makeFakePi(); // no getActiveTools
		const activate = await importIndexWithDangerFullAccessOverride();
		activate(fakePi as never);
		const notify = vi.fn();
		await withPlatform("win32", async () => {
			await commandHandlers.permission.handler("", { ui: { notify } });
		});
		expect(notify).toHaveBeenCalledTimes(1);
		const text = String(notify.mock.calls[0]?.[0]);
		expect(text).toContain(
			"sandbox mode: danger-full-access (/permission override)",
		);
		expect(text).toContain("shell: powershell only (activation unknown)");
		expect(text).not.toContain("(not activated)");
	});

	it("Ruling 8: win32 + bash active and pwsh missing → one UI notice, and the message names the fix", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const first = makeFakePiWithActiveTools(["bash"]);
		activate(first.fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await withPlatform("win32", async () => {
				first.hooks.session_start?.(
					{ type: "session_start" },
					uiCtx("p", notify),
				);
				first.hooks.session_start?.(
					{ type: "session_start" },
					uiCtx("p", notify),
				); // a repeated session_start inside the same activate
			});
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0]?.[1]).toBe("warning");
			const message = String(notify.mock.calls[0]?.[0]);
			expect(message).toContain("~/.pi/agent/settings.json");
			expect(message).toContain("requires pi >= 1.0.0"); // T15 revision: same host-prerequisite wording as UnsupportedWindowsShellError
			expect(message).toContain('"defaultTools"');
			// Only the valid direction: on win32, pi activates only powershell by default, and this package registers bash with exposure: "hidden" —
			// `-bash` neither removes the tool the extension registered nor is the action needed here.
			expect(message).toContain('{ "defaultTools": ["+powershell"] }');
			expect(message).not.toContain("-bash");
			expect(message).toContain("refused");
			expect(warn).not.toHaveBeenCalled();

			// Once per process: the host calls the factory again for every session; a second activate / session_start must not spam the notice again
			const second = makeFakePiWithActiveTools(["bash"]);
			activate(second.fakePi as never);
			const notify2 = vi.fn();
			await withPlatform("win32", async () => {
				second.hooks.session_start?.(
					{ type: "session_start" },
					uiCtx("p2", notify2),
				);
			});
			expect(notify2).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: win32 + no UI (hasUI=false) → the notice goes to stderr", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePiWithActiveTools(["bash"]);
		activate(fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await withPlatform("win32", async () => {
				hooks.session_start?.(
					{ type: "session_start" },
					{ hasUI: false, ui: { notify } },
				);
			});
			expect(notify).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledTimes(1);
			const text = String(warn.mock.calls[0]?.[0]);
			expect(text).toContain("sandbox:");
			expect(text).toContain("+powershell");
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: ctx already stale (the hasUI getter throws) → fall back to console.warn and do not propagate (I2)", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePiWithActiveTools(["bash"]);
		activate(fakePi as never);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const staleCtx = {
				get hasUI(): boolean {
					throw new Error(
						"This extension ctx is stale after session replacement or reload.",
					);
				},
				ui: { notify: vi.fn() },
			};
			await withPlatform("win32", async () => {
				expect(() =>
					hooks.session_start?.({ type: "session_start" }, staleCtx),
				).not.toThrow();
			});
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain("+powershell");
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: win32 + old host with no getActiveTools → cannot tell, stay silent, and do not throw (I2)", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePi(); // no getActiveTools
		activate(fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await withPlatform("win32", async () => {
				expect(() =>
					hooks.session_start?.({ type: "session_start" }, uiCtx("p", notify)),
				).not.toThrow();
			});
			expect(notify).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: win32 + getActiveTools throws (stale host ctx) → stay silent and do not throw (I2)", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePiWithActiveTools(() => {
			throw new Error("host ctx is stale");
		});
		activate(fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await withPlatform("win32", async () => {
				expect(() =>
					hooks.session_start?.({ type: "session_start" }, uiCtx("p", notify)),
				).not.toThrow();
			});
			expect(notify).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: win32 + pwsh already on the active list → stay silent", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePiWithActiveTools(["bash", "powershell"]);
		activate(fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await withPlatform("win32", async () => {
				hooks.session_start?.({ type: "session_start" }, uiCtx("p", notify));
			});
			expect(notify).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: win32 + bash was never active → stay silent (do not nag to install pwsh)", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePiWithActiveTools(["read"]);
		activate(fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await withPlatform("win32", async () => {
				hooks.session_start?.({ type: "session_start" }, uiCtx("p", notify));
			});
			expect(notify).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("Ruling 8: non-win32 → no notice even if bash is active and pwsh is missing", async () => {
		vi.resetModules();
		const activate = (await import("../index")).default;
		const { fakePi, hooks } = makeFakePiWithActiveTools(["bash"]);
		activate(fakePi as never);
		const notify = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// Platform gate: this case asserts the **non-win32** branch (do not nag to install pwsh); without pinning platform, Windows would take the win32 notice branch.
			await withPlatform("linux", async () => {
				hooks.session_start?.({ type: "session_start" }, uiCtx("p", notify));
				expect(notify).not.toHaveBeenCalled();
				expect(warn).not.toHaveBeenCalled();
			});
		} finally {
			warn.mockRestore();
		}
	});
});
