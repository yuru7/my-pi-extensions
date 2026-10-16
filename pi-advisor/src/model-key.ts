/**
 * `provider/modelId` codec. A legacy `provider:modelId` value is accepted on
 * read and canonicalized to the slash form. The first separator wins, so a
 * model id may itself contain the other character.
 */

export interface ParsedModelKey {
	provider: string;
	modelId: string;
}

export function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function advisorModelLabel(model: { provider: string; id: string }): string {
	return `${model.provider}:${model.id}`;
}

export function parseModelKey(key: string): ParsedModelKey | undefined {
	const trimmed = key.trim();
	if (trimmed.length === 0) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash > 0 && slash < trimmed.length - 1) {
		return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
	}
	const colon = trimmed.indexOf(":");
	if (colon > 0 && colon < trimmed.length - 1) {
		return { provider: trimmed.slice(0, colon), modelId: trimmed.slice(colon + 1) };
	}
	return undefined;
}

export function canonicalModelKey(entry: string): string {
	const parsed = parseModelKey(entry);
	return parsed ? `${parsed.provider}/${parsed.modelId}` : entry;
}
