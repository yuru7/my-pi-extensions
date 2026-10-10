import { afterEach, describe, expect, it, vi } from "vitest";
import { getEscalationBroker, type ParentApprovalChannel, resetEscalationBrokerForTests } from "../src/escalation-broker";

/** Build a parent-channel fake: hasUI can be toggled; select/input record calls and return fixed values. */
function fakeChannel(sessionId: string, hasUI = true, choice: string | undefined = "Allow once") {
	const select = vi.fn(async () => choice);
	const input = vi.fn(async (_title: string, _placeholder?: string) => "because");
	const channel: ParentApprovalChannel = { sessionId, hasUI: () => hasUI, select, input };
	return { channel, select, input };
}

afterEach(() => {
	// Reset the module-level global slot across tests (testing.md: module singletons must be reset explicitly)
	resetEscalationBrokerForTests();
});

describe("getEscalationBroker", () => {
	it("globalThis singleton: repeated calls return the same object, and reset replaces it with a new object", () => {
		const first = getEscalationBroker();
		expect(getEscalationBroker()).toBe(first);
		resetEscalationBrokerForTests();
		expect(getEscalationBroker()).not.toBe(first);
	});
});

describe("resolveChannel (strict routing, spec §2 D3)", () => {
	it("link + registered parent → hits the parent channel", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("parent-1");
		broker.registerParent(channel);
		broker.linkChild("child-1", "parent-1");
		expect(broker.resolveChannel("child-1")).toBe(channel);
	});

	it("no link → null (Review Focus #4: do not guess the only interactive session in the process)", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("parent-1");
		broker.registerParent(channel);
		expect(broker.resolveChannel("orphan")).toBeNull();
	});

	it("parent unregistered (after session_shutdown) → null (Review Focus #4)", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("parent-1");
		broker.registerParent(channel);
		broker.linkChild("child-1", "parent-1");
		broker.unregisterParent("parent-1");
		expect(broker.resolveChannel("child-1")).toBeNull();
	});

	it("parent registered but hasUI() is false → null (Review Focus #4)", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("parent-1", false);
		broker.registerParent(channel);
		broker.linkChild("child-1", "parent-1");
		expect(broker.resolveChannel("child-1")).toBeNull();
	});

	it("child already disposed (unlink) → null", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("parent-1");
		broker.registerParent(channel);
		broker.linkChild("child-1", "parent-1");
		broker.unlinkChild("child-1");
		expect(broker.resolveChannel("child-1")).toBeNull();
	});

	it("depth-2: skip an intermediate session with no registered channel and hit the top-level parent", () => {
		const broker = getEscalationBroker();
		const { channel: top } = fakeChannel("top");
		broker.registerParent(top);
		broker.linkChild("mid", "top");
		broker.linkChild("leaf", "mid");
		expect(broker.resolveChannel("leaf")).toBe(top);
	});

	it("depth-2: the intermediate session is registered but has no UI → keep walking up", () => {
		const broker = getEscalationBroker();
		const { channel: top } = fakeChannel("top");
		const { channel: mid } = fakeChannel("mid", false);
		broker.registerParent(top);
		broker.registerParent(mid);
		broker.linkChild("mid", "top");
		broker.linkChild("leaf", "mid");
		expect(broker.resolveChannel("leaf")).toBe(top);
	});

	it("a cyclic link → null, and no infinite loop (Review Focus #3)", () => {
		const broker = getEscalationBroker();
		broker.linkChild("a", "b");
		broker.linkChild("b", "a");
		expect(broker.resolveChannel("a")).toBeNull();
	});

	it("a self-loop → null (Review Focus #3)", () => {
		const broker = getEscalationBroker();
		broker.linkChild("a", "a");
		expect(broker.resolveChannel("a")).toBeNull();
	});

	it("an ancestor chain longer than 32 → null, and no infinite loop (Review Focus #3)", () => {
		const broker = getEscalationBroker();
		for (let i = 0; i < 40; i++) {
			broker.linkChild(`s${i}`, `s${i + 1}`);
		}
		expect(broker.resolveChannel("s0")).toBeNull();
	});

	it("linkChild missing parentSessionId → no link is created", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("parent-1");
		broker.registerParent(channel);
		broker.linkChild("child-1", undefined);
		expect(broker.resolveChannel("child-1")).toBeNull();
	});

	it("an empty sessionId is neither registered as a parent nor used as the parent end of a link", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("");
		broker.registerParent(channel);
		broker.linkChild("child-1", "");
		expect(broker.resolveChannel("child-1")).toBeNull();
	});
});

