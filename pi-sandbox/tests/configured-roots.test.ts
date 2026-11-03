import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_CONFIG } from "../src/config";
import { configuredWritableRoots } from "../src/configured-roots";
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs, windowsAclRunnerArgv } from "../src/runners";

let dir: string;
let workspace: string;
let globalRoot: string;
let projectRoot: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "configured-roots-"));
	workspace = join(dir, "workspace");
	globalRoot = join(dir, "global");
	projectRoot = join(dir, "project");
	for (const path of [workspace, globalRoot, projectRoot]) mkdirSync(path);
	workspace = realpathSync.native(workspace);
	globalRoot = realpathSync.native(globalRoot);
	projectRoot = realpathSync.native(projectRoot);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function config() {
	return { ...DEFAULT_SANDBOX_CONFIG, globalExtraWritableRoots: [globalRoot], extraWritableRoots: [projectRoot] };
}

describe("configured writable roots", () => {
	it("selects the project only when trusted, per call", () => {
		expect(configuredWritableRoots(config(), "workspace-write", true, "linux")).toEqual([projectRoot]);
		for (const trust of [false, null]) {
			expect(configuredWritableRoots(config(), "workspace-write", trust, "linux")).toEqual([globalRoot]);
		}
	});
	it("ignores even invalid or missing config in other modes", () => {
		const bad = { ...config(), extraWritableRoots: { error: "invalid" } };
		for (const mode of ["read-only", "danger-full-access"] as const) {
			expect(configuredWritableRoots(bad, mode, true, "linux")).toEqual([]);
		}
		expect(() => configuredWritableRoots(bad, "workspace-write", true, "linux")).toThrow("invalid");
	});
	it("rejects missing roots, files and custom runners instead of silently dropping them", () => {
		const file = join(dir, "file");
		writeFileSync(file, "x");
		for (const path of [join(dir, "missing"), file]) {
			expect(() => configuredWritableRoots({ ...config(), extraWritableRoots: [path] }, "workspace-write", true, "linux")).toThrow("unavailable");
		}
		expect(() => configuredWritableRoots({ ...config(), runnerCommand: ["custom"] }, "workspace-write", true, "linux")).toThrow("custom runner");
	});
	it.skipIf(process.platform === "win32")("resolves symlinks and deduplicates canonical paths", () => {
		const link = join(dir, "link");
		symlinkSync(projectRoot, link);
		expect(configuredWritableRoots({ ...config(), extraWritableRoots: [link, projectRoot] }, "workspace-write", true, "linux")).toEqual([projectRoot]);
	});
	it("rejects any selected non-empty Windows roots, even without workspace overlap or an existing directory", () => {
		for (const root of [workspace, projectRoot, join(dir, "missing")]) {
			const selected = { ...config(), extraWritableRoots: [root] };
			expect(() => configuredWritableRoots(selected, "workspace-write", true, "win32")).toThrow(/extraWritableRoots.*not supported on Windows/);
		}
		for (const trust of [false, null]) {
			expect(() => configuredWritableRoots(config(), "workspace-write", trust, "win32")).toThrow(/extraWritableRoots.*not supported on Windows/);
		}
	});
	it("on Windows ignores untrusted project roots, accepts empty selected roots, and ignores roots in other modes", () => {
		const projectOnly = { ...config(), globalExtraWritableRoots: [] };
		for (const trust of [false, null]) {
			expect(configuredWritableRoots(projectOnly, "workspace-write", trust, "win32")).toEqual([]);
		}
		expect(configuredWritableRoots({ ...projectOnly, extraWritableRoots: [] }, "workspace-write", true, "win32")).toEqual([]);
		for (const mode of ["read-only", "danger-full-access"] as const) {
			expect(configuredWritableRoots(config(), mode, true, "win32")).toEqual([]);
		}
	});
	it("forwards a POSIX-selected root to the backend profiles", () => {
		const roots = configuredWritableRoots(config(), "workspace-write", true, "linux");
		const policy = { mode: "workspace-write" as const, workspaceRoot: workspace, extraRoots: roots };
		expect(bwrapProfileArgs(policy)).toContain(projectRoot);
		expect(landlockProfileArgs(policy)).toContain(projectRoot);
		expect(seatbeltProfileArgs(policy)[1]).toContain(JSON.stringify(projectRoot));
		expect(windowsAclRunnerArgv(policy, { node: "node", runner: "runner" })).toEqual(expect.arrayContaining(["--extra", projectRoot]));
	});
});
