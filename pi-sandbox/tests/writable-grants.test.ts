import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMissingGrantDirectories } from "../src/grant-path";
import {
	getWritableGrants,
	resetWritableGrantsForTests,
} from "../src/writable-grants";

let root = "";

afterEach(() => {
	resetWritableGrantsForTests();
	if (root.length > 0) rmSync(root, { recursive: true, force: true });
	root = "";
});

function scratch(): string {
	root = mkdtempSync(join(tmpdir(), "grant-cleanup-"));
	const ancestor = join(root, "keep");
	mkdirSync(ancestor);
	return ancestor;
}

describe("empty directories created for a grant", () => {
	it("removes the empty leaf and empty parents this grant created", () => {
		const ancestor = scratch();
		const leaf = join(ancestor, "share", "app");
		const created = createMissingGrantDirectories(leaf);
		getWritableGrants().grant("s", leaf, created);

		getWritableGrants().clear("s");

		expect(existsSync(leaf)).toBe(false);
		expect(existsSync(join(ancestor, "share"))).toBe(false);
		expect(existsSync(ancestor)).toBe(true);
		expect(getWritableGrants().list("s")).toEqual([]);
	});

	it("keeps a created directory that contains a file, and the parents above it", () => {
		const ancestor = scratch();
		const leaf = join(ancestor, "share", "app");
		const created = createMissingGrantDirectories(leaf);
		writeFileSync(join(leaf, "file.txt"), "ok");
		getWritableGrants().grant("s", leaf, created);

		getWritableGrants().clear("s");

		expect(existsSync(join(leaf, "file.txt"))).toBe(true);
		expect(existsSync(join(ancestor, "share"))).toBe(true);
	});

	it("does not remove a directory that already existed", () => {
		const ancestor = scratch();
		const leaf = join(ancestor, "already");
		mkdirSync(leaf);
		const created = createMissingGrantDirectories(leaf);
		expect(created).toEqual([]);
		getWritableGrants().grant("s", leaf, created);

		getWritableGrants().clear("s");

		expect(existsSync(leaf)).toBe(true);
	});

	it("removes a shared parent only after every created child is gone", () => {
		const ancestor = scratch();
		const share = join(ancestor, "share");
		const kept = join(share, "kept");
		const empty = join(share, "empty");
		const createdKept = createMissingGrantDirectories(kept);
		const createdEmpty = createMissingGrantDirectories(empty);
		writeFileSync(join(kept, "file.txt"), "ok");
		getWritableGrants().grant("s", kept, createdKept);
		getWritableGrants().grant("s", empty, createdEmpty);

		getWritableGrants().clear("s");

		expect(existsSync(join(kept, "file.txt"))).toBe(true);
		expect(existsSync(empty)).toBe(false);
		expect(existsSync(share)).toBe(true);
	});

	it("removes the shared parent when every created child is empty", () => {
		const ancestor = scratch();
		const share = join(ancestor, "share");
		const first = join(share, "a");
		const second = join(share, "b");
		getWritableGrants().grant("s", first, createMissingGrantDirectories(first));
		getWritableGrants().grant(
			"s",
			second,
			createMissingGrantDirectories(second),
		);

		getWritableGrants().clear("s");

		expect(existsSync(share)).toBe(false);
		expect(existsSync(ancestor)).toBe(true);
	});

	it("stops when a path component is a file and does not create anything under it", () => {
		const ancestor = scratch();
		const file = join(ancestor, "fresh", "not-a-dir");
		mkdirSync(join(ancestor, "fresh"));
		writeFileSync(file, "x");

		expect(() => createMissingGrantDirectories(join(file, "app"))).toThrow(
			/not a directory/,
		);
		expect(existsSync(join(ancestor, "fresh"))).toBe(true);
		expect(existsSync(file)).toBe(true);
		expect(existsSync(join(file, "app"))).toBe(false);
	});

	it("removes a parent it just created when a later component cannot be created", () => {
		const ancestor = scratch();
		const leaf = join(ancestor, "fresh", "a".repeat(256));

		expect(() => createMissingGrantDirectories(leaf)).toThrow();
		expect(existsSync(join(ancestor, "fresh"))).toBe(false);
		expect(existsSync(ancestor)).toBe(true);
	});
});
