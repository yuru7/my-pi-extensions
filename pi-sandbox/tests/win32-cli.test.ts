// pi-sandbox/tests/win32-cli.test.ts

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyRunnerFailure, RUNNER_FAILURE_RULES } from "../src/confine";
import {
	parseArgs,
	RUNNER_FAILURE_EXIT,
	RUNNER_SIGNATURE,
	requireDirectory,
} from "../src/win32/cli.js";

const base = [
	"--workspace",
	"C:\\ws",
	"--temp",
	"C:\\tmp",
	"--mode",
	"workspace-write",
	"--",
	"pwsh.exe",
	"-Command",
	"echo hi",
];

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

describe("win32 runner cli", () => {
	it("parses the documented contract", () => {
		expect(parseArgs(base)).toEqual({
			workspace: "C:\\ws",
			temp: "C:\\tmp",
			mode: "workspace-write",
			extras: [],
			command: "pwsh.exe",
			args: ["-Command", "echo hi"],
		});
	});

	it("collects repeatable --extra directories", () => {
		const parsed = parseArgs([
			"--workspace",
			"C:\\ws",
			"--extra",
			"C:\\data\\one",
			"--temp",
			"C:\\tmp",
			"--mode",
			"read-only",
			"--extra",
			"C:\\data\\two",
			"--",
			"pwsh.exe",
		]);
		expect(parsed.extras).toEqual(["C:\\data\\one", "C:\\data\\two"]);
		expect(parsed.command).toBe("pwsh.exe");
	});

	it("keeps the command argv verbatim after the separator", () => {
		const parsed = parseArgs([
			...base.slice(0, 6),
			"--",
			"pwsh.exe",
			"-Command",
			"echo --workspace x",
		]);
		expect(parsed.args).toEqual(["-Command", "echo --workspace x"]);
	});

	it("rejects missing, unknown, and duplicated args", () => {
		expect(() =>
			parseArgs(["--temp", "C:\\tmp", "--mode", "read-only", "--", "pwsh.exe"]),
		).toThrowError(/missing --workspace/);
		expect(() => parseArgs(["--workspace"])).toThrowError(
			/missing value after --workspace/,
		);
		expect(() =>
			parseArgs([...base.slice(0, 6), "--oops", "--", "pwsh.exe"]),
		).toThrowError(/unknown argument: --oops/);
		expect(() =>
			parseArgs([
				...base.slice(0, 6),
				"--write-sid",
				"S-1-4-1-1",
				"--",
				"pwsh.exe",
			]),
		).toThrowError(/unknown argument: --write-sid/);
	});

	it("rejects unknown modes and a missing command", () => {
		expect(() =>
			parseArgs([
				"--workspace",
				"C:\\ws",
				"--temp",
				"C:\\tmp",
				"--mode",
				"danger-full-access",
				"--",
				"pwsh.exe",
			]),
		).toThrowError(/unknown mode: danger-full-access/);
		expect(() =>
			parseArgs([
				"--workspace",
				"C:\\ws",
				"--temp",
				"C:\\tmp",
				"--mode",
				"read-only",
				"--",
			]),
		).toThrowError(/missing command after --/);
	});

	it("validates that both roots exist as directories", () => {
		dir = mkdtempSync(join(tmpdir(), "sbx-cli-"));
		expect(() =>
			requireDirectory("--workspace", join(dir, "nope")),
		).toThrowError(/--workspace is not an existing directory/);
		const file = join(dir, "file.txt");
		writeFileSync(file, "x");
		expect(() => requireDirectory("--temp", file)).toThrowError(
			/--temp is not an existing directory/,
		);
		expect(() => requireDirectory("--workspace", dir)).not.toThrow();
	});

	it("exposes the documented failure contract", () => {
		expect(RUNNER_SIGNATURE).toBe("windows-acl-run");
		expect(RUNNER_FAILURE_EXIT).toBe(127);
		// Cross-module consistency: confine.ts's windows-acl failure rules are handwritten literals (not imported from cli.js).
		// A one-sided drift on either side misses or misclassifies a runner failure. Pin them here to the same constants on the runner side.
		const rules = RUNNER_FAILURE_RULES["windows-acl"];
		expect(rules).toHaveLength(1);
		expect(rules[0]?.allowedExitCodes).toEqual([RUNNER_FAILURE_EXIT]);
		expect(rules[0]?.fatalSignatures).toEqual([`${RUNNER_SIGNATURE}: `]);
		// The classifier decides on the same fields: 127 plus the signature line is a runner failure; any other exit code is not.
		const signatureLine = `${RUNNER_SIGNATURE}: --workspace is not an existing directory: C:\\missing`;
		expect(
			classifyRunnerFailure(RUNNER_FAILURE_EXIT, signatureLine, rules),
		).toBe(signatureLine);
		expect(
			classifyRunnerFailure(RUNNER_FAILURE_EXIT + 1, signatureLine, rules),
		).toBeUndefined();
	});
});