describe("request (FIFO + abort, spec §4.6)", () => {
	it("passes title/options through and returns the user's choice; with no signal the third argument is undefined", async () => {
		const broker = getEscalationBroker();
		const { channel, select } = fakeChannel("parent-1");
		await expect(broker.request(channel, "T", ["Allow once", "Deny"])).resolves.toEqual({ choice: "Allow once" });
		expect(select).toHaveBeenCalledWith("T", ["Allow once", "Deny"], undefined);
	});

	it("when a signal is present it is passed through as opts.signal (the parent dialog can be closed on abort)", async () => {
		const broker = getEscalationBroker();
		const ac = new AbortController();
		let received: AbortSignal | undefined;
		const select = vi.fn(async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
			received = opts?.signal;
			return "Deny";
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select };
		await expect(broker.request(channel, "T", ["Allow once", "Deny"], ac.signal)).resolves.toEqual({ choice: "Deny" });
		expect(received).toBe(ac.signal);
	});

	it("FIFO: the second dialog does not open before the first settles, and results do not get crossed (Review Focus #5)", async () => {
		const broker = getEscalationBroker();
		const titles: string[] = [];
		const releases: ((value: string | undefined) => void)[] = [];
		const select = vi.fn((title: string) => new Promise<string | undefined>((resolve) => {
			titles.push(title);
			releases.push(resolve);
		}));
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select };
		const first = broker.request(channel, "t1", ["Allow once", "Deny"]);
		const second = broker.request(channel, "t2", ["Allow once", "Deny"]);
		await vi.waitFor(() => expect(titles).toEqual(["t1"]));
		releases[0]?.("Allow once");
		await expect(first).resolves.toEqual({ choice: "Allow once" });
		await vi.waitFor(() => expect(titles).toEqual(["t1", "t2"]));
		releases[1]?.("Deny");
		await expect(second).resolves.toEqual({ choice: "Deny" });
	});

	it("signal already aborted → select is not called, resolves undefined (Review Focus #2: no phantom approval dialog)", async () => {
		const broker = getEscalationBroker();
		const { channel, select } = fakeChannel("parent-1");
		const ac = new AbortController();
		ac.abort();
		await expect(broker.request(channel, "T", ["Allow once"], ac.signal)).resolves.toEqual({ choice: undefined });
		expect(select).not.toHaveBeenCalled();
	});

	it("abort while in flight → select receives the same signal and resolves undefined", async () => {
		const broker = getEscalationBroker();
		const ac = new AbortController();
		let received: AbortSignal | undefined;
		// Reproduce real pi TUI behavior: on abort, close the dialog and resolve undefined
		const select = vi.fn((_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
			new Promise<string | undefined>((resolve) => {
				received = opts?.signal;
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			}));
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select };
		const pending = broker.request(channel, "T", ["Allow once", "Deny"], ac.signal);
		await vi.waitFor(() => expect(received).toBe(ac.signal));
		ac.abort();
		await expect(pending).resolves.toEqual({ choice: undefined });
	});

	it("parent-side select throws → resolve undefined (treat as cancel; do not propagate and interrupt the subagent tool call)", async () => {
		const broker = getEscalationBroker();
		const select = vi.fn(async () => {
			throw new Error("ui exploded");
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select };
		await expect(broker.request(channel, "T", ["Allow once"])).resolves.toEqual({ choice: undefined });
	});

	it("a throw from the previous request does not affect later dequeue (Review Focus #5)", async () => {
		const broker = getEscalationBroker();
		let calls = 0;
		const select = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new Error("ui exploded");
			return "Allow once";
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select };
		await expect(broker.request(channel, "t1", ["Allow once"])).resolves.toEqual({ choice: undefined });
		await expect(broker.request(channel, "t2", ["Allow once"])).resolves.toEqual({ choice: "Allow once" });
	});
});

describe("resolveOwnChannel (this session's own channel, Ruling 17)", () => {
	it("registered and hasUI() is true → returns itself", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("self");
		broker.registerParent(channel);
		expect(broker.resolveOwnChannel("self")).toBe(channel);
	});

	it("not registered → null", () => {
		expect(getEscalationBroker().resolveOwnChannel("nobody")).toBeNull();
	});

	it("registered but hasUI() is false → null", () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("self", false);
		broker.registerParent(channel);
		expect(broker.resolveOwnChannel("self")).toBeNull();
	});

	it("hasUI() throws → null, and does not propagate (fail-closed, Minor 4)", () => {
		const broker = getEscalationBroker();
		broker.registerParent({
			sessionId: "boom",
			hasUI: () => {
				throw new Error("This extension ctx is stale");
			},
			select: async () => undefined,
		});
		broker.linkChild("c", "boom");
		expect(broker.resolveChannel("c")).toBeNull();
		expect(broker.resolveOwnChannel("boom")).toBeNull();
	});

	it("does not follow the link: even if this session has a link, it matches only itself by sessionId", () => {
		const broker = getEscalationBroker();
		const { channel: parent } = fakeChannel("parent");
		broker.registerParent(parent);
		broker.linkChild("self", "parent");
		expect(broker.resolveOwnChannel("self")).toBeNull();
		expect(broker.resolveChannel("self")).toBe(parent);
	});
});

