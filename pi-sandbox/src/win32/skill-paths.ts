import { fileURLToPath } from "node:url";

/** Absolute path of the diagnostic skill directory. A relative path will not work: pi resolves
 *  paths returned by `resources_discover` against the **session cwd**
 *  (`resolveResourcePath(p) = resolvePath(p, cwd)`); `baseDir` is only a source label. See the
 *  real-machine evidence in spec §4.10.
 *  The skill must live in the non-conventional directory `resources/skills/` (otherwise pi's
 *  package auto-discovery loads it on every platform, spec §4.10). */
const ACL_SKILL_DIR = fileURLToPath(new URL("../../resources/skills/diagnose-windows-sandbox-acl", import.meta.url));

/**
 * Platform gate for the diagnostic skill (spec Ruling 9): hand the skill directory to pi
 * only on Windows. Return **additional** paths, never a complete set. pi merges
 * (`mergePaths(lastSkillPaths, …)` in `resource-loader.js`): an empty array adds nothing
 * and does not wipe the default skill directory or skills contributed by other extensions.
 */
export function aclSkillPaths(platform: string = process.platform): string[] {
	return platform === "win32" ? [ACL_SKILL_DIR] : [];
}
