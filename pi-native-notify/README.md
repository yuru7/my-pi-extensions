# pi-native-notify

A Pi extension that sends a native OS notification when a long-running task completes.

Repository: [yuru7/my-pi-extensions](https://github.com/yuru7/my-pi-extensions)

> **Note:** The developer has only verified this extension on WSL2. Other platforms are implemented, but have not been tested on real devices by the author.

Completion is detected with `agent_settled`, not `agent_end`. Notifications are not sent while a retry, a re-run after compaction, or a queued follow-up is still pending. After the full run has actually finished, a notification is sent when either of the following is true:

- The terminal is unfocused (regardless of elapsed time)
- Elapsed time is at or above the threshold (default **30 seconds**; notifies even while focused)

## Supported platforms

| Environment | Notification method |
| --- | --- |
| Windows | Toast notification via PowerShell |
| WSL | Windows notification via `powershell.exe` |
| Linux | `notify-send` |
| macOS | `osascript` `display notification` |

The OS is detected automatically. WSL is treated separately from regular Linux and prefers Windows notifications. Notification sound follows each OS's standard notification settings.

## Requirements

### Windows / WSL

- Windows PowerShell (`powershell.exe`)
- When used from WSL, notifications must be enabled on the Windows side
- If `powershell.exe` is not on PATH, set an absolute path in `powershellPath` in the config file

### Linux

- `notify-send` (freedesktop.org Desktop Notifications)
- Ubuntu / Debian example: `sudo apt install libnotify-bin`
- If it is not installed, notifications are skipped. Pi's agent run itself does not fail

### macOS

- `osascript` (preinstalled)

## Installation

```bash
pi install npm:pi-native-notify
```

After installing, restart Pi or run `/reload`. Because the package includes the `pi-package` keyword, it will also appear on [Pi Packages](https://pi.dev/packages) after publication.

### Update / uninstall

```bash
pi update npm:pi-native-notify
pi remove npm:pi-native-notify
```

### Install from a local path

This repository is a monorepo for multiple extensions. During development or before publication, point Pi at the `pi-native-notify/` package.

```bash
git clone https://github.com/yuru7/my-pi-extensions.git
pi install ./my-pi-extensions/pi-native-notify
```

If you already have a clone, pass that path:

```bash
pi install /absolute/path/to/my-pi-extensions/pi-native-notify
```

To try it temporarily:

```bash
pi -e /absolute/path/to/my-pi-extensions/pi-native-notify
```

When installed from a local path, update by running `git pull` in the repository, then restart Pi or run `/reload`. Uninstall as follows:

```bash
pi remove /absolute/path/to/my-pi-extensions/pi-native-notify
```

## Configuration

Change the threshold interactively:

```text
/notify-settings
```

The current number of seconds is shown, and you can enter a new value. This is the threshold for "notify even while focused if the run took at least this long". `0` is valid and notifies on every `agent_settled`. Invalid values are rejected and the existing setting is left unchanged.

Focus detection uses the terminal's DECSET 1004 (`ESC[I` / `ESC[O`). Terminals that do not support it are not treated as unfocused; only the elapsed-time threshold applies. In tmux, `set -g focus-events on` is required.

Config file:

```text
~/.pi/agent/notify-settings.json
```

Example:

```json
{
  "thresholdSeconds": 30
}
```

To set the `powershell.exe` path explicitly on WSL:

```json
{
  "thresholdSeconds": 30,
  "powershellPath": "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
}
```

Changes take effect immediately after save. The value is kept across Pi restarts.

## Notification message

- Title: `Done - Pi`
- Body: the target prompt (newlines are collapsed to spaces; truncated if longer than 50 characters. If unavailable, `Task completed`)

## Troubleshooting

### No notification on Windows

- Check that notifications are not turned off in Settings
- Focus assist / quiet hours may hide notifications
- This extension does not depend on PowerShell execution policy; it runs a self-contained `-Command`. No external modules are required

### No notification from WSL

- Check that notifications are allowed on the Windows side
- From the terminal, confirm that `powershell.exe -NoProfile -Command "echo ok"` works
- If it does not, set an absolute path in `powershellPath`

### notify-send is missing on Linux

Notifications are skipped, and a diagnostic message is shown the first time only.

```bash
sudo apt install libnotify-bin
```

A Desktop Notification Service must also be running (GNOME / KDE / XFCE, and so on).

### No notification on macOS

- In System Settings → Notifications, check that the notification source (Script Editor / osascript) is allowed
- When launched from a terminal or IDE, that app's notification permission may be required

### No notification sound

This extension does not play its own sound. It respects the OS notification sound settings.

### Config file is not saved

- Check that you have write permission to `~/.pi/agent/`
- Invalid values entered via `/notify-settings` do not update the file

### No notification for short tasks

While you are looking at the terminal, runs shorter than 30 seconds are not notified by default. If you have switched to another window, short tasks are still notified. Use `/notify-settings` to change the threshold.

If unfocus is not detected in tmux, check `set -g focus-events on`.

## Development

```bash
cd pi-native-notify
node --test tests
```

Notification failures do not fail Pi's agent run.
