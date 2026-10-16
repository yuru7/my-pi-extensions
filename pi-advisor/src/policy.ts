import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DisabledForModelsEntry } from "./config.ts";
import { EFFORT_ORDINAL, type GradedEffort } from "./messages.ts";
import { canonicalModelKey, modelKey } from "./model-key.ts";

let disabledForModelsCache: DisabledForModelsEntry[] = [];

export function setDisabledForModels(models: DisabledForModelsEntry[]): void {
	disabledForModelsCache = models;
}

export function isModelBlocked(model: Model<Api> | undefined, thinkingLevel?: string): boolean {
	if (!model) return false;
	const key = modelKey(model);
	for (const entry of disabledForModelsCache) {
		if (typeof entry === "string") {
			if (canonicalModelKey(entry) === key) return true;
			continue;
		}
		if (canonicalModelKey(entry.model) !== key) continue;
		if (entry.minEffort === undefined) return true;
		const thresholdOrdinal = EFFORT_ORDINAL.indexOf(entry.minEffort);
		if (thresholdOrdinal === -1) continue;
		const executorOrdinal = EFFORT_ORDINAL.indexOf(thinkingLevel as GradedEffort);
		if (executorOrdinal >= thresholdOrdinal) return true;
	}
	return false;
}

export function isExecutorBlocked(ctx: ExtensionContext, thinkingLevel?: string): boolean {
	return isModelBlocked(ctx.model, thinkingLevel);
}
