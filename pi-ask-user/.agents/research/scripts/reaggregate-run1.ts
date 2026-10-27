// Re-aggregate a saved run1 eval-results file (whose committed `summary` was
// produced by an earlier buggy aggregation that counted errored calls as
// "did not ask"). Recomputes the summary from the raw rows with corrected
// rules: only successful outcomes (`asked` / `answered`) enter the recall and
// false-call denominators; transport errors (429/other) and HTTP-400
// tool-arg rejections are counted separately. Violations are recomputed from
// the saved parsed `questions` arrays (run1 predates the eval.ts validator).
//
// Run: node reaggregate-run1.ts <eval-results-file>
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
	console.error("usage: node reaggregate-run1.ts <eval-results-file>");
	process.exit(1);
}
const data = JSON.parse(fs.readFileSync(file, "utf8"));
type Row = {
	variant: string;
	caseId?: string;
	c?: { id: string };
	asked: boolean | null;
	questionCount?: number;
	questions?: unknown;
	error?: string;
};
const rows: Row[] = data.results ?? data.rows;
for (const r of rows) {
	r.caseId = r.caseId ?? r.c?.id;
}

const EXPECT: Record<string, string> = {
	T01: "ask",
	T02: "ask",
	T03: "ask",
	T04: "ask",
	T05: "no_ask",
	T06: "no_ask",
	T07: "no_ask",
	T08: "ask",
	T09: "ask",
	T10: "no_ask",
	T11: "no_ask",
	T12: "discretionary",
};
const CASE_IDS = Object.keys(EXPECT);
const RESERVED = new Set(["Other", "Type something.", "Next"]);

/** Same checks as the run1-era standalone validator (schema limits + reserved labels). */
function validateQuestions(questions: unknown): string[] {
	const v: string[] = [];
	if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) {
		v.push("questions count");
		return v;
	}
	for (const q of questions as Record<string, unknown>[]) {
		const header = q.header;
		if (typeof header !== "string" || header.length < 1 || header.length > 16) v.push("header length");
		const options = q.options;
		if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
			v.push("options count");
			continue;
		}
		for (const o of options as Record<string, unknown>[]) {
			const label = o.label;
			if (typeof label !== "string" || label.length < 1 || label.length > 60) v.push("label length");
			if (RESERVED.has(label as string)) v.push("reserved label");
			if (q.multiSelect === true && typeof o.preview === "string") v.push("preview with multiSelect");
		}
	}
	return v;
}

const summary: Record<string, unknown> = {};
for (const variant of [...new Set(rows.map((r) => r.variant))]) {
	const variantRows = rows.filter((r) => r.variant === variant);
	const valid = variantRows.filter((r) => r.asked !== null);
	const errored = variantRows.filter((r) => r.asked === null);
	const http400 = errored.filter((r) => (r.error ?? "").includes("400")).length;
	let askHit = 0;
	let askTotal = 0;
	let falseCalls = 0;
	let falseTotal = 0;
	const violations: string[] = [];
	const perCase: Record<string, unknown> = {};
	for (const id of CASE_IDS) {
		const caseValid = valid.filter((r) => r.caseId === id);
		const asked = caseValid.filter((r) => r.asked === true);
		const caseViolations = asked.flatMap((r) => validateQuestions(r.questions));
		violations.push(...caseViolations);
		perCase[id] = {
			expect: EXPECT[id],
			asked: `${asked.length}/${caseValid.length}`,
			questionCounts: asked.map((r) => r.questionCount ?? 0),
			violations: [...new Set(caseViolations)],
			errors: errored.filter((r) => r.caseId === id).length,
		};
		if (EXPECT[id] === "ask") {
			askTotal += caseValid.length;
			askHit += asked.length;
		}
		if (EXPECT[id] === "no_ask") {
			falseTotal += caseValid.length;
			falseCalls += asked.length;
		}
	}
	const t09 = valid.filter((r) => r.caseId === "T09" && r.asked === true);
	summary[variant] = {
		validCalls: valid.length,
		erroredCalls: errored.length,
		erroredHttp400: http400,
		askRecall: `${askHit}/${askTotal}`,
		falseCallsOnNoAsk: `${falseCalls}/${falseTotal}`,
		schemaViolations: violations.length,
		violationKinds: [...new Set(violations)],
		T09_batched: `${t09.filter((r) => (r.questionCount ?? 0) >= 2).length}/${t09.length}`,
		perCase,
	};
}

data.summary = summary;
data.note =
	"summary recomputed by reaggregate-run1.ts; errored calls (429/HTTP-400) are excluded from the recall and false-call denominators";
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
