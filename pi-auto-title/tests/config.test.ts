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
		assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
	});

	test("missing fields fall back to defaults and explicit false is kept", () => {
		const config = parseConfig({
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
		const config = parseConfig({ statusIndicator: { running: "", idle: "" } });
		assert.equal(config.statusIndicator.running, "");
		assert.equal(config.statusIndicator.idle, "");
	});

	test("unknown fields are ignored", () => {
		const config = parseConfig({ autoTitle: { color: "red" }, extra: 1 });
		assert.deepEqual(config, DEFAULT_CONFIG);
	});

	test("a non-object configuration is a validation error", () => {
		assert.throws(() => parseConfig([]), /configuration must be a JSON object/);
	});

	test("a wrong field type names the offending field", () => {
		assert.throws(
			() => parseConfig({ autoTitle: { enabled: "yes" } }),
			/autoTitle\.enabled/,
		);
		assert.throws(
			() => parseConfig({ autoTitle: { model: 42 } }),
			/autoTitle\.model/,
		);
		assert.throws(
			() => parseConfig({ autoTitle: { fallbackToCurrentModel: null } }),
			/autoTitle\.fallbackToCurrentModel/,
		);
		assert.throws(
			() => parseConfig({ statusIndicator: { enabled: 1 } }),
			/statusIndicator\.enabled/,
		);
	});

	test("an empty model or thinkingLevel is a validation error", () => {
		assert.throws(
			() => parseConfig({ autoTitle: { model: "" } }),
			/autoTitle\.model/,
		);
		assert.throws(
			() => parseConfig({ autoTitle: { thinkingLevel: "" } }),
			/autoTitle\.thinkingLevel/,
		);
	});

	test("a non-object section is a validation error", () => {
		assert.throws(
			() => parseConfig({ autoTitle: "on" }),
			/autoTitle must be a JSON object/,
		);
		assert.throws(
			() => parseConfig({ statusIndicator: [] }),
			/statusIndicator must be a JSON object/,
		);
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

	test("an invalid field type falls back to the defaults and names the field", () => {
		const path = tempConfigPath();
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify({ autoTitle: { enabled: "yes" } }));
		const result = loadConfig(path);
		assert.deepEqual(result.config, DEFAULT_CONFIG);
		assert.match(result.warning ?? "", /autoTitle\.enabled/);
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
		const config = parseConfig({
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
		const config = parseConfig({
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

	test("an invalid threshold is rejected with the field named", () => {
		for (const thresholdSeconds of [0, -5, "30", null, true]) {
			assert.throws(
				() =>
					parseConfig({
						statusIndicator: {
							stallDetection: { thresholdSeconds },
						},
					}),
				/statusIndicator\.stallDetection\.thresholdSeconds/,
			);
		}
	});

	test("an invalid stalled marker type is rejected with the field named", () => {
		assert.throws(
			() => parseConfig({ statusIndicator: { stalled: 7 } }),
			/statusIndicator\.stalled/,
		);
	});

	test("an invalid stallDetection section is rejected with the field named", () => {
		assert.throws(
			() => parseConfig({ statusIndicator: { stallDetection: "off" } }),
			/statusIndicator\.stallDetection/,
		);
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
