# pi-ai-approval

English | [日本語](./README_ja.md)

A fail-closed approval gate for [Pi](https://pi.dev), the coding agent. An isolated AI reviewer classifies every covered tool call into one of six risk levels, and a local `riskActions` policy decides whether it runs: `allow`, `ask` (a Deny / Approve / Approve + Add Rule prompt), or `deny`.

The AI never decides the final outcome. It only assesses risk and explains what the operation does; the decision always comes from your local configuration, and anything the reviewer cannot classify is blocked.

## How it works

```text
Tool call
   ↓
AI review (isolated reviewer session)
   ↓
Risk level + instruction alignment + operation summary + rationale
   ↓
riskActions configuration
   ↓
allow ─────────→ execute
ask  → Deny / Approve / Approve + Add Rule
       Approve: execute this call
       Approve + Add Rule: approve and add a session rule
       Deny: block
deny ─────────→ block
```

- **`allow`** runs the tool call without confirmation.
- **`ask`** shows an approval prompt. The choices are fixed to **Deny / Approve / Approve + Add Rule (Deny preselected)**. `askTimeoutSeconds` can limit how long the prompt stays open; the default `null` waits until you answer. While a limit is active, the remaining seconds count down, and reaching zero declines the action.
- **`deny`** blocks the tool call and returns the AI's rationale to the agent, together with instructions not to retry the same action through a workaround.

When available, the reviewer also uses the agent reasoning directly associated with the current tool call as supporting evidence. That reasoning is untrusted and does not prove the user authorized or requested the action. If the model or provider does not expose reasoning, the review uses only the conversation and the planned action.

An Approve (including `Approve + Add Rule`) applies to exactly that one tool call. The next call is reviewed on its own, and a session rule only lets the reviewer-confirmed classification fall by one level; the rule never approves anything by itself. Concurrent `ask` outcomes are serialized so only one prompt is ever visible.

## Risk levels

Risk is the practical risk of running the action **in the context of the user's current task**: how much damage its failure, misuse, or unintended side effects could cause, how costly it would be to reverse, and how directly it implements what the user asked for. Alongside the risk level, the reviewer reports an `instruction_alignment` of `direct`, `implied`, `weak`, or `unrelated`.

Key principles:

- Ordinary development actions that directly implement the user's request, are narrowly scoped, and are easily reversible are `low` risk — even when they modify project files.
- Explicit user instruction reduces uncertainty, but it does not eliminate blast radius, irreversibility, production impact, or security consequences.
- `very_high` and `critical` actions stay at that level even when explicitly requested.

| Level | Meaning |
| --- | --- |
| `very_low` | No state change: reading files, `grep`/`find`/`ls`, `git status`, checking test results or config values |
| `low` | Normal, limited, easily recoverable work implementing the request: editing requested sources, creating files, refactoring, formatters, local build/test, deleting build artifacts |
| `medium` | Aligned with the goal but with larger side effects or recovery: bulk changes, dependency updates, local DB migrations, dev service restarts, mild git history operations, out-of-project config, external service writes |
| `high` | Important data/environments/services affected, or a large leap from instruction to side effect: production/shared changes, force pushes, critical settings, DB data updates, firewall/IAM/network changes. Explicitly requested production work keeps a medium-to-high floor |
| `very_high` | Even when explicitly requested, blast radius, recovery cost, or irreversibility requires human re-verification: bulk production data operations, mass deletions, major IAM changes, protected-branch force updates |
| `critical` | Beyond normal agent auto-execution regardless of instruction: secret exfiltration, unrecoverable mass destruction, permanent security-mechanism disablement, broad privilege grants |

Worked examples: editing a file to fix the reported bug → `low`; installing a needed dependency → `medium`; a requested operation under `/tmp` → `very_low`/`low` (`rm -rf /tmp/*` at most `medium`; deleting `/tmp` itself → `high`); an explicitly requested plain local `git commit` → `low` (`--amend` and history rewrites stay `medium` or above); an unrequested `git reset --hard` → `high` (explicitly requested → `medium`); a production DB migration, even explicitly requested → `high`; bulk-deleting production data → `very_high`; sending secrets to an external URL, even if requested → `critical`.

## Session approval rules

The third approval choice, **Approve + Add Rule**, approves the current call and then asks you to type a rule that applies to the rest of this Pi session. The rule is memory-only: it is never written to disk and it disappears when the session runtime resets (including a session reload or replacement). Esc in the rule input cancels the input and brings the choices back; Enter stores the sanitized text.

How a rule affects later calls:

- The active rules are added to the reviewer's system prompt with the explicit instruction that they never change its risk classification. The reviewer may only report the ID of the single rule that clearly and entirely covers the planned action.
- The local layer treats every reported rule ID that is not in the live rule set as no match.
- When the reported rule exists, the classification is lowered by exactly one step and the policy is applied again — for `ask` and for `deny` alike. An `allow` classification is already permissive, so the rule changes nothing there, and `very_low` is the floor.
- A rule only moves a decision toward `allow`. If the lowered level is mapped to `deny` again (or cannot fall further), the original decision and level stand, so a rule never strengthens an outcome. `critical` can never become an automatic `allow`, because its single step lands on `very_high`, which the policy never allows.
- With the default policy, a matched rule turns a `high` deny into the `medium` prompt, while `very_high` and `critical` stay blocked. A policy that maps `medium` to `allow` would let the rule run a `high` action automatically.
- An automatic `allow` that came from a rule posts an info notification naming the rule and the original and effective levels. When the lowered level asks, the prompt shows a `Session Rule:` line naming the rule and the level it was lowered from.

Rules are bounded: at most 20 rules per session, each at most 500 characters after control characters and ANSI escapes are stripped and line breaks are folded. In the approval prompt, empty or over-long text is rejected with the reason and the input stays open; nothing is truncated silently. The rule manager reports the same rejection instead.

Manage the rules with `/ai-approval session-rules`: it lists the active rules with their IDs and lets you add, edit (the editor is prefilled with the current text), or remove one. Esc at any step leaves everything unchanged.

Example: a command keeps landing on `medium` → `ask`. Choose **Approve + Add Rule** and type `Allow pnpm test and pnpm build in this repository for this session`. On the next call the reviewer reports the rule ID, the local policy lowers `medium` to `low`, and the call runs with an info notification instead of a prompt. With the default policy the same rule turns a `high` deny into the `medium` prompt; `very_high` and `critical` remain blocked.

## Configuration

`ai-approval.json` is read from the global agent directory (`~/.pi/agent/`) and, for trusted projects, from `.pi/ai-approval.json` in the project. Project settings can only make the policy stricter; they cannot weaken it. If neither file exists, the extension warns on startup and suggests running `/ai-approval init` to create one; built-in defaults stay active until then.

```json
{
  "primaryModel": "CURRENT",
  "primaryThinkingLevel": "low",
  "secondaryModel": "CURRENT",
  "secondaryThinkingLevel": "low",
  "timeoutMs": 90000,
  "askTimeoutSeconds": null,
  "riskActions": {
    "very_low": "allow",
    "low": "allow",
    "medium": "ask",
    "high": "deny",
    "very_high": "deny",
    "critical": "deny"
  }
}
```

### riskActions

| Key | Allowed values | Default |
| --- | --- | --- |
| `very_low`, `low`, `medium`, `high` | `allow`, `ask`, `deny` | `allow`, `allow`, `ask`, `deny` |
| `very_high`, `critical` | `ask`, `deny` | `deny`, `deny` |

`very_high` and `critical` cannot be set to `allow`. If you try, the config parser warns and uses `deny`.

To confirm every non-trivial action with a human, use:

```json
{
  "riskActions": {
    "very_low": "allow",
    "low": "allow",
    "medium": "ask",
    "high": "ask",
    "very_high": "ask",
    "critical": "ask"
  }
}
```

### Reviewer models

`primaryModel` and `secondaryModel` configure the two-step reviewer chain; the current session model always remains the last-resort third channel. Both settings accept either an explicit `provider/model-id` or the special value `CURRENT` — which is also the default, meaning "use the current session model".

A model that appears more than once in the chain is tried only once: the first channel that resolves to it owns the attempt and later duplicates are skipped, so a temporarily unavailable model is never requested repeatedly. Duplicate detection uses the model only; thinking levels never create a separate channel. For example, with `primaryModel: "openai/gpt-5.6-luna"` failing and `secondaryModel: "openai/gpt-5.6-luna"`, the secondary is skipped even when their thinking levels differ. If every distinct channel fails, the action is blocked — the risk is never guessed.

### Reviewer thinking levels

`primaryThinkingLevel` and `secondaryThinkingLevel` set the thinking effort for each reviewer channel. Allowed values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and the special value `CURRENT` — which inherits the current session's thinking level at review time. The default is `low`. When `CURRENT` is set but the session thinking level is unavailable, `low` is used. The last-resort current-model channel always uses the session's thinking level (or `low` when unavailable).

```json
{
  "primaryThinkingLevel": "low",
  "secondaryThinkingLevel": "CURRENT"
}
```

Environment overrides (`PI_AI_APPROVAL_PRIMARY_MODEL`, `PI_AI_APPROVAL_SECONDARY_MODEL`, `PI_AI_APPROVAL_PRIMARY_THINKING_LEVEL`, `PI_AI_APPROVAL_SECONDARY_THINKING_LEVEL`, `PI_AI_APPROVAL_TIMEOUT_MS`, `PI_AI_APPROVAL_POLICY`) are also supported.

### Ask timeout

`askTimeoutSeconds` is how long an approval prompt waits, in seconds. The default `null` does not time out. `0` and negative numbers are the same as `null`. A positive number counts down on the prompt, in whole seconds, and declines the action when it reaches zero. That decline blocks the tool call.

```json
{
  "askTimeoutSeconds": 30
}
```

A trusted project file overrides the global file, including an explicit `null`. `timeoutMs` is a different setting: it limits the reviewer, not the approval prompt.

### Assessment language

`assessmentLanguage` controls the language of the reviewer's `action_summary` and `rationale` (shown in the approval prompt and rejection reasons). The default `auto` follows the user's primary conversation language. Set a fixed language name to pin it:

```json
{
  "assessmentLanguage": "Japanese"
}
```

Project settings override the global setting.

### Fail-closed guarantees

The following all block the tool call, without ever showing an approval prompt:

- reviewer timeout, failure, cancellation, or unparseable output
- an unknown risk level in the reviewer response
- all reviewer channels failing
- the approval prompt being dismissed or unavailable

Session rules never turn a failure into an approval, but not every rule problem is a block. An unavailable rule input UI still blocks (declined with a diagnostic); hitting Esc in the rule input returns to the choices without approving the call; empty or over-limit rule text keeps the input open; and a rule ID the reviewer reports that is not in the live rule set is treated as no match, so the call falls back to the normal approval prompt.

A denial circuit breaker stops runaway retry loops: repeated adverse outcomes (denials, declined approvals, review failures, timeouts) within one turn abort the agent turn.

## Review scope

Which tool calls get reviewed is controlled by `review` rules (tool parameter → scope), independent of the risk policy:

```json
{
  "review": {
    "bash.command": "always",
    "powershell.command": "always",
    "read.path": "outside-or-private",
    "grep.path": "outside-or-private",
    "write.path": "outside-or-private",
    "edit.path": "outside-or-private"
  }
}
```

Built-in defaults are `bash.command: always` and `powershell.command: always`; `read.path`, `grep.path`, `write.path`, `edit.path: outside-or-private`; `find.path`, `ls.path: private-only`.

Rule keys are `<tool>.<parameter>`: `bash.command`/`powershell.command` route the command string of every bash/PowerShell call, `read.path`/`grep.path`/`find.path`/`ls.path` route the read or search scope, and `write.path`/`edit.path` route the file being modified. Tools without a built-in rule but with a top-level string `path` parameter (for example `custom_reader.path`) are supported too and default to `private-only`.

### Scope values

| Scope | A call is reviewed when… |
| --- | --- |
| `off` | Never — the tool/parameter is not reviewed at all. |
| `private-only` | The target path is classified as private data. |
| `outside-or-private` | The target path resolves outside the project root **or** is private. For `write`/`edit`, security-relevant in-project files also count. |
| `always` | Always, regardless of the target. |

"Private" is decided by a deterministic rule catalog: credential and secret files (`.env*`, key files, `auth.json`, token stores, browser login data, …), private directories outside the project (`.ssh`, `.gnupg`, `.aws`/`.kube`/cloud-CLI configs, browser profiles, Pi agent data, …) and, for the search tools, directory scopes or globs that may contain such files. For `write`/`edit`, "sensitive" additionally covers security-relevant in-project targets such as CI workflows, container/deploy manifests, dependency lockfiles, shell profiles, key material (`.pem`, `.key`, …) and sensitive directory segments (`.git`, `secrets`, `terraform`, `k8s`, …).

`bash.command` and `powershell.command` are special: they route a command string rather than a path, so only `off` skips them — every other scope reviews each of those shell commands (commands that reference private data are reviewed in a restricted no-tool mode).

Being reviewed does not mean being blocked: a reviewed call goes to the AI reviewer, which classifies its risk level, and your `riskActions` config then decides allow/ask/deny.

## Commands

- `/ai-approval` — status: reviewer channels, timeout, config paths, warnings
- `/ai-approval init` — write the default configuration file (chooses global/project; asks before overwriting an existing file)
- `/ai-approval rules` — the review matrix and the effective risk actions
- `/ai-approval session-rules` — list, add, edit, or remove session approval rules (interactive)
- `/ai-approval bypass` / `/ai-approval enable` — temporarily disable/restore review (interactive TUI only, with a persistent warning)

## Install

```bash
pi install npm:@yuru7/pi-ai-approval
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Acknowledgments

This project was created with inspiration from [pi-approval-guardian](https://github.com/mics8128/pi-approval-guardian).

## License

[MIT](./LICENSE)
