# pi-sandbox

English | [日本語](./README_ja.md)

pi coding-agent extension: process-level sandbox (bwrap / landlock / seatbelt / windows-acl) — workspace writable, everything else readable, fail-closed.

## Install

```bash
# From npm
pi install npm:@yuru7/pi-sandbox

# Or from a local checkout
pi install .
```

## How it works

bash commands are wrapped in a platform sandbox runner and spawned locally (**path transparent**: host paths work as-is); the write/edit tools run an in-process write fence before execution; read is unrestricted.

**Scope: model-issued work only.** A `!command` / `!!command` you type yourself (also the RPC `bash` command) is executed by pi itself through the `user_bash` event, which this extension does not handle — it runs as your own shell, unconfined by the modes above. The same holds for any other process you start outside pi.

| Platform | Runner | Mechanism |
|---|---|---|
| Linux | `bwrap` (preferred) | `--ro-bind / /` whole filesystem read-only + rw binds of the workspace and the host `/tmp` |
| Linux | `landlock-run` (fallback, precompiled binary shipped with the package) | Landlock LSM allow list: `/` read-only, workspace + `/tmp` writable |
| macOS | `sandbox-exec` (built in) | Seatbelt SBPL: `deny file-write*` + workspace/temp exceptions |
| Windows | `windows-acl` (built in, `partial` enforcement) | Restricted-token sandbox: `WRITE_RESTRICTED` token + capability-SID ACL grants on the workspace and `%TEMP%` + Low mandatory integrity label; **powershell tool only** (`bash` is refused in confined modes) |
| Other | none | **fail-closed**: confined commands are always refused, never silently run bare |

### Windows

The `windows-acl` runner starts each confined command from a `WRITE_RESTRICTED` token whose integrity level is lowered to Low. In `workspace-write` the token also carries capability SIDs granted write access to the workspace and the host `%TEMP%`, with an inheritable `NO_WRITE_UP` label on both roots; `read-only` grants no write capability. Enforcement is **`partial`**, with three structural gaps inherited from the reference implementation:

- **an NTFS hard link aliases the file object**: a hard link to an authorized file inside the workspace is equally writable from outside it
- **reads are unconfined**: like every other runner here, a confined process can read everything you can read
- **files tagged by another AppContainer tool's package SID are unreadable** to the Low-integrity child (remove the foreign ACE or reinstall the tree to recover)

The confined shell is the **`powershell` tool only**. On Windows (pi >= 1.0.0) pi-sandbox registers its confined `bash` with `exposure: "hidden"`, which makes it *registered but unreachable*: the model never sees it, and naming it (`defaultTools`, `--tools`, `setActiveTools()`) does not activate it. Keeping the registration is deliberate — extension tools shadow same-named built-ins, so the `bash` name stays occupied by this definition and no unconfined built-in `bash` can be reached on Windows; should a future host change how `hidden` is honored, that definition still refuses every confined call (fail-closed, never spawned). `bash` is never run unconfined here unless you explicitly switch to `danger-full-access`, the only bypass (where it runs bare, as everywhere else).

Known limitation: **`defaultTools` cannot deselect an extension-registered tool** (`-name` entries only remove built-ins, and extension tools are auto-activated unless their definition opts out). pi-sandbox does not ask you to configure around this: on Windows the `bash` name is withdrawn from the model at the definition level (`exposure: "hidden"`), so there is nothing to configure away. If `powershell` is not active (a host older than 1.0.0, which ships no `powershell` tool, or a selection that leaves it out), `/permission` shows `shell: powershell only (not activated)`, and pi-sandbox hints once at activation when `bash` is still in the active list (older hosts); `{ "defaultTools": ["+powershell"] }` (requires pi >= 1.0.0) adds it back.

**Supported Windows range.** Same as the upstream design this backend ports (deepseek-harness): **no new OS floor** — the mechanism is a `WRITE_RESTRICTED` token plus a Low mandatory label, both legacy APIs — which is exactly why that route was chosen over `mxc` (Windows 11 24H2+). End-to-end verification in this repository ran on **Windows 10 Enterprise LTSC 2019 (build 17763.316)**: the automated e2e suite and the manual acceptance checklist are green there. Newer builds are expected to work (nothing in the backend depends on them), but have not been exercised here yet. Note the upstream *tests* run on Windows Server 2025, so its test fixtures are not portable to older builds; this package's Windows fixtures deliberately use version-independent primitives.

