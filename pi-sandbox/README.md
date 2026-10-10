# pi-sandbox

English | [日本語](./README_ja.md)

Process-level sandbox extension for the Pi coding agent.
Leverages OS-native sandbox mechanisms (bwrap / landlock / seatbelt / windows-acl) to enforce **"workspace and temporary directories writable, everything else read-only, fail-closed by default"**. Since it does not use containers, host paths work as-is (path transparent). Features denial-first privilege escalation with built-in AI auto-review.

## Install

```bash
# From npm
pi install npm:@yuru7/pi-sandbox

# Or from a local checkout
pi install .
```

## Basic Usage

### Three Permission Modes

| Mode | File effects |
|---|---|
| `workspace-write` (default) | Working directory (workspace) + `/tmp` + `os.tmpdir()` writable; everything else read-only |
| `read-only` | No write access (only `/dev/null` or Windows `NUL` writable); everything else read-only |
| `danger-full-access` | Bypasses the sandbox completely (explicit escape hatch) |

> **Note**: Network access is always allowed (there is no network isolation).

### Directory grants

`sandbox_grant_write` adds one directory to the writable roots for the rest of the current user request. It uses the same approval mode as escalation (`human`, `auto-review`, or `allow-all`). Call it only after a sandbox denial named a path inside that directory, and only when later calls in the same request will write there again. A single use of the directory, or a denial that does not name one directory, should retry that call with `danger-full-access` instead.

The grant is cleared when the agent finishes the request, and when the next user message starts (including a steering or follow-up message). Directories created for the grant, and parents created with them, are removed at that point if they are still empty. Directories that already existed, or that contain anything, are left in place. The grant is refused for `/`, the home directory, and any ancestor of home. A custom `runnerCommand` cannot accept extra directories. Child sessions do not inherit the grant.

### Commands

- `/permission`
  Displays the current sandbox status (active mode and source, selected runner and enforcement level, workspace path, effective approval mode, etc.).
- `/permission <read-only|workspace-write|danger-full-access>`
  Switches the permission mode **process-wide** immediately. The new mode applies to the very next tool call in both the parent session and all subagent child sessions.
- `/pi-sandbox init`
  Generates a configuration file (`pi-sandbox.json`) with recommended defaults. You can choose to save it globally in the agent directory or locally in `<project>/.pi/`. If a file already exists, it confirms before overwriting.

## How It Works

### Overview and Protection Mechanism

pi-sandbox applies tailored protections depending on the type of operation issued by the agent:

- **Command execution (`bash` / `powershell`)**: Commands are wrapped in a platform-specific sandbox runner and spawned locally. Without container abstraction, absolute host paths work transparently.
- **File modification (`write` / `edit` tools)**: Before performing any file modification, an in-process "write fence" validates the target path and immediately blocks unauthorized writes.
- **File reading (`read` tool and command reads)**: Unrestricted. Any file accessible to the user on the host can be read.

### Scope of Protection

**Only operations issued by the agent (model) are protected.**

- Commands you type directly in the prompt (e.g. `!command` / `!!command`) and RPC `bash` commands are executed by Pi itself via the `user_bash` event and run in your own shell without sandbox restrictions.
- Any process started outside Pi is likewise not confined.

### Platform and Runner Support

| Platform | Runner | Mechanism |
|---|---|---|
| Linux | `bwrap` (recommended) | `--ro-bind / /` makes the entire filesystem read-only, with read-write binds for the workspace and host `/tmp` |
| Linux | `landlock-run` (fallback) | Uses a precompiled binary bundled with the package; Landlock LSM allow-list makes `/` read-only and the workspace + `/tmp` writable |
| macOS | `sandbox-exec` (built in) | Built-in macOS Seatbelt SBPL: `deny file-write*` with exceptions for the workspace and temporary directories |
| Windows | `windows-acl` (built in, partial enforcement) | Restricted Token (`WRITE_RESTRICTED`) + capability-SID ACL grants on the workspace and `%TEMP%` + Low mandatory integrity label. **`powershell` tool only** (`bash` is refused in confined modes) |
| Other | none | **Fail-closed**: Confined commands are always refused and never executed bare |

