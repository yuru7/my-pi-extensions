import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_CONFIG, buildDefaultConfigFile, getSandboxConfig, isAutoReviewTimeoutMs, loadSandboxConfig, resetSandboxConfigCache, selectApprovalSettings, selectExtraWritableRoots, validateSandboxConfig } from "../src/config";

let dir: string;
let agentDir: string;
let projectDir: string;

function writeGlobal(obj: unknown, name = "sandbox.json") {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, name), JSON.stringify(obj));
}
function writeProject(obj: unknown, name = "sandbox.json") {
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", name), JSON.stringify(obj));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cfg-"));
	agentDir = join(dir, "agent");
	projectDir = join(dir, "project");
	mkdirSync(projectDir, { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(() => {
	resetSandboxConfigCache();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("loadSandboxConfig", () => {
	it("falls back to defaults when no files exist", () => {
		expect(loadSandboxConfig(projectDir)).toEqual(DEFAULT_SANDBOX_CONFIG);
	});
	it("merges fieldwise: project > global > default", () => {
		writeGlobal({ mode: "read-only", probeTimeoutMs: 1000 });
		writeProject({ mode: "workspace-write" });
		const cfg = loadSandboxConfig(projectDir);
		expect(cfg.mode).toBe("workspace-write");
		expect(cfg.probeTimeoutMs).toBe(1000);
		expect(cfg.runnerCommand).toBeNull();
	});
	it("invalid mode warns and falls back to default", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeProject({ mode: "yolo" });
		expect(loadSandboxConfig(projectDir).mode).toBe("workspace-write");
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
	it("legacy 1.x groups are ignored with a warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeProject({ image: { name: "x" }, runtime: { engine: "docker" }, host: { commands: [] }, mode: "read-only" });
		expect(loadSandboxConfig(projectDir).mode).toBe("read-only");
		expect(warn.mock.calls.flat().join(" ")).toMatch(/legacy/);
		warn.mockRestore();
	});
	it("corrupt JSON is ignored (defaults)", () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "sandbox.json"), "{broken");
		expect(loadSandboxConfig(projectDir)).toEqual(DEFAULT_SANDBOX_CONFIG);
	});
	it("non-object JSON (array/number/string/boolean) counts as corrupt (I2)", () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		const path = join(projectDir, ".pi", "sandbox.json");
		for (const content of ["5", "[1,2]", '"workspace-write"', "true", "null"]) {
			writeFileSync(path, content);
			expect(loadSandboxConfig(projectDir), content).toEqual(DEFAULT_SANDBOX_CONFIG); // does not throw
		}
	});
});