describe("request's \"never rejects\" contract (pathological input, Minor 5)", () => {
	it("signal's aborted getter throws → resolve undefined, and do not reject", async () => {
		const broker = getEscalationBroker();
		const { channel } = fakeChannel("p");
		const hostile = {
			get aborted(): boolean {
				throw new Error("hostile signal");
			},
		} as AbortSignal;
		await expect(broker.request(channel, "T", ["Allow once"], hostile)).resolves.toEqual({ choice: undefined });
	});
});

describe("request: two-step Deny reason (select + input in the same FIFO task)", () => {
	const reasonPrompt = { title: "Why deny?", placeholder: "optional" };

	it("Deny + denialReason + channel.input → returns the reason", async () => {
		const broker = getEscalationBroker();
		const { channel, input } = fakeChannel("p", true, "Deny");
		await expect(broker.request(channel, "T", ["Allow once", "Deny"], undefined, reasonPrompt))
			.resolves.toEqual({ choice: "Deny", reason: "because" });
		expect(input).toHaveBeenCalledWith("Why deny?", "optional", undefined);
	});

	it("Allow once → does not prompt for a reason (input is called zero times)", async () => {
		const broker = getEscalationBroker();
		const { channel, input } = fakeChannel("p", true, "Allow once");
		await expect(broker.request(channel, "T", ["Allow once", "Deny"], undefined, reasonPrompt)).resolves.toEqual({ choice: "Allow once" });
		expect(input).not.toHaveBeenCalled();
	});

	it("channel has no input → returns { choice: 'Deny' } (a missing reason does not block the denial)", async () => {
		const broker = getEscalationBroker();
		const select = vi.fn(async () => "Deny");
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select };
		await expect(broker.request(channel, "T", ["Allow once", "Deny"], undefined, reasonPrompt)).resolves.toEqual({ choice: "Deny" });
	});

	it("input throws → returns { choice: 'Deny' } (a reason error does not change denial semantics, fail-closed)", async () => {
		const broker = getEscalationBroker();
		const select = vi.fn(async () => "Deny");
		const input = vi.fn(async () => {
			throw new Error("ui exploded");
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select, input };
		await expect(broker.request(channel, "T", ["Allow once", "Deny"], undefined, reasonPrompt)).resolves.toEqual({ choice: "Deny" });
	});

	it("signal abort is passed through to input (closes the reason dialog while in flight)", async () => {
		const broker = getEscalationBroker();
		const ac = new AbortController();
		let inputSignal: AbortSignal | undefined;
		const select = vi.fn(async () => "Deny");
		const input = vi.fn(async (_t: string, _p: string | undefined, opts?: { signal?: AbortSignal }) => {
			inputSignal = opts?.signal;
			return "ok";
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select, input };
		await broker.request(channel, "T", ["Allow once", "Deny"], ac.signal, reasonPrompt);
		expect(inputSignal).toBe(ac.signal);
	});

	it("FIFO atomicity: B must not open select before A's reason input settles (the host has only one dialog slot)", async () => {
		const broker = getEscalationBroker();
		const events: string[] = [];
		let releaseInput: ((value: string | undefined) => void) | undefined;
		const input = vi.fn((title: string) => {
			events.push(`input:${title}`);
			return new Promise<string | undefined>((resolve) => {
				releaseInput = resolve;
			});
		});
		const select = vi.fn(async (title: string) => {
			events.push(`select:${title}`);
			return "Deny";
		});
		const channel: ParentApprovalChannel = { sessionId: "p", hasUI: () => true, select, input };
		const first = broker.request(channel, "t1", ["Allow once", "Deny"], undefined, reasonPrompt);
		const second = broker.request(channel, "t2", ["Allow once", "Deny"], undefined, reasonPrompt);
		await vi.waitFor(() => expect(events).toEqual(["select:t1", "input:Why deny?"]));
		expect(select).toHaveBeenCalledTimes(1);
		releaseInput?.("r1");
		await expect(first).resolves.toEqual({ choice: "Deny", reason: "r1" });
		await vi.waitFor(() => expect(events).toEqual(["select:t1", "input:Why deny?", "select:t2", "input:Why deny?"]));
		releaseInput?.("r2");
		await expect(second).resolves.toEqual({ choice: "Deny", reason: "r2" });
	});
});
