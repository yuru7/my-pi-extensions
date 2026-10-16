# pi-advisor

English | [日本語](./README_ja.md)

A [Pi](https://pi.dev) extension that gives the executor a zero-argument `advisor` tool. The executor can hand the current conversation branch to a stronger model and resume from that model's plan, correction, or stop signal.

The advisor prompt stays off the executor system prompt until you select a model. With no model selected, the tool is removed from the active set, so its description and guidelines are not sent.

## Install

```sh
pi install npm:@yuru7/pi-advisor
```

Restart Pi.

## Quick start

Run `/advisor`. The picker lists models Pi already has credentials for. Type to filter by model name, provider, or `provider/modelId`. Choose a model. If it supports reasoning, a second picker asks for the effort. `high` is marked recommended.

Pi confirms with `Advisor: <provider/modelId>, <effort>`, and the `advisor` tool becomes active for this session and later ones.

Choose **No advisor** to turn it off. Press Esc on the model picker to leave the current selection unchanged. Press Esc on the effort picker to keep the model and send no reasoning effort.

`/advisor` needs an interactive terminal. `pi --print` and RPC report `/advisor requires interactive mode`.

## What the executor is told

`standard` is the only prompt mode. While the tool is active, Pi adds a one-line snippet and seven guidelines. They tell the executor to consult before substantive work (writing, editing, an interpretation, or an assumption), before declaring completion after the deliverable is durable, and when stuck, not converging, or facing results that do not fit. Routine orientation does not require a call. On multi-step work, the first call before the approach crystallizes carries most of the value, and a later call is skipped when tool output just read already dictates the next action. Advice outweighs a passing self-test. A conflict goes back with both sides stated, and the key guidance is quoted or paraphrased in the next visible reply. The tool description says the advisor already sees every tool call and result.

The advisor's own instructions (return a plan, a correction, or a stop, and do not call tools) are sent only on the advisor request.

## What a call sends

`advisor()` takes no arguments. The extension reads the current conversation branch, including compaction and branch summaries, strips the in-flight `advisor` call, and prepends a tool inventory. The advisor request uses `tools: []`. The answer comes back only as the tool result. It is not inserted as a new user message.

Selecting a model from another provider sends the conversation, including tool results, to that provider. Do not pick a reviewer you would not trust with that transcript. API keys are not written to the config file or to logs. The extension does not store the conversation itself.

## Configuration

Settings are stored at `~/.pi/agent/pi-advisor.json` (Pi's agent directory). The file is created on the first successful `/advisor` save, with mode `0600` when the system allows it. A missing file means advisor is off. Invalid JSON is ignored and the extension uses defaults. `/advisor` rewrites only `model` and `effort`, so hand-edited keys stay.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `model` | string | absent | Reviewer model as `provider/modelId` |
| `effort` | string | absent | Reasoning effort. Absent means no `reasoning` value is sent |
| `promptMode` | string | `standard` | Built-in executor guidance. Only `standard` is implemented |
| `disabledForModels` | array | `[]` | Executor models that should not see the tool |
| `toolInventory` | string | `full` | How much tool information the advisor receives |
| `guidance` | object | built-in text | Optional `promptSnippet` and `promptGuidelines` overrides |

```json
{
  "model": "anthropic/claude-opus-4-5",
  "effort": "high",
  "promptMode": "standard",
  "toolInventory": "full",
  "disabledForModels": [
    "anthropic/claude-opus-4-5",
    { "model": "openai/gpt-5.2", "minEffort": "high" }
  ]
}
```

`toolInventory` accepts `full` (every registered tool's description and parameter schema), `active` (currently active tools), or `names` (names only). `full` matches the reference implementation's information. The inventory JSON is key-sorted and reused until a name, description, or schema changes.

`guidance` is read when the extension loads. Reload Pi after editing it. `toolInventory` is read on each advisor call. `disabledForModels` is applied again at session start and whenever the executor model or thinking level changes.

A string entry in `disabledForModels` disables advisor for that executor model at every effort. An object with `minEffort` disables it only when the executor's effort is at or above that level (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`). An unset effort, or `off`, does not match `minEffort`. Legacy `provider:modelId` keys are accepted and compared as `provider/modelId`.

Full field rules: [docs/configuration.md](./docs/configuration.md). Tool result shape: [docs/tool-reference.md](./docs/tool-reference.md).

## Prompt size

Compared with the rpiv-advisor 2.13.8 executor text, `standard` adds fewer tokens. The count uses the `o200k_base` tokenizer on the lines Pi's `buildSystemPrompt` inserts, plus the advisor tool schema. It is an estimate, not a provider bill. Details: [docs/comparison.md](./docs/comparison.md).

| | Original | Standard |
| --- | ---: | ---: |
| Tool definition | 95 | 52 |
| Prompt guidance | 412 | 282 |
| Total added by the extension | 507 | 334 |
| Reduction from the original | — | 34.1% |

When advisor is off, that text is not added.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The picker lists only **No advisor** | Authenticate a provider with Pi's `/login`, then run `/advisor` again |
| `Advisor (<model>) has no API key available.` | Re-authenticate that provider. OAuth models use Pi's runtime credentials when the host exposes them |
| `Previously configured advisor model <key> is no longer available` | The saved model left the registry. Pick another with `/advisor` |
| `Failed to save advisor selection` | The config file could not be written. The previous selection is unchanged |
| Advisor never appears for the current model | That executor model is in `disabledForModels` for the current effort |

## Known limits

- The advisor does not edit files, run tools, or switch the executor model.
- Only `standard` prompt mode is implemented. Another `promptMode` value is ignored and `standard` is used.
- Live model trials of advisor call rate were not run. The comparison test checks that the shortened guidelines still contain each required decision, and that the token count is lower. It does not measure how often a model calls the tool.
- `guidance` changes apply on the next extension load.

## Acknowledgements

This extension was inspired by [`rpiv-advisor`](https://github.com/juicesharp/rpiv-mono/tree/1ffa165c224b5489fb5774a6652ef2e1c3bc6b2a/packages/rpiv-advisor) 2.13.8 in [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono).

## License

MIT. Copyright (c) 2026 yuru7.
