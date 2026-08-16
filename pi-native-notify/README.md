# pi-native-notify

Pi の長時間タスクが完了したとき、利用中の OS へネイティブ通知を送る Extension です。

リポジトリ: [yuru7/my-pi-extensions](https://github.com/yuru7/my-pi-extensions)

完了判定には `agent_end` ではなく `agent_settled` を使います。retry、compaction 後の再実行、queued follow-up が残っている間は通知しません。一連の処理が本当に終わってから、次のいずれかなら知らせます。

- ターミナルがフォーカスアウトしている（秒数は問わない）
- 経過時間が閾値以上（デフォルト **30秒**。フォーカス中でも通知する）

## Supported platforms

| 環境 | 通知手段 |
| --- | --- |
| Windows | PowerShell 経由の Toast 通知 |
| WSL | `powershell.exe` 経由で Windows 通知 |
| Linux | `notify-send` |
| macOS | `osascript` の `display notification` |

OS は自動判定します。WSL は通常の Linux とは区別し、Windows 通知を優先します。通知音は各 OS の標準通知設定に従います。

## Requirements

### Windows / WSL

- Windows PowerShell (`powershell.exe`)
- WSL から使う場合は、Windows 側で通知が有効であること
- `powershell.exe` が PATH に無い場合は、設定ファイルの `powershellPath` に絶対パスを書けます

### Linux

- `notify-send`（freedesktop.org Desktop Notifications）
- Ubuntu / Debian の例: `sudo apt install libnotify-bin`
- 未導入の場合は通知をスキップします。Pi の Agent 処理自体は失敗しません

### macOS

- `osascript`（標準搭載）

## インストール

```bash
pi install npm:pi-native-notify
```

インストール後、Pi を再起動するか `/reload` してください。`pi-package` キーワード付きのため、公開後は [Pi Packages](https://pi.dev/packages) にも掲載されます。

### 更新 / 削除

```bash
pi update npm:pi-native-notify
pi remove npm:pi-native-notify
```

### ローカルパスから入れる

このリポジトリは複数 Extension 用のモノレポです。開発中や未公開の状態では、`pi-notify/` をパッケージとして指定します。

```bash
git clone https://github.com/yuru7/my-pi-extensions.git
pi install ./my-pi-extensions/pi-notify
```

すでにクローン済みなら、そのパスを指定してください。

```bash
pi install /absolute/path/to/my-pi-extensions/pi-notify
```

一時的に試す場合:

```bash
pi -e /absolute/path/to/my-pi-extensions/pi-notify
```

ローカルパスで入れている場合の更新は、リポジトリを `git pull` したあと Pi を再起動するか `/reload` してください。削除は次のとおりです。

```bash
pi remove /absolute/path/to/my-pi-extensions/pi-notify
```

## Configuration

対話的に閾値を変える:

```text
/notify-settings
```

現在の秒数が表示され、新しい秒数を入力できます。この値は「これ以上かかったら、フォーカス中でも通知する」閾値です。`0` は有効で、すべての `agent_settled` を通知します。不正な値は拒否され、既存の設定は変わりません。

フォーカス判定は端末の DECSET 1004（`ESC[I` / `ESC[O`）を使います。対応していない端末では、フォーカスアウト扱いにはせず、経過時間の閾値だけが効きます。tmux では `set -g focus-events on` が必要です。

設定ファイル:

```text
~/.pi/agent/notify-settings.json
```

例:

```json
{
  "thresholdSeconds": 30
}
```

WSL で `powershell.exe` の場所を明示する場合:

```json
{
  "thresholdSeconds": 30,
  "powershellPath": "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
}
```

保存後すぐに反映されます。Pi を再起動しても値は維持されます。

## 通知メッセージ

- タイトル: `Done - Pi`
- 本文: 対象プロンプト（改行は空白にまとめ、50文字を超える場合は省略。取れない場合は `タスクが完了しました`）

## Troubleshooting

### Windows で通知されない

- 設定アプリで通知がオフになっていないか確認してください
- フォーカス支援 / サイレント時間が有効だと表示されないことがあります
- PowerShell 実行ポリシーではなく、この Extension は `-Command` で完結します。外部モジュールは不要です

### WSL から通知されない

- Windows 側で通知が許可されているか確認してください
- ターミナルから `powershell.exe -NoProfile -Command "echo ok"` が動くか確認してください
- 動かない場合は `powershellPath` に絶対パスを設定してください

### Linux で notify-send がない

通知はスキップされ、初回のみ診断メッセージを出します。

```bash
sudo apt install libnotify-bin
```

GNOME / KDE / XFCE など、Desktop Notification Service が動いていることも必要です。

### macOS で通知されない

- システム設定 → 通知で、通知元（Script Editor / osascript）が許可されているか確認してください
- ターミナルや IDE から起動していると、そのアプリの通知権限が必要になることがあります

### 通知音が鳴らない

独自の音声再生はしません。OS の通知音設定を尊重します。

### 設定ファイルが保存されない

- `~/.pi/agent/` への書き込み権限があるか確認してください
- `/notify-settings` で不正値を入れるとファイルは更新されません

### 短いタスクで通知されない

ターミナルを見ている間は、デフォルトでは 30 秒未満の処理を通知しません。別ウィンドウへ移っているときは短いタスクでも通知します。閾値を変えたい場合は `/notify-settings` を使ってください。

tmux でフォーカスアウトが取れないときは `set -g focus-events on` を確認してください。

## 開発

```bash
cd pi-notify
node --test tests
```

通知処理の失敗は Pi 本体の Agent 処理を失敗させません。
