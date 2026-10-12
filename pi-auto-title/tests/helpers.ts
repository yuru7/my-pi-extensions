/** Shared fakes for pi-auto-title tests. */

import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StopReason,
} from "@earendil-works/pi-ai";
import type { AiClient, CompleteOptions } from "../src/generator.ts";

export function fakeModel(
	provider: string,
	id: string,
	reasoning = false,
): Model<Api> {
	return { provider, id, reasoning } as unknown as Model<Api>;
}

export function assistant(
	text: string,
	stopReason: StopReason = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: text === "" ? [] : [{ type: "text", text }],
		stopReason,
		errorMessage: stopReason === "error" ? "boom" : undefined,
	} as unknown as AssistantMessage;
}

export interface RecordedCall {
	model: Model<Api>;
	context: Context;
	options: CompleteOptions;
}

export type Responder = (
	call: RecordedCall,
) => Promise<AssistantMessage> | AssistantMessage;

export interface RecordingClient {
	client: AiClient;
	calls: RecordedCall[];
}

/** AI client that records every request and answers from a queue of responders. */
export function recordingClient(responders: Responder[]): RecordingClient {
	const calls: RecordedCall[] = [];
	const client: AiClient = {
		complete(model, context, options) {
			const call = { model, context, options };
			calls.push(call);
			const responder = responders.shift();
			if (responder === undefined)
				return Promise.reject(new Error("unexpected AI request"));
			return Promise.resolve(responder(call));
		},
	};
	return { client, calls };
}

/** Await pending microtasks and immediate callbacks. */
export function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
