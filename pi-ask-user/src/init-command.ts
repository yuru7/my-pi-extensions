import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	configPath,
	DEFAULT_COLLAPSE_KEY,
	DEFAULT_TIMEOUT_SECONDS,
} from "./config.ts";

const INIT_ARGUMENT = "init";

/** 上書き確認は No を先頭にして、無意識の Enter では上書きしない。 */
const OVERWRITE_CHOICES = ["No", "Yes"] as const;

export interface AskUserCommandContext {
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select?(title: string, options: string[]): Promise<string | undefined>;
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `/pi-ask-user init` が書き出す既定値。README の設定例と同じ形。 */
export function buildDefaultConfigFile(): Record<string, unknown> {
	return {
		timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
		collapseKey: DEFAULT_COLLAPSE_KEY,
		guidance: {
			description: "",
			promptSnippet: "",
			promptGuidelines: [],
		},
	};
}

export function writeDefaultConfig(path = configPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(buildDefaultConfigFile(), null, 2)}\n`);
}

async function runInit(ctx: AskUserCommandContext): Promise<void> {
	const path = configPath();
	const existed = existsSync(path);
	if (existed) {
		if (typeof ctx.ui.select !== "function") {
			ctx.ui.notify(
				`pi-ask-user: ${path} already exists and this host cannot show an overwrite confirmation; the file was left unchanged`,
				"error",
			);
			return;
		}
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(
				`${path} already exists. Overwrite it with the default settings?`,
				[...OVERWRITE_CHOICES],
			);
		} catch (error) {
			ctx.ui.notify(
				`pi-ask-user: could not show the overwrite confirmation: ${errorText(error)}`,
				"warning",
			);
			return;
		}
		if (choice === undefined) {
			ctx.ui.notify("pi-ask-user: cancelled", "info");
			return;
		}
		if (choice !== "Yes") {
			ctx.ui.notify(
				"pi-ask-user: cancelled. The existing file was left unchanged",
				"info",
			);
			return;
		}
	}
	try {
		writeDefaultConfig(path);
	} catch (error) {
		ctx.ui.notify(
			`pi-ask-user: could not write the configuration file: ${errorText(error)}`,
			"error",
		);
		return;
	}
	ctx.ui.notify(
		`pi-ask-user: ${path} ${existed ? "reset to the defaults" : "created"}`,
		"info",
	);
}

export function createAskUserCommand() {
	return {
		description: "Manage pi-ask-user settings (/pi-ask-user init)",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			if (!INIT_ARGUMENT.startsWith(prefix)) return [];
			return [
				{
					value: INIT_ARGUMENT,
					label: INIT_ARGUMENT,
					description:
						"Write the default configuration file (asks before overwriting)",
				},
			];
		},
		handler: async (args: string, ctx: AskUserCommandContext) => {
			if (args.trim().toLowerCase() !== INIT_ARGUMENT) {
				ctx.ui.notify(
					"pi-ask-user: available command:\n  /pi-ask-user init — write the default configuration file (asks before overwriting)",
					"info",
				);
				return;
			}
			await runInit(ctx);
		},
	};
}
