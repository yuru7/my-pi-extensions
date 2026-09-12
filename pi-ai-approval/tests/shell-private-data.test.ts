// pi-lens-ignore: find-import-file-without-extension
import assert from "node:assert/strict";
import test from "node:test";
import {
	commandReferencesPrivateData,
	looksLikePrivateGlob,
} from "../src/shell-private-data.ts";

test("matches literal private paths without glob syntax", () => {
	assert.equal(looksLikePrivateGlob(".env"), true);
	assert.equal(looksLikePrivateGlob("ID_RSA"), true);
	assert.equal(looksLikePrivateGlob("notes.txt"), false);
	assert.equal(looksLikePrivateGlob("src/app.ts"), false);
});

test("matches brace expansions against private candidates", () => {
	assert.equal(looksLikePrivateGlob("id_{rsa,ed25519}"), true);
	assert.equal(looksLikePrivateGlob("notes_{a,b}.txt"), false);
});

test("matches character classes against private candidates", () => {
	assert.equal(looksLikePrivateGlob("id_[re]sa"), true);
	assert.equal(looksLikePrivateGlob("id_[xyz]sa"), false);
});

test("treats invalid patterns as non-matching", () => {
	assert.equal(looksLikePrivateGlob("foo["), false);
	assert.equal(looksLikePrivateGlob("data[0].csv"), false);
	assert.equal(looksLikePrivateGlob("*"), false);
});

test("detects private references in shell commands", () => {
	assert.equal(
		commandReferencesPrivateData("cat ~/.ssh/id_rsa", "/repo"),
		true,
	);
	assert.equal(
		commandReferencesPrivateData("cat ~/.ssh/id_{rsa,ed25519}", "/repo"),
		true,
	);
	assert.equal(
		commandReferencesPrivateData("cat ~/.ssh/id_[re]sa", "/repo"),
		true,
	);
	assert.equal(
		commandReferencesPrivateData("cat src/app.ts data.csv", "/repo"),
		false,
	);
});

test("detects PowerShell private-data references", () => {
	for (const command of [
		"Get-Content $env:USERPROFILE\\.ssh\\id_rsa",
		"Get-Content ${env:USERPROFILE}\\.aws\\credentials",
		"Get-Content $env:HOME\\.kube\\config",
		"Get-Content $HOME\\.ssh\\config",
		"Get-Content ~\\.ssh\\id_rsa",
		"Get-Content $env:USERPROFILE\\.pi\\agent\\auth.json",
		'Get-Content "$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\Default\\Preferences"',
		"Get-ChildItem $env:APPDATA\\Mozilla\\Firefox\\Profiles\\default\\prefs.js",
		"Select-String -Path ~/.ssh/config -Pattern PRIVATE",
	]) {
		assert.equal(commandReferencesPrivateData(command, "/repo"), true, command);
	}

	for (const command of [
		"Get-ChildItem -Path .",
		"Get-Content src/app.ts",
		"Get-Content $env:TEMP\\notes.txt",
		"Get-Content $env:USERPROFILE\\Documents\\notes.txt",
		"Get-ChildItem $env:APPDATA\\MyApp\\cache.json",
	]) {
		assert.equal(commandReferencesPrivateData(command, "/repo"), false, command);
	}
});
