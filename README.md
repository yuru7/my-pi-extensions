# my-pi-extensions

Personal extensions for [Pi](https://pi.dev), the coding agent.

Each package lives in its own directory and is published independently. See that directory's README for install, commands, and configuration. The release flow (pnpm → npm) is in [docs/PUBLISH.md](./docs/PUBLISH.md).

## Packages

| Package | Description |
| --- | --- |
| [pi-undo](./pi-undo) | Checkpoint file changes from `write`, `edit`, and `bash`, then undo the session to an earlier turn |
| [pi-print-stream](./pi-print-stream) | Stream non-interactive runs: realtime answer text, tool JSONL, transient thinking, and a usage summary |
| [pi-native-notify](./pi-native-notify) | Send a native OS notification when a long-running task completes or Pi waits for your input |
| [pi-ai-approval](./pi-ai-approval) | Fail-closed approval gate: an AI reviewer classifies each tool call's risk level, and local `riskActions` config allows, asks, or denies it |

## License

[MIT](./LICENSE)
