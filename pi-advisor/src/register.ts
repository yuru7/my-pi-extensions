import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";
import { loadAdvisorSettings } from "./config.ts";
import { executeAdvisor } from "./execute.ts";
import { ADVISOR_TOOL_NAME, TOOL_LABEL } from "./messages.ts";
import { resolveGuidance, STANDARD_DESCRIPTION } from "./prompt.ts";

const AdvisorParams = obj({}, { open: true });

export function registerAdvisorTool(pi: ExtensionAPI): void {
	const settings = loadAdvisorSettings();
	const guidance = resolveGuidance(settings.guidance, settings.promptMode);
	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: TOOL_LABEL,
		description: STANDARD_DESCRIPTION,
		promptSnippet: guidance.promptSnippet,
		promptGuidelines: guidance.promptGuidelines,
		parameters: AdvisorParams,
		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			return executeAdvisor(ctx, pi, signal, onUpdate);
		},
	});
}
