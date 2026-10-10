import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertShellAllowed,
	classifyDenial,
	classifyRunnerFailure,
	confine,
	DENIAL_SIGNATURES,
	RUNNER_FAILURE_RULES,
	SandboxUnavailableError,
	UnsupportedWindowsShellError,
} from "../src/confine";

const hooks = { launcherPath: () => "/opt/landlock-run" };

describe("confine", () => {
	it("bwrap: runner + profile + '--' + original argv", () => {
		const result = confine(["bash", "-c", "true"], "workspace-write", "/ws", {
			selected: { runner: "bwrap", enforcement: "full" },
		});
		expect(result.argv).toEqual([
			"bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
			"--bind", "/tmp", "/tmp", "--bind", "/ws", "/ws", "--", "bash", "-c", "true",
		]);
		expect(result.denialSignatures).toEqual(["read-only file system"]);
		expect(result.runnerFailureRules).toEqual(RUNNER_FAILURE_RULES.bwrap);
	});
	it("landlock: injected launcher path, per-backend dialect (no cross-backend union)", () => {
		const result = confine(["true"], "read-only", "/ws", {
			selected: { runner: "landlock", enforcement: "partial" },
			hooks,
		});
		expect(result.argv[0]).toBe("/opt/landlock-run");
		expect(result.enforcement).toBe("partial");
		expect(result.denialSignatures).toEqual(["permission denied"]);
	});
	it("unavailable runner throws SandboxUnavailableError (fail-closed, argv never spawned)", () => {
		expect(() => confine(["true"], "read-only", "/ws", { selected: { runner: "unavailable" } }))
			.toThrow(SandboxUnavailableError);
		expect(() => confine(["true"], "read-only", "/ws", { selected: { runner: "unavailable" } }))
			.toThrow(/SANDBOX_UNAVAILABLE/);
	});
	it("runnerCommand override: bwrap-dialect profile appended, custom failure signatures", () => {
		const result = confine(["true"], "workspace-write", "/ws", {
			runnerCommand: ["myrunner", "--flag"],
			runnerFailureSignatures: ["myrunner: "],
		});
		expect(result.argv).toEqual([
			"myrunner", "--flag",
			"--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
			"--bind", "/tmp", "/tmp", "--bind", "/ws", "/ws", "--", "true",
		]);
		expect(result.enforcement).toBe("full");
		expect(result.denialSignatures).toEqual(["read-only file system", "permission denied"]);
		expect(result.runnerFailureRules).toEqual([{ fatalSignatures: ["myrunner: "] }]);
	});
	it.skipIf(process.platform === "win32")("canonicalizes the workspace root before building the profile", () => {
		// A real mkdtemp directory plus a symlink root (dir/real and dir/link→real): the old version passed /tmp, which is
		// already canonical on most systems, so removing the canonicalPath mutation still passed. A symlink root makes the assertion load-bearing.
		// Creating a symlink on win32 needs privileges (Developer Mode or Administrator), so this uses the same skipIf as policy.test.ts.
		// Link and junction resolution on Windows is covered by tests/win32/e2e.test.ts.
		const dir = mkdtempSync(join(tmpdir(), "confine-"));
		try {
			mkdirSync(join(dir, "real"));
			symlinkSync(join(dir, "real"), join(dir, "link"));
			const realRoot = realpathSync.native(join(dir, "real"));
			const result = confine(["true"], "workspace-write", join(dir, "link"), {
				selected: { runner: "bwrap", enforcement: "full" },
			});
			// bwrap's workspace bind is a source=target pair (--bind <root> <root>): both must be the
			// realpath, and the symlink spelling must not remain in argv (both assertions fail if the canonicalPath mutation is removed).
			const bindIdx = result.argv.indexOf(realRoot);
			expect(bindIdx).toBeGreaterThan(-1);
			expect(result.argv[bindIdx + 1]).toBe(realRoot);
			expect(result.argv).not.toContain(join(dir, "link"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("classifyRunnerFailure", () => {
	const rules = RUNNER_FAILURE_RULES.landlock;
	it("exit 125 + fatal landlock-run line → matched line", () => {
		expect(classifyRunnerFailure(125, "landlock-run: ruleset creation failed: EOPNOTSUPP", rules))
			.toBe("landlock-run: ruleset creation failed: EOPNOTSUPP");
	});
	it("wrong exit code → no match even with the fatal signature", () => {
		expect(classifyRunnerFailure(1, "landlock-run: something", rules)).toBeUndefined();
	});
	it("the informational partial-enforcement line alone is NOT a failure (exact-line exclusion runs before the fatal match)", () => {
		expect(classifyRunnerFailure(125, "landlock-run: partial enforcement (older Landlock ABI)", rules)).toBeUndefined();
	});
	it("informational line removed, fatal line on another row still matches", () => {
		const stderr = "landlock-run: partial enforcement (older Landlock ABI)\nlandlock-run: fatal boom";
		expect(classifyRunnerFailure(125, stderr, rules)).toBe("landlock-run: fatal boom");
	});
	it("exit 0 or null → never a runner failure", () => {
		expect(classifyRunnerFailure(0, "landlock-run: x", rules)).toBeUndefined();
		expect(classifyRunnerFailure(null, "landlock-run: x", rules)).toBeUndefined();
	});
	it("bwrap rule has no exit gate: any nonzero exit with 'bwrap: ' matches", () => {
		expect(classifyRunnerFailure(1, "bwrap: Can't mount proc", RUNNER_FAILURE_RULES.bwrap)).toContain("bwrap: ");
	});
});

describe("windows-acl dialect", () => {
	it("classifies the four Windows denial dialects case-insensitively", () => {
		const signatures = DENIAL_SIGNATURES["windows-acl"];
		expect(signatures).toEqual(["access is denied", "access to the path", "permission denied", "operation not permitted"]);
		for (const text of [
			"Access is denied.",
			"Access to the path 'C:\\other\\x.txt' is denied.",
			"rm: cannot remove '/c/tmp/x': Permission denied",
			"EPERM: operation not permitted, unlink 'C:\\x'",
		]) {
			expect(classifyDenial(1, text, signatures)).toBe(true);
		}
		expect(classifyDenial(1, "command not found", signatures)).toBe(false);
		expect(classifyDenial(0, "Access is denied.", signatures)).toBe(false);
	});

	it("treats exit 127 plus the runner signature as a runner failure (and nothing else)", () => {
		const rules = RUNNER_FAILURE_RULES["windows-acl"];
		expect(classifyRunnerFailure(127, "windows-acl-run: --temp is not an existing directory: C:\\nope", rules)).toMatch(/--temp is not an existing directory/);
		// Known tradeoff: a confined command that itself exits 127 and happens to print the signature also matches (Review Focus #3)
		expect(classifyRunnerFailure(127, "windows-acl-run: Access is denied.", rules)).toBeDefined();
		// An exit other than 127 is never a runner failure (the command actually ran)
		expect(classifyRunnerFailure(1, "windows-acl-run: Access is denied.", rules)).toBeUndefined();
		expect(classifyRunnerFailure(127, "Access is denied.", rules)).toBeUndefined();
	});

	it("wraps the win32 runner argv with the resolved rung", () => {
		const confined = confine(["pwsh.exe", "-Command", "echo hi"], "workspace-write", "C:\\work\\demo", {
			hooks: {
				platform: "win32",
				windowsAclRung: () => ({ node: "C:\\node.exe", runner: "C:\\pkg\\src\\win32\\runner.js" }),
			},
		});
		expect(confined.argv.slice(0, 4)).toEqual(["C:\\node.exe", "C:\\pkg\\src\\win32\\runner.js", "--workspace", "C:\\work\\demo"]);
		expect(confined.argv).toContain("--temp");
		expect(confined.argv).toContain("--mode");
		expect(confined.argv.slice(-4)).toEqual(["--", "pwsh.exe", "-Command", "echo hi"]);
		expect(confined.enforcement).toBe("partial");
		// Explicit literals: pin dialect content and order, and the exit-127 gate (equality against the export table alone is a false positive when a missing key makes undefined===undefined)
		expect(confined.denialSignatures).toEqual(["access is denied", "access to the path", "permission denied", "operation not permitted"]);
		expect(confined.runnerFailureRules).toEqual([{ allowedExitCodes: [127], fatalSignatures: ["windows-acl-run: "] }]);
		expect(confined.denialSignatures).toEqual(DENIAL_SIGNATURES["windows-acl"]);
		expect(confined.runnerFailureRules).toEqual(RUNNER_FAILURE_RULES["windows-acl"]);
	});

	it("resolves the rung exactly once and never consults it a second time", () => {
		let rungCalls = 0;
		const confined = confine(["true"], "read-only", "C:\\work\\demo", {
			selected: { runner: "windows-acl", enforcement: "partial" },
			hooks: {
				// The second resolution fails: confirms confine resolves once and then passes it through, and runnerInvocation does not resolve again on its own
				windowsAclRung: () => {
					rungCalls += 1;
					return rungCalls === 1 ? { node: "C:\\node.exe", runner: "C:\\runner.js" } : undefined;
				},
			},
		});
		expect(rungCalls).toBe(1);
		expect(confined.argv.slice(0, 2)).toEqual(["C:\\node.exe", "C:\\runner.js"]);
	});

	it("fails closed when the win32 rung cannot be resolved", () => {
		// The global runner cache has already selected windows-acl, so the path below is confine's own fail-closed guard
		expect(() => confine(["pwsh.exe", "-Command", "echo hi"], "workspace-write", "C:\\work\\demo", {
			hooks: { platform: "win32", windowsAclRung: () => undefined },
		})).toThrowError(/SANDBOX_UNAVAILABLE/);
		// Inject selected explicitly: independent of the cache and the selectRunner path, this pins the error type and detail deterministically
		expect(() => confine(["pwsh.exe", "-Command", "echo hi"], "workspace-write", "C:\\work\\demo", {
			selected: { runner: "windows-acl", enforcement: "partial" },
			hooks: { windowsAclRung: () => undefined },
		})).toThrowError(SandboxUnavailableError);
		expect(() => confine(["pwsh.exe", "-Command", "echo hi"], "workspace-write", "C:\\work\\demo", {
			selected: { runner: "windows-acl", enforcement: "partial" },
			hooks: { windowsAclRung: () => undefined },
		})).toThrowError(/win32 runner is not resolvable/);
	});

	it("documents the bash refusal without a defaultTools snippet", () => {
		// win32 tool wiring: `defaultTools` cannot remove a tool the extension registered, and no config is required anymore. The message only gives the guidance that works:
		// use powershell, bash stays fail-closed, and danger-full-access is the only explicit escape hatch.
		const error = new UnsupportedWindowsShellError("bash");
		expect(error.message).toContain('[sandbox: bash is not supported on Windows]');
		expect(error.message).toContain("the command was NOT executed");
		expect(error.message).toContain("powershell tool only");
		expect(error.message).toContain("fail-closed");
		expect(error.message).toContain("pi >= 1.0.0");
		expect(error.message).toContain("danger-full-access");
		expect(error.message).not.toContain("-bash");
		expect(error.message).not.toContain("defaultTools");
	});

	it("refuses bash on win32 confined modes and nothing else", () => {
		expect(() => assertShellAllowed("bash", "win32", "workspace-write")).toThrowError(UnsupportedWindowsShellError);
		expect(() => assertShellAllowed("bash", "win32", "read-only")).toThrowError(UnsupportedWindowsShellError);
		expect(() => assertShellAllowed("bash", "win32", "danger-full-access")).not.toThrow();
		expect(() => assertShellAllowed("bash", "linux", "workspace-write")).not.toThrow();
		expect(() => assertShellAllowed("powershell", "win32", "read-only")).not.toThrow();
	});
});

describe("classifyDenial", () => {
	it("case-insensitive substring match on nonzero exit", () => {
		expect(classifyDenial(1, "touch: cannot touch '/etc/x': Read-only file system", ["read-only file system"])).toBe(true);
	});
	it("exit 0 or null → false", () => {
		expect(classifyDenial(0, "Read-only file system", ["read-only file system"])).toBe(false);
		expect(classifyDenial(null, "Read-only file system", ["read-only file system"])).toBe(false);
	});
	it("no signature present → false", () => {
		expect(classifyDenial(1, "command not found", ["read-only file system"])).toBe(false);
	});
});
