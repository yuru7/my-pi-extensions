/**
 * Shape the executor branch before it is sent to the advisor.
 *
 * The in-flight `advisor` tool call has no result yet, and providers reject
 * that orphan. Some providers also reject an assistant tail, and Pi 1.x copies
 * the executor's tool declarations onto system messages. Those declarations are
 * removed so `tools: []` is actually empty.
 */

import type { Message } from "@earendil-works/pi-ai";
import { ADVISOR_TOOL_NAME, MSG_ADVISOR_NUDGE } from "./messages.ts";

interface ToolDeclarationMessage {
	role: string;
	toolsAdded?: unknown;
	toolsRemoved?: unknown;
}

export function stripInflightAdvisorCall(messages: Message[]): Message[] {
	const last = messages.at(-1);
	if (last?.role !== "assistant") return messages;
	const filtered = last.content.filter((part) => !(part.type === "toolCall" && part.name === ADVISOR_TOOL_NAME));
	if (filtered.length === last.content.length) return messages;
	if (filtered.length === 0) return messages.slice(0, -1);
	return [...messages.slice(0, -1), { ...last, content: filtered }];
}

export function ensureUserTailForAdvisor(messages: Message[]): Message[] {
	const last = messages.at(-1);
	if (last?.role !== "assistant") return messages;
	const nudge: Message = {
		role: "user",
		content: [{ type: "text", text: MSG_ADVISOR_NUDGE }],
		timestamp: Date.now(),
	};
	return [...messages, nudge];
}

export function stripToolDeclarations<T extends ToolDeclarationMessage>(messages: T[]): T[] {
	if (!messages.some((message) => message.role === "system" && (message.toolsAdded || message.toolsRemoved))) {
		return messages;
	}
	return messages.map((message) => {
		if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return message;
		const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
		return rest as T;
	});
}
