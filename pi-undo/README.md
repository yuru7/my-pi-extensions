# pi-undo

A Pi extension that checkpoints file changes from `write`, `edit`, and `bash`, then undoes the current session to an earlier user turn — or to a new empty session.

Repository: [yuru7/my-pi-extensions](https://github.com/yuru7/my-pi-extensions)

Pi mutations are snapshotted **before** the tool runs. Content is stored in a SHA-256 CAS under `~/.pi/agent/pi-undo/`. Objects 4 KB or larger are Deflate-compressed when that shrinks them. Git is not required. Snapshot failures never block `write` / `edit` / `bash`.

## What undo does

### `/undo` / `/undo <N>` — conversation turn

- `/undo` with no number is the same as `/undo 1`
- Keeps the selected user message
- Drops the assistant replies and tool calls after that message from the active conversation path (`navigateTree`, no branch summary)
- Restores files that Pi changed from that turn onward, from the mutation journal

### `/redo` — reverse the last `/undo`

- Returns to the conversation point that was active immediately before `/undo` or `/undo <N>`
- Restores files by re-applying Pi mutations for that conversation point
- `/undo-start` cannot be redone

### `/undo-start` — session start

- Restores every mutation this extension captured in the current session
- Opens a new empty session with the old session as `parentSession`

This is **not** a byte-for-byte disk image of session start. External edits that Pi never overwrote are kept. If Pi later edited the same file, the snapshot is the file as it existed immediately before that Pi write.

## Commands

```text
/undo
/undo <N>
/undo <N> --force
/undo-list
/undo-diff
/undo-diff <N>
/undo-start
/undo-start --force
/undo-status
/redo
/redo --force
/pi-undo:reset-setting
/pi-undo:clear-undo-store
```

`/undo` is an alias for `/undo 1`. Number 1 is the newest turn that changed files; those numbers are what `<N>` refers to.

`/undo-list` lists user turns in the current branch, oldest first (newest at the bottom). Turns with no file changes are shown in gray without a number and cannot be selected.

`/undo-diff` is an alias for `/undo-diff 1`. `/undo-diff <N>` previews the file changes that `/undo <N>` would restore.

`/undo-status` shows store usage and how many turns and files this session has tracked.

`/redo` returns to the conversation and files as they were immediately before the last `/undo` or `/undo <N>`. There is nothing to redo until an undo succeeds.

`/pi-undo:reset-setting` replaces the config file with the built-in defaults. You get a selector: **No** (default) or **Yes**. Esc cancels.

`/pi-undo:clear-undo-store` permanently deletes every snapshot, session journal, and undo journal under `~/.pi/agent/pi-undo/`, including the current session's undo history. The conversation and the configuration file are kept. The current session can keep snapshotting afterwards, starting from an empty store. You get a selector: **No** (default) or **Yes**. Esc cancels.

If `~/.pi/agent/pi-undo.json` is missing, the extension writes it with those defaults on load.

On `/undo`, `/redo`, and `/tree`, files that changed after Pi's last write are not overwritten automatically. You get a selector: **No (Do not overwrite)** (default) or **Yes (Overwrite)**. Esc cancels the navigation. `--force` on `/undo` and `/redo` overwrites without asking.

Built-in `/tree` also restores files by default (`syncTree: true`). Going back undoes later Pi mutations; returning to a later point on that branch restores the snapshot taken when you left it, or re-applies mutations if there is no snapshot. Leaf snapshots are saved when leaving a point, not after arriving. `/undo <N>` and `/redo` always restore from mutations, not from a leaf snapshot. Set `syncTree` to `false` if you want `/tree` to move the conversation only. `/undo <N>` and `/redo` always restore files.

## Installation

```bash
pi install npm:pi-undo
```

After installing, restart Pi or run `/reload`. Because the package includes the `pi-package` keyword, it will also appear on [Pi Packages](https://pi.dev/packages) after publication.

## Quick Start

After `/reload`, keep using Pi as usual. Files are snapshotted automatically before each `write`, `edit`, or `bash` mutation. Git is not required.

When a turn went the wrong way, list the numbered restore points:

```text
/undo-list
```

```text
Undo points (1 = newest):
2  10:12  Add login endpoint           5 files
   10:31  What does this endpoint do?  no file changes
1  10:45  Fix authentication bug       3 files
```

Oldest first, newest at the bottom. Number 1 is the newest turn that changed files. Gray lines have no number and cannot be selected.

Preview what `/undo` would restore, then undo that turn:

```text
/undo-diff
/undo
```

`/undo` keeps the selected user message, drops the replies after it, and restores the files Pi changed from that turn onward. If you edited those files after Pi's last write, you get a selector; **No (Do not overwrite)** is the default.

`/redo` reverses the last `/undo`. `/undo 2` jumps to an older numbered turn. `/undo-start` restores every captured mutation in this session and opens a new empty session.

## Configuration

Config file:

```text
~/.pi/agent/pi-undo.json
```

If the file is missing, it is created with the defaults below. If it cannot be parsed, Pi keeps running and you get:

```text
pi-undo: Failed to load configuration; using defaults.
```

Use `/pi-undo:reset-setting` to overwrite the file with the same defaults.

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
~/.pi/agent/pi-undo/
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

After each recorded mutation, the post-change hash is stored. On restore, a file is treated as externally edited when the current hash does not match Pi's last write.

`/undo`, `/redo`, and `/tree` ask before overwriting those files. **No (Do not overwrite)** is the default selection and keeps your edits. Move the selection to **Yes (Overwrite)** to overwrite. Esc cancels the navigation. `--force` on `/undo` and `/redo` skips the prompt and overwrites.

```text
Overwrite 2 files modified after Pi's last write?

  src/config.ts
  README.md

→ No (Do not overwrite)
  Yes (Overwrite)
```

If you keep **No (Do not overwrite)**, the restore summary still lists the skipped files:

```text
Restored: 7 files
Skipped: 2 files modified after Pi's last write

  src/config.ts
  README.md

Use /undo 3 --force to overwrite them.
```

v1 does not 3-way merge "Pi edits" vs "your edits" on the same file.

## Limits and maintenance

- 10 MB per file and 300 MB total store on disk by default
- Bash directory walks stop at 2000 files or 50 MB per call by default; an oversized directory is skipped as a whole
- Inactive session history older than `retentionDays` can be garbage-collected
- The active session's history is not deleted automatically
- `/pi-undo:clear-undo-store` wipes the whole store immediately without resetting the conversation (config is kept)
- If the active session alone exceeds the cap, new snapshots are skipped and a warning is shown
- Unfinished `pending/` journals from a crash are reported on the next `session_start`

## Supported platforms

Linux, macOS, Windows, and Pi running inside WSL. Path forms such as `C:\...`, `C:/...`, Git Bash `/c/...`, WSL `/mnt/c/...`, and UNC `\\server\share\...` are normalized where the current process can actually open them.

## Development

```bash
cd pi-undo
pnpm install
pnpm test
```
