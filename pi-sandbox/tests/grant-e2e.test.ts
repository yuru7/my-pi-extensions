import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSandboxConfig } from "../src/config";
import { createPermissionState } from "../src/permission";
import { resetRunnerCache, selectRunner } from "../src/runners";
import { createSandboxTools } from "../src/tools";

resetRunnerCache();
const selected = selectRunner(5000);
const skipReason = (() => {
	if (process.platform === "win32")
		return "confined bash is unavailable on Windows";
	if (selected.runner === "unavailable") return "no usable sandbox runner";
	return undefined;
})();

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

describe.skipIf(skipReason !== undefined)(
	`deny → grant → retry through the real sandbox (${skipReason ?? selected.runner})`,
	() => {
		let fixture: string;
		let workspace: string;
		let outside: string;

		beforeAll(() => {
			fixture = mkdtempSync(join(process.cwd(), "grant-e2e-"));
			workspace = join(fixture, "workspace");
			outside = join(fixture, "outside");
			for (const dir of [workspace, outside, join(workspace, ".pi")])
				mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(workspace, ".pi", "pi-sandbox.json"),
				JSON.stringify({
					mode: "workspace-write",
					includeGitRoot: false,
					approvalMode: "allow-all",
				}),
			);
		});

		afterAll(() => {
			if (fixture) rmSync(fixture, { recursive: true, force: true });
		});

		const tools = () => {
			const config = loadSandboxConfig(workspace, join(fixture, "empty-agent"));
			return createSandboxTools({
				cwd: workspace,
				getConfig: () => config,
				permission: createPermissionState(),
				selected,
			});
		};

		const ctx = {
			cwd: workspace,
			hasUI: false,
			isProjectTrusted: () => true,
			sessionManager: {
				getSessionId: () => "grant-e2e",
				getSessionFile: () => undefined,
			},
		} as never;

		const text = (result: { content: { type: string; text?: string }[] }) =>
			result.content
				.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
				.join("\n");

		it("grants the denied directory and lets the exact retry succeed", async () => {
			const target = join(outside, "file.txt");
			const command = `echo ok > ${quote(target)}`;

			const denied = await tools().bash.execute(
				"grant-e2e-1",
				{ command, timeout: 30 },
				undefined,
				undefined,
				ctx,
			);
			expect(denied.isError).toBe(true);
			const deniedText = text(denied);
			expect(deniedText).toContain(
				"[sandbox: file access denied under workspace-write mode]",
			);
			expect(deniedText).toContain(outside);
			expect(existsSync(target)).toBe(false);

			const granted = await tools().grantWrite.execute(
				"grant-e2e-2",
				{ path: outside, justification: "the denied write lands here" },
				undefined,
				undefined,
				ctx,
			);
			expect(text(granted)).toContain("Granted write access");

			const retried = await tools().bash.execute(
				"grant-e2e-3",
				{ command, timeout: 30 },
				undefined,
				undefined,
				ctx,
			);
			expect(retried.isError).not.toBe(true);
			expect(existsSync(target)).toBe(true);
		}, 120_000);
	},
);
