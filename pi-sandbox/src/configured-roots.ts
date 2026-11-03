import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type SandboxConfig, selectExtraWritableRoots } from "./config";
import type { SandboxMode } from "./policy";

/** Resolve configured roots at the point of use, never treating a missing path as a grant. */
export function configuredWritableRoots(
	config: SandboxConfig,
	mode: SandboxMode,
	projectTrusted: boolean | null,
	platform: string = process.platform,
): string[] {
	if (mode !== "workspace-write") return [];
	const raw = selectExtraWritableRoots(config, projectTrusted);
	if (raw.length > 0 && platform === "win32") {
		throw new Error("sandbox: extraWritableRoots is not supported on Windows; no configured roots were granted");
	}
	if (raw.length > 0 && (config.runnerCommand?.length ?? 0) > 0) {
		throw new Error("sandbox: extraWritableRoots is not supported with a custom runner");
	}
	const roots = [...new Set(raw.map((path: string) => {
		if (!isAbsolute(path) || path.includes("\0")) {
			throw new Error(`sandbox: extraWritableRoots requires an absolute path: ${path}`);
		}
		const absolute = resolve(path);
		try {
			const canonical = realpathSync.native(absolute);
			if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
			return canonical;
		} catch (error) {
			throw new Error(`sandbox: extraWritableRoots directory is unavailable: ${absolute}`, { cause: error });
		}
	}))];
	return roots;
}
