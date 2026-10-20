import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configPath, loadConfig } from "../src/config.ts";
import {
	buildDefaultConfigFile,
	createAskUserCommand,
	type AskUserCommandContext,
} from "../src/init-command.ts";

let root: string;
let agentDir: string;
let previousAgentDir: string | undefined;

test.beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-ask-user-init-"));
	agentDir = join(root, "agent");
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(agentDir, { recursive: true });
});

test.afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

interface Harness {
	command: ReturnType<typeof createAskUserCommand>;
	ctx: AskUserCommandContext;
	selects: Array<{ title: string; options: string[] }>;
	notices: Array<{ message: string; type?: "info" | "warning" | "error" }>;
	setSelect(
		result: string | undefined | ((options: string[]) => string | undefined),
	): void;
	setSelectThrows(error: unknown): void;
}

function harness(): Harness {
	const command = createAskUserCommand();
	const selects: Array<{ title: string; options: string[] }> = [];
	const notices: Array<{
		message: string;
		type?: "info" | "warning" | "error";
	}> = [];
	let result: string | undefined | ((options: string[]) => string | undefined);
	let thrown: unknown;
	const ctx: AskUserCommandContext = {
		ui: {
			select: async (title, options) => {
				if (thrown !== undefined) throw thrown;
				selects.push({ title, options });
				return typeof result === "function" ? result(options) : result;
			},
			notify: (message, type) => {
				notices.push({ message, type });
			},
		},
	};
	return {
		command,
		ctx,
		selects,
		notices,
		setSelect(next) {
			result = next;
			thrown = undefined;
		},
		setSelectThrows(error) {
			thrown = error;
		},
	};
}

test("completes the init argument and rejects anything else", async () => {
	const h = harness();
	assert.deepEqual(
		h.command.getArgumentCompletions("").map((item) => item.value),
		["init"],
	);
	assert.deepEqual(
		h.command.getArgumentCompletions("IN").map((item) => item.value),
		["init"],
	);
	assert.deepEqual(h.command.getArgumentCompletions("nope"), []);

	await h.command.handler("", h.ctx);
	assert.match(
		h.notices.at(-1)?.message ?? "",
		/usage: \/pi-ask-user init|available command/,
	);
	await h.command.handler("reset", h.ctx);
	assert.match(h.notices.at(-1)?.message ?? "", /available command/);
	assert.equal(existsSync(configPath()), false);
});

test("init writes the default config file", async () => {
	const h = harness();
	await h.command.handler("init", h.ctx);
	const path = configPath();
	assert.equal(existsSync(path), true);
	assert.deepEqual(
		JSON.parse(readFileSync(path, "utf8")),
		buildDefaultConfigFile(),
	);
	const loaded = loadConfig(path);
	assert.deepEqual(loaded.warnings, []);
	assert.equal(loaded.config.timeoutSeconds, 600);
	assert.equal(loaded.config.collapseKey, "ctrl+o");
	assert.deepEqual(loaded.config.guidance, { promptGuidelines: [] });
	assert.match(h.notices.at(-1)?.message ?? "", /created$/);
});

test("overwriting is confirmed and No keeps the file", async () => {
	const path = configPath();
	writeFileSync(path, JSON.stringify({ timeoutSeconds: 30 }));

	const no = harness();
	no.setSelect((options) => options[0]);
	await no.command.handler("init", no.ctx);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		timeoutSeconds: 30,
	});
	assert.equal(no.selects.length, 1);
	assert.deepEqual(no.selects[0].options, ["No", "Yes"]);
	assert.match(no.notices.at(-1)?.message ?? "", /left unchanged/);

	const cancel = harness();
	cancel.setSelect(undefined);
	await cancel.command.handler("init", cancel.ctx);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		timeoutSeconds: 30,
	});
	assert.match(cancel.notices.at(-1)?.message ?? "", /cancelled/);

	const yes = harness();
	yes.setSelect((options) => options[1]);
	await yes.command.handler("init", yes.ctx);
	assert.deepEqual(
		JSON.parse(readFileSync(path, "utf8")),
		buildDefaultConfigFile(),
	);
	assert.match(yes.notices.at(-1)?.message ?? "", /reset to the defaults$/);
});

test("init creates missing parent directories", async () => {
	rmSync(agentDir, { recursive: true, force: true });
	const h = harness();
	await h.command.handler("init", h.ctx);
	assert.equal(existsSync(configPath()), true);
	assert.match(h.notices.at(-1)?.message ?? "", /created$/);
});

test("a failing write is reported", async () => {
	mkdirSync(configPath(), { recursive: true }); // a directory where the file should be
	const h = harness();
	h.setSelect((options) => options[1]); // confirm the overwrite
	await h.command.handler("init", h.ctx);
	assert.equal(h.notices.at(-1)?.type, "error");
	assert.match(
		h.notices.at(-1)?.message ?? "",
		/could not write the configuration file/,
	);
});

test("a failing select dialog leaves the file alone", async () => {
	const path = configPath();
	writeFileSync(path, JSON.stringify({ timeoutSeconds: 30 }));

	const h = harness();
	h.setSelectThrows(new Error("no tty"));
	await h.command.handler("init", h.ctx);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		timeoutSeconds: 30,
	});
	assert.equal(h.notices.at(-1)?.type, "warning");
});

test("a host without select never overwrites an existing file", async () => {
	const path = configPath();
	writeFileSync(path, JSON.stringify({ timeoutSeconds: 30 }));

	const command = createAskUserCommand();
	const notices: Array<{
		message: string;
		type?: "info" | "warning" | "error";
	}> = [];
	await command.handler("init", {
		ui: { notify: (message, type) => notices.push({ message, type }) },
	});
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		timeoutSeconds: 30,
	});
	assert.equal(notices.at(-1)?.type, "error");
});