PowerShell language mode follows startup constraints, not the ACL boundary: under `read-only` PowerShell may degrade to ConstrainedLanguage (`Add-Type`/COM/reflection fail) because `%TEMP%` is not writable; `workspace-write` keeps FullLanguage.

**`NUL` is writable in both modes** — an environment property of the device (its DACL grants Everyone read/write/execute), not a capability grant, so it holds regardless of which roots the token was granted. It is reachable only through the device spellings: `cmd`'s `> NUL` and Node's `\\.\NUL`. A *relative* `NUL` is not the device: libuv builds NT paths and does not apply the Win32 device-name mapping, so `writeFileSync('NUL', …)` is an ordinary file named `NUL` in the child's cwd — allowed inside the workspace, denied outside it, exactly like any other name.

**Standing security-descriptor changes.** Granting is idempotent but never revoked: after pi exits, the ACEs, the world `FILE_DELETE_CHILD` deny and the Low mandatory label on the workspace and `%TEMP%` remain. This relaxes those trees for **any** Low-integrity process running as the same user, and clearing an inheritable label later does not walk back what already propagated to child objects. Switching back to `read-only` makes the capability ACEs inert (that token carries no capability SID) but does not remove them. The first grant eagerly propagates across the whole `%TEMP%` tree (seconds on a large tree); later calls hit the exact-match fast path. `%TEMP%` and `TMP` themselves are **not** rewritten — the sandbox's writable temp root is the host `%TEMP%`.

**The `%TEMP%` cost.** `%TEMP%` is a shared user tree: its subdirectories inherit the deny ACE, so a third party that opens its own temp subdirectory with `GENERIC_ALL`/`FullControl` is refused. DELETE-based deletes, `MAXIMUM_ALLOWED` and ordinary read/write opens are unaffected.

**Denial classification is English-only.** The denial dialects the tool matches to inject the `[sandbox: …]` denial marker, the escalation hint and the denial ledger are English Win32/`cmd`/PowerShell message text, matched against the child's **stderr**. On a localized Windows those messages are localized: the sandbox still denies the access (enforcement is language-independent), but the tool may not annotate the denial and denial-first escalation will not arm. Treat a missing marker as a classification gap, not as a confinement failure.

`koffi` (the FFI layer for the Win32 calls) is a regular dependency, loaded lazily and only on Windows — the Win32 binding table is never materialized elsewhere.

