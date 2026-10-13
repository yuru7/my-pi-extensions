import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	configPath,
	DEFAULT_CONFIG,
	defaultConfig,
	loadConfig,
	parseConfig,
	writeDefaultConfig,
} from "../src/config.ts";

function tempConfigPath(): string {
	return join(
		mkdtempSync(join(tmpdir(), "pi-auto-title-")),
		"nested",
		"pi-auto-title.json",
	);
}

describe("configPath", () => {
	test("is <agent dir>/pi-auto-title.json (e.g. ~/.pi/agent/)", () => {
		assert.equal(configPath(), join(getAgentDir(), "pi-auto-title.json"));
	});

	test("follows PI_CODING_AGENT_DIR for the agent directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-agent-dir-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			assert.equal(configPath(), join(dir, "pi-auto-title.json"));
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});
});

describe("parseConfig", () => {
	test("an empty object yields the defaults", () => {
		assert.deepEqual(parseConfig({}), { config: DEFAULT_CONFIG, errors: [] });
	});

	test("missing fields fall back to defaults and explicit false is kept", () => {
		const { config } = parseConfig({
			autoTitle: { enabled: false },
			statusIndicator: { running: ">" },
		});
		assert.deepEqual(config, {
			autoTitle: {
				enabled: false,
				model: "CURRENT",
				thinkingLevel: "CURRENT",
				fallbackToCurrentModel: true,
			},
			statusIndicator: {
				enabled: true,
				running: ">",
				idle: "✅",
				stalled: "⏸️",
				stallDetection: { enabled: true, thresholdSeconds: 30 },
			},
		});
	});

	test("empty status marker strings are allowed", () => {
		const { config } = parseConfig({
			statusIndicator: { running: "", idle: "" },
		});
		assert.equal(config.statusIndicator.running, "");
		assert.equal(config.statusIndicator.idle, "");
	});

	test("unknown fields are ignored", () => {
		const { config } = parseConfig({ autoTitle: { color: "red" }, extra: 1 });
		assert.deepEqual(config, DEFAULT_CONFIG);
	});

	test("a non-object configuration yields the defaults with the error named", () => {
		const { config, errors } = parseConfig([]);
		assert.deepEqual(config, DEFAULT_CONFIG);
		assert.deepEqual(errors, ["configuration must be a JSON object"]);
	});

	test("a wrong field type falls back per field and names the offending field", () => {
		const { config, errors } = parseConfig({
			autoTitle: { enabled: "yes", model: "anthropic/claude-sonnet-4-5" },
		});
		assert.equal(config.autoTitle.enabled, DEFAULT_CONFIG.autoTitle.enabled);
		// A valid field keeps its value even when a sibling is invalid.
		assert.equal(config.autoTitle.model, "anthropic/claude-sonnet-4-5");
		assert.deepEqual(errors, ["autoTitle.enabled must be a boolean"]);

		const second = parseConfig({ autoTitle: { model: 42 } });
		assert.equal(second.config.autoTitle.model, DEFAULT_CONFIG.autoTitle.model);
		assert.deepEqual(second.errors, [
			"autoTitle.model must be a non-empty string",
		]);

		const third = parseConfig({
			autoTitle: { fallbackToCurrentModel: null },
		});
		assert.equal(
			third.config.autoTitle.fallbackToCurrentModel,
			DEFAULT_CONFIG.autoTitle.fallbackToCurrentModel,
		);
		assert.deepEqual(third.errors, [
			"autoTitle.fallbackToCurrentModel must be a boolean",
		]);
	});

	test("an empty model or thinkingLevel falls back and is named", () => {
		const { config, errors } = parseConfig({
			autoTitle: { model: "", thinkingLevel: "" },
		});
		assert.equal(config.autoTitle.model, DEFAULT_CONFIG.autoTitle.model);
		assert.equal(
			config.autoTitle.thinkingLevel,
			DEFAULT_CONFIG.autoTitle.thinkingLevel,
		);
		assert.deepEqual(errors, [
			"autoTitle.model must be a non-empty string",
			"autoTitle.thinkingLevel must be a non-empty string",
		]);
	});

	test("a non-object section falls back as a whole with the section named", () => {
		const first = parseConfig({ autoTitle: "on" });
		assert.deepEqual(first.config, DEFAULT_CONFIG);
		assert.deepEqual(first.errors, ["autoTitle must be a JSON object"]);

		const second = parseConfig({ statusIndicator: [] });
		assert.deepEqual(second.config, DEFAULT_CONFIG);
		assert.deepEqual(second.errors, ["statusIndicator must be a JSON object"]);
	});

	test("an invalid enabled value cannot silently turn generation back on", () => {
		// Fail-safe: a user-chosen false survives any other field error, and an
		// invalid enabled value itself falls back to the default with a warning
		// the caller must surface.
		const { config, errors } = parseConfig({
			autoTitle: { enabled: false, model: "anthropic/claude-sonnet-4-5" },
			statusIndicator: { enabled: 1 },
		});
		assert.equal(config.autoTitle.enabled, false);
		assert.deepEqual(errors, ["statusIndicator.enabled must be a boolean"]);
	});
});

