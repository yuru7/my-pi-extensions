import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAdvisorSettings } from "./config.ts";
import { reconcileAdvisorTool } from "./handlers.ts";
import { ADVISOR_TOOL_NAME, errModelUnavailable, msgAdvisorRestored, msgAdvisorRestoredInactive } from "./messages.ts";
import { modelKey, parseModelKey } from "./model-key.ts";
import { isExecutorBlocked, setDisabledForModels } from "./policy.ts";
import { setAdvisorEffort, setAdvisorModel } from "./state.ts";

let restoreAnnounced = false;

export function __resetAdvisorAnnounced(): void {
	restoreAnnounced = false;
}

export function restoreAdvisorState(ctx: ExtensionContext, pi: ExtensionAPI): void {
	const config = loadAdvisorSettings();
	setDisabledForModels(config.disabledForModels);

	const deactivate = (): void => {
		setAdvisorModel(undefined);
		setAdvisorEffort(undefined);
		reconcileAdvisorTool(pi, ctx, { blocked: true });
	};

	if (!config.model) {
		deactivate();
		return;
	}

	const parsed = parseModelKey(config.model);
	if (!parsed) {
		deactivate();
		return;
	}

	const notifyOnce = (message: string, level: "info" | "warning" | "error"): void => {
		if (!ctx.hasUI || restoreAnnounced) return;
		ctx.ui.notify(message, level);
		restoreAnnounced = true;
	};

	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		deactivate();
		notifyOnce(errModelUnavailable(config.model), "warning");
		return;
	}

	setAdvisorModel(model);
	setAdvisorEffort(config.effort);

	if (isExecutorBlocked(ctx, pi.getThinkingLevel())) {
		reconcileAdvisorTool(pi, ctx, { blocked: true });
		notifyOnce(msgAdvisorRestoredInactive(modelKey(model), config.effort), "info");
		return;
	}

	const active = pi.getActiveTools();
	if (!active.includes(ADVISOR_TOOL_NAME)) {
		pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
	}
	notifyOnce(msgAdvisorRestored(modelKey(model), config.effort), "info");
}

export function registerAdvisorSessionStart(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		restoreAdvisorState(ctx, pi);
	});
}
