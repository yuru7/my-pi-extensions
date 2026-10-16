/**
 * Locate `completeSimple` on the host Pi.
 *
 * Pi >= 0.80.1 exports it from `@earendil-works/pi-ai/compat`. Older hosts
 * export it from the package root and have no `/compat` subpath. The host's
 * copy is a peer dependency, so both paths are dynamic imports. `/compat` is
 * the first try; the root import runs only when the subpath cannot be resolved.
 *
 * Prefer `ModelRegistry`'s runtime `completeSimple` when it exists. That path
 * applies credential-derived request fields (for example an OAuth base URL).
 * The method is bound because it uses `this`.
 */

import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export type CompleteSimpleFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

const MODULE_NOT_FOUND_CODES = new Set(["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

let testCompleteSimple: CompleteSimpleFn | undefined;

export function __setCompleteSimpleForTests(fn: CompleteSimpleFn | undefined): void {
	testCompleteSimple = fn;
}

export function getRuntimeCompleteSimple(modelRegistry: unknown): CompleteSimpleFn | undefined {
	try {
		if (modelRegistry === null || typeof modelRegistry !== "object") return undefined;
		const runtime = (modelRegistry as { runtime?: unknown }).runtime;
		if (runtime === null || typeof runtime !== "object") return undefined;
		const completeSimple = (runtime as { completeSimple?: unknown }).completeSimple;
		return typeof completeSimple === "function" ? (completeSimple.bind(runtime) as CompleteSimpleFn) : undefined;
	} catch {
		return undefined;
	}
}

function isModuleNotFound(err: unknown): boolean {
	for (let current: unknown = err, depth = 0; current != null && depth < 16; depth++) {
		if (typeof current === "object" && MODULE_NOT_FOUND_CODES.has((current as { code?: unknown }).code as string)) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

export async function loadCompleteSimple(): Promise<CompleteSimpleFn> {
	if (testCompleteSimple) return testCompleteSimple;

	let mod: { completeSimple?: CompleteSimpleFn };
	try {
		mod = (await import("@earendil-works/pi-ai/compat")) as { completeSimple?: CompleteSimpleFn };
	} catch (err) {
		if (!isModuleNotFound(err)) throw err;
		mod = (await import("@earendil-works/pi-ai")) as { completeSimple?: CompleteSimpleFn };
	}
	const completeSimple = mod.completeSimple;
	if (typeof completeSimple !== "function") {
		throw new Error(
			"pi-ai does not expose completeSimple on /compat or the package root — unsupported host pi-ai version",
		);
	}
	return completeSimple;
}
