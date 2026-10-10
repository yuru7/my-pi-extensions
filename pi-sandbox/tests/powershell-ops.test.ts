import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxPowerShellOps, POWERSHELL_UTF8_PREFIX } from "../src/powershell-ops";

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: () => void };

/** Fake spawn: only the surface the ops actually use. */
function fakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.pid = 1;
	child.kill = () => {};
	return child;
}

/**
 * close must be emitted in a microtask: ops attaches the close/stderr listeners only after spawnFn returns,
 * so a synchronous emit is dropped by EventEmitter (when stderr and close share a tick, data comes first and then close, which is what makes stderrTail current).
 */
function closeLater(child: FakeChild, code: number): void {
	queueMicrotask(() => child.emit("close", code));
}

/** M4: exec prechecks that cwd exists first. The cwd used by tests must be a real directory (workspaceRoot may still be a fictional path). */
const cwd = mkdtempSync(join(tmpdir(), "powershell-ops-cwd-"));
const missingCwd = join(tmpdir(), "pi-sandbox-powershell-missing-dir");

afterAll(() => {
	rmSync(cwd, { recursive: true, force: true });
});

afterEach(() => {
	vi.doUnmock("@earendil-works/pi-coding-agent");
	vi.resetModules();
});

describe("powershell sandbox ops", () => {
	it("wraps the command in the pwsh argv with the UTF-8 prefix", async () => {
		const spawnFn = vi.fn(() => {
			const child = fakeChild();
			closeLater(child, 0);
			return child as unknown as ChildProcess;
		});
		const ops = createSandboxPowerShellOps({
			mode: "danger-full-access",
			workspaceRoot: "C:\\ws",
			platform: "win32",
			spawnFn: spawnFn as never,
			powerShellConfig: () => ({
				shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
				args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
			}),
		});
		const chunks: Buffer[] = [];
		await ops.exec("Write-Output 'hi'", cwd, { onData: (b) => chunks.push(b) });
		const [program, argv] = spawnFn.mock.calls[0] as unknown as [string, string[]];
		expect(program).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
		expect(argv.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
		expect(argv[5]).toBe(`${POWERSHELL_UTF8_PREFIX}Write-Output 'hi'`);
		expect(POWERSHELL_UTF8_PREFIX).toContain("[Console]::OutputEncoding");
	});

	it("confines the command under the win32 rung in workspace-write", async () => {
		const spawnFn = vi.fn(() => {
			const child = fakeChild();
			closeLater(child, 0);
			return child as unknown as ChildProcess;
		});
		const ops = createSandboxPowerShellOps({
			mode: "workspace-write",
			workspaceRoot: "C:\\ws",
			platform: "win32",
			spawnFn: spawnFn as never,
			powerShellConfig: () => ({ shell: "pwsh.exe", args: ["-Command"] }),
			hooks: { platform: "win32", windowsAclRung: () => ({ node: "C:\\node.exe", runner: "runner.js" }) },
		});
		await ops.exec("echo hi", cwd, { onData: () => {} });
		const [program, argv] = spawnFn.mock.calls[0] as unknown as [string, string[]];
		expect(program).toBe("C:\\node.exe");
		expect(argv.slice(0, 2)).toEqual(["runner.js", "--workspace"]);
		// The UTF-8 prefix must land on the command string (the last pwsh argv after `--`), not on the executable
		expect(argv.at(-1)).toBe(`${POWERSHELL_UTF8_PREFIX}echo hi`);
		expect(argv.at(-2)).toBe("-Command");
	});

	it("records a denial through the shared ledger callback", async () => {
		const onDenial = vi.fn();
		const spawnFn = vi.fn(() => {
			const child = fakeChild();
			queueMicrotask(() => {
				child.stderr.emit("data", Buffer.from("Set-Content: Access is denied."));
				child.emit("close", 1);
			});
			return child as unknown as ChildProcess;
		});
		const ops = createSandboxPowerShellOps({
			mode: "workspace-write",
			workspaceRoot: "C:\\ws",
			platform: "win32",
			spawnFn: spawnFn as never,
			onDenial,
			powerShellConfig: () => ({ shell: "pwsh.exe", args: ["-Command"] }),
			hooks: { platform: "win32", windowsAclRung: () => ({ node: "C:\\node.exe", runner: "runner.js" }) },
		});
		const chunks: Buffer[] = [];
		await ops.exec("Set-Content C:\\other\\x hi", cwd, { onData: (b) => chunks.push(b) });
		expect(onDenial).toHaveBeenCalledTimes(1);
		expect(chunks.map((c) => c.toString()).join("")).toContain("[sandbox: file access denied");
	});

	it("reports a PowerShell-specific message when cwd does not exist (never bash's)", async () => {
		const spawnFn = vi.fn(() => {
			const child = fakeChild();
			closeLater(child, 0);
			return child as unknown as ChildProcess;
		});
		const ops = createSandboxPowerShellOps({
			mode: "danger-full-access",
			workspaceRoot: "C:\\ws",
			platform: "win32",
			spawnFn: spawnFn as never,
			powerShellConfig: () => ({ shell: "pwsh.exe", args: ["-Command"] }),
		});
		await expect(ops.exec("echo hi", missingCwd, { onData: () => {} })).rejects.toThrow(
			`Working directory does not exist: ${missingCwd}\nCannot execute PowerShell commands.`,
		);
		expect(spawnFn).not.toHaveBeenCalled();
	});

	it("resolves the host config per exec (host config can change between calls)", async () => {
		const spawnFn = vi.fn(() => {
			const child = fakeChild();
			closeLater(child, 0);
			return child as unknown as ChildProcess;
		});
		const powerShellConfig = vi.fn()
			.mockReturnValueOnce({ shell: "pwsh-a.exe", args: ["-Command"] })
			.mockReturnValueOnce({ shell: "pwsh-b.exe", args: ["-Command"] });
		const ops = createSandboxPowerShellOps({
			mode: "danger-full-access",
			workspaceRoot: "C:\\ws",
			platform: "win32",
			spawnFn: spawnFn as never,
			powerShellConfig,
		});
		await ops.exec("first", cwd, { onData: () => {} });
		await ops.exec("second", cwd, { onData: () => {} });
		expect(powerShellConfig).toHaveBeenCalledTimes(2);
		expect(spawnFn.mock.calls[0]?.[0]).toBe("pwsh-a.exe");
		expect(spawnFn.mock.calls[1]?.[0]).toBe("pwsh-b.exe");
	});

	it("uses the host's getPowerShellConfig when no config is injected (pi >= 1.0.0)", async () => {
		const hostConfig = vi.fn()
			.mockReturnValueOnce({ shell: "host-pwsh-a.exe", args: ["-Command"] })
			.mockReturnValueOnce({ shell: "host-pwsh-b.exe", args: ["-Command"] });
		vi.doMock("@earendil-works/pi-coding-agent", () => ({ getPowerShellConfig: hostConfig }));
		vi.resetModules();
		const fresh = await import("../src/powershell-ops");
		const spawnFn = vi.fn(() => {
			const child = fakeChild();
			closeLater(child, 0);
			return child as unknown as ChildProcess;
		});
		const ops = fresh.createSandboxPowerShellOps({
			mode: "danger-full-access",
			workspaceRoot: "C:\\ws",
			platform: "win32",
			spawnFn: spawnFn as never,
		});
		await ops.exec("first", cwd, { onData: () => {} });
		await ops.exec("second", cwd, { onData: () => {} });
		expect(hostConfig).toHaveBeenCalledTimes(2); // resolved once per exec
		expect(spawnFn.mock.calls[0]?.[0]).toBe("host-pwsh-a.exe");
		expect(spawnFn.mock.calls[1]?.[0]).toBe("host-pwsh-b.exe");
	});

	it("fails closed without spawning when the host has no usable getPowerShellConfig (pi < 1.0.0)", async () => {
		// A real ESM namespace yields undefined when the export is missing. vitest's ESM mock throws on an undeclared export,
		// so declare the export explicitly as a non-function. Both paths land on the same `typeof === "function"` probe.
		vi.doMock("@earendil-works/pi-coding-agent", () => ({ getPowerShellConfig: undefined }));
		vi.resetModules();
		const fresh = await import("../src/powershell-ops");
		const spawnFn = vi.fn();
		const ops = fresh.createSandboxPowerShellOps({
			mode: "danger-full-access",
			workspaceRoot: "C:\\ws",
			platform: "win32",
			spawnFn: spawnFn as never,
		});
		await expect(ops.exec("echo hi", cwd, { onData: () => {} })).rejects.toThrow(
			/pi-sandbox: the powershell tool requires pi >= 1\.0\.0/,
		);
		expect(spawnFn).not.toHaveBeenCalled();
	});
});
