// pi-sandbox/tests/win32-sid.test.ts
import { describe, expect, it } from "vitest";
import {
	assertGrantRootsDisjoint,
	canonicalSidInput,
	extraWriteSid,
	tempWriteSid,
	workspaceWriteSid,
} from "../src/win32/sid.js";

describe("win32 capability SIDs", () => {
	it("derives the documented workspace SID (golden vectors)", () => {
		// Values come from the derivation the spec confirms (sha256 -> two uint32 % (2^30-1) + 1). Changing the formula would leave existing ACEs behind as residue.
		expect(workspaceWriteSid("C:\\work\\demo")).toBe(
			"S-1-4-105015370-174601073",
		);
		expect(workspaceWriteSid("C:\\Users\\alice\\AppData\\Local\\Temp")).toBe(
			"S-1-4-201402608-266402677",
		);
	});

	it("domain-separates the temp SID from the workspace SID", () => {
		expect(tempWriteSid("C:\\Users\\alice\\AppData\\Local\\Temp")).toBe(
			"S-1-4-465295939-439959006-1",
		);
		// The two capabilities for the same path must differ (the third sub-authority is the domain-separation marker)
		expect(tempWriteSid("C:\\work\\demo")).not.toBe(
			workspaceWriteSid("C:\\work\\demo"),
		);
		expect(workspaceWriteSid("C:\\ws")).toMatch(/^S-1-4-\d{1,10}-\d{1,10}$/);
		expect(tempWriteSid("C:\\ws")).toMatch(/^S-1-4-\d{1,10}-\d{1,10}-1$/);
		expect(extraWriteSid("C:\\work\\demo")).toMatch(
			/^S-1-4-\d{1,10}-\d{1,10}-2$/,
		);
		expect(extraWriteSid("C:\\work\\demo")).not.toBe(
			tempWriteSid("C:\\work\\demo"),
		);
		expect(extraWriteSid("C:\\work\\demo")).not.toBe(
			workspaceWriteSid("C:\\work\\demo"),
		);
	});

	it("derives one SID per directory spelling", () => {
		const canonical = "C:\\work\\demo";
		expect(workspaceWriteSid(canonicalSidInput("C:\\work\\demo\\"))).toBe(
			workspaceWriteSid(canonical),
		);
		expect(workspaceWriteSid(canonicalSidInput("C:/work/demo"))).toBe(
			workspaceWriteSid(canonical),
		);
		// Different case is the same directory: after normalization the SID must match, or two capabilities each grant half
		expect(workspaceWriteSid(canonicalSidInput("c:\\WORK\\Demo"))).toBe(
			workspaceWriteSid(canonical),
		);
	});

	it("keeps root spellings and sibling prefixes intact", () => {
		expect(canonicalSidInput("C:\\")).toBe("C:\\");
		expect(canonicalSidInput("\\\\server\\share\\")).toBe("\\\\server\\share");
		expect(() =>
			assertGrantRootsDisjoint("C:\\work", "C:\\workshop"),
		).not.toThrow();
	});

	it("rejects a temp root nested inside the workspace", () => {
		expect(() =>
			assertGrantRootsDisjoint("C:\\work\\demo", "C:\\work\\demo\\tmp"),
		).toThrowError(/temp root must not be inside the workspace/i);
		expect(() =>
			assertGrantRootsDisjoint("C:\\work", "C:\\Temp"),
		).not.toThrow();
		// A workspace nested under temp is allowed (redundant grants, not an error)
		expect(() =>
			assertGrantRootsDisjoint("C:\\Temp\\proj", "C:\\Temp"),
		).not.toThrow();
		expect(() =>
			assertGrantRootsDisjoint("C:\\work", "C:\\work"),
		).not.toThrow();
	});
});
