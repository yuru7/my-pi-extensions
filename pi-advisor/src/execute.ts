/**
 * Advisor side call. The executor branch is forwarded with an empty tool list.
 * A normal stop that contains no text is retried once. Abort, API error, and
 * thrown exceptions are not retried, and every failure is a normal tool result.
 */

import type {
	AssistantMessage,
	Message,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadAdvisorSettings } from "./config.ts";
import { ensureUserTailForAdvisor, stripInflightAdvisorCall, stripToolDeclarations } from "./context.ts";
import { getInventoryMessage } from "./inventory.ts";
import {
	ERR_ABORTED_DETAIL,
	ERR_CALL_ABORTED,
	ERR_EMPTY_RESPONSE,
	ERR_EMPTY_RESPONSE_DETAIL,
	ERR_NO_MODEL,
	ERR_NO_MODEL_SELECTED,
	errCallFailed,
	errCallThrew,
	errMisconfigured,
	errNoApiKey,
	errNoApiKeyDetail,
	type GradedEffort,
	msgConsulting,
} from "./messages.ts";
import { advisorModelLabel } from "./model-key.ts";
import { getRuntimeCompleteSimple, loadCompleteSimple } from "./pi-compat.ts";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.ts";
import { getAdvisorEffort, getAdvisorModel } from "./state.ts";

export interface AdvisorDetails {
	advisorModel?: string;
	effort?: GradedEffort;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

export function advisorTextFromResponse(response: AssistantMessage): string {
	return response.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function buildAdvisorResult(opts: {
	text: string;
	effort: GradedEffort | undefined;
	advisorLabel?: string;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}): AgentToolResult<AdvisorDetails> {
	const details: AdvisorDetails = { effort: opts.effort };
	if (opts.advisorLabel !== undefined) details.advisorModel = opts.advisorLabel;
	if (opts.usage !== undefined) details.usage = opts.usage;
	if (opts.stopReason !== undefined) details.stopReason = opts.stopReason;
	if (opts.errorMessage !== undefined) details.errorMessage = opts.errorMessage;
	return { content: [{ type: "text", text: opts.text }], details };
}

function buildErrorResult(
	advisorLabel: string | undefined,
	effort: GradedEffort | undefined,
	userText: string,
	errorMessage: string,
): AgentToolResult<AdvisorDetails> {
	return buildAdvisorResult({ text: userText, effort, advisorLabel, errorMessage });
}

function stopReasonEnvelope(
	response: AssistantMessage,
	effort: GradedEffort | undefined,
	advisorLabel: string,
): AgentToolResult<AdvisorDetails> | undefined {
	if (response.stopReason === "aborted") {
		return buildAdvisorResult({
			text: ERR_CALL_ABORTED,
			effort,
			advisorLabel,
			usage: response.usage,
			stopReason: response.stopReason,
			errorMessage: response.errorMessage ?? ERR_ABORTED_DETAIL,
		});
	}
	if (response.stopReason === "error") {
		return buildAdvisorResult({
			text: errCallFailed(response.errorMessage),
			effort,
			advisorLabel,
			usage: response.usage,
			stopReason: response.stopReason,
			errorMessage: response.errorMessage,
		});
	}
	return undefined;
}

export async function executeAdvisor(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	const effort = getAdvisorEffort();
	const advisor = getAdvisorModel();
	if (!advisor) {
		return buildErrorResult(undefined, effort, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
	}
	const advisorLabel = advisorModelLabel(advisor);

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
	if (!auth.ok) {
		return buildErrorResult(advisorLabel, effort, errMisconfigured(advisorLabel, auth.error), auth.error);
	}
	const runtimeCompleteSimple = getRuntimeCompleteSimple(ctx.modelRegistry);
	if (!auth.apiKey && !runtimeCompleteSimple) {
		return buildErrorResult(advisorLabel, effort, errNoApiKey(advisorLabel), errNoApiKeyDetail(advisor.provider));
	}

	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages = ensureUserTailForAdvisor(
		stripInflightAdvisorCall(stripToolDeclarations(convertToLlm(sessionMessages))),
	);
	const settings = loadAdvisorSettings();
	const registered = pi.getAllTools();
	const tools =
		settings.toolInventory === "active"
			? registered.filter((tool) => pi.getActiveTools().includes(tool.name))
			: registered;
	const inventoryMessage = getInventoryMessage(tools, settings.toolInventory);
	const messages: Message[] = inventoryMessage ? [inventoryMessage, ...branchMessages] : branchMessages;

	onUpdate?.({
		content: [{ type: "text", text: msgConsulting(advisorLabel, effort) }],
		details: { advisorModel: advisorLabel, effort },
	});

	try {
		const completeSimple = runtimeCompleteSimple ?? (await loadCompleteSimple());
		const requestOptions: SimpleStreamOptions = { signal };
		if (effort) requestOptions.reasoning = effort;
		if (!runtimeCompleteSimple) {
			if (auth.apiKey) requestOptions.apiKey = auth.apiKey;
			if (auth.headers) requestOptions.headers = auth.headers;
		}

		const callAdvisor = (): Promise<AssistantMessage> =>
			completeSimple(advisor, { systemPrompt: ADVISOR_SYSTEM_PROMPT, messages, tools: [] }, requestOptions);

		let response = await callAdvisor();
		const firstTerminal = stopReasonEnvelope(response, effort, advisorLabel);
		if (firstTerminal) return firstTerminal;

		let advisorText = advisorTextFromResponse(response);
		if (!advisorText) {
			response = await callAdvisor();
			const retryTerminal = stopReasonEnvelope(response, effort, advisorLabel);
			if (retryTerminal) return retryTerminal;
			advisorText = advisorTextFromResponse(response);
			if (!advisorText) {
				return buildAdvisorResult({
					text: ERR_EMPTY_RESPONSE,
					effort,
					advisorLabel,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
				});
			}
		}

		return buildAdvisorResult({
			text: advisorText,
			effort,
			advisorLabel,
			usage: response.usage,
			stopReason: response.stopReason,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return buildErrorResult(advisorLabel, effort, errCallThrew(message), message);
	}
}
