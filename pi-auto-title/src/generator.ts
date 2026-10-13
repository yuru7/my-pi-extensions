/**
 * AI title generation for pi-auto-title.
 *
 * One generation run takes the session's first user message, asks a model for a
 * short title, and normalizes the answer. The run is independent of the main
 * agent: it uses its own request, its own deadline, and its own abort signal,
 * so a slow or broken title request can never block or fail the agent.
 *
 * The whole run, authentication and fallback included, shares one deadline.
 * When the configured model cannot be used, one fallback to the current session
 * model is allowed and announced up front with a safe reason category; a
 * cancelled run never falls back. When everything fails, the directory name
 * stays and the agent keeps working.
 */

import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { AutoTitleSettings } from "./config.ts";
import {
	describeModel,
	FAILURE_LABELS,
	planModelAttempts,
	type FailureKind,
	type ModelAttempt,
	type SessionModelInfo,
} from "./model.ts";
import { normalizeTitle } from "./title.ts";

/** Deadline for one generation run, covering authentication and fallback. */
export const TITLE_GENERATION_TIMEOUT_MS = 30_000;

/** Upper bound for the user text sent to the title model. */
export const MAX_INPUT_CHARS = 2_000;

const TITLE_SYSTEM_PROMPT = `You write a short tab title for a coding session.

Rules:
- The title describes what the user is working on.
- Match the language of the user's input; Japanese input gets a Japanese title.
- At most 30 characters. Prefer 10 to 20 characters.
- Keep it as short and concrete as possible.
- Prefer the goal of the work over the mere topic.
- Output the title only: no quotes, no explanation, no Markdown.
- Do not start with "Pi -" or a status icon.
- Never invent facts that are not in the input.

Examples:

Input:
AWS Lambdaでフォーム公開APIを実装したい

Output:
Lambdaフォーム公開API

Input:
CircleCIのDynamic Configurationへの
移行内容をレビューして

Output:
CircleCI設定移行レビュー`;

/** Options handed to the AI client for one title request. */
export interface CompleteOptions {
	/** Thinking level to request; undefined requests no thinking. */
	reasoning: ThinkingLevel | undefined;
	/** Aborted when the run is cancelled or hits its deadline. */
	signal: AbortSignal;
	/** Provider request timeout in milliseconds. */
	timeoutMs: number;
}

/** Minimal AI surface needed for title generation. */
export interface AiClient {
	complete(
		model: Model<Api>,
		context: Context,
		options: CompleteOptions,
	): Promise<AssistantMessage>;
}

export interface GenerateTitleOptions {
	/** The `autoTitle` part of the configuration. */
	settings: AutoTitleSettings;
	/** Session model information captured when generation starts. */
	info: SessionModelInfo;
	/** Client running the title request. */
	client: AiClient;
	/** First user message of the session. */
	firstUserText: string;
	/** Aborted by the caller to cancel the run (session switch, reload, tree). */
	signal?: AbortSignal;
	/** Called once, when a fallback attempt is about to run. */
	onFallback?: (warning: string) => void;
	/**
	 * Called once per user-visible issue: a thinking-level adjustment, or the
	 * run giving up. Text carries model references and fixed reason categories
	 * only; provider error text and details stay in the log.
	 */
	onIssue?: (message: string) => void;
	/** Deadline for the whole run; defaults to {@link TITLE_GENERATION_TIMEOUT_MS}. */
	timeoutMs?: number;
	/** Log sink for fallback and failure details. */
	log?: (message: string) => void;
}

export interface GenerateTitleResult {
	/** Generated title, or undefined when generation gave up. */
	title?: string;
	/** Why no title was produced; detailed and only used for logging. */
	reason?: string;
}

/** Text blocks of an assistant message, concatenated. */
export function assistantText(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("");
}

function clipInput(text: string): string {
	return text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
}

/** Build the minimal request context: the title prompt plus the first user message. */
export function buildTitleContext(firstUserText: string): Context {
	return {
		systemPrompt: TITLE_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: clipInput(firstUserText),
				timestamp: Date.now(),
			},
		],
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const SECRET_LIKE =
	/(?:\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}|\bBearer\s+[A-Za-z0-9._~+/=-]+)/g;

/** Best-effort hiding of credential-looking material from log lines. */
export function redactSecrets(message: string): string {
	return message.replace(SECRET_LIKE, "[redacted]");
}

/** Categorize a request failure; timeouts get their own safe category. */
function requestFailureKind(error: unknown): FailureKind {
	const name = error instanceof Error ? error.name : "";
	const message = errorMessage(error).toLowerCase();
	if (
		name === "TimeoutError" ||
		/\btimed?\s?out\b|\betimedout\b|timeout/.test(message)
	) {
		return "timeout";
	}
	return "call-failure";
}

