/**
 * pi-advisor — zero-argument `advisor` tool and `/pi-advisor` picker.
 *
 * The tool stays out of the active set until a model is selected, so its
 * description and guidelines are absent from the executor system prompt while
 * advisor is off. Settings live in Pi's agent directory as `pi-advisor.json`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisorCommand } from "../src/command.ts";
import {
	registerAdvisorBeforeAgentStart,
	registerModelSelectHandler,
	registerThinkingLevelSelectHandler,
} from "../src/handlers.ts";
import { registerAdvisorTool } from "../src/register.ts";
import { registerAdvisorSessionStart } from "../src/restore.ts";

export default function (pi: ExtensionAPI): void {
	registerAdvisorTool(pi);
	registerAdvisorCommand(pi);
	registerAdvisorBeforeAgentStart(pi);
	registerModelSelectHandler(pi);
	registerThinkingLevelSelectHandler(pi);
	registerAdvisorSessionStart(pi);
}
