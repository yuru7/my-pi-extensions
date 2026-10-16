# Prompt comparison

Baseline: `@juicesharp/rpiv-advisor` 2.13.8, commit `1ffa165c224b5489fb5774a6652ef2e1c3bc6b2a`. The original executor description, snippet, and seven guidelines are kept in `src/prompt.ts` as `BASELINE_*` and are not registered on the tool.

`standard` is the text this package registers. The advisor's own system prompt is unchanged from the baseline and is not part of these counts, because it is sent only on an advisor request.

## How the numbers were counted

Pi 0.85 does not export `buildSystemPrompt` from the package entry, but the installed `dist/core/system-prompt.js` is what the host uses. The test builds two prompts with that function: one with the advisor snippet and guidelines, and one without. The token delta of those two strings is the guidance count below. In this measurement it matched the token count of the exact lines Pi inserts (`- advisor: …` and one `- ` bullet per guideline).

The tool-definition count is the `o200k_base` token count of the stable JSON `{ name, description, parameters }`, where `parameters` is `Type.Object({})`.

Tokenizer: `gpt-tokenizer` `o200k_base`. This is an estimate of the text Pi constructs. It is not a provider's billed token count. No live Pi process was attached, and no model API was called.

The test `tests/prompt.test.ts` asserts these counts, so a prompt edit that changes them fails until the table is updated.

## Counts

| Item | Original | Standard |
| --- | ---: | ---: |
| Tool definition tokens | 95 | 52 |
| Prompt guidance tokens | 412 | 282 |
| Extension total | 507 | 334 |
| Reduction from the original | baseline | 34.1% |
| Advisor call reproduction rate | not measured | not measured |

34.1% is `(507 - 334) / 507`.

With advisor disabled, Pi's prompt builder does not receive the snippet or guidelines, and the tool is not in the active set, so this total is not added.

## Call behavior

The shortened guidelines still state each condition the plan requires:

1. Consult before substantive work or a major decision, including writing, editing, committing to an interpretation, or building on an assumption. Routine orientation does not require it.
2. Consult before declaring completion, after the deliverable is durable (written, saved, or committed).
3. Consult when stuck, after repeated failures, when the approach is not converging, when results do not fit, or when changing approach.
4. On multi-step work, consult before committing to an approach and before finishing. Most of the value is that first call, before the approach crystallizes. Skip a later call when tool output just read already dictates the next action.
5. Weight the advice unless empirical results or primary evidence contradict it. A passing self-test shows the test missed what the advice checks.
6. If advice conflicts with evidence already gathered, consult again and state both sides, instead of changing direction silently.
7. Quote or paraphrase the key guidance in the next visible reply. The tool description also says the advisor already sees every tool call and result.

`tests/prompt.test.ts` checks that those phrases are present. It does not run an executor model, so it cannot report a call rate, a rate of missed consultations, or a task-quality score. Those live trials were not run in this implementation pass. If a later trial shows a new miss, the guideline text should be restored toward the baseline before any further shortening.
