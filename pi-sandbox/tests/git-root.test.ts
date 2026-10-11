import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { gitWritableRoots, resetGitRootsForTests } from "../src/git-root";
import { canonicalPath } from "../src/policy";
import {
	bwrapProfileArgs,
	landlockProfileArgs,
	seatbeltProfileArgs,
	windowsAclRunnerArgv,
} from "../src/runners";

let dir: string;

beforeEach(() => {
	dir = canonicalPath(mkdtempSync(join(tmpdir(), "git-root-")));
	resetGitRootsForTests();
});
afterEach(() => {
	resetGitRootsForTests();
	rmSync(dir, { recursive: true, force: true });
});

it("returns the repository root (the layer holding .git) for a workspace inside it", () => {
	mkdirSync(join(dir, "repo", ".git"), { recursive: true });
	const ws = join(dir, "repo", "a", "b");
	mkdirSync(ws, { recursive: true });
	expect(gitWritableRoots(ws)).toEqual([join(dir, "repo")]);
});

it("returns nothing when the cwd is the repository root itself (already writable)", () => {
	const repo = join(dir, "repo");
	mkdirSync(join(repo, ".git"), { recursive: true });
	expect(gitWritableRoots(repo)).toEqual([]);
});

function runGit(args: readonly string[], cwd?: string): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	expect(result.status, result.stderr ?? "").toBe(0);
}

it("detects a real repository created by git init", () => {
	const repo = join(dir, "repo");
	runGit(["init", "-q", "-b", "main", repo]);
	const ws = join(repo, "a", "b");
	mkdirSync(ws, { recursive: true });
	expect(gitWritableRoots(ws)).toEqual([repo]);
});

it("detects a real linked worktree and adds its commondir", () => {
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
	const roots = gitWritableRoots(ws);
	expect(roots).toContain(worktree);
	expect(roots).toContain(join(main, ".git", "worktrees", "wt"));
	expect(roots).toContain(join(main, ".git")); // commondir: commits write objects/refs here
});

it("returns nothing when no ancestor holds .git", () => {
	const ws = join(dir, "plain", "sub");
	mkdirSync(ws, { recursive: true });
	expect(gitWritableRoots(ws)).toEqual([]);
});

it("follows the gitdir: pointer of a .git file (submodule-style)", () => {
	const sub = join(dir, "super", "sub");
	const gitDir = join(dir, "super", ".git", "modules", "sub");
	mkdirSync(join(sub, "inner"), { recursive: true });
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(join(sub, ".git"), `gitdir: ../.git/modules/sub\n`);
	expect(gitWritableRoots(join(sub, "inner"))).toEqual([sub, gitDir]);
});

it("follows the gitdir: pointer of a linked worktree and adds its commondir", () => {
	const worktree = join(dir, "main", "wt");
	const gitDir = join(dir, "main", ".git", "worktrees", "wt");
	const commonDir = join(dir, "main", ".git");
	mkdirSync(join(worktree, "inner"), { recursive: true });
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(gitDir, "commondir"), "../..\n");
	expect(gitWritableRoots(join(worktree, "inner"))).toEqual([
		worktree,
		gitDir,
		commonDir,
	]);
});

it("widen nothing when the .git file has no parseable gitdir: pointer (fail-closed)", () => {
	// An outer repository exists, but the walk must stop at the unparseable layer and never fall back to it.
	mkdirSync(join(dir, "outer", ".git"), { recursive: true });
	const ws = join(dir, "outer", "inner", "sub");
	mkdirSync(ws, { recursive: true });
	writeFileSync(join(dir, "outer", "inner", ".git"), "not a pointer\n");
	expect(gitWritableRoots(ws)).toEqual([]);
});

it("widens nothing when a gitdir: target is not an existing directory (broken pointer)", () => {
	const ws = join(dir, "repo", "sub");
	mkdirSync(ws, { recursive: true });
	writeFileSync(join(dir, "repo", ".git"), "gitdir: ../missing-gitdir\n");
	expect(gitWritableRoots(ws)).toEqual([]);
});

it.skipIf(process.getuid?.() === 0)(
	"an uninspectable .git stops the walk (no fallback to an outer repository)",
	() => {
		mkdirSync(join(dir, "outer", ".git"), { recursive: true });
		const inner = join(dir, "outer", "inner");
		const ws = join(inner, "sub");
		mkdirSync(ws, { recursive: true });
		writeFileSync(join(inner, ".git"), "gitdir: ../whatever\n");
		chmodSync(inner, 0o000); // statSync(inner/.git) now fails with EACCES
		try {
			expect(gitWritableRoots(ws)).toEqual([]);
		} finally {
			chmodSync(inner, 0o755);
		}
	},
);

it("reaches every confined runner's policy through the extraRoots channel", () => {
	const repo = join(dir, "repo");
	mkdirSync(join(repo, ".git"), { recursive: true });
	const ws = join(repo, "sub");
	mkdirSync(ws, { recursive: true });
	const policy = {
		mode: "workspace-write" as const,
		workspaceRoot: ws,
		extraRoots: gitWritableRoots(ws),
	};
	expect(bwrapProfileArgs(policy)).toEqual(expect.arrayContaining([repo]));
	expect(landlockProfileArgs(policy).join(" ")).toContain(repo);
	expect(seatbeltProfileArgs(policy).join(" ")).toContain(repo);
	expect(
		windowsAclRunnerArgv(policy, { node: "node", runner: "runner.js" }),
	).toEqual(expect.arrayContaining([repo]));
});

it("scans once per cwd: a later-created .git is not picked up (memoized)", () => {
	const ws = join(dir, "repo", "sub");
	mkdirSync(ws, { recursive: true });
	expect(gitWritableRoots(ws)).toEqual([]);
	mkdirSync(join(dir, "repo", ".git"), { recursive: true });
	expect(gitWritableRoots(ws)).toEqual([]);
});
