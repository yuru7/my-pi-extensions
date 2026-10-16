/**
 * Stable tool-inventory message prepended to an advisor request.
 *
 * The cache key includes the inventory mode, tool name, description, and
 * parameter schema. A cache hit returns the same message object, including its
 * timestamp, so an unchanged inventory stays byte-identical for prompt cache.
 * `sourceInfo` is omitted because its path changes across installs.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ToolInventory } from "./config.ts";

const ADVISOR_STATE_KEY = Symbol.for("pi-advisor");

interface InventoryState {
	signature?: string;
	message?: Message;
}

function runtimeState(): InventoryState {
	const g = globalThis as unknown as { [key: symbol]: InventoryState | undefined };
	let state = g[ADVISOR_STATE_KEY];
	if (!state) {
		state = {};
		g[ADVISOR_STATE_KEY] = state;
	}
	return state;
}

export function __resetInventoryCacheForTests(): void {
	const state = runtimeState();
	state.signature = undefined;
	state.message = undefined;
}

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) {
		return `[${value.map((entry) => (entry === undefined ? "null" : stableStringify(entry))).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const entries: string[] = [];
	for (const key of Object.keys(record).sort()) {
		const child = record[key];
		if (child === undefined) continue;
		entries.push(`${JSON.stringify(key)}:${stableStringify(child)}`);
	}
	return `{${entries.join(",")}}`;
}

function sortedTools(tools: ToolInfo[]): ToolInfo[] {
	return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function inventoryText(tools: ToolInfo[], mode: ToolInventory): string {
	if (mode === "names") {
		const names = sortedTools(tools)
			.map((tool) => `- ${tool.name}`)
			.join("\n");
		return `## Available Executor Tools\n\n${names}`;
	}
	const blocks = sortedTools(tools).map(
		(tool) => `### ${tool.name}\n${tool.description}\n\nParameters: ${stableStringify(tool.parameters)}`,
	);
	return `## Available Executor Tools\n\n${blocks.join("\n\n---\n\n")}`;
}

function signatureFor(tools: ToolInfo[], mode: ToolInventory): string {
	const body = sortedTools(tools)
		.map((tool) =>
			mode === "names" ? tool.name : `${tool.name}\n${tool.description}\n${stableStringify(tool.parameters)}`,
		)
		.join("\n");
	return `${mode}\n${body}`;
}

export function getInventoryMessage(tools: ToolInfo[], mode: ToolInventory): Message | undefined {
	if (tools.length === 0) return undefined;
	const signature = signatureFor(tools, mode);
	const state = runtimeState();
	if (state.signature === signature && state.message) return state.message;
	const message: Message = {
		role: "user",
		content: [{ type: "text", text: inventoryText(tools, mode) }],
		timestamp: Date.now(),
	};
	state.signature = signature;
	state.message = message;
	return message;
}
