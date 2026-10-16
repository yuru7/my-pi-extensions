import type { Api, Model } from "@earendil-works/pi-ai";
import type { GradedEffort } from "./messages.ts";

let selectedAdvisor: Model<Api> | undefined;
let selectedAdvisorEffort: GradedEffort | undefined;

export function getAdvisorModel(): Model<Api> | undefined {
	return selectedAdvisor;
}

export function setAdvisorModel(model: Model<Api> | undefined): void {
	selectedAdvisor = model;
}

export function getAdvisorEffort(): GradedEffort | undefined {
	return selectedAdvisorEffort;
}

export function setAdvisorEffort(effort: GradedEffort | undefined): void {
	selectedAdvisorEffort = effort;
}
