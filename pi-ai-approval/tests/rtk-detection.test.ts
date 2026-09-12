// pi-lens-ignore: find-import-file-without-extension
import assert from "node:assert/strict";
import test from "node:test";
import { commandContainsRtk, shellActionContainsRtk } from "../src/rtk-detection.ts";

test("detects RTK invocations rewritten by pi-rtk-optimizer", () => {
	for (const command of [
		"rtk read package.json",
		"rtk read src/policy.ts --max-lines 5",
		"rtk ls -la",
		"rtk grep TODO src",
		'rtk find . -name "*.ts"',
		"rtk git status",
		"rtk git commit -m test",
		"rtk pnpm install",
		"rtk docker rm foo",
		"rtk kubectl delete pod foo",
		"rtk foo bar",
		"rtk",
		"  rtk ls",
		"rtk read ~/.ssh/id_rsa",
	]) {
		assert.equal(commandContainsRtk(command), true, command);
	}
});

test("detects RTK inside compound commands", () => {
	for (const command of [
		"echo hi && rtk ls",
		"grep foo . | rtk grep -v node_modules",
		"rtk git status; rtk read x",
		"rtk ls & rtk git status",
		"echo hi\nrtk ls",
	]) {
		assert.equal(commandContainsRtk(command), true, command);
	}
});

test("detects RTK after a heredoc closes but not inside the body", () => {
	assert.equal(
		commandContainsRtk("cat <<EOF\nbody\nEOF\nrtk ls"),
		true,
	);
	assert.equal(
		commandContainsRtk("cat <<-EOF\n\tbody\n\tEOF\nrtk ls"),
		true,
	);
	for (const command of [
		"cat <<'EOF'\nrtk git status\nEOF",
		"cat <<EOF\nit's && rtk ls\nEOF",
		"cat <<EOF\n\tbody\nEOF\n",
	]) {
		assert.equal(commandContainsRtk(command), false, command);
	}
});

test("does not treat RTK as data, arguments, or non-command text", () => {
	for (const command of [
		"git status",
		"cat package.json && grep TODO src",
		"echo rtk",
		"grep rtk src",
		'echo "rtk ls"',
		"echo 'a && rtk ls'",
		"echo a\\&\\& rtk ls",
		"rtkfoo ls",
		'"rtk" ls',
		"rtk=1 ls",
	]) {
		assert.equal(commandContainsRtk(command), false, command);
	}
});

test("treats here-strings as arguments, not heredoc bodies", () => {
	assert.equal(
		commandContainsRtk('rtk grep foo <<< "bar"\necho next'),
		true,
	);
	assert.equal(
		commandContainsRtk('grep foo <<< "rtk bar"\nrtk ls'),
		true,
	);
});

test("gates RTK detection to shell actions", () => {
	assert.equal(
		shellActionContainsRtk({ tool: "bash", payload: { command: "rtk ls" } }),
		true,
	);
	assert.equal(
		shellActionContainsRtk({
			tool: "powershell",
			payload: { command: "rtk ls" },
		}),
		true,
	);
	assert.equal(
		shellActionContainsRtk({ tool: "read", payload: { command: "rtk ls" } }),
		false,
	);
	assert.equal(shellActionContainsRtk({ tool: "bash", payload: {} }), false);
	assert.equal(
		shellActionContainsRtk({ tool: "bash", payload: { command: 1 } }),
		false,
	);
});
