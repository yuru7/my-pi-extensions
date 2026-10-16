import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { __resetConfigWarningsForTests, __setAdvisorConfigPathForTests } from "../src/config.ts";
import { __resetInventoryCacheForTests } from "../src/inventory.ts";
import { __setCompleteSimpleForTests } from "../src/pi-compat.ts";
import { setDisabledForModels } from "../src/policy.ts";
import { __resetAdvisorAnnounced } from "../src/restore.ts";
import { setAdvisorEffort, setAdvisorModel } from "../src/state.ts";

export function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-advisor-"));
}

export function useConfigDir(): string {
	const dir = tempDir();
	__setAdvisorConfigPathForTests(join(dir, "pi-advisor.json"));
	__resetConfigWarningsForTests();
	return dir;
}

export function resetRuntime(): void {
	__setAdvisorConfigPathForTests(undefined);
	__resetConfigWarningsForTests();
	__resetInventoryCacheForTests();
	__resetAdvisorAnnounced();
	__setCompleteSimpleForTests(undefined);
	setAdvisorModel(undefined);
	setAdvisorEffort(undefined);
	setDisabledForModels([]);
}

export function emptyUsage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function fakeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "anthropic",
		id: "claude-opus",
		name: "Opus",
		api: "anthropic-messages",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		...overrides,
	} as Model<Api>;
}

export function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus",
		usage: emptyUsage(),
		stopReason,
		errorMessage: stopReason === "error" ? "provider failed" : undefined,
		timestamp: 1,
	};
}

export interface Harness {
	pi: ExtensionAPI;
	tools: unknown[];
	commands: Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
	listeners: Map<string, ((event: never, ctx: ExtensionContext) => Promise<void> | void)[]>;
	active: string[];
	allTools: ToolInfo[];
	thinking: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export function createHarness(): Harness {
	const harness: Harness = {
		pi: {} as ExtensionAPI,
		tools: [],
		commands: new Map(),
		listeners: new Map(),
		active: ["read", "bash"],
		allTools: [],
		thinking: "medium",
	};
	harness.pi = {
		registerTool: (tool: unknown) => {
			harness.tools.push(tool);
		},
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			harness.commands.set(name, options);
		},
		on: (event: string, handler: (event: never, ctx: ExtensionContext) => Promise<void> | void) => {
			const list = harness.listeners.get(event) ?? [];
			list.push(handler);
			harness.listeners.set(event, list);
		},
		getActiveTools: () => [...harness.active],
		setActiveTools: (names: string[]) => {
			harness.active = [...names];
		},
		getAllTools: () => harness.allTools,
		getThinkingLevel: () => harness.thinking,
	} as unknown as ExtensionAPI;
	return harness;
}

export interface FakeCtx extends ExtensionContext {
	notifications: { message: string; level: string }[];
	customResults: (string | null)[];
}

export function createCtx(overrides: Record<string, unknown> = {}): FakeCtx {
	const notifications: { message: string; level: string }[] = [];
	const ctx = {
		hasUI: true,
		notifications,
		customResults: [],
		model: undefined,
		modelRegistry: {
			getAvailable: () => [],
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
		sessionManager: {
			getEntries: () => [],
			getLeafId: () => null,
		},
		...overrides,
	} as unknown as FakeCtx;
	ctx.ui = {
		notify: (message: string, level: string) => {
			notifications.push({ message, level });
		},
		custom: async () => ctx.customResults.shift() ?? null,
	} as unknown as FakeCtx["ui"];
	return ctx;
}
