import { lstatSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
	dirname,
	isAbsolute,
	join,
	parse,
	resolve as resolvePath,
} from "node:path";
import type { DenialRecord } from "./denial-ledger";
import { canonicalizeTarget, grantTooWide, isWithinRoots } from "./fence";
import { canonicalPath } from "./policy";

export { grantTooWide };

const QUOTED_ABSOLUTE = /['"]((?:\/|[A-Za-z]:[\\/])[^'"]+)['"]/g;
const BARE_ABSOLUTE = /(?:^|[\s(])((?:\/|[A-Za-z]:[\\/])[^\s:'"]+)/g;

/** `~` 与 `~/...` 展开后再按 cwd 解析相对路径。模型拿到的是原始参数，宿主不会先替这个工具展开。 */
export function resolveGrantRequest(raw: string, cwd: string): string {
	const trimmed = raw.trim();
	let expanded = trimmed;
	if (trimmed === "~") expanded = homedir();
	else if (trimmed.startsWith("~/") || trimmed.startsWith("~\\"))
		expanded = join(homedir(), trimmed.slice(2));
	return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

/**
 * 批准前确认这条路径能成为目录：已存在则必须是目录（跟随 symlink）；
 * 尚不存在则最近的已存在祖先必须是目录，否则 mkdir 会落在文件上。
 */
export function assertCanCreateDirectory(path: string): void {
	let current = path;
	for (;;) {
		try {
			if (!statSync(current).isDirectory()) {
				throw new Error(`sandbox_grant_write path is not a directory: ${path}`);
			}
			return;
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.startsWith("sandbox_grant_write")
			)
				throw error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			let listed: ReturnType<typeof lstatSync> | undefined;
			try {
				listed = lstatSync(current);
			} catch {
				listed = undefined;
			}
			if (
				listed !== undefined &&
				!listed.isSymbolicLink() &&
				!listed.isDirectory()
			) {
				throw new Error(`sandbox_grant_write path is not a directory: ${path}`);
			}
			const parent = dirname(current);
			if (parent === current)
				throw new Error(`sandbox_grant_write path is not a directory: ${path}`);
			current = parent;
		}
	}
}

/**
 * 逐级创建尚不存在的目录，只返回这次真正新建的那些（含中途新建的父目录）。
 * 已存在的目录记成 EEXIST，不算我们造的。中途失败时把刚建的空目录收回，不留半截。
 */
export function createMissingGrantDirectories(directory: string): string[] {
	const created: string[] = [];
	const { root } = parse(directory);
	const segments = directory
		.slice(root.length)
		.split(/[\\/]+/u)
		.filter((segment) => segment.length > 0);
	let current = root;
	try {
		for (const segment of segments) {
			current = join(current, segment);
			try {
				mkdirSync(current);
				created.push(canonicalPath(current));
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") throw error;
				if (!statSync(current).isDirectory()) {
					throw new Error(
						`sandbox_grant_write path is not a directory: ${directory}`,
					);
				}
			}
		}
	} catch (error) {
		removeEmptyCreatedDirectories(created);
		throw error;
	}
	return created;
}

/**
 * 权限收回时删掉仍为空的新建目录。深的先删，这样子目录被删光后变空的父目录也会跟着消失。
 * 非空、符号链接、`/` 与家目录一律留下。rmdir 本身不会删除里面的东西。
 */
export function removeEmptyCreatedDirectories(
	created: readonly string[],
): void {
	const unique = [...new Set(created.filter((path) => path.length > 0))].sort(
		(a, b) => segmentCount(b) - segmentCount(a) || b.length - a.length,
	);
	for (const dir of unique) {
		if (grantTooWide(dir)) continue;
		try {
			if (!lstatSync(dir).isDirectory()) continue;
			rmdirSync(dir);
		} catch {
			// 非空、已消失、或没有权限：留在原地。
		}
	}
}

function segmentCount(path: string): number {
	return path.split(/[\\/]+/u).filter((segment) => segment.length > 0).length;
}

/** 从拒绝文本里抽出绝对路径。命令文本不参与：那是模型写的，不能当拒绝证据。 */
export function extractAbsolutePaths(text: string): string[] {
	const found: string[] = [];
	for (const pattern of [QUOTED_ABSOLUTE, BARE_ABSOLUTE]) {
		pattern.lastIndex = 0;
		for (;;) {
			const match = pattern.exec(text);
			if (match === null) break;
			const path = match[1]?.replace(/[),.;]+$/u, "") ?? "";
			if (path.length > 1) found.push(path);
		}
	}
	return found;
}

/** write/edit 的 target 就是被拒路径；shell 只认 stderr / error 里出现的绝对路径。 */
export function deniedPaths(record: DenialRecord): string[] {
	if (record.tool === "write" || record.tool === "edit") {
		return record.target.trim().length > 0 ? [record.target] : [];
	}
	return extractAbsolutePaths(`${record.stderr ?? ""}\n${record.error ?? ""}`);
}

/** 请求目录盖住了这条拒绝里的至少一个路径（canonical 后）。 */
export function grantCoversDenial(
	grantPath: string,
	record: DenialRecord,
): boolean {
	return deniedPaths(record).some((path) =>
		isWithinRoots(canonicalizeTarget(path), [grantPath]),
	);
}
