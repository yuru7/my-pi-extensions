import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertWriteAllowed,
	canonicalizeTarget,
	FenceDenialError,
	grantDirectoryForDenial,
	isWithinRoots,
} from "../src/fence";
import { defaultTmpRoots } from "../src/policy";

/**
 * Creating a symlink on Windows requires privileges (Developer Mode or administrator), and junction / 8.3 short-name / case-insensitive
 * resolution differs from POSIX, so cases that depend on POSIX `symlinkSync` semantics are skipped on win32. Windows
 * link / short-name / case coverage is in `tests/win32/e2e.test.ts` and in the win32-gated injection cases under "win32 containment" in this file.
 */
const isWin32 = process.platform === "win32";

let dir: string;
let ws: string;
let outside: string;
// Note: wsWrite must be constructed inside beforeEach — constructing it at module scope freezes the ws of that moment (undefined),
// and the old implementation swallowed an undefined root inside statSync's try/catch, which hid that these tests never exercised the workspace root.
let wsWrite: { mode: "workspace-write"; workspaceRoot: string };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fence-"));
	// NOTE: create the directory before realpath — realpathSync.native throws ENOENT for a path that does not exist.
	mkdirSync(join(dir, "ws"), { recursive: true });
	mkdirSync(join(dir, "outside"), { recursive: true });
	ws = realpathSync.native(join(dir, "ws"));
	outside = realpathSync.native(join(dir, "outside"));
	wsWrite = { mode: "workspace-write", workspaceRoot: ws };
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("canonicalizeTarget", () => {
	// Skip on win32: creating a symlink needs privileges (Developer Mode/administrator); Windows link semantics are covered by tests/win32/e2e.test.ts.
	it.skipIf(isWin32)(
		"resolves symlinks in the existing prefix, keeps the missing tail",
		() => {
			symlinkSync(outside, join(ws, "link"));
			expect(canonicalizeTarget(join(ws, "link", "newfile.txt"))).toBe(
				join(outside, "newfile.txt"),
			);
		},
	);
	it("keeps an entirely missing path's resolved spelling", () => {
		expect(canonicalizeTarget(join(ws, "a", "b"))).toBe(join(ws, "a", "b"));
	});
	// Skip on win32: creating a symlink needs privileges (Developer Mode/administrator); Windows link semantics are covered by tests/win32/e2e.test.ts.
	it.skipIf(isWin32)(
		"follows a dangling symlink to its target spelling (Ruling 7)",
		() => {
			symlinkSync(
				join(realpathSync.native("/etc"), "sbx-probe-x"),
				join(ws, "d2"),
			);
			expect(canonicalizeTarget(join(ws, "d2"))).toBe(
				join(realpathSync.native("/etc"), "sbx-probe-x"),
			);
		},
	);
	it("collapses .. lexically against the real ancestor", () => {
		expect(canonicalizeTarget(join(ws, "sub", "..", "f"))).toBe(join(ws, "f"));
	});
});

describe("isWithinRoots", () => {
	it("lexical fast path: exact root and prefix", () => {
		expect(isWithinRoots(ws, [ws])).toBe(true);
		expect(isWithinRoots(join(ws, "a/b"), [ws])).toBe(true);
		expect(isWithinRoots(`${ws}sibling`, [ws])).toBe(false); // string prefix, but not a path-segment boundary
	});
	// Skip on win32: creating a symlink needs privileges (Developer Mode/administrator); Windows ancestor-identity / short-name semantics are covered by tests/win32/e2e.test.ts.
	it.skipIf(isWin32)(
		"ancestor identity walk catches a symlinked spelling that lexically misses",
		() => {
			const viaSymlink = join(dir, "ws-link", "f"); // dir/ws-link → ws (lexically does not contain the ws prefix)
			symlinkSync(ws, join(dir, "ws-link"));
			expect(isWithinRoots(viaSymlink, [ws])).toBe(true);
		},
	);
	it("unrelated path → false", () => {
		expect(isWithinRoots(join(outside, "f"), [ws])).toBe(false);
	});
});

