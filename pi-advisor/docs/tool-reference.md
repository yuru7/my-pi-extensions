# `advisor` tool

## Signature

```ts
advisor() // no parameters
```

The parameter schema is an empty object. The conversation branch is read from the session when the tool runs.

## Request

Each call builds the advisor request in this order:

1. Tool inventory, from `toolInventory` in the config. `full` lists every registered tool. The block is omitted when the registry is empty.
2. The current conversation branch from Pi's `buildSessionContext()` and `convertToLlm()`, so compaction summaries and branch summaries are what the executor model would see. Only the leaf branch is included.
3. Tail cleanup. The in-flight `advisor` tool call is removed. If the tail is still an assistant message, a user message is appended: `Please advise on the executor's situation above.`
4. Tool declarations copied onto system messages (`toolsAdded` / `toolsRemoved` on Pi 1.x) are removed.

The request system prompt is the advisor prompt (plan, correction, or stop; no tools). `tools` is `[]`. The configured effort is sent as `reasoning` when it is set.

The call prefers Pi's auth-aware runtime `completeSimple` on the model registry, so OAuth hosts can apply credential-derived fields such as base URL. That path does not receive the preflight API key. If the host has no runtime method, the extension loads `completeSimple` from `@earendil-works/pi-ai/compat`, and from the package root only when `/compat` cannot be resolved.

While the call runs, the tool update text is `Consulting advisor (<label>[, <effort>])…`.

## Result

```ts
{
  content: [{ type: "text", text: string }],
  details: {
    advisorModel?: string,    // "provider:modelId"
    effort?: ThinkingLevel,   // the effort captured when the call started
    usage?: Usage,
    stopReason?: StopReason,
    errorMessage?: string,    // set on failure paths
  }
}
```

`details.effort` is the value used for that call, even if the selection changes while the request is in flight.

A normal stop with no text is retried once with the same messages. Abort, a provider error stop, and a thrown exception are not retried. Failures are tool results. They do not crash the executor turn.

| `content` text | `details.errorMessage` |
| --- | --- |
| `No advisor model is configured. The user can enable one with the /advisor command.` | `no advisor model selected` |
| `Advisor (<label>) is misconfigured: <err>` | the registry auth error |
| `Advisor (<label>) has no API key available.` | `no API key for <provider>` |
| `Advisor call was cancelled before it completed.` | the provider message, or `aborted` |
| `Advisor call failed: <err>` | the provider message |
| `Advisor returned no text content.` | `empty response` |
| `Advisor call threw: <msg>` | the thrown message |

## When the tool is active

The tool is registered at load. It is removed from the active set, which also drops its snippet and guidelines from the executor system prompt, when any of these is true:

1. No advisor model is selected.
2. `model` is missing, unparseable, or names a model the registry cannot find. The in-memory selection is cleared too.
3. The current executor model matches `disabledForModels`.

`session_start` reloads the file. `before_agent_start` reconciles the tool every turn. `model_select` and `thinking_level_select` reconcile on change. Other extensions' tools are left in the active list. The advisor name is not inserted twice.

## Picker keys

Both pickers show at most 10 rows. The hint is `type to filter • ↑↓ navigate • enter select • esc cancel`.

| Key | Effect |
| --- | --- |
| printable character | appends to the fuzzy filter |
| Backspace | deletes one filter character |
| Up / Down | move the selection |
| Enter | select |
| Esc | cancel |

The filter matches the visible label and the `provider/modelId` value. Contiguous runs and matches after a space, `:`, or `-` rank higher.
