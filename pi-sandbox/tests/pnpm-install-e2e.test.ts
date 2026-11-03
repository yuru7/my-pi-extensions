import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSandboxConfig } from "../src/config";
import { isWithinRoots } from "../src/fence";
import { createPermissionState } from "../src/permission";
import { canonicalPath, defaultTmpRoots } from "../src/policy";
import {
	resetRunnerCache,
	runnerInvocation,
	selectRunner,
} from "../src/runners";
import { createSandboxTools } from "../src/tools";

// The store and the unrelated path must not be covered by the workspace or the
// implicit temporary-directory grant. Use siblings under a private fixture dir.
resetRunnerCache();
const selected = selectRunner(5000);
const skipReason = (() => {
	if (process.platform === "win32")
		return "confined bash is unavailable on Windows";
	if (selected.runner === "unavailable") return "no usable sandbox runner";
	if (isWithinRoots(canonicalPath(process.cwd()), defaultTmpRoots()))
		return "cwd is under an implicitly writable temporary root";
	if (spawnSync("pnpm", ["--version"], { stdio: "ignore" }).status !== 0)
		return "pnpm is unavailable";
	if (spawnSync("tar", ["--version"], { stdio: "ignore" }).status !== 0)
		return "tar is unavailable";
	const argv = runnerInvocation(selected, {
		mode: "read-only",
		workspaceRoot: process.cwd(),
	});
	if (
		spawnSync(argv[0], [...argv.slice(1), "--", "true"], {
			stdio: "ignore",
			timeout: 5000,
		}).status !== 0
	)
		return `selected runner ${selected.runner} cannot execute`;
	return undefined;
})();

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

describe.skipIf(skipReason !== undefined)(
	`pnpm install through real sandbox (${skipReason ?? selected.runner})`,
	() => {
		let fixture: string;
		let workspace: string;
		let store: string;
		let other: string;

		beforeAll(() => {
			fixture = mkdtempSync(join(process.cwd(), "pnpm-install-e2e-"));
			workspace = join(fixture, "workspace");
			store = join(fixture, "store");
			other = join(fixture, "other");
			const pkg = join(fixture, "package");
			for (const dir of [
				workspace,
				store,
				other,
				pkg,
				join(workspace, ".pi"),
				join(workspace, "home"),
				join(workspace, "runtime"),
			])
				mkdirSync(dir, { recursive: true });
			// Establish that the unrelated directory is host-writable before testing confinement.
			writeFileSync(join(other, "host-check"), "ok\n");
			rmSync(join(other, "host-check"));
			writeFileSync(
				join(pkg, "package.json"),
				JSON.stringify({
					name: "sandbox-local-e2e",
					version: "1.0.0",
					main: "index.js",
				}),
			);
			writeFileSync(join(pkg, "index.js"), "module.exports = 42;\n");
			const tar = spawnSync(
				"tar",
				["-czf", join(workspace, "package.tgz"), "-C", fixture, "package"],
				{ encoding: "utf8" },
			);
			expect(tar.status, tar.stderr).toBe(0);
			writeFileSync(
				join(workspace, "package.json"),
				JSON.stringify({
					name: "sandbox-pnpm-e2e",
					version: "1.0.0",
					private: true,
					dependencies: { "sandbox-local-e2e": "file:package.tgz" },
				}),
			);
		});

		afterAll(() => {
			if (fixture) rmSync(fixture, { recursive: true, force: true });
		});

		it("only grants the configured store in workspace-write mode", async () => {
			const ctx = {
				cwd: workspace,
				hasUI: false,
				isProjectTrusted: () => true,
				sessionManager: {
					getSessionId: () => "pnpm-e2e",
					getSessionFile: () => undefined,
				},
			} as never;
			const configFile = join(workspace, ".pi", "pi-sandbox.json");
			const run = async (
				mode: "read-only" | "workspace-write",
				roots: string[],
				command: string,
			) => {
				writeFileSync(
					configFile,
					JSON.stringify({
						mode,
						includeGitRoot: false,
						extraWritableRoots: roots,
					}),
				);
				const config = loadSandboxConfig(
					workspace,
					join(fixture, "empty-agent"),
				);
				const { bash } = createSandboxTools({
					cwd: workspace,
					getConfig: () => config,
					permission: createPermissionState(),
					selected,
				});
				return bash.execute(
					"pnpm-e2e",
					{ command, timeout: 110 },
					undefined,
					undefined,
					ctx,
				);
			};
			const home = join(workspace, "home");
			const runtime = join(workspace, "runtime");
			const install = [
				`HOME=${quote(home)}`,
				`XDG_CONFIG_HOME=${quote(join(home, "config"))}`,
				`XDG_DATA_HOME=${quote(join(home, "data"))}`,
				`XDG_CACHE_HOME=${quote(join(home, "cache"))}`,
				`XDG_RUNTIME_DIR=${quote(runtime)}`,
				`TMPDIR=${quote(runtime)}`,
				"npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null npm_config_fetch_retries=0",
				`pnpm install --offline --ignore-scripts --no-frozen-lockfile --reporter append-only --store-dir ${quote(store)}`,
			].join(" ");
			const text = (result: Awaited<ReturnType<typeof run>>) =>
				result.content
					.map((part) => (part.type === "text" ? part.text : ""))
					.join("\n");

			// The read-only case must not silently turn the configured root into a grant.
			const readOnly = await run("read-only", [store], install);
			expect(readOnly.isError, text(readOnly)).toBe(true);
			expect(readdirSync(store)).toEqual([]);
			const roWrite = await run(
				"read-only",
				[store],
				`echo denied > ${quote(join(store, "ro-marker"))}`,
			);
			expect(roWrite.isError, text(roWrite)).toBe(true);
			expect(existsSync(join(store, "ro-marker"))).toBe(false);

			const denied = await run("workspace-write", [], install);
			expect(denied.isError, text(denied)).toBe(true);
			expect(text(denied)).toMatch(
				/EACCES|EPERM|EROFS|permission denied|read-only file system/i,
			);
			expect(text(denied)).toContain(store);
			expect(readdirSync(store)).toEqual([]);
			expect(
				existsSync(
					join(workspace, "node_modules", "sandbox-local-e2e", "index.js"),
				),
			).toBe(false);

			const allowed = await run("workspace-write", [store], install);
			expect(allowed.isError, text(allowed)).not.toBe(true);
			expect(
				readFileSync(
					join(workspace, "node_modules", "sandbox-local-e2e", "index.js"),
					"utf8",
				),
			).toBe("module.exports = 42;\n");
			expect(readdirSync(store).length).toBeGreaterThan(0);

			const otherMarker = join(other, "denied");
			const otherDenied = await run(
				"workspace-write",
				[store],
				`echo denied > ${quote(otherMarker)}`,
			);
			expect(otherDenied.isError, text(otherDenied)).toBe(true);
			expect(text(otherDenied)).toMatch(
				/permission denied|read-only file system/i,
			);
			expect(existsSync(otherMarker)).toBe(false);
		}, 180_000);
	},
);