describe("loadConfig", () => {
	test("a missing file returns the defaults without a warning", () => {
		const path = tempConfigPath();
		const result = loadConfig(path);
		assert.deepEqual(result.config, DEFAULT_CONFIG);
		assert.equal(result.warning, undefined);
		assert.equal(existsSync(path), false);
	});

	test("a missing file does not create the configuration file", () => {
		const path = tempConfigPath();
		loadConfig(path);
		assert.equal(existsSync(path), false);
	});

	test("a valid file is loaded with defaults for missing fields", () => {
		const path = tempConfigPath();
		writeDefaultConfig(path);
		const result = loadConfig(path);
		assert.deepEqual(result.config, DEFAULT_CONFIG);
		assert.equal(result.warning, undefined);
	});

	test("invalid JSON falls back to the defaults with a warning", () => {
		const path = tempConfigPath();
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "{ not json");
		const result = loadConfig(path);
		assert.deepEqual(result.config, DEFAULT_CONFIG);
		assert.match(result.warning ?? "", /invalid configuration at/);
	});

	test("an invalid field type falls back to the default and names the field", () => {
		const path = tempConfigPath();
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify({ autoTitle: { enabled: "yes" } }));
		const result = loadConfig(path);
		assert.deepEqual(result.config, DEFAULT_CONFIG);
		assert.match(result.warning ?? "", /invalid configuration fields at/);
		assert.match(result.warning ?? "", /autoTitle\.enabled/);
	});

	test("a deliberately disabled generation survives an unrelated field error", () => {
		const path = tempConfigPath();
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				autoTitle: { enabled: false },
				statusIndicator: { running: 3 },
			}),
		);
		const result = loadConfig(path);
		assert.equal(result.config.autoTitle.enabled, false);
		assert.match(result.warning ?? "", /statusIndicator\.running/);
	});

	test("a partially valid file keeps its values and is not rewritten", () => {
		const path = tempConfigPath();
		mkdirSync(join(path, ".."), { recursive: true });
		const text = JSON.stringify({ statusIndicator: { running: ">" } });
		writeFileSync(path, text);
		const result = loadConfig(path);
		assert.equal(result.config.statusIndicator.running, ">");
		assert.equal(result.warning, undefined);
		assert.equal(readFileSync(path, "utf8"), text);
	});
});