The bundled `diagnose-windows-sandbox-acl` skill (diagnoses and repairs cases where Windows file permissions block pi-sandbox's grants) is contributed to pi **on Windows only**. Its repair modifies security descriptors, so it needs an unconfined caller — run it from an approved `danger-full-access` (or by hand).

## Three permission modes

| Mode | File effects |
|---|---|
| `read-only` | only `/dev/null` writable |
| `workspace-write` (default) | working directory + `/tmp` + `os.tmpdir()` writable, everything else read-only |
| `danger-full-access` | sandbox bypassed entirely (explicit escape hatch) |

Network is always allowed (no network isolation).

## /permission command

- `/permission` — show the current status (mode and source, selected runner and enforcement, workspace)
- `/permission <read-only|workspace-write|danger-full-access>` — switch mode, **process-wide**: the next tool call in the parent session and in every subagent child session adopts it immediately

## /pi-sandbox command

- `/pi-sandbox init` — write `pi-sandbox.json` with the default settings shown below. Choose the global agent directory or `<project>/.pi/`. If that file already exists, the command asks before overwriting; cancelling leaves it unchanged. Legacy `sandbox.json` in the same directory is still read, and fields in the new file override it. A `/permission` override still takes precedence over the file

## Escalation approval (model-initiated, denial-first)

bash/write/edit take two optional parameters: `sandbox_permissions` (`workspace-write` or `danger-full-access`) + `justification` (a one-sentence reason). Approval is **denial-first**:

- A strictly wider request is honored only when this session has an **unconsumed sandbox denial of that same operation** (same tool, same cwd, same arguments aside from the escalation fields). A denial of `echo a` does not unlock `echo b`, and a bash denial does not unlock powershell. Otherwise the escalation fields are **ignored**, the call runs at the current mode, and the result carries a `[sandbox: escalation fields were ignored …]` note;
- a denial record is **consumed once** and expires after 10 minutes: one denial buys exactly one escalation retry (approval still applies to that one call only);
- placeholder parameters are normalized per field: omission and JSON `null` both mean "no request", and the parameter schema declares `null` explicitly — so models on strict-schema providers (where pi marks both fields as required) have a valid "no escalation" value to send; a `"null"` or blank string in `justification` is normalized the same way. String placeholders (`"null"` / empty / whitespace) get one more layer of protection: the tools' `prepareArguments` strips them **before** pi validates the arguments — strict-schema models often write the required-but-optional fields as the string `"null"`, and this keeps such calls running instead of failing with an error that has nothing to do with the sandbox.

Who decides that one retry is `approvalMode`:

| Mode | Behavior |
|---|---|
| `human` | **Allow once / Deny**. After Deny you may type an optional reason. A subagent's request is forwarded to the parent prompt (in-process pi-subagents, parent must have UI). With no channel (headless, cross-process subagents) the escalation is refused. |
| `auto-review` (default) | An independent reviewer model answers `ALLOW` or `DENY`. No human prompt, including when the reviewer or the UI is unavailable. Headless and subagent sessions use the same path. |
| `allow-all` | A valid, denial-backed, strictly wider request is approved once. This does **not** switch the session to `danger-full-access`. |

`allow-all` and `auto-review` still refuse a request that has no matching denial. An invalid `approvalMode`, reviewer model, or thinking level denies the escalation; a bad config never becomes `allow-all`, and the sandbox around ordinary calls stays in place.

## Auto-review

The reviewer is a separate model call. It does not see the agent transcript, it is not given tools, and it does not change the agent model or thinking level. The prompt is only:

- sandbox metadata (backend, mode, workspace, writable paths; network stays allowed)
- the attempted command or write path, cwd, exit code, and the tails of stdout/stderr (8KiB each) or the write-fence error
- the requested mode and the agent's justification

Those fields are sent to the reviewer provider's API. Treat that as a disclosure of the command and the captured output. Secrets are redacted only for a few obvious patterns; do not rely on that.

The reviewer must answer exactly `ALLOW` or `DENY`. Anything else (empty, mixed, a tool call) is a deny. A normal `DENY` is final: pi-sandbox does not ask a second model and does not fall through to the human prompt.

`autoReview.model` is `CURRENT` (the agent model at the moment the escalation is handled) or `provider/model-id`. `autoReview.thinkingLevel` is `CURRENT` or a Pi thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). An explicit level the model does not support fails that attempt; it is not silently lowered.

If the configured model cannot be called (unknown id, missing auth, auth failure, unsupported API or thinking level, connection/API/rate-limit failure, or a 15s timeout), pi-sandbox warns once and retries the same review on the active agent model, with the same thinking setting. Each attempt has its own 15s budget. A late reply from a timed-out attempt is ignored. There is no third model. The retry is skipped when the setting is already `CURRENT` or the same provider and model id. If that second call also fails, the escalation is denied.

```text
[pi-sandbox] Auto-review warning:
Configured reviewer model "provider/model-A" is unavailable (request failed).
Falling back to the active model "provider/model-B".
```

The warning goes to `ctx.ui.notify(..., "warning")` when a UI exists, otherwise to stderr. It names the models and a short reason. It does not include the command, the logs, or credentials. A failed warning does not turn the decision into an allow.

This is a risk judgment, not a guarantee. `danger-full-access` removes the sandbox for that one call, so the reviewer has to judge the whole command, not the single path that was denied. A normal install command can still run arbitrary package scripts.

## Configuration

Global files live in Pi's agent directory from `getAgentDir()` (usually `~/.pi/agent`, or `$PI_CODING_AGENT_DIR` when that variable is set). Do not point this extension at a hand-built `~/.pi/agent` path. The SDK `agentDir` option is not visible on the extension context in current Pi; set `PI_CODING_AGENT_DIR` as well when a process should use a different agent directory.

Project files live in `<project>/.pi/`. The extension does not create a config file on startup. `/pi-sandbox init` writes `pi-sandbox.json` when you ask it to. Legacy `sandbox.json` files are left in place.

Priority, per field (later wins):

1. `<project>/.pi/pi-sandbox.json`
2. `<project>/.pi/sandbox.json` (legacy name, still read)
3. `<agent-dir>/pi-sandbox.json`
4. `<agent-dir>/sandbox.json`
5. defaults

`autoReview.model` and `autoReview.thinkingLevel` merge on their own. An untrusted project, or a host that cannot answer `isProjectTrusted()`, does not get to change approval settings: mode, runner, and probe still merge, but `approvalMode` / `autoReview` stay on the global files. That stops an untrusted checkout from selecting `allow-all`.

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

