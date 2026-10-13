/**
 * Model and thinking level resolution for title generation.
 *
 * Resolution only reads the Pi session's model state, it never changes it:
 * `CURRENT` picks the active session model (or thinking level) at the moment
 * generation starts, an explicit `provider/model-id` is looked up in Pi's model
 * registry and must have credentials. Thinking levels are adjusted to the
 * target model with Pi's own clamping rules, so a level the model cannot honor
 * is lowered (or raised) to the nearest supported one.
 *
 * Failures carry a {@link FailureKind} category, so warnings can say why a
 * fallback happened without echoing provider error text.
 */

import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	CURRENT_MODEL,
	CURRENT_THINKING_LEVEL,
	type AutoTitleSettings,
} from "./config.ts";

/** Why a model attempt cannot run, or why its request failed. */
export type FailureKind =
	| "not-found"
	| "no-credentials"
	| "no-model"
	| "timeout"
	| "call-failure";

/** User-facing labels for {@link FailureKind}; they never carry provider error text. */
export const FAILURE_LABELS: Record<FailureKind, string> = {
	"not-found": "model not registered",
	"no-credentials": "no credentials",
	"no-model": "no usable model",
	timeout: "timed out",
	"call-failure": "call failed",
};

/** Everything resolution needs to know about the running Pi session. */
export interface SessionModelInfo {
	/** Active session model at generation start. */
	currentModel: Model<Api> | undefined;
	/** Active session thinking level at generation start. */
	currentThinkingLevel: ModelThinkingLevel;
	/** Registry lookup for an explicit `provider/model-id` reference. */
	findModel(reference: string): Model<Api> | undefined;
	/** Whether Pi can supply credentials for the model. */
	hasAuth(model: Model<Api>): boolean;
}

/** One planned attempt at generating a title with a specific model. */
export interface ModelAttempt {
	model: Model<Api>;
	/** Thinking level to request, already adjusted to the model. */
	thinkingLevel: ModelThinkingLevel;
	/** Set on the fallback attempt: the configured reference that could not be used. */
	fallbackFrom?: string;
	/** Set on the fallback attempt: the detailed reason of the first failure, for logs. */
	fallbackReason?: string;
	/** Set on the fallback attempt: the safe reason category of the first failure. */
	fallbackKind?: FailureKind;
	/** Log line when the configured thinking level had to be adjusted. */
	log?: string;
}

export interface ModelPlan {
	/** Attempts in order: the configured model first, then at most one fallback. */
	attempts: ModelAttempt[];
	/** Why no attempt could be planned at all. */
	failure?: string;
}

export type ModelResolution =
	| { ok: true; model: Model<Api> }
	| { ok: false; reason: string; kind: FailureKind };

/** Canonical `provider/model-id` label used in logs and warnings. */
export function describeModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function sameModel(left: Model<Api>, right: Model<Api>): boolean {
	return left.provider === right.provider && left.id === right.id;
}

/**
 * Resolve the configured thinking level against `model`.
 *
 * `CURRENT` uses the session's active level. The result is clamped with Pi's
 * thinking level rules; an adjusted result carries a log line.
 */
export function resolveThinkingLevel(
	requested: string,
	model: Model<Api>,
	currentLevel: ModelThinkingLevel,
): { level: ModelThinkingLevel; log?: string } {
	const wanted: ModelThinkingLevel =
		requested === CURRENT_THINKING_LEVEL
			? currentLevel
			: (requested as ModelThinkingLevel);
	const level = clampThinkingLevel(model, wanted);
	if (level === wanted) return { level };
	return {
		level,
		log: `pi-auto-title: thinking level "${wanted}" is not available on ${describeModel(
			model,
		)}; using "${level}"`,
	};
}

/** Resolve one model reference without any fallback. */
export function resolveModel(
	reference: string,
	info: SessionModelInfo,
): ModelResolution {
	if (reference === CURRENT_MODEL) {
		return info.currentModel === undefined
			? {
					ok: false,
					reason: "the session has no active model",
					kind: "no-model",
				}
			: { ok: true, model: info.currentModel };
	}
	const model = info.findModel(reference);
	if (model === undefined) {
		return {
			ok: false,
			reason: `model ${reference} is not in the model registry`,
			kind: "not-found",
		};
	}
	if (!info.hasAuth(model)) {
		return {
			ok: false,
			reason: `no credentials for ${describeModel(model)}`,
			kind: "no-credentials",
		};
	}
	return { ok: true, model };
}

function buildAttempt(
	model: Model<Api>,
	settings: AutoTitleSettings,
	currentLevel: ModelThinkingLevel,
): ModelAttempt {
	const { level, log } = resolveThinkingLevel(
		settings.thinkingLevel,
		model,
		currentLevel,
	);
	return { model, thinkingLevel: level, log };
}

/**
 * Plan the model attempts for one generation run.
 *
 * The configured model runs first. When `fallbackToCurrentModel` allows it, the
 * current session model is planned as a single fallback, unless it is the same
 * model that already failed. Nothing is planned when the configured model
 * cannot be used and no fallback exists; `failure` then carries the reason.
 */
export function planModelAttempts(
	settings: AutoTitleSettings,
	info: SessionModelInfo,
): ModelPlan {
	const primary = resolveModel(settings.model, info);
	const fallbackModel = settings.fallbackToCurrentModel
		? info.currentModel
		: undefined;
	const useFallback =
		fallbackModel !== undefined &&
		(!primary.ok || !sameModel(primary.model, fallbackModel));

	const attempts: ModelAttempt[] = [];
	if (primary.ok) {
		attempts.push(
			buildAttempt(primary.model, settings, info.currentThinkingLevel),
		);
	}

	if (useFallback && fallbackModel !== undefined) {
		const attempt = buildAttempt(
			fallbackModel,
			settings,
			info.currentThinkingLevel,
		);
		attempts.push({
			...attempt,
			fallbackFrom: primary.ok ? describeModel(primary.model) : settings.model,
			fallbackReason: primary.ok ? "the title request failed" : primary.reason,
			fallbackKind: primary.ok ? "call-failure" : primary.kind,
		});
	}

	if (attempts.length === 0) {
		return {
			attempts,
			failure: primary.ok
				? "no model available for title generation"
				: `${primary.reason}${
						settings.fallbackToCurrentModel
							? ""
							: " (fallbackToCurrentModel is off)"
					}`,
		};
	}
	return { attempts };
}
