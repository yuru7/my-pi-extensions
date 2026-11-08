import { describe, expect, it } from "vitest";
import type { DenialRecord } from "../src/denial-ledger";
import { grantDirectoryForDenial } from "../src/fence";
import {
	denialPaths,
	deniedPaths,
	extractAbsolutePaths,
	grantCoversDenial,
} from "../src/grant-path";

const STORE = "/tmp/pnpmtest/store/v11/files/9c";

/** pnpm wraps the final error at the terminal width and prints the same path unwrapped on stdout. */
const WRAPPED_STDERR = `Error:   × installing dependencies
  ╰─▶ Failed to write cafs: Failed to create the parent directory at "/tmp/
      pnpmtest/store/v11/files/9c": Read-only file system (os error 30)
`;
const UNWRAPPED_STDOUT = `[WARN] GET [hidden] error (Failed to write cafs: Failed to create the parent directory at "${STORE}": Read-only file system (os error 30)) — 1
`;

function bashRecord(overrides: Partial<DenialRecord> = {}): DenialRecord {
	return {
		sessionId: "s",
		tool: "bash",
		fingerprint: "f",
		cwd: "/work",
		workspace: "/work",
		sandboxMode: "workspace-write",
		backend: "bwrap",
		target: "pnpm install",
		writablePaths: ["/work", "/tmp"],
		recordedAt: Date.now(),
		...overrides,
	};
}

describe("extractAbsolutePaths", () => {
	it("drops a quoted path that was wrapped across lines instead of guessing the join", () => {
		expect(extractAbsolutePaths(WRAPPED_STDERR)).toEqual([]);
	});

	it("reads the unwrapped copy from stdout", () => {
		expect(extractAbsolutePaths(UNWRAPPED_STDOUT)).toEqual([STORE]);
	});

	it("deduplicates a path matched by both the quoted and the bare pattern", () => {
		expect(extractAbsolutePaths(`"${STORE}" ${STORE}`)).toEqual([STORE]);
	});
});

describe("denialPaths", () => {
	it("prefers stderr when it has a usable path", () => {
		expect(
			denialPaths(
				'at "/tmp/real/a.txt": Read-only file system',
				'at "/tmp/other/b.txt": Read-only file system',
			),
		).toEqual(["/tmp/real/a.txt"]);
	});

	it("falls back to stdout when stderr only has the wrapped fragment", () => {
		expect(denialPaths(WRAPPED_STDERR, UNWRAPPED_STDOUT)).toEqual([STORE]);
	});

	it("falls back to stdout when stderr has no usable path at all", () => {
		expect(
			denialPaths(
				"EACCES: permission denied",
				'at "/tmp/real/a.txt": Read-only file system',
			),
		).toEqual(["/tmp/real/a.txt"]);
	});
});

describe("deniedPaths and grant coverage", () => {
	it("recovers the store path from stdout for a bash denial", () => {
		const record = bashRecord({
			stderr: WRAPPED_STDERR,
			stdout: UNWRAPPED_STDOUT,
		});
		expect(deniedPaths(record)).toEqual([STORE]);
		expect(grantCoversDenial("/tmp/pnpmtest/store/v11/files", record)).toBe(
			true,
		);
	});

	it("keeps the write/edit target as the only denied path", () => {
		const record = bashRecord({ tool: "write", target: "/work/notes.txt" });
		expect(deniedPaths(record)).toEqual(["/work/notes.txt"]);
	});
});

describe("grantDirectoryForDenial", () => {
	it("names the real containing directory when stderr wrapped the path", () => {
		expect(
			grantDirectoryForDenial(denialPaths(WRAPPED_STDERR, UNWRAPPED_STDOUT)),
		).toEqual({ grantDirectory: "/tmp/pnpmtest/store/v11/files" });
	});
});
