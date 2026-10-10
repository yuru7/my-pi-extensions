import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxBashOps } from "../src/bash-ops";
import { sandboxDenialMarker } from "../src/escalation";

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = vi.fn((signal?: string) => {
		process.nextTick(() => child.emit("close", null, signal ?? "SIGTERM"));
		return true;
	});
	return child;
}

/** After M4, exec awaits the cwd precheck before spawn and attaching listeners. Wait until the close listener is in place before closing, so we do not race ahead. */
async function settle(
	child: ReturnType<typeof fakeChild>,
	code: number | null,
) {
	for (let i = 0; i < 1000 && child.listenerCount("close") === 0; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	child.emit("close", code, code === null ? "SIGKILL" : undefined);
}

const bwrapSelected = {
	selected: { runner: "bwrap" as const, enforcement: "full" as const },
};

/**
 * Platform injection (testing.md "parameter injection"): aside from the win32 cases at the end, this file verifies **POSIX confinement logic**
 * (confined argv / profile / env scrubbing / denial classification / timeout and abort). On win32, `createSandboxBashOps`
 * refuses bash before any spawn per Ruling 2. Without a platform injection, these cases degrade on Windows into "testing the refusal guard".
 * Injecting `platform: "linux"` makes them run on any host. The win32 bash refusal is covered by the win32 cases at the end of this file,
 * `tests/confine.test.ts`, and `tests/win32/*` (`e2e.test.ts`).
 */
const posix = { platform: "linux" as const };

// M4: exec prechecks that cwd exists. The exec cwd used by tests must be a real directory (workspaceRoot may still be a fictional path).
const cwd = mkdtempSync(join(tmpdir(), "bash-ops-cwd-"));

afterAll(() => {
	rmSync(cwd, { recursive: true, force: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("createSandboxBashOps", () => {
	it("danger-full-access spawns the raw bash argv", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "danger-full-access",
			workspaceRoot: "/ws",
			spawnFn,
		});
		const p = ops.exec("echo hi", cwd, { onData: () => {} });
		await settle(child, 0);
		await p;
		expect(spawnFn).toHaveBeenCalledWith(
			"bash",
			["-c", "echo hi"],
			expect.objectContaining({ cwd }),
		);
	});
	it("workspace-write spawns the confined argv (bwrap profile + -- + bash)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "workspace-write",
			workspaceRoot: "/ws",
			spawnFn,
			...bwrapSelected,
		});
		const p = ops.exec("true", cwd, { onData: () => {} });
		await settle(child, 0);
		await p;
		const [program, args] = spawnFn.mock.calls[0] as [string, string[]];
		expect(program).toBe("bwrap");
		expect(args).toContain("--");
		expect(args.slice(-3)).toEqual(["bash", "-c", "true"]);
	});
	it("unavailable runner rejects with SANDBOX_UNAVAILABLE and never spawns", async () => {
		const spawnFn = vi.fn(() => fakeChild()) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "read-only",
			workspaceRoot: "/ws",
			spawnFn,
			selected: { runner: "unavailable" },
		});
		await expect(ops.exec("true", cwd, { onData: () => {} })).rejects.toThrow(
			/SANDBOX_UNAVAILABLE/,
		);
		expect(spawnFn).not.toHaveBeenCalled();
	});
	it("env pins LC_MESSAGES=C, preserves LANG, removes LC_ALL (Review Focus #3 + Ruling 10)", async () => {
		vi.stubEnv("LANG", "zh_CN.UTF-8");
		vi.stubEnv("LC_ALL", "zh_CN.UTF-8");
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "workspace-write",
			workspaceRoot: "/ws",
			spawnFn,
			...bwrapSelected,
		});
		const p = ops.exec("true", cwd, { onData: () => {} });
		await settle(child, 0);
		await p;
		const options = (
			spawnFn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }]
		)[2];
		expect(options.env.LC_MESSAGES).toBe("C");
		expect(options.env.LANG).toBe("zh_CN.UTF-8");
		expect(options.env.LC_ALL).toBeUndefined(); // LC_ALL overrides LC_MESSAGES and must be removed
	});
	it("streams stdout and stderr to onData", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "danger-full-access",
			workspaceRoot: "/ws",
			spawnFn,
		});
		const chunks: Buffer[] = [];
		const p = ops.exec("cmd", cwd, { onData: (b) => chunks.push(b) });
		child.stdout.write("out");
		child.stderr.write("err");
		await settle(child, 0);
		await p;
		expect(chunks.map((c) => c.toString()).join("")).toBe("outerr");
	});
	it("denial on nonzero exit appends marker + hint through onData", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "workspace-write",
			workspaceRoot: "/ws",
			spawnFn,
			...bwrapSelected,
		});
		const chunks: Buffer[] = [];
		const p = ops.exec("touch /etc/x", cwd, { onData: (b) => chunks.push(b) });
		child.stderr.write("touch: cannot touch '/etc/x': Read-only file system");
		await settle(child, 1);
		const result = await p;
		expect(result.exitCode).toBe(1);
		const text = chunks.map((c) => c.toString()).join("");
		expect(text).toContain(sandboxDenialMarker("workspace-write"));
		expect(text).toContain("call sandbox_grant_write alone");
		expect(text).toContain("/etc");
	});
	it("denial without an absolute path offers only escalation", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "workspace-write",
			workspaceRoot: "/ws",
			spawnFn,
			...bwrapSelected,
		});
		const chunks: Buffer[] = [];
		const p = ops.exec("cmd", cwd, { onData: (b) => chunks.push(b) });
		child.stderr.write("Read-only file system");
		await settle(child, 1);
		await p;
		const text = chunks.map((c) => c.toString()).join("");
		expect(text).toContain("this denial names no directory");
		expect(text).not.toContain("call sandbox_grant_write alone");
	});
	it("a custom runner denial offers only escalation even when stderr names a path", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "workspace-write",
			workspaceRoot: "/ws",
			spawnFn,
			runnerCommand: ["myrunner"],
			runnerFailureSignatures: ["runner failed"],
		});
		const chunks: Buffer[] = [];
		const p = ops.exec("touch /etc/x", cwd, { onData: (b) => chunks.push(b) });
		child.stderr.write("touch: cannot touch '/etc/x': Read-only file system");
		await settle(child, 1);
		await p;
		const text = chunks.map((c) => c.toString()).join("");
		expect(text).toContain(
			"custom runnerCommand cannot accept a directory grant",
		);
		expect(text).not.toContain("call sandbox_grant_write alone");
	});
	it("onDenial fires exactly once on classified denial (denial-first ledger)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const onDenial = vi.fn();
		const ops = createSandboxBashOps({
			...posix,
			mode: "workspace-write",
			workspaceRoot: "/ws",
			spawnFn,
			...bwrapSelected,
			onDenial,
		});
		const p = ops.exec("touch /etc/x", cwd, { onData: () => {} });
		child.stderr.write("touch: cannot touch '/etc/x': Read-only file system");
		await settle(child, 1);
		await p;
		expect(onDenial).toHaveBeenCalledTimes(1);
	});
	it("onDenial does not fire on runner failure (that is sandbox unavailable, not a denial)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const onDenial = vi.fn();
		const ops = createSandboxBashOps({
			...posix,
			mode: "workspace-write",
			workspaceRoot: "/ws",
			spawnFn,
			onDenial,
			selected: { runner: "landlock", enforcement: "full" },
			hooks: { launcherPath: () => "/opt/landlock-run" },
		});
		const p = ops.exec("true", cwd, { onData: () => {} });
		child.stderr.write("landlock-run: ruleset creation failed");
		await settle(child, 125);
		await expect(p).rejects.toThrow(/SANDBOX_UNAVAILABLE/);
		expect(onDenial).not.toHaveBeenCalled();
	});
	it("timeout (seconds) kills the tree with SIGKILL and rejects timeout:N (I1: pi ops contract)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "danger-full-access",
			workspaceRoot: "/ws",
			spawnFn,
		});
		// the fake child has no pid, so killTree falls back to child.kill and the SIGKILL assertion still holds
		await expect(
			ops.exec("sleep 100", cwd, { onData: () => {}, timeout: 0.01 }),
		).rejects.toThrow(/timeout:/);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});
	it("timeout <= 0 arms no timer (pi-local parity, Ruling 20)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "danger-full-access",
			workspaceRoot: "/ws",
			spawnFn,
		});
		const p = ops.exec("sleep 100", cwd, { onData: () => {}, timeout: 0 });
		await vi.waitFor(() => {
			expect(spawnFn).toHaveBeenCalled();
		});
		// If the guard is missing, a 0ms timer kills inside this window (close goes null) and the call rejects with timeout:0.
		// Racing settle alone closes the stream before the armed timer, and cleanup clears it, so the regression is not detected reliably.
		await new Promise((resolve) => setTimeout(resolve, 20));
		await settle(child, 0);
		const result = await p;
		expect(result.exitCode).toBe(0);
		expect(child.kill).not.toHaveBeenCalled();
	});
	it('abort signal kills the tree with SIGTERM and rejects "aborted" (I1: pi ops contract)', async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "danger-full-access",
			workspaceRoot: "/ws",
			spawnFn,
		});
		const ac = new AbortController();
		const p = ops.exec("sleep 100", cwd, {
			onData: () => {},
			signal: ac.signal,
		});
		// The M4 precheck is an await. Wait for spawn (the abort listener is attached synchronously right after) before aborting, so we do not race ahead of the listener.
		await vi.waitFor(() => {
			expect(spawnFn).toHaveBeenCalled();
		});
		ac.abort();
		await expect(p).rejects.toThrow(/aborted/);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});
	it('already-aborted signal rejects "aborted" without spawning (Ruling 9 + I1)', async () => {
		const spawnFn = vi.fn(() => fakeChild()) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "danger-full-access",
			workspaceRoot: "/ws",
			spawnFn,
		});
		const ac = new AbortController();
		ac.abort();
		await expect(
			ops.exec("true", cwd, { onData: () => {}, signal: ac.signal }),
		).rejects.toThrow(/aborted/);
		expect(spawnFn).not.toHaveBeenCalled();
	});
	it("external kill (no timer, no abort) still resolves {exitCode: null}", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "danger-full-access",
			workspaceRoot: "/ws",
			spawnFn,
		});
		const p = ops.exec("sleep 100", cwd, { onData: () => {} });
		await settle(child, null); // fire close(null) directly: neither a timeout nor an abort
		const result = await p;
		expect(result.exitCode).toBeNull();
	});
	it("spawns detached so the process group is killable (I3)", async () => {
		const child = fakeChild();
		const spawnFn = vi.fn(() => child) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "danger-full-access",
			workspaceRoot: "/ws",
			spawnFn,
		});
		const p = ops.exec("true", cwd, { onData: () => {} });
		await settle(child, 0);
		await p;
		const options = (
			spawnFn.mock.calls[0] as [string, string[], { detached?: boolean }]
		)[2];
		expect(options.detached).toBe(true);
	});
	it("rejects with a friendly error when cwd does not exist (M4)", async () => {
		const spawnFn = vi.fn(() => fakeChild()) as never;
		const ops = createSandboxBashOps({
			...posix,
			mode: "danger-full-access",
			workspaceRoot: "/ws",
			spawnFn,
		});
		await expect(
			ops.exec("true", "/nonexistent-sbx-dir-xyz", { onData: () => {} }),
		).rejects.toThrow(/Working directory does not exist/);
		expect(spawnFn).not.toHaveBeenCalled();
	});
	it("refuses bash on win32 confined modes before spawning, but danger-full-access still spawns", async () => {
		const confinedSpawn = vi.fn(() => fakeChild()) as never;
		const confined = createSandboxBashOps({
			mode: "workspace-write",
			workspaceRoot: process.cwd(),
			platform: "win32",
			spawnFn: confinedSpawn,
		});
		await expect(
			confined.exec("echo hi", cwd, { onData: () => {} }),
		).rejects.toThrowError(/bash is not supported on Windows/);
		expect(confinedSpawn).not.toHaveBeenCalled(); // the guard fail-closes before confine/spawn

		const child = fakeChild();
		const dfaSpawn = vi.fn(() => child) as never;
		const dfa = createSandboxBashOps({
			mode: "danger-full-access",
			workspaceRoot: process.cwd(),
			platform: "win32",
			spawnFn: dfaSpawn,
		});
		const p = dfa.exec("echo hi", cwd, { onData: () => {} });
		await settle(child, 0);
		await p;
		expect(dfaSpawn).toHaveBeenCalledTimes(1); // the guard must not fire after the danger-full-access early return
		const [, args, options] = dfaSpawn.mock.calls[0] as unknown as [
			string,
			string[],
			{ detached: boolean; windowsHide: boolean },
		];
		expect(args).toEqual(["-c", "echo hi"]);
		expect(options.detached).toBe(false); // win32 has no process group
		expect(options.windowsHide).toBe(true);
	});
});
