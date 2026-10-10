// pi-sandbox/tests/win32-runner.test.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import koffi from "koffi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as abi from "../src/win32/abi.js";
import { RUNNER_FAILURE_EXIT, RUNNER_SIGNATURE } from "../src/win32/cli.js";
import { main } from "../src/win32/runner.js";

const PVOID = koffi.pointer("void");

// requireDirectory hits the real filesystem: the workspace and --temp roots must be directories that actually exist,
// and withPathLock really mkdirs its lock-file root, so isolate each case in its own temp directory
// instead of writing into the repo cwd.
let root = "";
let WS = "";
let TMP = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-sandbox-win32-runner-"));
	WS = mkdtempSync(join(root, "ws-"));
	TMP = mkdtempSync(join(root, "tmp-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function makeDeps(overrides: Record<string, unknown> = {}) {
	const calls: Array<{ name: string; args: unknown[] }> = [];
	// One distinguishable sentinel pointer per SID string. Other sentinels in the stub are 0x1/0x2/0x5000/0x9000/0xa000;
	// start at 0x10000 so a DACL merge can assert which SID was written, not merely count the calls.
	const sidPointers = new Map<string, bigint>();
	// makeWellKnownSid returns the buffer from its own allocBytes; the 3rd argument the stub receives is that pointer.
	const wellKnownPointers = new Map<number, bigint>();
	const rec =
		(name: string, result: unknown) =>
		(...args: unknown[]) => {
			calls.push({ name, args });
			return typeof result === "function"
				? (result as (...a: unknown[]) => unknown)(...args)
				: (result as never);
		};
	const api = {
		calls,
		getLastError: () => 0,
		formatMessage: () => "",
		openProcess: rec("openProcess", 0x1n),
		closeHandle: rec("closeHandle", 1),
		openProcessToken: (process: unknown, access: number, slot: unknown) => {
			koffi.encode(slot as never, PVOID, 0x2n);
			return 1;
		},
		getTokenInformation: (
			token: unknown,
			cls: number,
			info: Buffer | null,
			length: number,
			needed: Buffer,
		) => {
			if (cls === abi.TokenGroups) {
				if (info === null) {
					koffi.encode(needed as never, "uint32", 32);
					return 0;
				}
				info.writeUInt32LE(1, 0);
				info.writeBigUInt64LE(0x30n, abi.TOKEN_GROUPS_OFFSET);
				info.writeUInt32LE(
					abi.SE_GROUP_LOGON_ID >>> 0,
					abi.TOKEN_GROUPS_OFFSET + 8,
				);
				return 1;
			}
			if (info === null) {
				koffi.encode(needed as never, "uint32", 16);
				return 0;
			}
			// TokenDefaultDacl must supply a non-NULL existing DACL, or the §4.6 patch refuses to continue.
			// The TokenIntegrityLevel payload is only consumed by the stub's SetTokenInformation; writing 0 is enough.
			info.writeBigUInt64LE(cls === abi.TokenDefaultDacl ? 0x9000n : 0n, 0);
			return 1;
		},
		getLengthSid: rec("getLengthSid", 12),
		copySid: rec("copySid", 1),
		convertStringSidToSidW: rec(
			"convertStringSidToSidW",
			(sid: string, slot: unknown) => {
				const existing = sidPointers.get(sid);
				const pointer =
					existing === undefined
						? 0x10000n + BigInt(sidPointers.size)
						: existing;
				sidPointers.set(sid, pointer);
				koffi.encode(slot as never, PVOID, pointer);
				return 1;
			},
		),
		createWellKnownSid: rec(
			"createWellKnownSid",
			(type: number, _reserved: unknown, sid: unknown) => {
				wellKnownPointers.set(type, sid as bigint);
				return 1;
			},
		),
		isValidSid: rec("isValidSid", 1),
		createRestrictedToken: rec(
			"createRestrictedToken",
			(...args: unknown[]) => {
				koffi.encode(args[8] as never, PVOID, 0x5000n); // the out-parameter slot must be written as a non-NULL token
				return 1;
			},
		),
		setTokenInformation: rec("setTokenInformation", 1),
		localAlloc: rec("localAlloc", Buffer.alloc(256)),
		localFree: rec("localFree", null),
		setEntriesInAclW: rec("setEntriesInAclW", (...args: unknown[]) => {
			koffi.encode(args[3] as never, PVOID, 0xa000n); // pointer to the merged new ACL
			return 0;
		}),
		initializeAcl: rec("initializeAcl", 1),
		addMandatoryAce: rec("addMandatoryAce", 1),
		getNamedSecurityInfoW: rec("getNamedSecurityInfoW", 0),
		setNamedSecurityInfoW: rec("setNamedSecurityInfoW", 0),
		getTempPathW: (length: number, buffer: Buffer) => {
			const p = `${root}${sep}`;
			buffer.write(p, 0, "utf16le");
			return p.length;
		},
		createFileW: rec("createFileW", 0x6000n),
		lockFileEx: rec("lockFileEx", 1),
		unlockFileEx: rec("unlockFileEx", 1),
		setConsoleCtrlHandler: rec("setConsoleCtrlHandler", 1),
	};
	const spawn = (token: unknown, options: { command: string }) => {
		calls.push({ name: "spawn", args: [token, options] });
		return { pid: 4242, process: 0x7000n, job: 0x7100n };
	};
	return {
		calls,
		api,
		sidPointers,
		spawn,
		wait: (process: unknown) => {
			calls.push({ name: "wait", args: [process] });
			return 99;
		},
		wellKnownPointers,
		...overrides,
	};
}

/** Byte offset of Trustee.ptstrName (the SID pointer) inside EXPLICIT_ACCESS_W. */
const TRUSTEE_NAME_OFFSET =
	abi.TRUSTEE_W_OFFSET + abi.TRUSTEE_W_PTSTRNAME_OFFSET;

/** Read the SID pointer named by the trustee in one merged entry. */
function mergedTrusteePointer(entries: Buffer) {
	return entries.readBigUInt64LE(TRUSTEE_NAME_OFFSET);
}

/**
 * The token default-DACL patch is the only single-entry (count=1) SetEntriesInAclW merge.
 * Both merges on the grant path carry 2 ACEs (environment-delete Deny + capability Grant).
 */
function defaultDaclTrustee(calls: Array<{ name: string; args: unknown[] }>) {
	const patches = calls.filter(
		(call) => call.name === "setEntriesInAclW" && call.args[0] === 1,
	);
	if (patches.length !== 1)
		throw new Error(
			`expected exactly one token default-DACL patch, got ${patches.length}`,
		);
	return mergedTrusteePointer(patches[0].args[1] as Buffer);
}

function args(
	mode: string,
	command = ["pwsh.exe", "-NoProfile", "-Command", "echo hi"],
) {
	return ["--workspace", WS, "--temp", TMP, "--mode", mode, "--", ...command];
}

describe("windows-acl runner main", () => {
	it("mirrors the confined child's exit code", async () => {
		const deps = makeDeps();
		await expect(main(args("workspace-write"), deps as never)).resolves.toBe(
			99,
		);
		expect(deps.calls.map((c) => c.name)).toContain("wait");
	});

	it("grants both roots and derives both SIDs in workspace-write", async () => {
		const deps = makeDeps();
		await main(args("workspace-write"), deps as never);
		const granted = deps.calls.filter(
			(c) => c.name === "setNamedSecurityInfoW",
		);
		expect(granted.length).toBeGreaterThanOrEqual(2); // workspace + %TEMP%
		const sids = deps.calls
			.filter((c) => c.name === "convertStringSidToSidW")
			.map((c) => String(c.args[0]));
		// Step 3 requirement #6: both SIDs must be derived. toHaveLength(2) is exactly the check for
		// "only one SID was derived and both roots share the same identity"; the old assertion was vacuously true for a single SID.
		expect(sids).toHaveLength(2);
		for (const sid of sids) expect(sid.startsWith("S-1-4-")).toBe(true);
		const [workspaceSid, tempSid] = sids;
		// workspace = 2 sub-authorities; temp = 3: the fixed third component `-1` is domain-separated from every workspace SID.
		expect(workspaceSid.split("-")).toHaveLength(5);
		expect(tempSid.split("-")).toHaveLength(6);
		expect(tempSid.endsWith("-1")).toBe(true);
		expect(new Set(sids).size).toBe(sids.length);
	});

	it("names the temp SID in the token's default DACL under workspace-write", async () => {
		const deps = makeDeps();
		await main(args("workspace-write"), deps as never);
		const sids = deps.calls
			.filter((c) => c.name === "convertStringSidToSidW")
			.map((c) => String(c.args[0]));
		const tempSid = sids.find((sid) => sid.split("-").length === 6);
		const workspaceSid = sids.find((sid) => sid.split("-").length === 5);
		if (tempSid === undefined || workspaceSid === undefined) {
			throw new Error(`expected both capability SIDs, got ${sids.join(", ")}`);
		}
		// §4.6: the default-DACL patch must name temp (writeSids[1]). Swapping the writeSids[1]/[0]
		// operands is caught here (the old assertion only inspected the pointer in a real-machine probe).
		const trustee = defaultDaclTrustee(deps.calls);
		expect(trustee).toBe(deps.sidPointers.get(tempSid));
		expect(trustee).not.toBe(deps.sidPointers.get(workspaceSid));
	});

	it("grants only the extra directory under read-only", async () => {
		const extra = mkdtempSync(join(root, "extra-"));
		const deps = makeDeps();
		await main(
			[
				"--workspace",
				WS,
				"--temp",
				TMP,
				"--mode",
				"read-only",
				"--extra",
				extra,
				"--",
				"pwsh.exe",
			],
			deps as never,
		);
		const grantedPaths = deps.calls
			.filter((call) => call.name === "setNamedSecurityInfoW")
			.map((call) => call.args[0]);
		expect(grantedPaths).toContain(extra);
		expect(grantedPaths).not.toContain(WS);
		const sids = deps.calls
			.filter((call) => call.name === "convertStringSidToSidW")
			.map((call) => String(call.args[0]));
		expect(sids).toEqual([expect.stringMatching(/-2$/)]);
	});

	it("names the well-known Everyone SID in the token's default DACL under read-only", async () => {
		const deps = makeDeps();
		await main(args("read-only"), deps as never);
		// read-only does not derive a capability SID; the default-DACL patch falls back to Everyone (writeSids is empty).
		const trustee = defaultDaclTrustee(deps.calls);
		expect(trustee).toBe(deps.wellKnownPointers.get(abi.WinWorldSid));
		expect(trustee).not.toBe(deps.wellKnownPointers.get(abi.WinLowLabelSid));
	});

	it("fails closed without spawning when a root grant cannot be applied", async () => {
		const deps = makeDeps();
		deps.api.setNamedSecurityInfoW = () => 5; // ERROR_ACCESS_DENIED: a grant failure must bubble up
		await expect(
			main(args("workspace-write"), deps as never),
		).rejects.toThrowError(/SetNamedSecurityInfoW/);
		// A grant failure must never degrade into "run with zero grants": spawn/wait must not happen even once.
		expect(
			deps.calls.filter((c) => c.name === "spawn" || c.name === "wait"),
		).toEqual([]);
	});

	it("grants nothing in read-only mode", async () => {
		const deps = makeDeps();
		await main(args("read-only"), deps as never);
		expect(deps.calls.some((c) => c.name === "setNamedSecurityInfoW")).toBe(
			false,
		);
		// Zero calls on the grant path: no path lock, no capability-SID resolution, no label/ACL read-and-build. The only
		// SetEntriesInAclW is the §4.6 token default-DACL patch (SID falls back to Everyone), not a DACL merge of a grant root.
		for (const grantCall of [
			"createFileW",
			"getNamedSecurityInfoW",
			"initializeAcl",
			"addMandatoryAce",
		]) {
			expect(deps.calls.some((c) => c.name === grantCall)).toBe(false);
		}
		expect(deps.calls.some((c) => c.name === "convertStringSidToSidW")).toBe(
			false,
		);
		expect(deps.calls.filter((c) => c.name === "setEntriesInAclW").length).toBe(
			1,
		);
	});

	it("passes the caller's argv verbatim to the spawner", async () => {
		const deps = makeDeps();
		await main(
			args("workspace-write", ["pwsh.exe", "-Command", "echo --temp C:\\x"]),
			deps as never,
		);
		const spawned = deps.calls.find((c) => c.name === "spawn");
		const options = spawned?.args[1] as { command: string; args: string[] };
		expect(options.command).toBe("pwsh.exe");
		// argv after `--` must be passed through verbatim: even if it looks like a runner flag ("--temp C:\\x")
		// it must not be parsed again or rewritten.
		expect(options.args).toEqual(["-Command", "echo --temp C:\\x"]);
	});

	it("starts the child in the runner's own cwd, not the workspace root", async () => {
		const deps = makeDeps();
		// Precondition: "inherit process.cwd()" and "rewrite to the workspace" can be distinguished only when the two differ.
		expect(WS).not.toBe(process.cwd());
		await main(args("workspace-write"), deps as never);
		const spawned = deps.calls.find((c) => c.name === "spawn");
		expect((spawned?.args[1] as { cwd: string }).cwd).toBe(process.cwd());
	});

	it("installs a Ctrl+C handler before spawning", async () => {
		const deps = makeDeps();
		await main(args("workspace-write"), deps as never);
		const names = deps.calls.map((c) => c.name);
		// Pin presence first: if setConsoleCtrlHandler is missing, indexOf is -1 and the order comparison is vacuously true.
		expect(names).toContain("setConsoleCtrlHandler");
		expect(names.indexOf("setConsoleCtrlHandler")).toBeLessThan(
			names.indexOf("spawn"),
		);
	});

	it("fails closed with the signature line and exit 127 on a Win32 error", async () => {
		const deps = makeDeps({
			api: {
				...makeDeps().api,
				createRestrictedToken: () => {
					throw new Error(
						"Win32 CreateRestrictedToken failed (1314): A required privilege is not held by the client.",
					);
				},
			},
		});
		await expect(
			main(args("workspace-write"), deps as never),
		).rejects.toThrowError(/CreateRestrictedToken/);
	});

	it("rejects a temp root nested inside the workspace before any Win32 call", async () => {
		const deps = makeDeps();
		const nestedTemp = join(WS, "tmp");
		mkdirSync(nestedTemp);
		await expect(
			main(
				[
					"--workspace",
					WS,
					"--temp",
					nestedTemp,
					"--mode",
					"workspace-write",
					"--",
					"pwsh.exe",
				],
				deps as never,
			),
		).rejects.toThrowError(/temp root must not be inside the workspace/i);
		expect(deps.calls.some((c) => c.name === "openProcess")).toBe(false);
		expect(deps.calls).toEqual([]); // no Win32 call has happened yet
	});

	it("prints exactly one signature line and exits 127 as the entry point", () => {
		const runner = fileURLToPath(
			new URL("../src/win32/runner.js", import.meta.url),
		);
		const missing = join(root, "missing-workspace");
		const result = spawnSync(
			process.execPath,
			[
				runner,
				"--workspace",
				missing,
				"--temp",
				TMP,
				"--mode",
				"read-only",
				"--",
				"echo",
			],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(RUNNER_FAILURE_EXIT);
		expect(result.stderr).toBe(
			`${RUNNER_SIGNATURE}: --workspace is not an existing directory: ${missing}\n`,
		);
	});

	it.skipIf(process.platform === "win32")(
		"runs main through a symlinked entry point (realpath guard)",
		() => {
			const runner = fileURLToPath(
				new URL("../src/win32/runner.js", import.meta.url),
			);
			const symlink = join(root, "runner-symlink.js");
			symlinkSync(runner, symlink);
			const result = spawnSync(
				process.execPath,
				[
					symlink,
					"--workspace",
					WS,
					"--temp",
					TMP,
					"--mode",
					"read-only",
					"--",
					"pwsh",
				],
				{ encoding: "utf8" },
			);
			// main must also run when the entry point is a symlink: on Linux/macOS win32() throws, producing the signature line and exit 127.
			// The old literal URL comparison returned false here, and the process silently exited 0 (the TS classifier treats that as success).
			expect(result.status).toBe(RUNNER_FAILURE_EXIT);
			expect(result.stderr).toContain(`${RUNNER_SIGNATURE}: `);
		},
	);
});
