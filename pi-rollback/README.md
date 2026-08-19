# pi-rollback

A Pi extension that checkpoints file changes from `write`, `edit`, and `bash`, then rolls the current session back to an earlier user turn — or to a new empty session.

Repository: [yuru7/my-pi-extensions](https://github.com/yuru7/my-pi-extensions)

Pi mutations are snapshotted **before** the tool runs. Content is stored in a SHA-256 CAS under `~/.pi/agent/pi-rollback/`. Git is not required. Snapshot failures never block `write` / `edit` / `bash`.

## What rollback does

### `/rollback <N>` — conversation turn

- Keeps the selected user message
- Drops the assistant replies and tool calls after that message from the active conversation path (`navigateTree`, no branch summary)
- Restores files that Pi changed from that turn onward, as far as snapshots allow

### `/rollback start` — session start

- Restores every mutation this extension captured in the current session
- Opens a new empty session with the old session as `parentSession`

This is **not** a byte-for-byte disk image of session start. External edits that Pi never overwrote are kept. If Pi later edited the same file, the snapshot is the file as it existed immediately before that Pi write.

## Commands

```text
/rollback
/rollback <N>
/rollback <N> --force
/rollback diff <N>
/rollback start
/rollback start --force
/rollback status
/reset-rollback-setting
/clear-rollback-store
```

`/rollback` lists user turns in the current branch, oldest first (newest at the bottom). Number 1 is the newest turn that changed files; those numbers are what `<N>` refers to. Turns with no file changes are shown in gray without a number and cannot be selected.

`/reset-rollback-setting` replaces the config file with the built-in defaults.

`/clear-rollback-store` permanently deletes every snapshot, session journal, and rollback journal under `~/.pi/agent/pi-rollback/`, including the current session's rollback history. The conversation and the configuration file are kept. The current session can keep snapshotting afterwards, starting from an empty store.

If `~/.pi/agent/pi-rollback.json` is missing, the extension writes it with those defaults on load.

`--force` overwrites files that changed after Pi's last write. The default `safeRestore` skips those files.

Built-in `/tree` also restores files by default (`syncTree: true`). Going back undoes later Pi mutations; returning to a later point on that branch re-applies those mutations (or the snapshot taken when you left it). That includes going back with `/tree` after `/rollback <N>`. Set `syncTree` to `false` if you want `/tree` to move the conversation only. `/rollback <N>` always restores files.

## Installation

```bash
pi install npm:pi-rollback
```

After installing, restart Pi or run `/reload`. Because the package includes the `pi-package` keyword, it will also appear on [Pi Packages](https://pi.dev/packages) after publication.

### Update / uninstall

```bash
pi update npm:pi-rollback
pi remove npm:pi-rollback
```

### Install from a local path

This repository is a monorepo for multiple extensions. During development or before publication, point Pi at the `pi-rollback/` package.

```bash
git clone https://github.com/yuru7/my-pi-extensions.git
pi install ./my-pi-extensions/pi-rollback
```

If you already have a clone, pass that path:

```bash
pi install /absolute/path/to/my-pi-extensions/pi-rollback
```

To try it temporarily:

```bash
pi -e /absolute/path/to/my-pi-extensions/pi-rollback
```

When installed from a local path, update by running `git pull` in the repository, then restart Pi or run `/reload`. Uninstall as follows:

```bash
pi remove /absolute/path/to/my-pi-extensions/pi-rollback
```

## Configuration

Config file:

```text
~/.pi/agent/pi-rollback.json
```

If the file is missing, it is created with the defaults below. If it cannot be parsed, Pi keeps running and you get:

```text
pi-rollback: Failed to load configuration; using defaults.
```

Use `/reset-rollback-setting` to overwrite the file with the same defaults.

```json
{
  "enabled": true,
  "maxFileSizeMB": 10,
  "maxTotalSizeMB": 300,
  "retentionDays": 14,
  "safeRestore": true,
  "syncTree": true,
  "bash": {
    "enabled": true,
    "maxFilesPerCall": 2000,
    "maxBytesPerCallMB": 50,
    "warnOnUnresolvedMutation": true
  },
  "excludeGlobs": []
}
```

Snapshot data (not this config file) lives in:

```text
~/.pi/agent/pi-rollback/
```

That store path is always excluded from snapshots so the extension cannot snapshot itself.

`.env` and `$HOME` are not excluded by name. Add globs only when you want them skipped:

```json
{
  "excludeGlobs": [
    "**/*.iso",
    "**/node_modules/**"
  ]
}
```

## Coverage

| Tool | Coverage |
| --- | --- |
| `write` / `edit` | Exact, for the local built-in tools |
| `bash` | Best-effort path extraction and optional directory walk |

`bash` coverage is partial when the command uses `$VAR`, `$(...)`, interpreters such as `python` / `node`, or a mutating command hits the per-call file/byte limit. Inspect-only commands such as `ls`, `cat`, and `find` without `-delete` / `-exec` are not snapshotted. Interpreter internals are not analyzed.

If a bash target is a directory and walking it exceeds `maxFilesPerCall` or `maxBytesPerCallMB`, that directory is skipped entirely rather than keeping a partial snapshot. Other files from the same command are still tracked when they fit.

Remote or overridden tools (SSH backends, other extensions replacing `write` / `edit` / `bash`) are not snapshotted in v1.

Virtual filesystems are skipped: `/proc`, `/sys`, `/dev`, `/run`, and Windows `\\.\` device paths. Sockets, FIFOs, and device files are not stored. Symlinks are not walked recursively.

## Safe restore

After each recorded mutation, the post-change hash is stored. On rollback, a file is skipped when the current hash does not match Pi's last write — usually because you edited it afterwards.

```text
Restored: 7 files
Skipped: 2 files modified after Pi's last write

  src/config.ts
  README.md

Use /rollback 3 --force to overwrite them.
```

v1 does not 3-way merge "Pi edits" vs "your edits" on the same file.

## Limits and maintenance

- 10 MB per file and 300 MB total store by default
- Bash directory walks stop at 2000 files or 50 MB per call by default; an oversized directory is skipped as a whole
- Inactive session history older than `retentionDays` can be garbage-collected
- The active session's history is not deleted automatically
- `/clear-rollback-store` wipes the whole store immediately without resetting the conversation (config is kept)
- If the active session alone exceeds the cap, new snapshots are skipped and a warning is shown
- Unfinished `pending/` journals from a crash are reported on the next `session_start`

## Supported platforms

Linux, macOS, Windows, and Pi running inside WSL. Path forms such as `C:\...`, `C:/...`, Git Bash `/c/...`, WSL `/mnt/c/...`, and UNC `\\server\share\...` are normalized where the current process can actually open them.

## Development

```bash
cd pi-rollback
pnpm install
pnpm test
```
