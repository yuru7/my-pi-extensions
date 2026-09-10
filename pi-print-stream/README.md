# pi-print-stream

A Pi extension that adds a **`--stream`** CLI flag for non-interactive runs.

```bash
pi -p "review this repository" --stream
```

While the turn runs:

- Answer text streams to stdout in realtime and stays in the scrollback.
- Tool calls stream as one JSON object per line and stay in the scrollback.
- Thinking appears as a transient block of at most 8 screen rows (TTY only)
  and never pollutes the scrollback or redirected output.
- When the run finishes, a usage summary shows tokens, elapsed time,
  generation time, and TPS.

## How it works

`--stream` is a wrapper over `pi --mode json -p`. It intercepts the prompt,
spawns a child `pi --mode json -p "<prompt>"` with the same model and flags,
renders the child's JSONL event stream, and returns `handled` so Pi's own
turn does not run twice. The child uses Pi's real print-mode path, so prompt
handling, retries, and compaction behave exactly like a normal `pi -p` run.

```bash
pi -p "explain this repo" --stream      # recommended
pi --stream "explain this repo"         # also works (prompt recovered from argv)
```

## Install

```bash
pi install npm:@yuru7/pi-print-stream
```

Local development:

```bash
pi -e ./extensions/index.ts -p "your prompt" --stream
```

## Output

### Answer text

`text_delta` events are written to stdout immediately, in arrival order.
On a TTY the answer Markdown is rendered for the terminal with
[`markdansi`](https://www.npmjs.com/package/markdansi) (headings, bold,
lists, code blocks, tables, and more) as an append-only stream: completed
lines are emitted as they arrive, while fenced code blocks and tables stay
buffered until complete. Tool calls never reset the Markdown state. When
stdout is not a TTY (redirect, pipe, `tee`, scripts), the raw Markdown is
written unchanged with no ANSI sequences, keeping logs and pipes
machine-readable.

### Tool calls

Tool activity is emitted as compact JSONL, one event per line. On a TTY the
lines are dimmed to stay unobtrusive; redirected output stays plain so
grep/jq keep working:

```json
{"type":"tool_start","id":"tool_1","name":"read","args":{"path":"src/index.ts"}}
{"type":"tool_end","id":"tool_1","name":"read","status":"success","elapsed_ms":42}
```

`tool_end.status` is `"success"` or `"error"`. `elapsed_ms` is measured with a
monotonic clock from `tool_execution_start` to `tool_execution_end`, so
parallel tool calls are measured independently.

Tool result bodies are intentionally not printed: `read`, `bash`, `grep`, and
web fetches can be very large. The stream shows the fact, name, args, status,
and timing of each call.

### Thinking (TTY only)

On a TTY, thinking deltas render as a transient block near the bottom of the
screen:

```text
────────────────────────────────────────
Thinking
  Need to inspect how message events are emitted.
  Tool execution should remain persistent.
  ...
────────────────────────────────────────
```

- At most 8 screen rows are shown (wrapping-aware: CJK, emoji, and ANSI
  sequences are measured by display width, not `string.length`).
- Older content scrolls off the top; only the latest rows are visible.
- Tool calls alone never end the thinking session: the block is hidden,
  the tool line is written, and the thinking view is repainted below it.
- The block is erased when answer text starts, and before errors or the
  final summary are written, so outputs never interleave.
- The block is erased on resize and repainted with the new terminal width.
- The thinking session ends when answer text takes over; tool-only message
  boundaries leave the view intact.

When stdout is not a TTY (redirect, pipe, `tee`, scripts), thinking is
discarded completely and no ANSI control sequences are emitted. Only answer
text, tool JSONL, and the final summary are written, keeping logs and pipes
machine-readable.

### Final summary

A compact 3-line block:

```text
Done in 24.8s
Tokens: Input 12,481 / Cache read 48,220 / Output 3,842 / Cache write 0
TPS: 331.2 tok/s
```

On failure the title is `Failed` and the statistics collected so far are
shown. A missing trailing newline in the answer is added before the summary.
On a TTY the block is dimmed; otherwise it is plain text.

## TPS definition

```text
TPS = Output tokens / Generation seconds
```

Generation time is the sum of `message_start` → `message_end` intervals for
assistant messages. Tool execution, network waits, and retries use wall-clock
`Elapsed` time but are excluded from `Generation` and TPS, so the number
reflects model generation speed rather than whole-agent latency. Usage is
summed from each assistant `message_end.message.usage`
(`input`, `output`, `cacheRead`, `cacheWrite`); missing fields count as zero.
When generation time is zero, TPS is shown as `-`.

## Behavior notes

- Non-interactive only (`print` mode without UI). In interactive mode the TUI
  already renders the turn, so `--stream` is a no-op. Under `--mode json` or
  `--mode rpc`, Pi emits its own machine stream and `--stream` stays out of
  the way.
- Malformed JSONL lines from the child never pollute stdout; a warning goes
  to stderr and streaming continues.
- `SIGINT` / `SIGTERM` erase the transient thinking view, forward the same
  signal to the child, and exit with `130` / `143`. The child exit code is
  otherwise propagated; a final assistant `stopReason: "error"` maps to exit
  `1` even when the JSON child itself exits `0`.
- All user-facing output is written to the real stdout (fd 1). Pi takes over
  `process.stdout.write` in print mode (forwarding extension output to
  stderr), so writing through `process.stdout` would lose redirected output.
  TTY detection and terminal width are likewise probed from fd 1, never from
  the replaced `process.stdout` object.
- No TUI framework, syntax highlighting, tool-result
  dumps, or session restore is included. Output stays on stdout/ANSI by
  design.

## License

[MIT](./LICENSE)
