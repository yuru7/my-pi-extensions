import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { saveAdvisorSelection } from "./config.ts";
import { reconcileAdvisorTool } from "./handlers.ts";
import {
	ADVISOR_TOOL_NAME,
	CHECKMARK,
	DEFAULT_EFFORT,
	errSelectionNotFound,
	type GradedEffort,
	isGradedEffort,
	MSG_ADVISOR_DISABLED,
	MSG_EFFORT_NOT_SET,
	MSG_PERSIST_FAILED,
	MSG_REQUIRES_INTERACTIVE,
	msgAdvisorEnabled,
	msgAdvisorEnabledInactive,
	NO_ADVISOR_VALUE,
	OFF_VALUE,
	RECOMMENDED_EFFORT_SUFFIX,
} from "./messages.ts";
import { modelKey } from "./model-key.ts";
import { isExecutorBlocked } from "./policy.ts";
import { getAdvisorEffort, getAdvisorModel, setAdvisorEffort, setAdvisorModel } from "./state.ts";
import { showAdvisorPicker, showEffortPicker } from "./ui.ts";

export function buildModelItems(availableModels: Model<Api>[], currentKey: string | undefined): SelectItem[] {
	const items: SelectItem[] = availableModels.map((model) => {
		const key = modelKey(model);
		const check = key === currentKey ? CHECKMARK : "";
		return { value: key, label: `${model.name}  (${model.provider})${check}` };
	});
	items.push({
		value: NO_ADVISOR_VALUE,
		label: currentKey === undefined ? `No advisor${CHECKMARK}` : "No advisor",
	});
	return items;
}

export function buildEffortItems(picked: Model<Api>): SelectItem[] {
	const levels = getSupportedThinkingLevels(picked).filter((level): level is GradedEffort => isGradedEffort(level));
	return [
		{ value: OFF_VALUE, label: "off (no reasoning sent)" },
		...levels.map((level) => ({
			value: level,
			label: level === DEFAULT_EFFORT ? `${level}${RECOMMENDED_EFFORT_SUFFIX}` : level,
		})),
	];
}

export function applyDisable(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!saveAdvisorSelection(undefined, undefined)) {
		ctx.ui.notify(MSG_PERSIST_FAILED, "error");
		return;
	}
	setAdvisorModel(undefined);
	setAdvisorEffort(undefined);
	const active = pi.getActiveTools();
	if (active.includes(ADVISOR_TOOL_NAME)) {
		pi.setActiveTools(active.filter((name) => name !== ADVISOR_TOOL_NAME));
	}
	ctx.ui.notify(MSG_ADVISOR_DISABLED, "info");
}

export function applyEnable(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	picked: Model<Api>,
	effort: GradedEffort | undefined,
): void {
	if (!saveAdvisorSelection(modelKey(picked), effort)) {
		ctx.ui.notify(MSG_PERSIST_FAILED, "error");
		return;
	}
	setAdvisorEffort(effort);
	setAdvisorModel(picked);
	const blocked = isExecutorBlocked(ctx, pi.getThinkingLevel());
	reconcileAdvisorTool(pi, ctx, { blocked });
	ctx.ui.notify(
		blocked ? msgAdvisorEnabledInactive(modelKey(picked), effort) : msgAdvisorEnabled(modelKey(picked), effort),
		"info",
	);
}

export function registerAdvisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("advisor", {
		description: "Configure the advisor model for the advisor-strategy pattern",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
				return;
			}

			const availableModels = ctx.modelRegistry.getAvailable();
			const current = getAdvisorModel();
			const currentKey = current ? modelKey(current) : undefined;
			const choice = await showAdvisorPicker(ctx, buildModelItems(availableModels, currentKey));
			if (!choice) return;

			if (choice === NO_ADVISOR_VALUE) {
				applyDisable(pi, ctx);
				return;
			}

			const picked = availableModels.find((model) => modelKey(model) === choice);
			if (!picked) {
				ctx.ui.notify(errSelectionNotFound(choice), "error");
				return;
			}

			let effortChoice: GradedEffort | undefined;
			if (picked.reasoning) {
				const effortResult = await showEffortPicker(ctx, buildEffortItems(picked), getAdvisorEffort(), DEFAULT_EFFORT);
				if (!effortResult) {
					ctx.ui.notify(MSG_EFFORT_NOT_SET, "info");
				} else if (effortResult !== OFF_VALUE && isGradedEffort(effortResult)) {
					effortChoice = effortResult;
				}
			}

			applyEnable(pi, ctx, picked, effortChoice);
		},
	});
}
