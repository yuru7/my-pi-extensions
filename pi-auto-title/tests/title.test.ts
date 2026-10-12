import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	FALLBACK_DIRECTORY_NAME,
	formatTitle,
	normalizeTitle,
	TitleDisplay,
	truncateTitle,
	workspaceNameFromPath,
} from "../src/title.ts";

describe("formatTitle", () => {
	test("running state puts the running marker first", () => {
		assert.equal(
			formatTitle({
				statusEnabled: true,
				running: "⏳",
				idle: "✅",
				status: "running",
				title: "web-app",
			}),
			"⏳ Pi - web-app",
		);
	});

	test("idle state puts the idle marker first", () => {
		assert.equal(
			formatTitle({
				statusEnabled: true,
				running: "⏳",
				idle: "✅",
				status: "idle",
				title: "web-app",
			}),
			"✅ Pi - web-app",
		);
	});

	test("a disabled status indicator omits the marker entirely", () => {
		assert.equal(
			formatTitle({
				statusEnabled: false,
				running: "⏳",
				idle: "✅",
				status: "running",
				title: "web-app",
			}),
			"Pi - web-app",
		);
	});

	test("custom markers are used verbatim", () => {
		assert.equal(
			formatTitle({
				statusEnabled: true,
				running: "[run]",
				idle: "[ok]",
				status: "idle",
				title: "x",
			}),
			"[ok] Pi - x",
		);
	});

	test("an empty marker string shows no prefix", () => {
		assert.equal(
			formatTitle({
				statusEnabled: true,
				running: "",
				idle: "",
				status: "running",
				title: "x",
			}),
			"Pi - x",
		);
		assert.equal(
			formatTitle({
				statusEnabled: true,
				running: "",
				idle: "✅",
				status: "running",
				title: "x",
			}),
			"Pi - x",
		);
	});
});

describe("workspaceNameFromPath", () => {
	test("takes the trailing name of a POSIX path", () => {
		assert.equal(
			workspaceNameFromPath("/home/user/projects/web-app"),
			"web-app",
		);
		assert.equal(
			workspaceNameFromPath("/home/user/projects/web-form/"),
			"web-form",
		);
	});

	test("takes the trailing name of a Windows path", () => {
		assert.equal(
			workspaceNameFromPath("C:\\Users\\user\\projects\\api-server"),
			"api-server",
		);
		assert.equal(
			workspaceNameFromPath("C:\\Users\\user\\projects\\api-server\\"),
			"api-server",
		);
		assert.equal(workspaceNameFromPath("D:/work/pi-ext"), "pi-ext");
	});

	test("roots fall back to the workspace name", () => {
		assert.equal(workspaceNameFromPath("/"), FALLBACK_DIRECTORY_NAME);
		assert.equal(workspaceNameFromPath("C:\\"), FALLBACK_DIRECTORY_NAME);
		assert.equal(workspaceNameFromPath("C:/"), FALLBACK_DIRECTORY_NAME);
		assert.equal(workspaceNameFromPath(""), FALLBACK_DIRECTORY_NAME);
		assert.equal(workspaceNameFromPath("////"), FALLBACK_DIRECTORY_NAME);
	});
});

describe("truncateTitle", () => {
	test("keeps a title at or below the limit untouched", () => {
		assert.equal(truncateTitle("a".repeat(30)), "a".repeat(30));
		assert.equal(truncateTitle("短いタイトル"), "短いタイトル");
	});

	test("limits ASCII titles to 30 code points", () => {
		assert.equal(truncateTitle("b".repeat(31)), "b".repeat(30));
		assert.equal(Array.from(truncateTitle("b".repeat(80))).length, 30);
	});

	test("counts Unicode code points, not UTF-16 units", () => {
		const emoji = "🎉".repeat(40);
		const cut = truncateTitle(emoji);
		assert.equal(Array.from(cut).length, 30);
		assert.equal(cut, "🎉".repeat(30));
	});

	test("keeps a word boundary when the kept range has one", () => {
		const text = `${"a".repeat(16)} ${"b".repeat(5)} ${"c".repeat(20)}`;
		assert.equal(truncateTitle(text), `${"a".repeat(16)} ${"b".repeat(5)}`);
	});

	test("cuts directly when no boundary is available", () => {
		assert.equal(truncateTitle("あ".repeat(45)), "あ".repeat(30));
		assert.equal(
			truncateTitle(`ab cd${"e".repeat(40)}`),
			`ab cd${"e".repeat(25)}`,
		);
	});
});

describe("normalizeTitle", () => {
	test("keeps a clean title", () => {
		assert.equal(
			normalizeTitle("Lambdaフォーム公開API"),
			"Lambdaフォーム公開API",
		);
	});

	test("removes wrapping quotes and Markdown decoration", () => {
		assert.equal(
			normalizeTitle('"CircleCI設定移行レビュー"'),
			"CircleCI設定移行レビュー",
		);
		assert.equal(
			normalizeTitle("'CircleCI設定移行レビュー'"),
			"CircleCI設定移行レビュー",
		);
		assert.equal(
			normalizeTitle("**CircleCI設定移行レビュー**"),
			"CircleCI設定移行レビュー",
		);
		assert.equal(
			normalizeTitle("`CircleCI設定移行レビュー`"),
			"CircleCI設定移行レビュー",
		);
		assert.equal(
			normalizeTitle("「CircleCI設定移行レビュー」"),
			"CircleCI設定移行レビュー",
		);
		assert.equal(normalizeTitle("## タイトル生成"), "タイトル生成");
		assert.equal(normalizeTitle("- タイトル生成"), "タイトル生成");
	});

	test("removes newlines and control characters", () => {
		assert.equal(
			normalizeTitle("フォーム公開API\n改善"),
			"フォーム公開API 改善",
		);
		assert.equal(
			normalizeTitle("  フォーム公開API\u0000  "),
			"フォーム公開API",
		);
		assert.equal(normalizeTitle("タブ\t区切り"), "タブ 区切り");
	});

	test("rejects text with nothing usable", () => {
		assert.equal(normalizeTitle(""), undefined);
		assert.equal(normalizeTitle("   \n  "), undefined);
		assert.equal(normalizeTitle('""'), undefined);
		assert.equal(normalizeTitle("****"), undefined);
	});

	test("limits the result to 30 code points", () => {
		assert.equal(normalizeTitle("あ".repeat(50)), "あ".repeat(30));
		assert.equal(Array.from(normalizeTitle("🎉".repeat(50)) ?? "").length, 30);
	});
});

describe("TitleDisplay", () => {
	test("passes titles to setTitle and skips duplicates", () => {
		const shown: string[] = [];
		const display = new TitleDisplay((title) => shown.push(title));
		display.show("✅ Pi - web-app");
		display.show("⏳ Pi - web-app");
		display.show("⏳ Pi - web-app");
		display.show("✅ Pi - web-app");
		assert.deepEqual(shown, [
			"✅ Pi - web-app",
			"⏳ Pi - web-app",
			"✅ Pi - web-app",
		]);
		assert.equal(display.last, "✅ Pi - web-app");
	});

	test("starts empty", () => {
		const display = new TitleDisplay(() => {});
		assert.equal(display.last, undefined);
	});

	test("force re-sends an unchanged title", () => {
		const shown: string[] = [];
		const display = new TitleDisplay((title) => shown.push(title));
		display.show("Pi - web-app");
		display.show("Pi - web-app");
		display.show("Pi - web-app", true);
		assert.deepEqual(shown, ["Pi - web-app", "Pi - web-app"]);
	});
});
