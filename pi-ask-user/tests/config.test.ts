import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	configPath,
	DEFAULT_COLLAPSE_KEY,
	DEFAULT_TIMEOUT_SECONDS,
	loadConfig,
	parseConfig,
	resolveTimeoutMs,
} from "../src/config.ts";

test("config path comes from Pi's agent directory", () => {
	assert.equal(configPath(), join(getAgentDir(), "pi-ask-user.json"));
	assert.equal(configPath("/tmp/custom-agent"), "/tmp/custom-agent/pi-ask-user.json");
});

test("PI_CODING_AGENT_DIR selects the global config directory", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-ask-user-agent";
		assert.equal(configPath(), "/tmp/pi-ask-user-agent/pi-ask-user.json");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("missing timeout and collapse key use the defaults", () => {
	const warnings: string[] = [];
	const config = parseConfig({}, warnings);
	assert.equal(config.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
	assert.equal(config.collapseKey, DEFAULT_COLLAPSE_KEY);
	assert.deepEqual(config.guidance, {});
	assert.deepEqual(warnings, []);
});

test("null, zero, and negative timeouts wait forever", () => {
	assert.equal(resolveTimeoutMs(null), null);
	assert.equal(resolveTimeoutMs(0), null);
	assert.equal(resolveTimeoutMs(-1), null);
	assert.equal(resolveTimeoutMs(undefined), 600_000);
	assert.equal(resolveTimeoutMs(30), 30_000);
	assert.equal(resolveTimeoutMs(0.5), 500);
});

test("invalid timeout and collapse values fall back", () => {
	const warnings: string[] = [];
	const config = parseConfig({ timeoutSeconds: "600", collapseKey: "ctr+o" }, warnings);
	assert.equal(config.timeoutSeconds, 600);
	assert.equal(config.collapseKey, "ctrl+o");
	assert.equal(warnings.length, 2);
});

test("off disables the collapse key and guidance replaces text", () => {
	const config = parseConfig(
		{
			collapseKey: "OFF",
			guidance: { description: "Ask carefully.", promptSnippet: "Ask rarely.", promptGuidelines: [] },
		},
		[],
	);
	assert.equal(config.collapseKey, "off");
	assert.equal(config.guidance.description, "Ask carefully.");
	assert.deepEqual(config.guidance.promptGuidelines, []);
});

test("a missing file is the default config and malformed JSON falls back", () => {
	const dir = mkdtempSync(join(tmpdir(), "ask-user-"));
	try {
		const missing = loadConfig(join(dir, "missing.json"));
		assert.equal(missing.config.timeoutSeconds, 600);
		assert.deepEqual(missing.warnings, []);
		const broken = join(dir, "broken.json");
		writeFileSync(broken, "{");
		const loaded = loadConfig(broken);
		assert.equal(loaded.config.timeoutSeconds, 600);
		assert.equal(loaded.warnings.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
