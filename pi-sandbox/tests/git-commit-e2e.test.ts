import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "../src/config";
import { isWithinRoots } from "../src/fence";
import { canonicalPath } from "../src/policy";
import { createPermissionState } from "../src/permission";
import { createSandboxTools } from "../src/tools";

/**
 * End-to-end proof for the git-managed subdirectory spec: a real `git commit` from a workspace
 * inside a repository (and inside a linked worktree) really lands through the sandbox.
 * Needs a working bwrap and git; skipped otherwise (the unit suite covers detection without them).
 *
 * The repository is created under the test process's cwd (the same place the e2e-denied marker
 * uses), never under /tmp: bwrap rw-binds /tmp on every workspace-write run, so a repository
 * there would commit through that grant and prove nothing about the git-root widening — the
 * switch on and off would look identical.
 */
const usable =
	process.platform === "linux" &&
	(() => {
		try {
			return (
				spawnSync("git", ["--version"]).status === 0 &&
				spawnSync("bwrap", [
					"--ro-bind",
					"/",
					"/",
					"--dev",
					"/dev",
					"--unshare-pid",
					"--proc",
					"/proc",
					"--die-with-parent",
					"--",
					"true",
				]).status === 0
			);
		} catch {
			return false;
		}
	})();

let dir: string;

/** The paired contrast is meaningless when the repository must live under /tmp (see the header): bwrap's always-rw /tmp grant would mask the switch. */
const cwdUnderTmp = isWithinRoots(canonicalPath(process.cwd()), ["/tmp"]);

beforeEach(() => {
	dir = mkdtempSync(join(process.cwd(), "git-e2e-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function makeDeps(cwd: string, config: SandboxConfig = DEFAULT_SANDBOX_CONFIG) {
	return {
		cwd,
		platform: "linux" as const,
		getConfig: () => config,
		permission: createPermissionState(),
		selected: { runner: "bwrap" as const, enforcement: "full" as const },
	};
}

const ctx = {
	hasUI: true,
	sessionManager: {
		getSessionId: () => "e2e-session",
		getSessionFile: () => undefined,
	},
	ui: {
		select: vi.fn(async () => "Allow once"),
		input: vi.fn(async () => undefined),
		notify: vi.fn(),
	},
} as never;

function runGit(args: readonly string[], cwd?: string): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	expect(result.status, result.stderr ?? "").toBe(0);
}

const COMMIT = "git add . && git -c user.name=e2e -c user.email=e2e@example.com commit -q -m e2e-commit";

it.skipIf(!usable)(
	"git add + git commit from a git-managed subdirectory succeeds inside the sandbox",
	async () => {
		const repo = join(dir, "repo");
		runGit(["init", "-q", "-b", "main", repo]);
		const ws = join(repo, "a", "b");
		mkdirSync(ws, { recursive: true });
		writeFileSync(join(ws, "hello.txt"), "hello\n");
		const { bash } = createSandboxTools(makeDeps(ws) as never);
		await bash.execute("e2e-1", { command: COMMIT }, undefined, undefined, ctx);
		const log = spawnSync("git", ["-C", repo, "log", "--oneline"], {
			encoding: "utf8",
		});
		expect(log.stdout).toContain("e2e-commit");
	},
	60_000,
);

it.skipIf(!usable || cwdUnderTmp)(
	"includeGitRoot: false keeps .git closed: the same repository and command commit only with the switch on (skipped when the cwd is under /tmp, where the tmp grant masks it)",
	async () => {
		const repo = join(dir, "repo");
		runGit(["init", "-q", "-b", "main", repo]);
		const ws = join(repo, "a", "b");
		mkdirSync(ws, { recursive: true });
		writeFileSync(join(ws, "hello.txt"), "hello\n");
		// Off: git cannot write .git, so no commit lands. The assertion is the history, not the call not throwing.
		const off = makeDeps(ws, {
			...DEFAULT_SANDBOX_CONFIG,
			includeGitRoot: false,
		});
		const { bash } = createSandboxTools(off as never);
		try {
			await bash.execute("e2e-1-off", { command: COMMIT }, undefined, undefined, ctx);
		} catch {
			// a denied write may surface as an error result; the history below is the assertion
		}
		const denied = spawnSync("git", ["-C", repo, "log", "--oneline"], {
			encoding: "utf8",
		});
		expect(denied.stdout).not.toContain("e2e-commit");
		// On (the default): the same repository and the same command land — the pair proves the switch, not the environment.
		const on = makeDeps(ws);
		const { bash: onBash } = createSandboxTools(on as never);
		await onBash.execute("e2e-1-on", { command: COMMIT }, undefined, undefined, ctx);
		const landed = spawnSync("git", ["-C", repo, "log", "--oneline"], {
			encoding: "utf8",
		});
		expect(landed.stdout).toContain("e2e-commit");
	},
	60_000,
);

it.skipIf(!usable)(
	"git commit from a linked worktree subdirectory succeeds inside the sandbox",
	async () => {
		const main = join(dir, "main");
		runGit(["init", "-q", "-b", "main", main]);
		runGit(
			[
				"-c",
				"user.name=e2e",
				"-c",
				"user.email=e2e@example.com",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"init",
			],
			main,
		);
		const worktree = join(dir, "wt");
		runGit(["worktree", "add", "-q", "-b", "wt", worktree], main);
		const ws = join(worktree, "sub");
		mkdirSync(ws, { recursive: true });
		writeFileSync(join(ws, "w.txt"), "w\n");
		const { bash } = createSandboxTools(makeDeps(ws) as never);
		await bash.execute("e2e-2", { command: COMMIT }, undefined, undefined, ctx);
		const log = spawnSync("git", ["-C", worktree, "log", "--oneline"], {
			encoding: "utf8",
		});
		expect(log.stdout).toContain("e2e-commit");
	},
	60_000,
);

it.skipIf(!usable)(
	"the sandbox is really enforcing (self-check: a host-writable path outside the writable roots is denied)",
	async () => {
		// The marker sits in the repo working tree: the raw process can write it (proven below),
		// but the sandboxed bash runs with a /tmp workspace and must not.
		const marker = join(process.cwd(), `.pi-e2e-denied-${process.pid}`);
		// The workspace must live outside every git repository (a tmpdir scratch, cleaned up below):
		// under `dir` it would sit inside this very checkout, and the git-root widening would then
		// legitimately open the marker path — this case is about the fence, not about git.
		const ws = mkdtempSync(join(tmpdir(), "git-e2e-ws-"));
		try {
			writeFileSync(marker, "host-writable\n"); // self-check: the host really allows this path
			rmSync(marker, { force: true });
			const { bash } = createSandboxTools(makeDeps(ws) as never);
			try {
				await bash.execute(
					"e2e-3",
					{ command: `echo x > ${marker}` },
					undefined,
					undefined,
					ctx,
				);
			} catch {
				// a denied write may surface as an error result; the file state is the assertion
			}
			expect(existsSync(marker)).toBe(false);
			// Self-check: the same write lands under danger-full-access, proving the tool path is real.
			const deps = makeDeps(ws);
			deps.permission.override = "danger-full-access";
			const { bash: full } = createSandboxTools(deps as never);
			await full.execute(
				"e2e-4",
				{ command: `echo x > ${marker}` },
				undefined,
				undefined,
				ctx,
			);
			expect(existsSync(marker)).toBe(true);
		} finally {
			rmSync(marker, { force: true });
			rmSync(ws, { recursive: true, force: true });
		}
	},
	60_000,
);
