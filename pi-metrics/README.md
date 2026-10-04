# pi-metrics

A Pi extension that prints one dim metrics line after each run finishes.

Repository: [yuru7/my-pi-extensions](https://github.com/yuru7/my-pi-extensions)

```text
Worked for 1m 19.1s · TPS 227.8 tok/s · TTFT 2.0s · in 12.2K · out 1.7K · cost $1.234567
```

Metrics are collected from `agent_start` through `agent_settled`, so a run with
several turns and tool calls produces exactly one line. Retries, auto-compaction,
and queued follow-ups that happen before the run settles are all included.

## Install

```bash
pi install npm:@yuru7/pi-metrics
```

Or load it directly while developing:

```bash
pi --extension ./extensions/index.ts
```

## Configuration

Create `pi-metrics.json` in Pi's agent directory
(`~/.pi/agent/pi-metrics.json` by default; `PI_CODING_AGENT_DIR` and a
customized config directory are honored). The file is optional; without it the
default format above is used.

```json
{
  "format": "Worked for {elapsed} · TPS {tps} tok/s · TTFT {ttft} · in {input} · out {output}"
}
```

The `format` string may use these placeholders:

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `{elapsed}` | Run start (`agent_start`) through `agent_settled` | `1m 19.1s` |
| `{tps}` | Output tokens per second of generation | `227.8` |
| `{ttft}` | Time to first token of the first measurable turn | `2.0s` |
| `{input}` | Input tokens summed over all turns | `12.2K` |
| `{output}` | Output tokens summed over all turns | `1.7K` |

A placeholder may appear more than once. Unknown placeholders such as `{foo}`
are left untouched, so typos stay visible and future placeholders keep working.
`tps` and `ttft` render as `n/a` when they cannot be measured; an estimated
`tps` gets a leading `≈` (for example `≈66.7`). The format itself never changes
shape.

The appended **cost** segment is not a placeholder and is not part of `format`.
When the run reported a positive cost, ` · cost $1.234567` is added after the
rendered line; providers that report no cost leave it at zero and the segment
is omitted entirely, separator included. The value is shown with six decimal
places, so small per-run costs stay visible.

```json
{ "format": "{elapsed} | {input} → {output} | {tps} tok/s" }
```

```text
23.7s | 8.1K → 1.3K | 181.4 tok/s
```

A missing file is normal and silent. Invalid JSON or a non-string `format`
falls back to the default format and shows one warning. Pi keeps working either
way, and unknown fields are ignored.

## What the numbers mean

- **elapsed** starts when the run starts (`agent_start`). Input handling,
  authentication checks, compaction, and image resizing that happen before the
  run are not counted.
- **cost** is the sum of `usage.cost.total` over the run's finalized assistant
  messages, in US dollars. It reflects the cost the provider reports for those
  messages, not a separate billing statement. Providers that do not report a
  cost contribute zero, and the cost segment is hidden unless the run total is
  positive.
- **input** / **output** sum the `usage` of every finalized assistant message in
  the run. Partial stream updates never contribute tokens.
- **TTFT** measures the first turn where a token delta was observed, from that
  turn's start to its first delta. It is not the wait from the run start to the
  first token.
- **TPS** is output-token rate. A measured value uses the span between the
  first and last token delta (minus stalls), so it excludes time to first token,
  tool execution, and retries; only token deltas count, so empty block start/end
  stream events do not widen the window. A gap longer than 500 ms inside a
  stream is treated as a stall and removed. When a whole turn streams in fewer
  than two deltas, or when its deltas arrive in a burst far shorter than the
  silence that preceded them (a buffered or coalesced stream), the span does not
  reflect generation time; the turn's response duration (which includes latency)
  is used instead and the value is shown as an estimate with a leading `≈`. A
  turn with no output tokens or no measurable duration shows `n/a`. Across
  turns, TPS is the sum of the adopted output tokens divided by the sum of the
  adopted generation times; short spans can be affected by how a provider chunks
  its stream. When any contribution was estimated, the aggregate carries the `≈`
  marker.

The line uses the standard theme's `dim` color with no background. Nothing is
written to the session, so resuming a session does not replay old metrics.
Metrics are not rendered in non-interactive modes (`rpc`, `json`, `print`);
state is still reset so the next run starts clean.

## Development

```bash
pnpm install
pnpm run check        # typecheck + tests
pnpm run package:check
```