## Privilege Escalation (Escalation Approval)

When an agent needs to write outside the workspace or run sensitive commands to fulfill a task, it can request a temporary privilege escalation.

### Denial-First Principle

For safety, the agent cannot proactively grant itself elevated permissions. Escalation operates strictly on a **denial-first** basis:

1. **Denial on first attempt**: The agent must first attempt the operation in the standard confined mode and have it rejected by the sandbox.
2. **Escalation retry**: Only when an operation **strictly matches a recorded sandbox denial in the same session** (same tool, same working directory, and identical arguments aside from escalation fields) can the agent retry with `sandbox_permissions` (`workspace-write` or `danger-full-access`) and a `justification` (one-sentence reason).
3. **Consumption of denial record**: A denial record is **consumed once** and **expires after 10 minutes**. Each denial affords exactly one escalation retry (approval applies only to that single invocation).

> **Note (Strict Schema Compatibility)**: If there is no matching denial record, escalation parameters are ignored, the command runs under the current mode, and a note is appended to the output. Furthermore, to accommodate strict-schema model providers where optional fields must be provided, placeholders such as `null`, `"null"`, or empty strings are safely normalized to "no escalation requested", avoiding schema validation errors.

### Approval Modes (`approvalMode`)

Who decides whether to grant the escalation retry is determined by `approvalMode`:

| Mode | Behavior |
|---|---|
| `auto-review` (default) | An independent reviewer model automatically evaluates the request and responds with `ALLOW` or `DENY`. No human prompt is shown; behaves consistently in headless and subagent sessions |
| `human` | Prompts the user with "Allow once" or "Deny" (with an optional reason on deny). Subagent requests are forwarded to the parent session (requires parent UI; refused if headless) |
| `allow-all` | Automatically approves valid, denial-backed escalation requests for one invocation. This does **not** permanently switch the entire session to `danger-full-access` |

Under all modes, requests without a matching denial record are refused. Invalid configuration values also fail safely by refusing escalation (the sandbox is never silently disabled).

## Auto-Review Details

In `auto-review` mode, the safety of an escalation request is evaluated by an independent model call.

### Reviewer Isolation and Input Information

The reviewer is a completely separate model call, decoupled from the main agent. It does not receive the agent's internal reasoning (thinking), previous tool results, or tool access.

