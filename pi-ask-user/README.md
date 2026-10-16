# pi-ask-user

A [Pi](https://github.com/badlogic/pi-mono) extension that lets the model ask up to four structured questions and returns the answers as data. An idle timeout, a countdown, and `Ctrl+O` collapse the dialog.

## Install

From this package directory:

```sh
pi install .
```

Pi loads `extensions/index.ts`. Restart the session after installing.

## What the model sees

The tool is `ask_user`. Each call takes 1–4 questions, and each question takes 2–4 options with a short label and a description. The dialog always appends a `Type something.` row. `multiSelect` allows several choices plus custom text. An option may include a markdown `preview` on single-select questions.

Reserved option labels are `Other`, `Type something.`, and `Next`.

The tool description asks the model to call it only when a decision cannot reasonably be inferred, and to batch related questions. When it recommends an option, it should put that option first and end the label with `(Recommended)`. The dialog shows that label as written. Usage guidelines are empty unless you set them. Timeout behavior is explained in the tool result, not in the prompt.

## Answering

| Key | Action |
| --- | --- |
| ↑ / ↓ | Move between options |
| Enter | Choose or confirm |
| Space | Toggle a multi-select option |
| Tab | Next question |
| `n` | Note for this question, or a global note on the Submit tab |
| Shift+Enter | New line while typing |
| Ctrl+G | External editor |
| Ctrl+U | Clear the draft |
| Esc | Cancel the questionnaire. Also closes an enlarged preview |
| Ctrl+P | Enlarge the selected option's preview. ↑↓ and ←→ scroll inside it |
| Ctrl+O | Collapse or restore the questionnaire |
| PageUp / PageDown | Scroll the conversation |

`Ctrl+O` is used only while a questionnaire is waiting. Otherwise Pi keeps its own `Ctrl+O` binding. Set `collapseKey` to `"off"` to disable the shortcut, or to another Pi key id such as `"alt+o"`.

`Ctrl+P` enlarges the focused option when that option has a `preview`. Inside the modal, ↑↓ and PageUp/PageDown scroll vertically, ←→ pans wide figures, and the mouse wheel scrolls. Esc or `Ctrl+P` closes it. The shortcut does nothing while typing a custom answer or a note.

Collapsing keeps the current answers, drafts, notes, and tab. The collapsed row looks like:

```text
Ctrl+O: show/hide | time limit lifted | ? Waiting
```

Pressing `Ctrl+O` is itself activity, so the idle timer stops when the dialog collapses.

The dialog opens in Pi's editor area, under the transcript, and takes at most 70% of the terminal height. PageUp, PageDown, and the mouse wheel scroll the transcript. A second questionnaire, or a question opened over another overlay, uses an overlay instead. Collapse hides that overlay when it is safe to do so, and keeps a one-line row when another overlay is underneath.

## Idle timeout

The default limit is 600 seconds for the whole questionnaire, starting when the dialog can accept input. The header shows the remaining time as `MM:SS`, or `HH:MM:SS` past one hour. The last minute is highlighted, and the last ten seconds use the error color.

The first keyboard event or mouse-wheel event after the dialog is shown removes the limit until that questionnaire ends. The timer is not paused or reset. Redraws, the countdown itself, and terminal focus reports do not count. After the limit is lifted the header says `time limit lifted`. With no limit it says `no time limit`.

If the limit expires, the dialog closes and the tool result sets `timedOut: true`. Answers that were already confirmed are kept. Unanswered questions are named and are not given a default choice. The result tells the model to continue with a safe assumption, not to repeat the same question immediately, and not to treat the timeout as approval for a destructive action.

Cancel (`Esc`) stays distinct: `cancelled: true` and no `timedOut` field.

## Configuration

Optional file: `<agent dir>/pi-ask-user.json`. The directory is Pi's `getAgentDir()`, which defaults to `~/.pi/agent` and follows `PI_CODING_AGENT_DIR`. The file is never created automatically. A missing file uses the defaults. Malformed JSON is ignored with a warning.

```json
{
  "timeoutSeconds": 600,
  "collapseKey": "ctrl+o",
  "guidance": {
    "description": "",
    "promptSnippet": "",
    "promptGuidelines": []
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `timeoutSeconds` | `600` | Seconds for one questionnaire. `null`, `0`, or a negative number waits forever. Any other invalid value falls back to 600. Decimals are allowed. |
| `collapseKey` | `"ctrl+o"` | Collapse shortcut, or `"off"`. |
| `guidance.description` | built-in short description | Non-empty string replaces the tool description. |
| `guidance.promptSnippet` | built-in one-liner | Non-empty string replaces the system-prompt snippet. |
| `guidance.promptGuidelines` | `[]` | Strings added as usage guidelines. |

The timeout is read when a question starts and does not change mid-question.

## Hosts

Interactive Pi shows the countdown, notices keyboard and wheel input, and supports `Ctrl+O`.

RPC and ACP hosts (the VS Code pendant, Zed, and similar clients) walk the questions with the host's select and input dialogs. The same timeout is passed through, and the host dialog closes when it expires. Those hosts do not provide the tabbed preview, notes, or `Ctrl+O`. If the host does not forward keystrokes or wheel events to Pi, the timeout cannot be lifted by activity inside the native dialog; answering or cancelling still ends it. A native dialog timeout is not treated as approval.

Non-interactive runs drop `ask_user` from the model's tool list in `before_agent_start`.

Other extensions can answer an open questionnaire on `rpiv:ask-user:answer`, using the `toolCallId` from `rpiv:ask-user:prompt`. The first valid answer wins. An answer after a timeout or cancel is rejected. Event names match the reference package so existing listeners keep working. Import them from `@yuru7/pi-ask-user/events`.

## Mouse reporting

Wheel and trackpad scrolling lift the timeout only when the terminal sends mouse events to Pi. In fullscreen mode this extension watches those events before Pi scrolls the transcript, so the history still moves. A terminal that turns wheel movement into arrow keys will move the selection instead; PageUp and PageDown still scroll. Windows Terminal on WSL is the primary environment this was written for.

## Prompt size

Compared with `@juicesharp/rpiv-ask-user-question` 2.13.8, the tool description, snippet, and guidelines together are shorter than the reference's 2944 characters, and `promptGuidelines` defaults to an empty list. Field descriptions in the JSON schema are reduced to the constraints the schema does not already express. A live model comparison of question quality was not run in this repository.

## Development

```sh
pnpm install
pnpm check
```

`pnpm check` typechecks, runs Biome, and runs the unit tests. Node.js 22.19 or newer is required.

## Acknowledgements

This extension was inspired by [`rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/1ffa165c224b5489fb5774a6652ef2e1c3bc6b2a/packages/rpiv-ask-user-question) 2.13.8 in [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono).

## License

MIT. Copyright (c) 2026 yuru7.
