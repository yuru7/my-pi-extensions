/**
 * End-to-end check of the title restore at process exit.
 *
 * A child process replays the real quit sequence, including `process.exit()`,
 * so the assertions cover the ordering that a unit test cannot: Pi's title
 * write after `session_shutdown`, then the extension's exit-time clear.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(
	new URL("./fixtures/exit-restore-fixture.ts", import.meta.url),
);

/** Every terminal title write in the child's stdout, in order. */
function titleWrites(stdout: string): string[] {
	const prefix = "\x1b]0;";
	const terminator = "\x07";
	const titles: string[] = [];
	let cursor = 0;
	for (;;) {
		const start = stdout.indexOf(prefix, cursor);
		if (start === -1) return titles;
		const body = start + prefix.length;
		const end = stdout.indexOf(terminator, body);
		if (end === -1) return titles;
		titles.push(stdout.slice(body, end));
		cursor = end + terminator.length;
	}
}

describe("title restore at process exit", () => {
	test("the empty title survives Pi's shutdown write", () => {
		const result = spawnSync(process.execPath, [FIXTURE], {
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		const titles = titleWrites(result.stdout);
		// The startup title, the quit restore, Pi's `π - web-app` write after
		// `session_shutdown`, and the exit-time clear that must win.
		assert.deepEqual(titles, ["Pi - web-app", "", "π - web-app", ""]);
	});
});