| Field | Default | Notes |
|---|---|---|
| `mode` | `workspace-write` | default permission mode; invalid values fall back to the default with a warning |
| `runnerCommand` | `null` | custom bwrap-compatible runner argv (must be paired with the next field) |
| `runnerFailureSignatures` | `null` | fatal diagnostic signatures for the custom runner (non-empty single lines) |
| `probeTimeoutMs` | `5000` | runner capability probe timeout (positive) |
| `approvalMode` | `auto-review` | `human`, `auto-review`, or `allow-all`. An invalid value denies escalation |
| `autoReview.model` | `CURRENT` | `CURRENT` or `provider/model-id` |
| `autoReview.thinkingLevel` | `CURRENT` | `CURRENT` or a Pi thinking level |

`/permission` prints the approval mode that will actually be used (global, when the project is not trusted).

## Security notes

- Confined processes can **read** everything you can read on the host (including `~/.ssh` and the like) — that is this sandbox's design semantics (same as the deepseek harness); root-only files stay protected by file permissions
- Under bwrap, bash's `/tmp` **is the host `/tmp`** (rw bind, matching the write/edit fence and the landlock/macOS runners): confined commands can modify or delete the host's temporary files — including live session sockets and pi's own temp files — and the host's `/tmp` permissions apply as-is. If the host `/tmp` is not writable, neither is the sandbox's
- On Windows the sandbox's temp root is the host `%TEMP%` (the `windows-acl` runner grants the real path and does not rewrite `TMP`/`TEMP`): confined commands can modify or delete the host's temporary files there — the same "the host tmp is the host tmp" semantics as the bwrap bind above
- Confined child processes force `LC_MESSAGES=C` (so denial diagnostics stay classifiable) and do not touch your `LANG`/`LC_CTYPE`
- Confined bash runs in its own process group (detached): timeout/abort kills the whole group, but if pi itself is hard-killed (e.g. SIGKILL), background grandchildren spawned by the command may survive (pi's internal child-tracking API is not available to extensions)
- The landlock fallback is partial enforcement on older kernel ABIs (the status output says so)

## Migrating from pi-container-sandbox 1.x

- Legacy config files (`sandbox.json` in the agent directory and in `<project>/.pi/`) are still read. New settings belong in `pi-sandbox.json` in those same directories. Legacy `image`/`runtime`/`host` sections are ignored with a warning — rewrite them as the fields above as needed. Existing `sandbox.json` files are not deleted or rewritten. `/pi-sandbox init` creates `pi-sandbox.json`, and overwrites that file only after you confirm
- The container runtime (docker/podman), image builds, `runtime.mounts`, the `/sandbox` command, `--container*` flags, and the external-path approval flow are not part of this package
- Need container-grade isolation (separate filesystem/network namespaces)? Install `@yuru7/pi-container-sandbox` — it keeps the container implementation
- `pi-sandbox` and `@yuru7/pi-container-sandbox` are **mutually exclusive**: both take over `bash`/`write`/`edit` and both read `sandbox.json` (with incompatible schemas) — enable only one at a time, and uninstall or disable the other before switching. This package also reads `pi-sandbox.json`, which the container package does not

## Development

```bash
npm test              # unit + integration (integration auto-skips without a runner)
npm run typecheck
./tests/e2e.sh
```

### Verifying escalation forwarding with a local build

The parent session can load a local pi-sandbox via `pi -e <path>`, but **`-e` only affects the parent**: pi-subagents builds a separate resource loader for each child session, so the child **re-discovers** extensions from `agentDir` and the project `.pi/`. If `~/.pi/agent/settings.json` still declares `npm:@yuru7/pi-sandbox`, the child loads the published build and forwarding **fails silently** (the child only reports `requires approval, but no approval channel is available`). Make both sides discover the same build:

```bash
AG=$(mktemp -d); cp ~/.pi/agent/auth.json "$AG/" 2>/dev/null || true
cat > "$AG/settings.json" <<EOF
{ "packages": ["<repo>/pi-sandbox", "<repo>/pi-subagents"] }
EOF
cd <writable project dir> && PI_CODING_AGENT_DIR="$AG" pi
```

Observations and the verification record live in `docs/superpowers/specs/2026-09-30-escalation-approval-forwarding-design.md` §11.

## License

MIT
