// pi-sandbox/tests/win32-acl.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import koffi from "koffi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as abi from "../src/win32/abi.js";
import { buildExplicitAccess, grantWrite, lockFilePath, withPathLock } from "../src/win32/acl.js";

const PVOID = koffi.pointer("void");

// withPathLock really mkdirs: put the lock-file root in an isolated temp directory, not the repo cwd.
let tempRoot = "";
beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "pi-sandbox-win32-acl-"));
});
afterEach(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

/** Allocate a block of native memory and write the given bytes into it. */
function allocBytes(bytes: Buffer): bigint {
	const pointer = koffi.alloc("uint8", bytes.length) as unknown as bigint;
	koffi.encode(pointer as never, "uint8", bytes, bytes.length);
	return pointer;
}

/** Build a minimal SID large enough for sameSidAt/getLengthSid to read, and return its pointer. */
function fakeSid(subAuthority: number): bigint {
	const sid = Buffer.alloc(12);
	sid.writeUInt8(1, 0); // revision
	sid.writeUInt8(1, 1); // 1 sub-authority
	sid.writeUInt32LE(subAuthority, 8);
	return allocBytes(sid);
}

const WORKSPACE_SID = fakeSid(0x1111);
const LOW_SID = fakeSid(0x2222);
const WORLD_SID = fakeSid(0x3333);

/** Write one ACE (4-byte header + 4-byte mask + 12-byte inline SID) and return the next offset. */
function writeAce(acl: Buffer, offset: number, type: number, flags: number, mask: number, sidPointer: bigint): number {
	acl.writeUInt8(type, offset);
	acl.writeUInt8(flags, offset + 1);
	acl.writeUInt16LE(24, offset + 2);
	acl.writeUInt32LE(mask, offset + 4);
	Buffer.from(koffi.decode(sidPointer as never, "uint8", 12) as number[]).copy(acl, offset + 8);
	return offset + 24;
}

/** Build an ACL (optionally with exact allow/deny/label ACEs) and return its native pointer. */
function buildAcl(options: { grant?: boolean; deny?: boolean; label?: boolean; denyInheritance?: number }): bigint {
	const count = (options.grant ? 1 : 0) + (options.deny ? 1 : 0) + (options.label ? 1 : 0);
	const acl = Buffer.alloc(8 + count * 24);
	acl.writeUInt16LE(2, 0); // AclRevision
	acl.writeUInt16LE(acl.length, 2); // AclSize
	acl.writeUInt16LE(count, 4); // AceCount
	let offset = 8;
	if (options.deny) offset = writeAce(acl, offset, abi.ACCESS_DENIED_ACE_TYPE, options.denyInheritance ?? abi.CONTAINER_INHERIT_ACE, abi.FILE_DELETE_CHILD, WORLD_SID);
	if (options.grant) offset = writeAce(acl, offset, abi.ACCESS_ALLOWED_ACE_TYPE, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.GRANT_MASK, WORKSPACE_SID);
	if (options.label) writeAce(acl, offset, abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, LOW_SID);
	return allocBytes(acl);
}

/** Write a pointer into a Win32 out-parameter slot (the stub API's "return a pointer" action). */
function writeSlot(slot: unknown, value: bigint): void {
	koffi.encode(slot as never, PVOID, value);
}

/** Fake binding table that records calls: only the calls acl.js actually uses. */
function makeApi(overrides: Record<string, unknown> = {}) {
	const calls: Array<{ name: string; args: unknown[] }> = [];
	const record = (name: string, result: unknown) => (...args: unknown[]) => {
		calls.push({ name, args });
		return typeof result === "function" ? (result as (...a: unknown[]) => unknown)(...args) : result;
	};
	const api = {
		calls,
		getLastError: () => 0,
		formatMessage: () => "",
		getTempPathW: (length: number, buffer: Buffer) => {
			const path = `${tempRoot}${sep}`;
			buffer.write(path, 0, "utf16le");
			return path.length;
		},
		createFileW: record("createFileW", 7n),
		lockFileEx: record("lockFileEx", 1),
		unlockFileEx: record("unlockFileEx", 1),
		closeHandle: record("closeHandle", 1),
		localAlloc: record("localAlloc", Buffer.alloc(64)),
		localFree: record("localFree", null),
		getLengthSid: record("getLengthSid", 12), // every fake SID in this test is 12 bytes
		initializeAcl: record("initializeAcl", 1),
		addMandatoryAce: record("addMandatoryAce", 1),
		setEntriesInAclW: (count: number, entries: Buffer, old: unknown, slot: unknown) => {
			calls.push({ name: "setEntriesInAclW", args: [count, entries, old, slot] });
			writeSlot(slot, allocBytes(Buffer.alloc(64)));
			return 0;
		},
		setNamedSecurityInfoW: record("setNamedSecurityInfoW", 0),
		getNamedSecurityInfoW: record("getNamedSecurityInfoW", 0),
		...overrides,
	};
	return api;
}

describe("win32 acl layer", () => {
	it("packs EXPLICIT_ACCESS_W at the verified offsets", () => {
		const entry = buildExplicitAccess(0x1234n as never, abi.DENY_ACCESS, abi.FILE_DELETE_CHILD, abi.CONTAINER_INHERIT_ACE);
		expect(entry.length).toBe(48);
		expect(entry.readUInt32LE(0)).toBe(abi.FILE_DELETE_CHILD);
		expect(entry.readUInt32LE(4)).toBe(abi.DENY_ACCESS);
		expect(entry.readUInt32LE(8)).toBe(abi.CONTAINER_INHERIT_ACE);
		expect(entry.readUInt32LE(24)).toBe(0);
		expect(entry.readUInt32LE(28)).toBe(abi.TRUSTEE_IS_SID);
		expect(entry.readBigUInt64LE(40)).toBe(0x1234n);
	});

	it("defaults the capability grant to OI|CI inheritance", () => {
		const entry = buildExplicitAccess(1n as never, abi.GRANT_ACCESS, abi.GRANT_MASK);
		expect(entry.readUInt32LE(8)).toBe(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT);
		expect(entry.readUInt32LE(0)).toBe(abi.GRANT_MASK);
	});

	it("locks the per-path lock file without sharing delete", () => {
		const api = makeApi({
			createFileW: (...args: unknown[]) => {
				(api.calls as Array<{ name: string; args: unknown[] }>).push({ name: "createFileW", args });
				return 7n;
			},
		});
		withPathLock(api as never, "C:\\work\\demo", () => "done");
		const open = (api.calls as Array<{ name: string; args: unknown[] }>).find((c) => c.name === "createFileW");
		expect(open).toBeDefined();
		const shareMode = open?.args[2];
		expect(shareMode).toBe(abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE);
		expect((shareMode as number) & 0x4).toBe(0); // FILE_SHARE_DELETE must stay off
		const order = (api.calls as Array<{ name: string }>).map((c) => c.name);
		// Pin presence first: if lockFileEx is missing, indexOf is -1 and the order comparison below is vacuously true.
		expect(order).toContain("lockFileEx");
		expect(order.indexOf("lockFileEx")).toBeLessThan(order.indexOf("unlockFileEx"));
		expect(order.lastIndexOf("closeHandle")).toBe(order.length - 1);
	});

	it("derives a deterministic lock path from the lowercased target", () => {
		const api = makeApi();
		expect(lockFilePath(api as never, "C:\\Work\\Demo")).toBe(lockFilePath(api as never, "c:\\work\\demo"));
		expect(lockFilePath(api as never, "C:\\work\\demo")).toMatch(/dsh-acl-locks[\\/][0-9a-f]{16}\.lock$/);
	});

	it("skips the security-descriptor write when the exact triple already stands", () => {
		// Exact ACE + exact deny + exact label are all present -> read the descriptor and free it, without calling SetNamedSecurityInfoW
		let descriptor = 0n;
		const api = makeApi({
			getNamedSecurityInfoW: (_path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown, daclSlot: bigint, saclSlot: bigint, descriptorSlot: bigint) => {
				writeSlot(daclSlot, buildAcl({ grant: true, deny: true }));
				writeSlot(saclSlot, buildAcl({ label: true }));
				descriptor = allocBytes(Buffer.alloc(64)); // the descriptor owns the ACL block
				writeSlot(descriptorSlot, descriptor);
				return 0;
			},
		});
		grantWrite(api as never, "C:\\work\\demo", WORKSPACE_SID as never, LOW_SID as never, WORLD_SID as never);
		const calls = api.calls as Array<{ name: string; args: unknown[] }>;
		expect(calls.some((c) => c.name === "setNamedSecurityInfoW")).toBe(false);
		// The skip path owns only this one descriptor allocation: it must be freed exactly once. The count catches a double free;
		// the identity catches "freed some other pointer (for example an interior ACL pointer)". Either one corrupts the Win32 heap.
		const frees = calls.filter((c) => c.name === "localFree");
		expect(frees).toHaveLength(1);
		expect(frees[0]?.args[0]).toBe(descriptor);
	});

	it("applies grant + deny + label in ONE SetNamedSecurityInfoW call", () => {
		const api = makeApi({
			getNamedSecurityInfoW: (_path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown, daclSlot: bigint, saclSlot: bigint, descriptorSlot: bigint) => {
				writeSlot(daclSlot, 0n);
				writeSlot(saclSlot, 0n);
				writeSlot(descriptorSlot, 0n);
				return 0;
			},
		});
		grantWrite(api as never, "C:\\work\\demo", WORKSPACE_SID as never, LOW_SID as never, WORLD_SID as never);
		const applyCalls = (api.calls as Array<{ name: string; args: unknown[] }>).filter((c) => c.name === "setNamedSecurityInfoW");
		expect(applyCalls).toHaveLength(1);
		expect(applyCalls[0]?.args[2]).toBe(abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION);
		const entries = (api.calls as Array<{ name: string; args: unknown[] }>).find((c) => c.name === "setEntriesInAclW")?.args[1] as Buffer;
		expect(entries.length).toBe(96); // two EXPLICIT_ACCESS_W entries: deny first, allow second
		expect(entries.readUInt32LE(4)).toBe(abi.DENY_ACCESS);
		expect(entries.readUInt32LE(48 + 4)).toBe(abi.GRANT_ACCESS);
		// Each EXPLICIT_ACCESS_W is 48 bytes: perms@0, mode@4, inheritance@8, trustee.ptstrName@40.
		// entry 0 = deny: pin the mask, the inheritance bits, and the denied SID.
		expect(entries.readUInt32LE(0)).toBe(abi.FILE_DELETE_CHILD);
		// The deny must inherit only onto containers (CONTAINER_INHERIT_ACE). If it degrades to the default OI|CI, 0x40 spreads onto files
		// and denies every GENERIC_ALL open under the root.
		expect(entries.readUInt32LE(8)).toBe(abi.CONTAINER_INHERIT_ACE);
		expect(entries.readBigUInt64LE(40)).toBe(WORLD_SID); // the deny names the world SID, not the capability SID
		// entry 1 = grant: pin the mask, the inheritance bits, and the granted SID.
		expect(entries.readUInt32LE(48)).toBe(abi.GRANT_MASK);
		expect(entries.readUInt32LE(56)).toBe(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT);
		expect(entries.readBigUInt64LE(88)).toBe(WORKSPACE_SID); // the grant names the capability SID, not the world SID
	});

	it("falls back to the apply path when the current triple is a near miss", () => {
		// Near miss 1: the deny ACE exists and its mask/SID are exact, but the inheritance bits are OI|CI rather than CONTAINER_INHERIT_ACE.
		// Everything else (capability ACE + label) is exact, so reaching apply can only be triggered by this one near miss.
		const wrongDeny = makeApi({
			getNamedSecurityInfoW: (_path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown, daclSlot: bigint, saclSlot: bigint, descriptorSlot: bigint) => {
				writeSlot(daclSlot, buildAcl({ grant: true, deny: true, denyInheritance: abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT }));
				writeSlot(saclSlot, buildAcl({ label: true }));
				writeSlot(descriptorSlot, allocBytes(Buffer.alloc(64)));
				return 0;
			},
		});
		grantWrite(wrongDeny as never, "C:\\work\\demo", WORKSPACE_SID as never, LOW_SID as never, WORLD_SID as never);
		expect((wrongDeny.calls as Array<{ name: string }>).filter((c) => c.name === "setNamedSecurityInfoW")).toHaveLength(1);

		// Near miss 2: the DACL has no deny ACE at all (the capability ACE is exact; the label is exact in the SACL,
		// and the label ACE inside the DACL is invisible to hasExactLabel and does not participate) -> also falls through to apply.
		const noDeny = makeApi({
			getNamedSecurityInfoW: (_path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown, daclSlot: bigint, saclSlot: bigint, descriptorSlot: bigint) => {
				writeSlot(daclSlot, buildAcl({ grant: true, label: true }));
				writeSlot(saclSlot, buildAcl({ label: true }));
				writeSlot(descriptorSlot, allocBytes(Buffer.alloc(64)));
				return 0;
			},
		});
		grantWrite(noDeny as never, "C:\\work\\demo", WORKSPACE_SID as never, LOW_SID as never, WORLD_SID as never);
		expect((noDeny.calls as Array<{ name: string }>).filter((c) => c.name === "setNamedSecurityInfoW")).toHaveLength(1);
	});

	it("fails closed with the API name when the descriptor cannot be read", () => {
		const api = makeApi({ getNamedSecurityInfoW: () => 5 });
		expect(() => grantWrite(api as never, "C:\\work\\demo", WORKSPACE_SID as never, LOW_SID as never, WORLD_SID as never))
			.toThrowError(/GetNamedSecurityInfoW/);
	});
});
