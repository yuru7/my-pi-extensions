import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROW_INTENT_META, type SentinelKind } from "./row-intent.ts";

export const I18N_NAMESPACE = "pi-ask-user";

type ScopeFn = (key: string, fallback: string) => string;

const localesDir = join(dirname(fileURLToPath(import.meta.url)), "../../locales");

function localeCandidates(): string[] {
	const raw = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "en";
	const tag = raw.split(".")[0]?.replaceAll("_", "-") || "en";
	const language = tag.split("-")[0] ?? "en";
	return language === tag ? [tag, "en"] : [tag, language, "en"];
}

function readCatalog(code: string): Record<string, string> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(localesDir, `${code}.json`), "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const catalog: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string") catalog[key] = value;
		}
		return catalog;
	} catch {
		return undefined;
	}
}

function loadCatalog(): Record<string, string> {
	for (const code of localeCandidates()) {
		const catalog = readCatalog(code);
		if (catalog) return catalog;
	}
	return {};
}

const catalog = loadCatalog();

export const t: ScopeFn = (key, fallback) => catalog[key] ?? fallback;

export function displayLabel(kind: SentinelKind): string {
	return t(`sentinel.${kind}`, ROW_INTENT_META[kind].label);
}
