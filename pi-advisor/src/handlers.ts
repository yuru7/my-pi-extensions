import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ADVISOR_TOOL_NAME, MSG_ADVISOR_DISABLED, msgAdvisorRestored } from "./messages.ts";
import { modelKey } from "./model-key.ts";
import { isExecutorBlocked, isModelBlocked } from "./policy.ts";
import { getAdvisorEffort, getAdvisorModel } from "./state.ts";

export interface ReconcileNotify {
	disabled: string;
	restored: string;
}

export function reconcileAdvisorTool(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: { blocked: boolean; notify?: ReconcileNotify },
): void {
	const active = pi.getActiveTools();
	const hasTool = active.includes(ADVISOR_TOOL_NAME);
	if (opts.blocked && hasTool) {
		pi.setActiveTools(active.filter((name) => name !== ADVISOR_TOOL_NAME));
		if (opts.notify && ctx.hasUI) ctx.ui.notify(opts.notify.disabled, "info");
	} else if (!opts.blocked && !hasTool) {
		pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
		if (opts.notify && ctx.hasUI) ctx.ui.notify(opts.notify.restored, "info");
	}
}

export function registerAdvisorBeforeAgentStart(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		const blocked = !getAdvisorModel() || isExecutorBlocked(ctx, pi.getThinkingLevel());
		reconcileAdvisorTool(pi, ctx, { blocked });
	});
}

export function registerModelSelectHandler(pi: ExtensionAPI): void {
	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore") return;
		const advisor = getAdvisorModel();
		if (!advisor) return;
		reconcileAdvisorTool(pi, ctx, {
			blocked: isModelBlocked(event.model, pi.getThinkingLevel()),
			notify: {
				disabled: `Advisor disabled for ${modelKey(event.model)}`,
				restored: msgAdvisorRestored(modelKey(advisor), getAdvisorEffort()),
			},
		});
	});
}

export function registerThinkingLevelSelectHandler(pi: ExtensionAPI): void {
	pi.on("thinking_level_select", async (event, ctx) => {
		const advisor = getAdvisorModel();
		if (!advisor) return;
		const model = ctx.model;
		reconcileAdvisorTool(pi, ctx, {
			blocked: isModelBlocked(model, event.level),
			notify: {
				disabled: model ? `Advisor disabled for ${modelKey(model)}` : MSG_ADVISOR_DISABLED,
				restored: msgAdvisorRestored(modelKey(advisor), getAdvisorEffort()),
			},
		});
	});
}
