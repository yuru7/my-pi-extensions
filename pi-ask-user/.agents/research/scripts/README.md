# wave-2 research scripts

Reproducibility helpers for `.agents/research/wave-2-evaluation.md`
(pi-ask-user guidance optimization, plan `.agents/plan/wave-2.md`).

## Files

- `measure.ts` — token measurements (o200k_base) for three guidance variants:
  rpiv-ask-user-question at pinned commit `d3c6f0812140605a4e55e0a660eb83edc12abbc5`,
  pi-ask-user before the change (`5c0b0a3`), and the current working tree.
- `rpiv-schema.ts` — verbatim copy of the upstream schema section at that pinned
  SHA (byte-verified on fetch).
- `eval.ts` — tool-selection evaluation harness. Three variants share the same
  tool name, schema, and system-prompt scaffold; only the guidance texts differ.
  Runs against Groq (OpenAI-compatible), model `openai/gpt-oss-120b`, and
  validates every tool call with the extension's own runtime validator
  (`validateQuestionnaire`) plus schema limits. Provider-rejected arguments
  (HTTP 400) are recorded as `invalid_args` outcomes, and transport errors as
  `error` outcomes; both are excluded from the recall / false-call denominators
  and reported per variant. Each run writes a timestamped
  `eval-results-<timestamp>.json`.

## Setup

```sh
cd .agents/research/scripts
pnpm add gpt-tokenizer@4.1.0   # measure.ts only; installed into the gitignored node_modules/
```

`eval.ts` requires `GROQ_API_KEY` in the environment and no dependency.

## Run

```sh
node measure.ts            # prints per-part token tables for the three variants
node eval.ts --selftest    # API-free check of the validator and aggregator
node eval.ts               # all variants, 12 cases x 1 repeat (throttled for Groq TPM)
node eval.ts C_proposed    # single variant
```

Set `REPEATS` / `CONCURRENCY` at the top of `eval.ts` before longer runs, and
expect Groq daily token budgets (TPD) to cap how much fits in one day.

## Notes

- Token numbers are o200k_base estimates, not provider-billed tokens.
- The evaluation is a single-turn proxy: the harness has no codebase, so cases
  whose "obvious" answer would require reading files (T05/T07) may over-report
  asks for every variant.
