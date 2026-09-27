import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { boundActionReasoning } from "./review.ts";

/**
 * Visible assistant reasoning that belongs to one tool call.
 * This is supporting evidence for the reviewer, never an authorization source.
 * `thinkingSignature` and redacted thinking bodies are never returned.
 */
export function collectActionReasoning(
	entries: readonly SessionEntry[],
	toolCallId: string,
): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;

		const content = message.content;
		const targetIndex = content.findIndex(
			(block) => block.type === "toolCall" && block.id === toolCallId,
		);
		if (targetIndex < 0) continue;

		// A thinking block applies only until the next tool call. Later sibling
		// calls in the same message do not inherit it.
		let start = 0;
		for (let blockIndex = targetIndex - 1; blockIndex >= 0; blockIndex--) {
			if (content[blockIndex]?.type === "toolCall") {
				start = blockIndex + 1;
				break;
			}
		}

		const parts: string[] = [];
		for (const block of content.slice(start, targetIndex)) {
			if (block.type !== "thinking") continue;
			if (block.redacted === true) continue;
			if (!block.thinking.trim()) continue;
			parts.push(block.thinking);
		}
		if (parts.length === 0) return undefined;
		return boundActionReasoning(parts.join("\n\n"));
	}
	return undefined;
}
