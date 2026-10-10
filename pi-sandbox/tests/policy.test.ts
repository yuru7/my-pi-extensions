import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canonicalPath,
	defaultTmpRoots,
	isSandboxMode,
	resolveEffectiveMode,
	SANDBOX_MODES,
	writableRoots,
} from "../src/policy";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "policy-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("canonicalPath", () => {
	// Skip on win32: creating a symlink needs privileges (Developer Mode or Administrator). Link and junction resolution on Windows is covered by tests/win32/e2e.test.ts.
	it.skipIf(process.platform === "win32")("resolves symlinks", () => {
		writeFileSync(join(dir, "real"), "x");
		symlinkSync(join(dir, "real"), join(dir, "link"));
		expect(canonicalPath(join(dir, "link"))).toBe(
			canonicalPath(join(dir, "real")),
		);
	});
	it("keeps the spelling of a missing path", () => {
		const missing = join(dir, "nope");
		expect(canonicalPath(missing)).toBe(missing);
	});
});

describe("writableRoots", () => {
	it("is empty for read-only and danger-full-access", () => {
		expect(writableRoots("read-only", dir)).toEqual([]);
		expect(writableRoots("danger-full-access", dir)).toEqual([]);
	});
	it("read-only keeps approved extra roots and danger-full-access ignores them", () => {
		const extra = join(dir, "extra");
		expect(writableRoots("read-only", dir, [], [extra])).toEqual([
			canonicalPath(extra),
		]);
		expect(writableRoots("danger-full-access", dir, [], [extra])).toEqual([]);
	});
	it("workspace-write: canonical, deduped, contains workspace and the platform tmp roots", () => {
		const roots = writableRoots("workspace-write", dir);
		expect(roots).toContain(canonicalPath(dir));
		// Platform-independent: the default tmp roots come from defaultTmpRoots(platform) (POSIX is "/tmp" + os.tmpdir(); win32 is only %TEMP%).
		for (const tmp of defaultTmpRoots(process.platform))
			expect(roots).toContain(canonicalPath(tmp));
		expect(new Set(roots).size).toBe(roots.length);
	});
});

describe("isSandboxMode", () => {
	it("accepts exactly the three modes", () => {
		for (const m of SANDBOX_MODES) expect(isSandboxMode(m)).toBe(true);
		expect(isSandboxMode("nope")).toBe(false);
		expect(isSandboxMode(undefined)).toBe(false);
	});
});

describe("resolveEffectiveMode", () => {
	it("override outranks config default", () => {
		expect(resolveEffectiveMode("read-only", "workspace-write")).toBe(
			"read-only",
		);
		expect(resolveEffectiveMode(null, "workspace-write")).toBe(
			"workspace-write",
		);
	});
});

describe("win32 writable roots", () => {
	it("drops the POSIX /tmp root on Windows", () => {
		expect(defaultTmpRoots("win32")).toEqual([tmpdir()]);
		expect(defaultTmpRoots("linux")).toEqual(["/tmp", tmpdir()]);
		expect(defaultTmpRoots("darwin")).toEqual(["/tmp", tmpdir()]);
	});

	it("derives the win32 workspace-write roots (workspace + %TEMP%)", () => {
		const roots = writableRoots(
			"workspace-write",
			"C:\\ws",
			defaultTmpRoots("win32"),
		);
		expect(roots).toHaveLength(2);
		expect(roots.map((r) => r.toLowerCase())).toContain("c:\\ws".toLowerCase());
	});
});