describe("assertWriteAllowed", () => {
	it("allows inside the workspace, including missing tails", () => {
		expect(() =>
			assertWriteAllowed(join(ws, "new/dir/file.txt"), wsWrite),
		).not.toThrow();
	});
	it("allows every platform tmp root (defaultTmpRoots) and os.tmpdir()", () => {
		// Platform-independent: do not hard-code the literal "/tmp" — on win32 the only tmp writable root is os.tmpdir() (%TEMP%), and the literal "/tmp"
		// must be denied there (that is why this case used to fail on Windows). The default tmp roots come from defaultTmpRoots(platform).
		for (const root of defaultTmpRoots(process.platform)) {
			expect(() =>
				assertWriteAllowed(
					join(canonicalizeTarget(root), "sbx-test-x"),
					wsWrite,
				),
			).not.toThrow();
		}
		expect(() =>
			assertWriteAllowed(
				join(canonicalizeTarget(tmpdir()), "sbx-test-x"),
				wsWrite,
			),
		).not.toThrow();
	});
	// Skip on win32: creating a symlink needs privileges (Developer Mode/administrator); Windows fence escapes are covered by tests/win32/e2e.test.ts.
	it.skipIf(isWin32)(
		"denies outside with marker + hint (Review Focus #1: symlink escape)",
		() => {
			// The escape target must be an existing directory truly outside the fence: dir/outside sits under os.tmpdir(), and tmpdir()
			// is a workspace-write writable root (spec §4), so pointing there would be legally allowed. Plan Review Focus #1
			// specifies /etc. The tail is deliberately missing (the plan says "the target does not exist"); otherwise the whole path can be resolved by realpath.
			symlinkSync(realpathSync.native("/etc"), join(ws, "link"));
			let err: unknown;
			try {
				assertWriteAllowed(join(ws, "link", "sbx-nonexistent-probe"), wsWrite);
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(FenceDenialError);
			const msg = (err as Error).message;
			expect(msg).toContain(
				"[sandbox: file access denied under workspace-write mode]",
			);
			expect(msg).toContain("Do not grant a wider directory");
			expect(msg).toContain("/etc");
		},
	);
	// Skip on win32: creating a symlink needs privileges (Developer Mode/administrator); Windows fence escapes are covered by tests/win32/e2e.test.ts.
	it.skipIf(isWin32)(
		"denies a dangling final-component symlink pointing outside (Ruling 7: P1 escape)",
		() => {
			symlinkSync(
				join(realpathSync.native("/etc"), `sbx-dangling-probe-${process.pid}`),
				join(ws, "dangling"),
			);
			expect(() => assertWriteAllowed(join(ws, "dangling"), wsWrite)).toThrow(
				FenceDenialError,
			);
		},
	);
	// Skip on win32: creating a symlink needs privileges (Developer Mode/administrator); Windows relative-link resolution is covered by tests/win32/e2e.test.ts.
	it.skipIf(isWin32)(
		"resolves a relative dangling symlink against the link's directory and denies escape (M5)",
		() => {
			const etcTarget = join(
				realpathSync.native("/etc"),
				`sbx-rel-probe-${process.pid}`,
			);
			symlinkSync(relative(ws, etcTarget), join(ws, "rel-dangling"));
			expect(canonicalizeTarget(join(ws, "rel-dangling"))).toBe(etcTarget);
			expect(() =>
				assertWriteAllowed(join(ws, "rel-dangling"), wsWrite),
			).toThrow(FenceDenialError);
		},
	);
	// Skip on win32: creating a symlink needs privileges (Developer Mode/administrator); Windows link semantics are covered by tests/win32/e2e.test.ts.
	it.skipIf(isWin32)(
		"allows a dangling final-component symlink pointing inside the workspace",
		() => {
			symlinkSync(join(ws, "future.txt"), join(ws, "dangling-in"));
			expect(() =>
				assertWriteAllowed(join(ws, "dangling-in"), wsWrite),
			).not.toThrow();
		},
	);
	it("read-only denies everything, even inside the workspace", () => {
		expect(() =>
			assertWriteAllowed(join(ws, "f"), {
				mode: "read-only",
				workspaceRoot: ws,
			}),
		).toThrow(FenceDenialError);
	});
	it("danger-full-access allows anywhere", () => {
		expect(() =>
			assertWriteAllowed("/etc/hosts", {
				mode: "danger-full-access",
				workspaceRoot: ws,
			}),
		).not.toThrow();
	});
	it("a custom runner denial does not offer a directory grant", () => {
		expect(() =>
			assertWriteAllowed("/etc/hosts", {
				mode: "workspace-write",
				workspaceRoot: ws,
				customRunner: true,
			}),
		).toThrow(/custom runnerCommand cannot accept a directory grant/);
	});
});

describe("grantDirectoryForDenial", () => {
	it("uses the parent of a file, refuses home, and splits different directories", () => {
		expect(grantDirectoryForDenial(["/etc/hosts"]).grantDirectory).toBe(
			canonicalizeTarget("/etc"),
		);
		expect(grantDirectoryForDenial([join(homedir(), "notes.txt")])).toEqual({
			refusedDirectory: canonicalizeTarget(homedir()),
		});
		expect(
			grantDirectoryForDenial(["/etc/hosts", join(tmpdir(), "elsewhere.txt")])
				.split,
		).toBe(true);
		expect(grantDirectoryForDenial([])).toEqual({});
	});
	it("names an existing directory itself, and a new directory create the same way", () => {
		const directory = mkdtempSync(join(tmpdir(), "grant-dir-"));
		try {
			const real = canonicalizeTarget(directory);
			expect(grantDirectoryForDenial([directory]).grantDirectory).toBe(real);
			expect(
				grantDirectoryForDenial([join(directory, "file.txt")]).grantDirectory,
			).toBe(real);
			const created = join(directory, "child");
			expect(grantDirectoryForDenial([created], true).grantDirectory).toBe(
				canonicalizeTarget(created),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("win32 containment", () => {
	// win32 literal fixtures always use C:\__pi_sandbox_fixture__…, which will not exist on a real machine: if C:\work\demo
	// really existed, the dev/ino identity fallback would hit a spelling that differs only in case, and a case-sensitive assertion would fail spuriously.
	// Host-shaped paths: both the separator and case comparison follow the host path.sep. Do not use a "C:\..."
	// literal as a positive case on POSIX — "\" is a legal filename character there, and treating it as a separator would make a real directory such as /tmp/ws\..
	// be misjudged as a child of /tmp/ws (a real escape). The Windows-shaped equivalent assertions are in
	// the win32-only cases below. The root is a nonexistent case-flipped spelling, so the identity fallback misses and the result is determinate.
	let caseRoot: string;
	let caseUnder: string;
	beforeEach(() => {
		caseRoot = join(dir, "Case", "Demo");
		caseUnder = join(dir, "case", "demo", "a.txt");
	});

	it("matches case-insensitively when the platform is case-insensitive", () => {
		expect(isWithinRoots(caseUnder, [caseRoot], false)).toBe(true);
		expect(
			isWithinRoots(join(dir, "case", "other", "a.txt"), [caseRoot], false),
		).toBe(false);
	});

	it("stays case-sensitive when told to", () => {
		expect(
			isWithinRoots(
				"C:\\__pi_sandbox_fixture__\\Demo\\a.txt",
				["C:\\__pi_sandbox_fixture__\\demo"],
				true,
			),
		).toBe(false);
		expect(isWithinRoots(caseUnder, [caseRoot], true)).toBe(false);
	});

	it.skipIf(sep === "\\")(
		"keeps a trailing backslash literal on POSIX (no separator widening)",
		() => {
			// "\" is a filename character on POSIX: the root ".../Demo\" contains only ".../Demo\/…", and stripping a trailing separator must not
			// also pull in the whole ".../Demo" subtree (that would widen POSIX behavior).
			const weirdRoot = `${caseRoot}\\`;
			expect(isWithinRoots(join(weirdRoot, "f.txt"), [weirdRoot], false)).toBe(
				true,
			);
			expect(isWithinRoots(join(caseRoot, "f.txt"), [weirdRoot], false)).toBe(
				false,
			);
		},
	);

	it("uses the platform separator instead of a hardcoded slash", () => {
		expect(
			isWithinRoots(
				"C:\\__pi_sandbox_fixture__\\demo",
				["C:\\__pi_sandbox_fixture__\\demo"],
				false,
			),
		).toBe(true);
		expect(
			isWithinRoots(
				"C:\\__pi_sandbox_fixture__\\demo2",
				["C:\\__pi_sandbox_fixture__\\demo"],
				false,
			),
		).toBe(false); // a prefix, but not a child path
		expect(isWithinRoots(caseRoot, [caseRoot], false)).toBe(true);
		expect(isWithinRoots(`${caseRoot}2`, [caseRoot], false)).toBe(false); // a prefix, but not a child path
		expect(
			isWithinRoots(join(caseRoot, "sub", "f.txt"), [caseRoot], false),
		).toBe(true);
	});

	it("does not treat a bare drive letter as a drive root", () => {
		// A bare "C:" is the per-drive current directory (drive-relative), not the drive root "C:\": lexical containment requires a separator immediately after the drive letter.
		// That result does not depend on path.sep (on POSIX the root does not exist, and neither the lexical check nor the identity fallback hits), so it is not gated and runs on Linux too;
		// the positive case ("C:\…" lies under "C:\") holds only on win32, and lives in the win32-gated case below.
		// The implementation's DRIVE_RELATIVE_PATH guard makes this result determinate on a win32 host as well (it no longer depends on the per-drive CWD).
		expect(isWithinRoots("C:", ["C:\\"], false)).toBe(false);
	});

	it.skipIf(process.platform !== "win32")(
		"normalizes / to \\ and bounds on the platform separator (win32)",
		() => {
			expect(
				isWithinRoots(
					"C:\\__pi_sandbox_fixture__\\Demo\\a.txt",
					["C:\\__pi_sandbox_fixture__\\demo"],
					false,
				),
			).toBe(true);
			expect(
				isWithinRoots(
					"C:/__pi_sandbox_fixture__/Demo/a.txt",
					["C:\\__pi_sandbox_fixture__\\demo"],
					false,
				),
			).toBe(true);
			expect(
				isWithinRoots(
					"C:\\__pi_sandbox_fixture__\\demo2",
					["C:\\__pi_sandbox_fixture__\\demo"],
					false,
				),
			).toBe(false);
			expect(
				isWithinRoots("C:\\__pi_sandbox_fixture__\\demo", ["C:\\"], false),
			).toBe(true); // drive root: after the tail is stripped to "C:", matching continues via the separator
			expect(isWithinRoots("C:work", ["C:\\"], false)).toBe(false); // a drive-relative path is not a child of the drive root
		},
	);

	it("honours the injected case sensitivity in the fence policy", () => {
		// Deviation: the plan's original draft used literal "C:\..." paths, but on Linux canonicalizeTarget joins them
		// onto cwd as POSIX relative paths (always denied); and dir/outside sits under tmpdir(), which is a writable root,
		// so a deny case needs _tmpRoots: [] to be truly outside the fence. Use a real directory plus a root spelling that differs only in case,
		// covering the same injection path (canonicalizeTarget → writableRoots → isWithinRoots).
		const caseFlippedWs = ws.toUpperCase();
		expect(caseFlippedWs).not.toBe(ws); // the mkdtemp prefix "fence-" guarantees the spelling changes after a case flip
		const policy = {
			mode: "workspace-write" as const,
			workspaceRoot: caseFlippedWs,
			caseSensitive: false,
			_tmpRoots: [] as readonly string[],
		};
		expect(() =>
			assertWriteAllowed(join(ws, "file.txt"), policy),
		).not.toThrow();
		expect(() =>
			assertWriteAllowed(join(outside, "file.txt"), policy),
		).toThrowError(/file access denied/);
	});
});

describe("identity fallback robustness", () => {
	it("treats a zero ino (Windows stat fallback) as unknown identity — fail-closed", async () => {
		// Background (caught by live CI on 2026-10-04): libuv's stat fallback on Windows (taken when a directory handle is
		// briefly held by Defender or the indexer, via GetFileAttributesExW) returns ino/dev = 0, an "unknown identity".
		// In the same Defender scan window the root and a target ancestor both receive 0 — `0 === 0` treats two
		// different directories as the same, and the identity fallback fail-opens (the fence allows by mistake). An unknown identity is not the same identity.
		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			const unknown = { dev: 0, ino: 0 } as unknown as import("node:fs").Stats;
			return { ...actual, statSync: () => unknown };
		});
		try {
			const { isWithinRoots: withUnknownIdentity } = await import(
				"../src/fence"
			);
			// root ("…\bbb") and the target ancestor ("…\aaa") both have unknown identity → they must not be treated as the same directory
			expect(
				withUnknownIdentity("C:\\tmp\\aaa\\f.txt", ["C:\\tmp\\bbb"], false),
			).toBe(false);
		} finally {
			vi.doUnmock("node:fs");
			vi.resetModules();
		}
	});

	it("compares the full 64-bit ino, not the rounded number form (win32 NTFS FileId)", async () => {
		// Background (caught by live CI on 2026-10-05): an NTFS FileId is 64 bits (a 16-bit sequence number plus a 48-bit MFT record number),
		// and two adjacent directories under the same parent differ by 1. `Stats.ino` as a number rounds to even past 2^53:
		// in live CI, outside the fence (true id …C5) and the granted root fake-tmp (…C4) were both read as
		// `14355223812536772`, and the identity fallback judged outside to be fake-tmp (the fence self-check in tools.test.ts
		// had verdict=true, fail-open, and the whole decision chain sat on the identity-fallback layer). Identity must compare the full 64 bits.
		const rootIno = 14355223812536772n; // …C4: even, exactly representable as a number (live value)
		const targetIno = 14355223812536773n; // …C5: the adjacent record; the number form rounds to …C4 (live value)
		expect(Number(targetIno)).toBe(Number(rootIno)); // fixture self-check: the number form really collides
		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			// Simulate a win32 host: `{ bigint: true }` yields the full FileId, and a number read yields the rounded value.
			const statSync = ((path: string, opts?: { bigint?: boolean }) => {
				const ino = String(path).includes("fake-tmp") ? rootIno : targetIno;
				return opts?.bigint ? { dev: 1n, ino } : { dev: 1, ino: Number(ino) };
			}) as unknown as typeof actual.statSync;
			return { ...actual, statSync };
		});
		try {
			const { isWithinRoots: withExactIdentity } = await import("../src/fence");
			// Falling back to number identity, both sides are 14355223812536772 → misjudged as the same directory → true
			expect(
				withExactIdentity(
					"C:\\tmp\\outside\\f.txt",
					["C:\\tmp\\fake-tmp"],
					false,
				),
			).toBe(false);
		} finally {
			vi.doUnmock("node:fs");
			vi.resetModules();
		}
	});

	it("treats an already-rounded number ino as unknown identity — fail-closed", async () => {
		// Defense on identity reads: when a broken host ignores `{ bigint: true }` and returns only the number form, values past 2^53
		// can no longer distinguish adjacent FileIds (the live evidence in the previous case). That is not "the same identity" but "identity cannot be proven",
		// and it is treated like a zero identity: imprecise means no match. This holds the `exact` isSafeInteger criterion — if it fell back to
		// isInteger, the rounded values of two different directories would be judged the same, and the fail-open would come back as-is.
		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			// the true ids of two different directories are both this rounded result in number form (the value observed in live CI)
			const statSync = (() => ({
				dev: 1,
				ino: 14355223812536772,
			})) as unknown as typeof actual.statSync;
			return { ...actual, statSync };
		});
		try {
			const { isWithinRoots: withRoundedIdentity } = await import(
				"../src/fence"
			);
			expect(
				withRoundedIdentity(
					"C:\\tmp\\outside\\f.txt",
					["C:\\tmp\\fake-tmp"],
					false,
				),
			).toBe(false);
		} finally {
			vi.doUnmock("node:fs");
			vi.resetModules();
		}
	});
});