describe("extraWritableRoots", () => {
	it("defaults to an empty array in both scopes and the generated config", () => {
		const config = loadSandboxConfig(projectDir);
		expect(selectExtraWritableRoots(config, true)).toEqual([]);
		expect(selectExtraWritableRoots(config, false)).toEqual([]);
		expect(buildDefaultConfigFile().extraWritableRoots).toEqual([]);
	});

	it("expands only the current user's home and preserves absolute paths", () => {
		const absolute = join(projectDir, "path with spaces");
		const config = validateSandboxConfig({ extraWritableRoots: ["~", "~/notes", absolute] }, "test");
		expect(selectExtraWritableRoots(config, true)).toEqual([homedir(), `${homedir()}/notes`, absolute]);
		expect(selectExtraWritableRoots(config, false)).toEqual([homedir(), `${homedir()}/notes`, absolute]);
	});

	it("expands environment variables once when loading paths", () => {
		vi.stubEnv("PI_TEST_ROOT", join(dir, "path with spaces"));
		vi.stubEnv("PI_TEST_CHILD", "child");
		writeGlobal({ extraWritableRoots: ["$PI_TEST_ROOT/${PI_TEST_CHILD}", "${PI_TEST_ROOT}", "~/$PI_TEST_CHILD"] });
		const config = loadSandboxConfig(projectDir);
		expect(selectExtraWritableRoots(config, false)).toEqual([join(dir, "path with spaces", "child"), join(dir, "path with spaces"), `${homedir()}/child`]);
		vi.stubEnv("PI_TEST_ROOT", join(dir, "changed"));
		expect(selectExtraWritableRoots(config, false)[0]).toBe(join(dir, "path with spaces", "child"));
		vi.stubEnv("PI_TEST_ROOT", `${dir}/$PI_TEST_CHILD`);
		expect(selectExtraWritableRoots(loadSandboxConfig(projectDir), false)[1]).toBe(`${dir}/$PI_TEST_CHILD`);
	});

	it("rejects unset, empty, and relative environment values", () => {
		for (const value of [undefined, "", "relative", "~"]) {
			vi.stubEnv("PI_TEST_ROOT", value);
			expect(() => validateSandboxConfig({ extraWritableRoots: ["$PI_TEST_ROOT/child"] }, "test"), String(value)).toThrow(/extraWritableRoots/);
		}
		vi.stubEnv("PI_TEST_ROOT", "");
		expect(() => validateSandboxConfig({ extraWritableRoots: ["/safe/${PI_TEST_ROOT}/child"] }, "test")).toThrow(/PI_TEST_ROOT.*unset or empty/);
	});

	it("keeps invalid project environment variables isolated from global roots", () => {
		vi.stubEnv("PI_TEST_ROOT", undefined);
		writeGlobal({ extraWritableRoots: [dir] });
		writeProject({ extraWritableRoots: ["$PI_TEST_ROOT/child"] });
		const config = loadSandboxConfig(projectDir);
		expect(selectExtraWritableRoots(config, false)).toEqual([dir]);
		expect(selectExtraWritableRoots(config, null)).toEqual([dir]);
		expect(() => selectExtraWritableRoots(config, true)).toThrow(/PI_TEST_ROOT.*unset or empty/);
	});

	it("rejects invalid arrays, relative paths, unsupported home syntax and NUL", () => {
		for (const value of [null, "~/notes", {}, [1], [""], ["relative"], ["./relative"], ["~other/notes"], ["~\\notes"], [join(projectDir, "bad\0path")]]) {
			// On Windows ~\\notes is supported as the native home-relative form.
			if (process.platform === "win32" && Array.isArray(value) && value[0] === "~\\notes") continue;
			expect(() => validateSandboxConfig({ extraWritableRoots: value }, "test"), JSON.stringify(value)).toThrow(/extraWritableRoots/);
		}
	});

	it.runIf(process.platform === "win32")("rejects Windows paths without an explicit drive or UNC share", () => {
		for (const path of ["\\relative-to-drive", "/relative-to-drive", "C:relative", "\\\\server"]) {
			expect(() => validateSandboxConfig({ extraWritableRoots: [path] }, "test"), path).toThrow(/extraWritableRoots/);
		}
	});

	it("replaces arrays by file priority and ignores project values unless trusted", () => {
		const paths = ["global-legacy", "global-new", "project-legacy", "project-new"].map((name) => join(dir, name));
		writeGlobal({ extraWritableRoots: [paths[0]] });
		writeGlobal({ extraWritableRoots: [paths[1]] }, "pi-sandbox.json");
		writeProject({ extraWritableRoots: [paths[2]] });
		writeProject({ extraWritableRoots: [paths[3]] }, "pi-sandbox.json");
		const config = loadSandboxConfig(projectDir);
		expect(selectExtraWritableRoots(config, true)).toEqual([paths[3]]);
		expect(selectExtraWritableRoots(config, false)).toEqual([paths[1]]);
		expect(selectExtraWritableRoots(config, null)).toEqual([paths[1]]);
		writeProject({ extraWritableRoots: [] }, "pi-sandbox.json");
		expect(selectExtraWritableRoots(loadSandboxConfig(projectDir), true)).toEqual([]);
	});

	it("does not let an invalid project value reset global roots or unrelated config", () => {
		const globalRoot = join(dir, "global");
		writeGlobal({ extraWritableRoots: [globalRoot], approvalMode: "human", probeTimeoutMs: 1234 });
		writeProject({ extraWritableRoots: ["relative"] }, "pi-sandbox.json");
		const config = getSandboxConfig(projectDir);
		expect(selectExtraWritableRoots(config, false)).toEqual([globalRoot]);
		expect(selectExtraWritableRoots(config, null)).toEqual([globalRoot]);
		expect(config.probeTimeoutMs).toBe(1234);
		expect(selectApprovalSettings(config, false).approvalMode).toBe("human");
		expect(() => selectExtraWritableRoots(config, true)).toThrow(/pi-sandbox\.json.*extraWritableRoots/);
	});

	it("validates the effective value independently for each scope", () => {
		const projectRoot = join(dir, "project-root");
		writeGlobal({ extraWritableRoots: null });
		writeProject({ extraWritableRoots: [projectRoot] }, "pi-sandbox.json");
		const config = loadSandboxConfig(projectDir);
		expect(selectExtraWritableRoots(config, true)).toEqual([projectRoot]);
		expect(() => selectExtraWritableRoots(config, false)).toThrow(/sandbox\.json.*extraWritableRoots/);
		expect(() => selectExtraWritableRoots(config, null)).toThrow(/extraWritableRoots/);
	});

	it("allows higher-priority files to replace invalid values within a scope", () => {
		const globalRoot = join(dir, "global-root");
		writeGlobal({ extraWritableRoots: ["relative"] });
		writeGlobal({ extraWritableRoots: [globalRoot] }, "pi-sandbox.json");
		writeProject({ extraWritableRoots: null });
		writeProject({ extraWritableRoots: [globalRoot] }, "pi-sandbox.json");
		const config = loadSandboxConfig(projectDir);
		expect(selectExtraWritableRoots(config, true)).toEqual([globalRoot]);
		expect(selectExtraWritableRoots(config, false)).toEqual([globalRoot]);
	});
});