/**
 * Settle `work` when it finishes or when `signal` aborts, whichever comes
 * first. A client that ignores the signal cannot hold the run past the abort.
 */
function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

interface AttemptOutcome {
	title?: string;
	reason?: string;
	kind: FailureKind;
}

async function runAttempt(
	attempt: ModelAttempt,
	context: Context,
	client: AiClient,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<AttemptOutcome> {
	try {
		const message = await raceWithAbort(
			client.complete(attempt.model, context, {
				reasoning:
					attempt.thinkingLevel === "off" ? undefined : attempt.thinkingLevel,
				signal,
				timeoutMs,
			}),
			signal,
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return {
				reason: redactSecrets(
					message.errorMessage ??
						`the request ended with ${message.stopReason}`,
				),
				kind: "call-failure",
			};
		}
		const title = normalizeTitle(assistantText(message));
		if (title === undefined) {
			return {
				reason: "the model returned no usable title",
				kind: "call-failure",
			};
		}
		return { title, kind: "call-failure" };
	} catch (error) {
		return {
			reason: redactSecrets(errorMessage(error)),
			kind: requestFailureKind(error),
		};
	}
}

/**
 * Screen-safe summary of a failed attempt: the fixed reason category only.
 * Provider error text and other details stay in the log, so nothing that a
 * provider might echo back (credentials, request bodies) can reach the screen.
 */
function failureSummary(kind: FailureKind | undefined): string {
	return kind === undefined ? "call failed" : FAILURE_LABELS[kind];
}

/**
 * Warning shown when the configured model is replaced by the current one.
 *
 * Only the model references and a fixed reason category appear here; provider
 * error text stays in the log, so no credential can reach the screen.
 */
function fallbackWarning(
	attempt: ModelAttempt,
	target: Model<Api>,
	kind: FailureKind,
): string {
	return `pi-auto-title: the configured model ${attempt.fallbackFrom} is unavailable; fell back to the current model ${describeModel(
		target,
	)} (reason: ${FAILURE_LABELS[kind]})`;
}

/**
 * Generate a title from the session's first user message.
 *
 * Runs the planned model attempts in order and stops at the first success, so a
 * fallback happens at most once and only while the run is still wanted. The
 * deadline covers the whole run: when it expires, generation gives up instead of
 * starting another attempt.
 */
export async function generateTitle(
	options: GenerateTitleOptions,
): Promise<GenerateTitleResult> {
	const log = options.log ?? (() => {});
	const timeoutMs = options.timeoutMs ?? TITLE_GENERATION_TIMEOUT_MS;

	if (!options.settings.enabled)
		return { reason: "title generation is disabled" };
	if (options.signal?.aborted)
		return { reason: "the generation was cancelled" };

	const plan = planModelAttempts(options.settings, options.info);
	if (plan.attempts.length === 0) {
		const reason = plan.failure ?? "no model available for title generation";
		log(`pi-auto-title: ${reason}`);
		options.onIssue?.(`pi-auto-title: title generation failed: ${reason}`);
		return { reason };
	}

	const context = buildTitleContext(options.firstUserText);
	const run = new AbortController();
	const timer = setTimeout(() => run.abort(), timeoutMs);
	const external = options.signal;
	const onExternalAbort = () => run.abort();
	external?.addEventListener("abort", onExternalAbort, { once: true });

	const stopReason = () =>
		external?.aborted
			? "the generation was cancelled"
			: `timed out after ${timeoutMs}ms`;

	try {
		let failure: string | undefined;
		let failureKind: FailureKind | undefined;
		for (const attempt of plan.attempts) {
			if (run.signal.aborted) return { reason: stopReason() };
			const kind = failureKind ?? attempt.fallbackKind ?? "call-failure";
			if (attempt.fallbackFrom !== undefined) {
				options.onFallback?.(fallbackWarning(attempt, attempt.model, kind));
			}
			if (attempt.log !== undefined) {
				log(attempt.log);
				options.onIssue?.(attempt.log);
			}
			const outcome = await runAttempt(
				attempt,
				context,
				options.client,
				run.signal,
				timeoutMs,
			);
			// A cancelled or expired run keeps nothing, not even an answer that
			// resolved at the same moment.
			if (run.signal.aborted) return { reason: stopReason() };
			if (outcome.title !== undefined) return { title: outcome.title };
			failure = outcome.reason;
			failureKind = outcome.kind;
			log(
				`pi-auto-title: title request on ${describeModel(attempt.model)} failed: ${failure}`,
			);
		}
		const reason = failure ?? "title generation failed";
		options.onIssue?.(
			`pi-auto-title: title generation failed: ${failureSummary(failureKind)}`,
		);
		return { reason };
	} finally {
		clearTimeout(timer);
		external?.removeEventListener("abort", onExternalAbort);
	}
}