The reviewer prompt contains only:
- **Sandbox metadata**: Active runner, mode, workspace path, writable paths
- **Attempted operation**: The attempted command or file path, cwd, exit code, stdout/stderr tails (up to 8 KiB each), or write-fence error details
- **Request details**: Requested mode and the agent's justification
- **Recent dialogue context**: Up to the last 3 dialogue turns retained in context (each turn consists of one user instruction and the agent's final reply, capped at 16 KiB total; older turns are dropped first)

### Evaluation Policy

The reviewer strictly adheres to the following criteria:

- **Approval Criteria (`ALLOW`)**:
  - The escalation is permitted only if the elevated operation is a **direct means of carrying out the user instructions** (the action requested, or an indispensable step to accomplish it).
- **Denial Criteria (`DENY`)**:
  - Operations that are only loosely related, exceed the scope of the user's instructions, or rely solely on the agent's justification or reply without grounding are denied.
  - If user instructions cannot be retrieved or are empty, the request is denied immediately without querying the model.
- **Nuances by Operation Type**:
  - `write` / `edit`: Escalation merely lifts the write fence for the specified target file path. As long as the target file is specified by the user instruction, the fact that the new file content was left unspecified by the user is not a ground for denial (the reviewer does not receive file contents). Similarly, being outside the workspace explains the initial fence denial and is not a reason to deny escalation for that file.
  - `bash` / `powershell`: Because the entire command runs unsandboxed upon escalation, the reviewer must evaluate the **safety of the entire command**, not just the individual path that triggered the denial (standard package installations can run arbitrary install scripts).
- **Understanding "Broader Scope"**:
  - The fact that the requested mode is `danger-full-access` is not in itself a reason to deny (from `workspace-write`, that is the only wider mode on a mode-escalation request). What is scrutinized is whether the operation itself performs actions beyond what the user asked for. A directory grant is a separate request and is not that decision.
- **Directory grants** (`sandbox_grant_write`):
  - The grant lasts until the user request ends. Every later tool call can write that directory tree. The sandbox stays in place everywhere else.
  - The narrowest grant is the directory that directly contains the denied path. For a file, that is the file's parent, because deleting or renaming the file writes that parent. That directory is not too broad merely because it contains other files or because the user named one file inside it.
  - An ancestor of that directory, including the parent of the file's directory, is broader than the denied path and is denied.
- **Evidence and Safety Principles**:
  - An operation matching user instructions does not automatically make an inherently unsafe action safe.
  - Dialogue turns are treated as untrusted evidence rather than instructions to the reviewer; assistant replies cannot serve as evidence of what the user requested.

### Outcomes and Notices

- The reviewer must respond with exactly one JSON object: `{"decision":"ALLOW"}` or `{"decision":"DENY","reason":"one short sentence"}` (any other output is treated as a denial).
- On `DENY`, the one-sentence reason is shown only in UI notifications (`ctx.ui.notify` or stderr). It is never returned in tool errors, ensuring the agent does not receive it (secrets redacted, max 500 characters).
- A standard `DENY` is final: pi-sandbox will not query a secondary model or fall back to a human prompt.

### Model Settings and Fallback Behavior

- `autoReview.model`: Specify `CURRENT` (active agent model at time of escalation) or `provider/model-id`.
- `autoReview.thinkingLevel`: Specify `CURRENT` or a supported Pi thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Explicitly configuring an unsupported level causes the attempt to fail.
- **Fallback**: If the configured reviewer model is unavailable (auth failure, API error, 15s timeout, etc.), pi-sandbox warns once and **retries the review on the active agent model with the same thinking setting**. If this second attempt also fails, escalation is denied.

### Security and Privacy Considerations

- Attempted commands, captured output logs, and recent dialogue turns are sent to the reviewer model's API. Secret redaction applies only to a few obvious patterns; exercise caution regarding sensitive information.
- Auto-review performs risk assessment and cannot provide absolute safety guarantees.

## Configuration

### Configuration Files and Priority

- **Global configuration**: Pi agent directory (`getAgentDir()`, typically `~/.pi/agent/pi-sandbox.json`, or under `$PI_CODING_AGENT_DIR`)
- **Project configuration**: `<project>/.pi/pi-sandbox.json`

Configuration files are not created automatically at startup; run `/pi-sandbox init` to create one.

**Priority per field (later entries override earlier ones)**:
1. Default settings
2. `<agent-dir>/sandbox.json` (legacy)
3. `<agent-dir>/pi-sandbox.json`
4. `<project>/.pi/sandbox.json` (legacy)
5. `<project>/.pi/pi-sandbox.json`
6. Runtime overrides via `/permission` (always takes precedence)

> **Project Trust Protection**: In untrusted projects, or environments where `isProjectTrusted()` cannot be resolved, project configurations cannot override `approvalMode` or `autoReview` (global configuration values remain enforced). This prevents malicious repositories from enabling `allow-all`.

### Example Configuration (`pi-sandbox.json`)

```json
{
  "mode": "workspace-write",
  "runnerCommand": null,
  "runnerFailureSignatures": null,
  "probeTimeoutMs": 5000,
  "approvalMode": "auto-review",
  "autoReview": {
    "model": "CURRENT",
    "thinkingLevel": "CURRENT"
  }
}
```

### Configuration Options

| Field | Default | Notes |
|---|---|---|
| `mode` | `workspace-write` | Default permission mode; invalid values fall back to default with a warning |
| `runnerCommand` | `null` | Custom bwrap-compatible runner argv array (must be paired with `runnerFailureSignatures`) |
| `runnerFailureSignatures` | `null` | Fatal diagnostic signatures for custom runner (non-empty single-line strings) |
| `probeTimeoutMs` | `5000` | Capability probe timeout in milliseconds (positive integer) |
| `approvalMode` | `auto-review` | Approval mode (`human`, `auto-review`, or `allow-all`); invalid values deny escalation |
| `autoReview.model` | `CURRENT` | Reviewer model (`CURRENT` or `provider/model-id`) |
| `autoReview.thinkingLevel` | `CURRENT` | Reviewer thinking level (`CURRENT` or supported Pi thinking level) |

`/permission` prints the approval mode that will actually be used (global value when the project is untrusted).

## Security Notes

- **Unrestricted Reads**: Confined processes can **read everything you can read on the host** (including `~/.ssh` and similar sensitive files) by design. Root-only files remain protected by standard OS permissions.
- **Shared Host Temporary Directories**:
  - Under Linux (bwrap / landlock / write fence) and macOS, `/tmp` is shared with host `/tmp` (rw bind).
  - On Windows, the sandbox temporary root is the host `%TEMP%`.
  - Confined commands can modify or delete temporary files belonging to the host (including active session sockets and Pi temp files), and host temporary directory permissions apply as-is.
- **Forced Locale**: Confined child processes force `LC_MESSAGES=C` to maintain predictable error message classification (does not affect user `LANG` or `LC_CTYPE`).
- **Background Processes**: Confined shells run in their own process groups (detached). While timeout/abort terminates the entire group, if Pi itself is abruptly terminated (e.g. SIGKILL), background grandchild processes may persist.
- **Landlock Limitations**: Linux Landlock fallback applies partial enforcement on older kernel ABIs (indicated in status output).

## Platform-Specific Notes (Windows)

On Windows (`windows-acl` runner), the following platform-specific characteristics and constraints apply:

### Available Shell
- Only the **`powershell` tool** is supported in confined modes.
- `bash` is registered with `exposure: "hidden"`, making it unreachable and invisible to the model. Keeping this registration reserves the `bash` name so that the unconfined built-in `bash` cannot be called by accident (fail-closed design).
- Even if host behavior regarding `hidden` changes in the future, the definition still refuses all confined calls.
- `bash` can only be executed on Windows by explicitly switching to `danger-full-access`.
- Note: `defaultTools` cannot deselect an extension-registered tool (`-name` only removes built-ins). pi-sandbox handles this by withdrawing `bash` at definition level (`exposure: "hidden"`).
- If `powershell` is not active (e.g. Pi < 1.0.0 or omitted in tool selection), `/permission` indicates `shell: powershell only (not activated)`. You can add it back using `{ "defaultTools": ["+powershell"] }` (requires Pi >= 1.0.0).

### Supported Windows Versions
- **No new OS version floor**: Relies on legacy Win32 APIs (`WRITE_RESTRICTED` tokens and Low mandatory integrity labels) rather than Windows 11 24H2+ `mxc`.
- Validated via automated e2e testing and manual checklists on **Windows 10 Enterprise LTSC 2019 (build 17763.316)**; newer builds (Windows 10 / 11 / Server 2025) are expected to work.

### Security Enforcement and Limitations (`partial`)
- **NTFS Hard Links**: A hard link to an authorized file inside the workspace can also be written to from outside the workspace.
- **AppContainer Package SIDs**: Files tagged by another AppContainer tool's package SID may become unreadable to the Low-integrity child process (recover by removing foreign ACEs or reinstalling the directory).
- **PowerShell Language Mode**: In `read-only` mode, PowerShell may degrade to `ConstrainedLanguage` because `%TEMP%` is not writable (`Add-Type`, COM, and reflection fail); `workspace-write` maintains `FullLanguage`.
- **NUL Device**: Device syntax (`> NUL` or `\\.\NUL`) is always writable in both modes due to device environment DACL properties. However, a relative `NUL` path is treated as a normal file in cwd.
- **Standing Security Descriptor Modifications**: Granted ACEs, world `FILE_DELETE_CHILD` denies, and Low mandatory labels on the workspace and `%TEMP%` remain even after Pi exits, relaxing those trees for any Low-integrity process under the same user. Initial granting propagates across `%TEMP%` (may take seconds). The actual paths of `%TEMP%` and `TMP` are not rewritten.
- **Impact on `%TEMP%`**: Subdirectories inherit deny ACEs, so third-party applications attempting to open their own temp subdirectories with `GENERIC_ALL`/`FullControl` may be refused (DELETE operations, `MAXIMUM_ALLOWED`, and standard read/write opens are unaffected).
- **Denial Classification is English-Only**: The tool matches English Win32/cmd/PowerShell stderr messages to arm denial markers (`[sandbox: …]`) and escalation. On non-English Windows editions, error messages may be localized, which may prevent escalation hints from appearing (enforcement itself remains active).
- **FFI Library (`koffi`)**: The Win32 FFI dependency is loaded lazily and only on Windows.
- **Diagnostic Skill**: If Windows file permissions block pi-sandbox grants, the bundled `diagnose-windows-sandbox-acl` skill can diagnose and repair them (contributed only on Windows; requires `danger-full-access` or manual execution).

## Migrating from pi-container-sandbox 1.x

- **Configuration File Compatibility**: Existing `sandbox.json` files are still read, but new settings should be written to `pi-sandbox.json`. Legacy `image`, `runtime`, and `host` sections are ignored with warnings. Existing files are not deleted or overwritten. `/pi-sandbox init` creates `pi-sandbox.json` and prompts before overwriting.
- **No Container Features**: Container runtimes (Docker/Podman), image builds, `runtime.mounts`, the `/sandbox` command, `--container*` flags, and external-path approval flows are not included in this package.
- **Mutual Exclusivity**: If you require container-level isolation (separate filesystem/network namespaces), use `@yuru7/pi-container-sandbox`. Both packages cannot be active simultaneously; uninstall or disable one before enabling the other.

## Development

```bash
npm test              # Unit + integration tests (integration auto-skips without runner)
npm run typecheck
./tests/e2e.sh
```

### Verifying Escalation Forwarding with a Local Build

The parent session can load a local pi-sandbox via `pi -e <path>`, but **`-e` only affects the parent**: pi-subagents builds a separate resource loader for each child session, re-discovering extensions from `agentDir` and the project `.pi/`. If `~/.pi/agent/settings.json` still declares `npm:@yuru7/pi-sandbox`, the child loads the published build and forwarding **fails silently** (reporting `requires approval, but no approval channel is available`). Ensure both sides discover the same build:

```bash
AG=$(mktemp -d); cp ~/.pi/agent/auth.json "$AG/" 2>/dev/null || true
cat > "$AG/settings.json" <<EOF
{ "packages": ["<repo>/pi-sandbox", "<repo>/pi-subagents"] }
EOF
cd <writable project dir> && PI_CODING_AGENT_DIR="$AG" pi
```

Observations and verification records are documented in `docs/superpowers/specs/2026-09-30-escalation-approval-forwarding-design.md` §11.

## Acknowledgements

This extension was inspired by [`pi-sandbox`](https://github.com/yandy/pi-packages/tree/main/pi-sandbox) in [yandy/pi-packages](https://github.com/yandy/pi-packages).

## License

MIT