describe("getSandboxConfig (fail-safe + cache)", () => {
	afterEach(() => { resetSandboxConfigCache(); });
	it("pairing-violation config falls back to DEFAULT with a warn, never throws (I2)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeProject({ runnerCommand: ["myrunner"] }); // missing runnerFailureSignatures → validate throws
			expect(getSandboxConfig(projectDir)).toEqual(DEFAULT_SANDBOX_CONFIG);
			expect(warn.mock.calls.flat().join(" ")).toMatch(/falling back to defaults/u);
		} finally {
			warn.mockRestore();
		}
	});
	it("caches per cwd: second call does not re-warn", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeProject({ probeTimeoutMs: 0 }); // invalid → throw → fail-safe
			expect(getSandboxConfig(projectDir)).toEqual(DEFAULT_SANDBOX_CONFIG);
			expect(getSandboxConfig(projectDir)).toEqual(DEFAULT_SANDBOX_CONFIG);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("validateSandboxConfig", () => {
	it("runnerCommand requires runnerFailureSignatures and vice versa", () => {
		expect(() => validateSandboxConfig({ runnerCommand: ["myrunner"] }, "test")).toThrow(/runnerFailureSignatures/);
		expect(() => validateSandboxConfig({ runnerFailureSignatures: ["x:"] }, "test")).toThrow(/runnerCommand/);
	});
	it("signatures must be non-empty single-line strings", () => {
		expect(() => validateSandboxConfig({ runnerCommand: ["r"], runnerFailureSignatures: [""] }, "t")).toThrow();
		expect(() => validateSandboxConfig({ runnerCommand: ["r"], runnerFailureSignatures: ["a\nb"] }, "t")).toThrow();
	});
	it("valid pair passes through", () => {
		const cfg = validateSandboxConfig({ runnerCommand: ["r"], runnerFailureSignatures: ["r:"] }, "t");
		expect(cfg.runnerCommand).toEqual(["r"]);
	});
	it("does not create a config file when none exists", () => {
		loadSandboxConfig(projectDir);
		expect(existsSync(join(agentDir, "pi-sandbox.json"))).toBe(false);
		expect(existsSync(join(agentDir, "sandbox.json"))).toBe(false);
		expect(existsSync(join(projectDir, ".pi", "pi-sandbox.json"))).toBe(false);
	});
	it("reads pi-sandbox.json and lets it override legacy sandbox.json field by field", () => {
		writeGlobal({ mode: "read-only", probeTimeoutMs: 1000, approvalMode: "human" });
		writeGlobal({ probeTimeoutMs: 2500, approvalMode: "allow-all" }, "pi-sandbox.json");
		writeProject({ mode: "workspace-write" });
		writeProject({
			approvalMode: "auto-review",
			autoReview: { model: "anthropic/claude-sonnet-4-6" },
		}, "pi-sandbox.json");
		const cfg = loadSandboxConfig(projectDir);
		expect(cfg.mode).toBe("workspace-write");
		expect(cfg.probeTimeoutMs).toBe(2500);
		expect(cfg.approvalMode).toBe("auto-review");
		expect(cfg.autoReview).toEqual({ model: "anthropic/claude-sonnet-4-6", thinkingLevel: "CURRENT" });
		expect(cfg.globalApproval).toEqual({
			approvalMode: "allow-all",
			autoReview: { model: "CURRENT", thinkingLevel: "CURRENT" },
			autoReviewTimeoutMs: 90_000,
			approvalInvalid: false,
		});
	});
	it("merges autoReview.model and thinkingLevel independently", () => {
		writeGlobal({ autoReview: { model: "openai/gpt" } }, "pi-sandbox.json");
		writeProject({ autoReview: { thinkingLevel: "low" } }, "pi-sandbox.json");
		const cfg = loadSandboxConfig(projectDir);
		expect(cfg.autoReview).toEqual({ model: "openai/gpt", thinkingLevel: "low" });
	});
	it("invalid approvalMode does not become allow-all and does not drop sandbox settings", () => {
		writeProject({ mode: "read-only", approvalMode: "yolo", autoReview: { model: "not a model", thinkingLevel: "huge" } }, "pi-sandbox.json");
		const cfg = loadSandboxConfig(projectDir);
		expect(cfg.mode).toBe("read-only");
		expect(cfg.approvalInvalid).toBe(true);
		expect(cfg.approvalMode).not.toBe("allow-all");
	});
	it("an untrusted project cannot apply allow-all", () => {
		writeGlobal({ approvalMode: "human" }, "pi-sandbox.json");
		writeProject({ approvalMode: "allow-all" }, "pi-sandbox.json");
		const cfg = loadSandboxConfig(projectDir);
		expect(selectApprovalSettings(cfg, true).approvalMode).toBe("allow-all");
		expect(selectApprovalSettings(cfg, false).approvalMode).toBe("human");
		expect(selectApprovalSettings(cfg, null).approvalMode).toBe("human");
	});
	it("autoReviewTimeoutMs defaults to 90000 milliseconds", () => {
		const cfg = loadSandboxConfig(projectDir);
		expect(cfg.autoReviewTimeoutMs).toBe(90_000);
		expect(cfg.globalApproval.autoReviewTimeoutMs).toBe(90_000);
	});
	it("autoReviewTimeoutMs merges project over global", () => {
		writeGlobal({ autoReviewTimeoutMs: 90_000 }, "pi-sandbox.json");
		writeProject({ autoReviewTimeoutMs: 30_000 }, "pi-sandbox.json");
		const cfg = loadSandboxConfig(projectDir);
		expect(cfg.autoReviewTimeoutMs).toBe(30_000);
		expect(cfg.globalApproval.autoReviewTimeoutMs).toBe(90_000);
	});
	it("an untrusted project cannot change autoReviewTimeoutMs", () => {
		writeGlobal({ autoReviewTimeoutMs: 90_000 }, "pi-sandbox.json");
		writeProject({ autoReviewTimeoutMs: 1_000 }, "pi-sandbox.json");
		const cfg = loadSandboxConfig(projectDir);
		expect(selectApprovalSettings(cfg, true).autoReviewTimeoutMs).toBe(1_000);
		expect(selectApprovalSettings(cfg, false).autoReviewTimeoutMs).toBe(90_000);
		expect(selectApprovalSettings(cfg, null).autoReviewTimeoutMs).toBe(90_000);
	});
	it("an invalid autoReviewTimeoutMs denies escalation and a later valid value repairs it", () => {
		writeGlobal({ autoReviewTimeoutMs: "90000" }, "pi-sandbox.json");
		expect(loadSandboxConfig(projectDir).approvalInvalid).toBe(true);
		writeProject({ autoReviewTimeoutMs: 90_000 }, "pi-sandbox.json");
		const cfg = loadSandboxConfig(projectDir);
		expect(cfg.approvalInvalid).toBe(false);
		expect(cfg.autoReviewTimeoutMs).toBe(90_000);
	});
	it("rejects non-positive and timer-overflowing autoReviewTimeoutMs", () => {
		for (const autoReviewTimeoutMs of [0, -1, "90000", null, 2_147_483_648]) {
			writeProject({ autoReviewTimeoutMs }, "pi-sandbox.json");
			expect(loadSandboxConfig(projectDir).approvalInvalid).toBe(true);
		}
		writeProject({ autoReviewTimeoutMs: 2_147_483_647 }, "pi-sandbox.json");
		expect(loadSandboxConfig(projectDir).approvalInvalid).toBe(false);
	});
	it("isAutoReviewTimeoutMs accepts only positive finite numbers within the timer range", () => {
		expect(isAutoReviewTimeoutMs(90_000)).toBe(true);
		expect(isAutoReviewTimeoutMs(50)).toBe(true);
		expect(isAutoReviewTimeoutMs(0)).toBe(false);
		expect(isAutoReviewTimeoutMs(-1)).toBe(false);
		expect(isAutoReviewTimeoutMs(Number.NaN)).toBe(false);
		expect(isAutoReviewTimeoutMs(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isAutoReviewTimeoutMs("90000")).toBe(false);
		expect(isAutoReviewTimeoutMs(2_147_483_648)).toBe(false);
		expect(isAutoReviewTimeoutMs(2_147_483_647)).toBe(true);
	});
	it("follows an explicit agent directory instead of HOME", () => {
		const sdkDir = join(dir, "sdk-agent");
		mkdirSync(sdkDir, { recursive: true });
		writeFileSync(join(sdkDir, "pi-sandbox.json"), JSON.stringify({ mode: "read-only", approvalMode: "human" }));
		const cfg = loadSandboxConfig(projectDir, sdkDir);
		expect(cfg.mode).toBe("read-only");
		expect(cfg.approvalMode).toBe("human");
		expect(sdkDir).not.toBe(join(homedir(), ".pi", "agent"));
		expect(existsSync(join(agentDir, "pi-sandbox.json"))).toBe(false);
	});
	it("PI_CODING_AGENT_DIR selects the global file via getAgentDir()", () => {
		writeGlobal({ approvalMode: "allow-all" }, "pi-sandbox.json");
		expect(loadSandboxConfig(projectDir).globalApproval.approvalMode).toBe("allow-all");
	});
	it("probeTimeoutMs must be a positive finite number (0 means unbounded to Node)", () => {
		expect(() => validateSandboxConfig({ probeTimeoutMs: 0 }, "t")).toThrow(/probeTimeoutMs/);
		expect(() => validateSandboxConfig({ probeTimeoutMs: Number.NaN }, "t")).toThrow(/probeTimeoutMs/);
		expect(validateSandboxConfig({ probeTimeoutMs: 100 }, "t").probeTimeoutMs).toBe(100);
	});
	it("includeGitRoot defaults to true and turns the git-root widening off when false", () => {
		expect(validateSandboxConfig({}, "t").includeGitRoot).toBe(true);
		expect(validateSandboxConfig({ includeGitRoot: false }, "t").includeGitRoot).toBe(false);
	});
	it("includeGitRoot must be a boolean; null does not slip through as the default", () => {
		expect(() => validateSandboxConfig({ includeGitRoot: "false" }, "t")).toThrow(/includeGitRoot must be a boolean/);
		expect(() => validateSandboxConfig({ includeGitRoot: 0 }, "t")).toThrow(/includeGitRoot must be a boolean/);
		expect(() => validateSandboxConfig({ includeGitRoot: null }, "t")).toThrow(/includeGitRoot must be a boolean/);
		expect(validateSandboxConfig({ includeGitRoot: true }, "t").includeGitRoot).toBe(true);
	});
	it("includeGitRoot merges fieldwise: project overrides global, absent means on", () => {
		expect(loadSandboxConfig(projectDir).includeGitRoot).toBe(true);
		writeGlobal({ includeGitRoot: false }, "pi-sandbox.json");
		expect(loadSandboxConfig(projectDir).includeGitRoot).toBe(false);
		writeProject({ includeGitRoot: true }, "pi-sandbox.json");
		expect(loadSandboxConfig(projectDir).includeGitRoot).toBe(true);
		writeProject({ includeGitRoot: false }, "pi-sandbox.json");
		expect(loadSandboxConfig(projectDir).includeGitRoot).toBe(false);
	});
	it("buildDefaultConfigFile writes includeGitRoot: true (the built-in default)", () => {
		expect(buildDefaultConfigFile().includeGitRoot).toBe(true);
	});
});
