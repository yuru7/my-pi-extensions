# Configuration

`pi-advisor` reads and writes one file in Pi's agent directory:

`~/.pi/agent/pi-advisor.json`

That directory is whatever Pi uses for agent state. The default is `~/.pi/agent`. The XDG config directory is not used.

## File behavior

- A missing file is normal. The extension uses defaults and does not create the file until `/advisor` saves.
- Invalid JSON, or a JSON value that is not an object, produces a warning and the defaults. Pi still starts.
- A field with the wrong type is ignored. Other fields are kept.
- `/advisor` writes `model` and `effort` only. Unknown keys, `guidance`, `disabledForModels`, `promptMode`, and `toolInventory` stay on disk.
- The save is a temp file in the same directory, then a rename. If the write fails, in-memory state and the active tool list are left as they were, and Pi shows `Failed to save advisor selection — selection not persisted`.
- After a successful rename the file mode is set to `0600` when the platform allows it. A failed mode change does not undo the save.

## Keys

| Key | Type | Default | Written by |
| --- | --- | --- | --- |
| `model` | string `provider/modelId` | absent (advisor off) | `/advisor` |
| `effort` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | absent (no `reasoning` sent) | `/advisor` |
| `promptMode` | string | `standard` | hand-edited |
| `disabledForModels` | `(string \| { model, minEffort? })[]` | `[]` | hand-edited |
| `toolInventory` | `full`, `active`, or `names` | `full` | hand-edited |
| `guidance.promptSnippet` | string | built-in snippet | hand-edited |
| `guidance.promptGuidelines` | string[] | seven built-in guidelines | hand-edited |

### `model`

The stored form is `provider/modelId`, split on the first `/`. A legacy `provider:modelId` value is accepted on read and compared in slash form. The next `/advisor` save rewrites it to slash form.

The tool result's `details.advisorModel` uses the colon form `provider:modelId`. That label is not the config key.

### `effort`

Shown only when the selected model reports reasoning support. The picker offers `off (no reasoning sent)` plus the graded levels Pi reports for that model, except `xhigh` and `max` unless the model maps them. `high` is labeled `(recommended)` when it is available.

Choosing `off`, or pressing Esc, deletes `effort`. No `reasoning` value is sent. Esc still saves the model.

An unknown effort in the file is ignored, with a warning.

### `promptMode`

`standard` is the only implemented mode. Any other value warns and the built-in `standard` text is used. The unknown value is left on disk.

### `disabledForModels`

Executor models for which the `advisor` tool is removed from the active set.

- A string blocks at every effort.
- An object without `minEffort` blocks at every effort.
- An object with `minEffort` blocks when the executor effort is at or above that level. Equal effort blocks.
- An unset executor effort, `off`, or a level outside the scale does not match `minEffort`.

An unknown `minEffort` drops that entry and warns. Empty strings, nulls, and other types are dropped. Surviving entries keep their order. Legacy colon keys still match.

The list is applied on `session_start`, before each turn, on executor model change, and on thinking-level change. `model_select` with `source: "restore"` does not notify again, because session restore already did.

### `toolInventory`

What the advisor is told about the executor's tools. This is not the executor system prompt.

- `full`: every registered tool, with description and parameter schema. This is the default and matches the reference package.
- `active`: the same detail, limited to tools in the active set.
- `names`: sorted tool names only.

An unknown value warns and `full` is used. The value is read on each advisor call, so a hand edit applies on the next call without a reload.

The serialized schema sorts object keys. The message is cached until the mode, names, descriptions, or schemas change. Install paths are not included.

### `guidance`

Replaces the executor-facing snippet and guidelines without changing the package.

- `promptSnippet`: a non-empty string.
- `promptGuidelines`: a non-empty array of non-empty strings.

A missing, empty, or wrong-typed field falls back to the built-in `standard` text. Both fields are read when the extension loads. Reload Pi after editing them.

The description of the tool itself is not overridable.

## Notifications

| Message | When |
| --- | --- |
| `Advisor: <label>[, <effort>]` | a model was selected with `/advisor` |
| `Advisor: <label>[, <effort>] (inactive for current executor)` | selected, but `disabledForModels` blocks the current executor |
| `Advisor restored: <label>[, <effort>]` | applied at session start, or unblocked mid-session |
| `Advisor restored: <label>[, <effort>] (inactive for current executor)` | restored while blocked |
| `Advisor disabled` | **No advisor** was chosen |
| `Advisor disabled for <provider/model>` | the executor model or effort became blocked |
| `Effort not set — advisor uses the model default` | Esc on the effort picker |
| `Advisor selection not found: <choice>` | the picked model was no longer available |
| `Previously configured advisor model <key> is no longer available` | the saved model is not in the registry |
| `Failed to save advisor selection — selection not persisted` | the config write failed |
| `/advisor requires interactive mode` | `/advisor` ran without interactive UI |

`Advisor restored: …` is shown at most once per process, so later session starts in the same process do not repeat it.