describe("stall detection settings", () => {
	test("the defaults include the stalled marker and detection values", () => {
		assert.deepEqual(DEFAULT_CONFIG.statusIndicator.stallDetection, {
			enabled: true,
			thresholdSeconds: 30,
		});
		assert.equal(DEFAULT_CONFIG.statusIndicator.stalled, "⏸️");
		// A copy is deep: mutating one copy must not touch the defaults.
		const copy = defaultConfig();
		copy.statusIndicator.stallDetection.thresholdSeconds = 5;
		assert.equal(
			DEFAULT_CONFIG.statusIndicator.stallDetection.thresholdSeconds,
			30,
		);
	});

	test("missing new fields fall back to the defaults (older config files)", () => {
		const { config } = parseConfig({
			statusIndicator: { running: ">", idle: "[ok]" },
		});
		assert.equal(config.statusIndicator.running, ">");
		assert.equal(config.statusIndicator.idle, "[ok]");
		assert.deepEqual(
			config.statusIndicator.stallDetection,
			DEFAULT_CONFIG.statusIndicator.stallDetection,
		);
		assert.equal(config.statusIndicator.stalled, "⏸️");
	});

	test("the threshold and stalled marker can be changed", () => {
		const { config } = parseConfig({
			statusIndicator: {
				stalled: "[wait]",
				stallDetection: { enabled: false, thresholdSeconds: 90 },
			},
		});
		assert.equal(config.statusIndicator.stalled, "[wait]");
		assert.deepEqual(config.statusIndicator.stallDetection, {
			enabled: false,
			thresholdSeconds: 90,
		});
	});

	test("an invalid threshold falls back with the field named", () => {
		for (const thresholdSeconds of [0, -5, "30", null, true]) {
			const { config, errors } = parseConfig({
				statusIndicator: {
					stallDetection: { thresholdSeconds },
				},
			});
			assert.equal(
				config.statusIndicator.stallDetection.thresholdSeconds,
				DEFAULT_CONFIG.statusIndicator.stallDetection.thresholdSeconds,
			);
			assert.deepEqual(errors, [
				"statusIndicator.stallDetection.thresholdSeconds must be a finite number >= 1",
			]);
		}
	});

	test("an invalid stalled marker type falls back with the field named", () => {
		const { config, errors } = parseConfig({ statusIndicator: { stalled: 7 } });
		assert.equal(
			config.statusIndicator.stalled,
			DEFAULT_CONFIG.statusIndicator.stalled,
		);
		assert.deepEqual(errors, ["statusIndicator.stalled must be a string"]);
	});

	test("an invalid stallDetection section falls back with the section named", () => {
		const { config, errors } = parseConfig({
			statusIndicator: { stallDetection: "off" },
		});
		assert.deepEqual(
			config.statusIndicator.stallDetection,
			DEFAULT_CONFIG.statusIndicator.stallDetection,
		);
		assert.deepEqual(errors, [
			"statusIndicator.stallDetection must be a JSON object",
		]);
	});

	test("a partially valid file keeps its values and gains the new defaults", () => {
		const path = tempConfigPath();
		mkdirSync(join(path, ".."), { recursive: true });
		const text = JSON.stringify({ statusIndicator: { running: ">" } });
		writeFileSync(path, text);
		const result = loadConfig(path);
		assert.equal(result.config.statusIndicator.running, ">");
		assert.deepEqual(
			result.config.statusIndicator.stallDetection,
			DEFAULT_CONFIG.statusIndicator.stallDetection,
		);
		assert.equal(result.warning, undefined);
		assert.equal(readFileSync(path, "utf8"), text);
	});
});

describe("writeDefaultConfig", () => {
	test("creates the file with two-space indent and a trailing newline", () => {
		const path = tempConfigPath();
		writeDefaultConfig(path);
		const text = readFileSync(path, "utf8");
		assert.equal(text, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
		assert.ok(text.endsWith("}\n"));
	});

	test("the written file loads back into the default config", () => {
		const path = tempConfigPath();
		writeDefaultConfig(path);
		assert.deepEqual(loadConfig(path).config, DEFAULT_CONFIG);
		assert.deepEqual(defaultConfig(), DEFAULT_CONFIG);
		assert.notEqual(defaultConfig(), DEFAULT_CONFIG);
	});
});
