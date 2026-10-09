import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildDefaultConfigFile, piSandboxConfigPaths, readProjectTrusted, resetSandboxConfigCache } from "./config";

const INIT_ARGUMENT = "init";

/** 上書き確認は No を先頭にして、無意識の Enter では上書きしない。 */
const OVERWRITE_CONFIRMATION_CHOICES = ["No", "Yes"] as const;

export interface PiSandboxCommandContext {
	cwd?: string;
	isProjectTrusted?: () => boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select?(title: string, options: string[]): Promise<string | undefined>;
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 保存先または上書きの選択。プロンプトを出せないときは何も書かず、呼び出し側は return する。
 * `undefined` はキャンセル（Esc）。
 */
async function promptChoice(
	ctx: PiSandboxCommandContext,
	title: string,
	options: readonly string[],
	unavailableDetail: string,
): Promise<string | undefined | null> {
	if (typeof ctx.ui.select !== "function") {
		ctx.ui.notify(`sandbox: ${unavailableDetail}`, "error");
		return null;
	}
	try {
		return await ctx.ui.select(title, [...options]);
	} catch (error) {
		ctx.ui.notify(`sandbox: ${unavailableDetail}: ${errorText(error)}`, "warning");
		return null;
	}
}

function projectApprovalNote(projectTrusted: boolean | null): string | null {
	if (projectTrusted === true) return null;
	if (projectTrusted === false) {
		return "sandbox: this project is untrusted, so approval settings in this file are not used until it is trusted. mode, runner, and probe apply now";
	}
	return "sandbox: project trust could not be confirmed, so approval settings in this file are not used. mode, runner, and probe apply now";
}

async function writeDefaultConfiguration(ctx: PiSandboxCommandContext): Promise<void> {
	const cwd = ctx.cwd?.trim() ?? "";
	if (!cwd) {
		ctx.ui.notify("sandbox: cannot choose a config destination without a session cwd", "error");
		return;
	}
	const paths = piSandboxConfigPaths(cwd);
	const destinations = [
		{
			project: true,
			path: paths.projectPath,
			label: `Project: ${paths.projectPath}${existsSync(paths.projectPath) ? "  (exists)" : ""}`,
		},
		{
			project: false,
			path: paths.globalPath,
			label: `Global: ${paths.globalPath}${existsSync(paths.globalPath) ? "  (exists)" : ""}`,
		},
	];
	const choice = await promptChoice(
		ctx,
		"Write the default configuration to:",
		destinations.map(({ label }) => label),
		"could not show the destination chooser",
	);
	if (choice === null) return;
	if (choice === undefined) {
		ctx.ui.notify("sandbox: configuration setup cancelled", "info");
		return;
	}
	const destination = destinations.find(({ label }) => label === choice);
	if (!destination) return;

	if (existsSync(destination.path)) {
		const overwrite = await promptChoice(
			ctx,
			`${destination.path} already exists. Overwrite?`,
			OVERWRITE_CONFIRMATION_CHOICES,
			"could not show the overwrite confirmation",
		);
		if (overwrite === null) return;
		if (overwrite !== "Yes") {
			ctx.ui.notify("sandbox: configuration setup cancelled. The existing file was left unchanged", "info");
			return;
		}
	}

	try {
		mkdirSync(dirname(destination.path), { recursive: true });
		writeFileSync(destination.path, `${JSON.stringify(buildDefaultConfigFile(), null, 2)}\n`);
	} catch (error) {
		ctx.ui.notify(`sandbox: failed to write ${destination.path}: ${errorText(error)}`, "error");
		return;
	}
	resetSandboxConfigCache();
	const lines = [`sandbox: default configuration written to ${destination.path}`];
	if (destination.project) {
		const note = projectApprovalNote(readProjectTrusted(ctx));
		if (note !== null) lines.push(note);
	}
	lines.push("sandbox: run /permission to check the effective settings");
	ctx.ui.notify(lines.join("\n"), "info");
}

export function createPiSandboxCommand() {
	return {
		description: "Write the default pi-sandbox.json (global or project; asks before overwriting)",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			if (!INIT_ARGUMENT.startsWith(prefix)) return [];
			return [{
				value: INIT_ARGUMENT,
				label: INIT_ARGUMENT,
				description: "Write the default configuration file",
			}];
		},
		handler: async (args: string, ctx: PiSandboxCommandContext) => {
			const arg = args.trim().toLowerCase();
			if (arg !== INIT_ARGUMENT) {
				const shown = args.trim();
				ctx.ui.notify(
					shown
						? `sandbox: unknown command "${shown}". Available: ${INIT_ARGUMENT}`
						: `sandbox: usage: /pi-sandbox ${INIT_ARGUMENT}`,
					shown ? "error" : "info",
				);
				return;
			}
			await writeDefaultConfiguration(ctx);
		},
	};
}
