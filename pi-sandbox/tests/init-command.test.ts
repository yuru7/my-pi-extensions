import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDefaultConfigFile, DEFAULT_SANDBOX_CONFIG, getSandboxConfig, loadSandboxConfig, resetSandboxConfigCache } from "../src/config";
import { createPiSandboxCommand, type PiSandboxCommandContext } from "../src/init-command";

let root: string;
let agentDir: string;
let project: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-sandbox-init-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(project, { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	resetSandboxConfigCache();
});

afterEach(() => {
	resetSandboxConfigCache();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function harness() {
	const command = createPiSandboxCommand();
	const selects: Array<{ title: string; options: string[] }> = [];
	const notices: Array<{ message: string; type?: string }> = [];
	let script: Array<(options: string[]) => string | undefined> = [];
	const ctx: PiSandboxCommandContext = {
		cwd: project,
		isProjectTrusted: () => false,
		ui: {
			select: async (title, options) => {
				selects.push({ title, options });
				const next = script.shift();
				if (!next) throw new Error("unexpected select call");
				return next(options);
			},
			notify: (message, type) => {
				notices.push({ message, type });
			},
		},
	};
	return {
		command,
		selects,
		notices,
		ctx,
		setScript: (next: Array<(options: string[]) => string | undefined>) => {
			script = next;
		},
	};
}

describe("/pi-sandbox init", () => {
	const projectPath = () => join(project, ".pi", "pi-sandbox.json");
	const globalPath = () => join(agentDir, "pi-sandbox.json");

	it("completes the init argument and rejects anything else", async () => {
		const { command, notices, ctx } = harness();
		expect(command.getArgumentCompletions("").map((item) => item.value)).toEqual(["init"]);
		expect(command.getArgumentCompletions("IN").map((item) => item.value)).toEqual(["init"]);
		expect(command.getArgumentCompletions("nope")).toEqual([]);

		await command.handler("", ctx);
		expect(notices.at(-1)).toEqual({ message: "sandbox: usage: /pi-sandbox init", type: "info" });
		await command.handler("status", ctx);
		expect(notices.at(-1)?.message).toBe('sandbox: unknown command "status". Available: init');
		expect(notices.at(-1)?.type).toBe("error");
		expect(existsSync(projectPath())).toBe(false);
	});

	it("writes defaults to a new project or global file and leaves legacy sandbox.json alone", async () => {
		const { command, selects, notices, ctx, setScript } = harness();
		const legacy = join(project, ".pi", "sandbox.json");
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(legacy, JSON.stringify({ mode: "read-only" }));

		setScript([() => undefined]);
		await command.handler("init", ctx);
		expect(existsSync(projectPath())).toBe(false);
		expect(notices.at(-1)?.message).toMatch(/cancelled/);

		notices.length = 0;
		setScript([(options) => options[0]]);
		await command.handler("INIT", ctx);
		expect(selects[1]?.title).toMatch(/default configuration/i);
		expect(selects[1]?.options[0]).toMatch(/^Project:/);
		expect(selects[1]?.options[1]).toMatch(/^Global:/);
		expect(selects[1]?.options[0]).not.toMatch(/\(exists\)/);
		expect(JSON.parse(readFileSync(projectPath(), "utf8"))).toEqual(buildDefaultConfigFile());
		expect(readFileSync(legacy, "utf8")).toBe(JSON.stringify({ mode: "read-only" }));
		expect(loadSandboxConfig(project)).toEqual({ ...DEFAULT_SANDBOX_CONFIG, mode: "workspace-write" });
		expect(notices.at(-1)?.message).toMatch(/default configuration written to /);
		expect(notices.at(-1)?.message).toMatch(/untrusted/);
		expect(notices.at(-1)?.message).toMatch(/\/permission/);

		notices.length = 0;
		ctx.isProjectTrusted = () => true;
		setScript([(options) => options[1]]);
		await command.handler("init", ctx);
		expect(JSON.parse(readFileSync(globalPath(), "utf8"))).toEqual(buildDefaultConfigFile());
		expect(notices.at(-1)?.message).not.toMatch(/untrusted|trust could not be confirmed/);
	});

	it("asks before overwriting and replaces the file only on Yes", async () => {
		const { command, selects, notices, ctx, setScript } = harness();
		const path = projectPath();
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(path, JSON.stringify({ mode: "read-only", approvalMode: "human" }));
		expect(getSandboxConfig(project).mode).toBe("read-only");

		setScript([(options) => options[0], () => "No"]);
		await command.handler("init", ctx);
		expect(selects[0]?.options[0]).toMatch(/\(exists\)/);
		expect(selects[1]?.title).toMatch(/already exists\. Overwrite\?/);
		expect(selects[1]?.options).toEqual(["No", "Yes"]);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mode: "read-only", approvalMode: "human" });
		expect(notices.at(-1)?.message).toMatch(/left unchanged/);
		expect(getSandboxConfig(project).mode).toBe("read-only");

		setScript([(options) => options[0], () => undefined]);
		await command.handler("init", ctx);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mode: "read-only", approvalMode: "human" });

		notices.length = 0;
		setScript([(options) => options[0], () => "Yes"]);
		await command.handler("init", ctx);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(buildDefaultConfigFile());
		expect(getSandboxConfig(project).mode).toBe("workspace-write");
		expect(getSandboxConfig(project).approvalMode).toBe("auto-review");
		expect(notices.at(-1)?.message).toMatch(/default configuration written to /);
	});

	it("does not write when the prompt cannot be shown or the write fails", async () => {
		const { command, notices, ctx } = harness();
		ctx.ui.select = async () => {
			throw new Error("no tty");
		};
		await command.handler("init", ctx);
		expect(existsSync(projectPath())).toBe(false);
		expect(notices.at(-1)?.message).toMatch(/destination chooser: no tty/);
		expect(notices.at(-1)?.type).toBe("warning");

		notices.length = 0;
		delete ctx.ui.select;
		await command.handler("init", ctx);
		expect(notices.at(-1)?.type).toBe("error");
		expect(existsSync(projectPath())).toBe(false);

		const blocked = globalPath();
		mkdirSync(blocked, { recursive: true });
		ctx.ui.select = async (_title, options) => options[1];
		await command.handler("init", ctx);
		expect(notices.at(-1)?.message).toMatch(/failed to write/);
		expect(notices.at(-1)?.type).toBe("error");
	});

	it("reports unknown project trust and refuses to run without a cwd", async () => {
		const { command, notices, ctx, setScript } = harness();
		delete ctx.isProjectTrusted;
		setScript([(options) => options[0]]);
		await command.handler("init", ctx);
		expect(notices.at(-1)?.message).toMatch(/trust could not be confirmed/);

		notices.length = 0;
		ctx.cwd = "  ";
		await command.handler("init", ctx);
		expect(notices.at(-1)?.message).toMatch(/without a session cwd/);
		expect(existsSync(globalPath())).toBe(false);
	});
});
