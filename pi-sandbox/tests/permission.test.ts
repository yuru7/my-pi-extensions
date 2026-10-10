import { afterEach, describe, expect, it, vi } from "vitest";
import { createPermissionCommand, createPermissionState } from "../src/permission";

function makeCtx() {
	return { ui: { notify: vi.fn() } };
}

afterEach(async () => {
	// processPermissionState is now a process-level globalThis singleton: it must be reset across cases and across files
	const { resetPermissionStateForTests } = await import("../src/permission");
	resetPermissionStateForTests();
	vi.resetModules();
});

describe("createPermissionCommand", () => {
	it("no args: notifies the status text (describeStatus gets \"\" when ctx has no cwd)", async () => {
		const state = createPermissionState();
		const describeStatus = vi.fn(() => "STATUS-BLOCK");
		const cmd = createPermissionCommand({ state, describeStatus });
		const ctx = makeCtx();
		await cmd.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("STATUS-BLOCK", "info");
		expect(describeStatus).toHaveBeenCalledWith("", null); // C2: an empty string when there is no cwd; index falls back to the activate cwd
		expect(state.override).toBeNull();
	});
	it("no args: passes the command-session ctx.cwd through to describeStatus (C2)", async () => {
		const describeStatus = vi.fn(() => "S");
		const cmd = createPermissionCommand({ state: createPermissionState(), describeStatus });
		const ctx = { ...makeCtx(), cwd: "/some/session/cwd" };
		await cmd.handler("", ctx);
		expect(describeStatus).toHaveBeenCalledWith("/some/session/cwd", null);
	});
	it("valid mode: sets the process-level override", async () => {
		const state = createPermissionState();
		const cmd = createPermissionCommand({ state, describeStatus: () => "" });
		const ctx = makeCtx();
		await cmd.handler("danger-full-access", ctx);
		expect(state.override).toBe("danger-full-access");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("danger-full-access"), "info");
	});
	it("invalid mode: error notify listing the three modes, override untouched", async () => {
		const state = createPermissionState();
		const cmd = createPermissionCommand({ state, describeStatus: () => "" });
		const ctx = makeCtx();
		await cmd.handler("yolo", ctx);
		expect(state.override).toBeNull();
		const [msg, level] = ctx.ui.notify.mock.calls[0];
		expect(level).toBe("error");
		expect(msg).toContain("read-only");
		expect(msg).toContain("workspace-write");
		expect(msg).toContain("danger-full-access");
	});
	it("argument completions filter by prefix and carry value+label", () => {
		const cmd = createPermissionCommand({ state: createPermissionState(), describeStatus: () => "" });
		expect(cmd.getArgumentCompletions("w")).toEqual([{ value: "workspace-write", label: "workspace-write" }]);
		expect(cmd.getArgumentCompletions("")).toHaveLength(3);
	});
});

describe("processPermissionState shared across module instances (a child session with a different cwd / a reload re-imports the extension)", () => {
	it("stays the same object after the module is re-imported, and still sees the override that was set", async () => {
		const { processPermissionState } = await import("../src/permission");
		processPermissionState.override = "danger-full-access";

		// Simulate the host dropping its extension module cache: the loader tokens on (cwd, generation), and a token change
		// calls clearExtensionCache() + createJiti({ moduleCache: false }) to re-import
		// (pi dist/core/extensions/loader.js). vitest's resetModules is equivalent.
		vi.resetModules();
		const { processPermissionState: reimported } = await import("../src/permission");

		expect(reimported).toBe(processPermissionState); // must be the same globalThis singleton
		expect(reimported.override).toBe("danger-full-access"); // the override set by the parent session is visible to the "newly imported instance"
	});

	it("resetPermissionStateForTests clears the global slot, and the next import returns to the default state", async () => {
		const mod = await import("../src/permission");
		mod.processPermissionState.override = "read-only";
		mod.resetPermissionStateForTests();

		vi.resetModules();
		const { processPermissionState: fresh } = await import("../src/permission");

		expect(fresh).not.toBe(mod.processPermissionState); // the old reference has left the global slot
		expect(fresh.override).toBeNull();
	});
});
