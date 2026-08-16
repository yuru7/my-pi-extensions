# Pi Native Notify Extension - ExecPlan

## 1. 目的

Pi の長時間タスク完了を、利用している OS のネイティブ通知として知らせる個人用 Extension を新規作成する。

Pi の Agent ライフサイクルイベントを利用し、`agent_start` から `agent_settled` までの経過時間が設定された閾値以上の場合にデスクトップ通知を送信する。

既存の `task-complete-notify` は直接改変せず、実装上の参考資料としてのみ利用する。

対応OSは以下とする。

* Windows
* Linux
* macOS

各OSでは、可能な限り標準的・ネイティブな通知手段を使用する。

---

## 2. ゴール

以下を満たした状態を初期バージョン完成とする。

* Pi Extension として正常にロードできる
* Windows / Linux / macOS を自動判定できる
* 各OSでネイティブ通知を送信できる
* OS標準の通知音、または通知システム標準の挙動を利用する
* Agent の処理時間が30秒以上の場合のみデフォルトで通知する
* 処理完了判定には Pi の `agent_settled` を利用する
* `/notify-settings` から通知設定を対話的に変更できる
* 設定を `~/.config/pi/notify-config.json` に永続化する
* Pi 再起動後も設定が維持される
* GitHub リポジトリから直接インストールできる
* npm 公開を必要としない
* 通知処理の失敗が Pi 本体の Agent 処理を失敗させない

---

## 3. 非ゴール

初期バージョンでは以下を対象外とする。

* Android への通知
* iOS への通知
* ntfy / Slack / Discord 等への外部通知
* 独自MP3などのカスタム通知音
* npm パッケージとしての公開
* タスク成功・失敗の自動判定
* Web UI
* 通知サービスごとの高度なカスタマイズ
* Growl 等のレガシー通知システム
* 外部通知ライブラリへの必須依存

初期実装は「Pi の処理完了をローカルOSへ確実に通知する」ことに集中する。

---

## 4. 対応環境

### Windows

想定:

* Windows 11
* Windows 10 は可能な範囲で互換
* Pi が WSL 内、または Windows ネイティブ環境で動作

通知方式:

```text
PowerShell
    ↓
Windows Toast / Notification
```

WSL の場合は `powershell.exe` を呼び出す。パスが通っている場合はデフォルトでそれを、パスが通っていない場合や特定の場合のために powershell.exe の絶対パスが個別設定できるようにしてください。

Windows ネイティブ Node.js 環境の場合も PowerShell を利用する。

外部 PowerShell Module は必須にしない。

---

### Linux

想定:

* GNOME
* KDE Plasma
* XFCE
* その他 freedesktop.org Desktop Notifications 対応環境

通知方式:

```text
notify-send
    ↓
Desktop Notification Service
```

`notify-send` を第一選択とする。

`notify-send` が存在しない場合は通知をスキップし、分かりやすい診断情報を返せるようにする。

---

### macOS

通知方式:

```text
osascript
    ↓
AppleScript
    ↓
macOS Notification
```

基本形:

```applescript
display notification "..." with title "Pi"
```

を利用する。

外部アプリや Homebrew パッケージを必須にしない。

---

## 5. Pi ライフサイクル設計

### 5.1 `agent_start`

Agent の処理開始時に発火する。

開始時刻を記録する。

```ts
let runStartedAt: number | null = null;

pi.on("agent_start", async () => {
  runStartedAt = Date.now();
});
```

---

### 5.2 `agent_settled`

Agent の一連の処理が完全に終了した時点で発火する。

ここでいう完全終了とは、単純な LLM 応答終了だけではなく、Pi が自動的に継続する可能性のある以下も終了した状態を指す。

* retry
* compaction 後の再実行
* queued follow-up

そのため、通知には `agent_end` ではなく `agent_settled` を利用する。

処理フロー:

```text
agent_start
    |
    v
Agent processing
    |
    +-- LLM
    +-- Tool call
    +-- Retry
    +-- Compaction
    +-- Follow-up
    |
    v
agent_settled
    |
    v
elapsed >= threshold ?
    |
    +-- No --> 何もしない
    |
    +-- Yes
           |
           v
       OS判定
           |
    +------+------+------+
    |             |      |
 Windows        Linux   macOS
    |             |      |
PowerShell   notify-send osascript
```

---

## 6. 経過時間

`agent_start` と `agent_settled` の差を秒単位で計算する。

```ts
const elapsedSeconds =
  runStartedAt === null
    ? 0
    : (Date.now() - runStartedAt) / 1000;
```

通知判定後は必ず状態をリセットする。

```ts
runStartedAt = null;
```

---

## 7. 通知条件

デフォルト閾値:

```text
30秒
```

以下の場合のみ通知する。

```text
elapsedSeconds >= thresholdSeconds
```

例:

|  所要時間 |  閾値 | 通知  |
| ----: | --: | --- |
|   10秒 | 30秒 | しない |
| 29.9秒 | 30秒 | しない |
|   30秒 | 30秒 | する  |
|   90秒 | 30秒 | する  |

閾値 `0` は有効とし、すべての `agent_settled` を通知対象とする。

---

## 8. 通知メッセージ

初期版ではシンプルな固定フォーマットとする。

タイトル:

```text
Pi
```

本文:

```text
タスクが完了しました（42.3秒）
```

将来的に以下を追加できるよう、通知APIは汎用化する。

* プロジェクト名
* カレントディレクトリ
* Git branch
* セッション名
* 成功 / 失敗
* Agent 最終応答の短い要約

ただし初期版には含めない。

---

## 9. 通知抽象化

OS固有ロジックを Pi のライフサイクル処理から分離する。

共通API:

```ts
export interface Notification {
  title: string;
  message: string;
}

export async function notify(
  notification: Notification
): Promise<void>;
```

内部でOSを判定する。

```ts
switch (platform) {
  case "win32":
    return notifyWindows(notification);

  case "linux":
    return notifyLinux(notification);

  case "darwin":
    return notifyMacOS(notification);

  default:
    return;
}
```

---

## 10. OS判定

基本的には Node.js の:

```ts
process.platform
```

を利用する。

代表値:

```text
win32  -> Windows
linux  -> Linux
darwin -> macOS
```

ただし WSL では:

```text
process.platform === "linux"
```

になる。

そのため Linux 判定時には WSL かどうかを追加判定する。

---

## 11. WSL判定

WSL の場合は Linux デスクトップ通知ではなく Windows 通知を優先する。

想定判定:

* `WSL_DISTRO_NAME`
* `WSL_INTEROP`
* `/proc/version`
* `/proc/sys/kernel/osrelease`

などの標準情報を利用する。

判定結果:

```text
process.platform = linux
        |
        v
WSL ?
  |
  +-- Yes --> Windows notifier
  |
  +-- No  --> Linux notifier
```

つまり通知バックエンドの実質的な判定は:

```text
Windows native    -> Windows notifier
WSL               -> Windows notifier
Linux native      -> Linux notifier
macOS             -> macOS notifier
```

とする。

---

## 12. Windows通知

### 12.1 基本方針

PowerShell を利用する。

WSL:

```text
powershell.exe
```

Windows ネイティブ:

```text
powershell.exe
```

または環境に応じた PowerShell 実行ファイル。

Node.js の `child_process.spawn` または `execFile` を利用する。

概念:

```ts
spawn(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ],
  {
    detached: true,
    stdio: "ignore",
  }
);
```

Pi の処理を通知完了までブロックしない。

---

### 12.2 通知音

Windows 側の標準通知音を利用する。

独自MP3再生は行わない。

OS設定で通知音が無効になっている場合は、それを尊重する。

---

### 12.3 PowerShell文字列の安全性

通知メッセージを PowerShell のコマンド文字列へ単純連結しない。

将来的に Agent の生成テキストを通知する可能性があるため、PowerShell インジェクションを防止する。

候補:

* Base64
* stdin
* 環境変数
* JSON
* 一時ファイル

のいずれかで文字列をデータとして渡す。

実装では最もシンプルかつ安全な方式を採用する。

---

## 13. Linux通知

第一選択:

```text
notify-send
```

概念:

```ts
execFile(
  "notify-send",
  [
    "--app-name=Pi",
    "--urgency=normal",
    "Pi",
    message,
  ]
);
```

Shell を介さず `execFile` または `spawn` を利用する。

これにより通知本文の Shell Injection を防ぐ。

---

### 13.1 `notify-send` の存在確認

初回通知時、または初期化時に利用可能か確認する。

例:

```text
which notify-send
```

または Node.js から直接実行して `ENOENT` を処理する。

必須要件として `libnotify` をプログラムから自動インストールしない。

不足している場合は README で案内する。

代表例:

```text
Ubuntu / Debian:
sudo apt install libnotify-bin
```

ただしOSパッケージインストールはユーザー操作とする。

---

### 13.2 通知音

Linux では独自に音声プレイヤーを起動しない。

デスクトップ環境の通知設定に委ねる。

つまり:

```text
notify-send
    ↓
Desktop Environment
    ↓
通知音の有無はOS設定
```

とする。

既存 `task-complete-notify` のような、

* mpv
* ffplay
* pw-play
* cvlc
* paplay

のフォールバック実装は持ち込まない。

---

## 14. macOS通知

`osascript` を利用する。

概念:

```ts
execFile(
  "osascript",
  [
    "-e",
    `display notification ...`
  ]
);
```

ただし通知本文を AppleScript 文字列へ直接連結しない。

安全に値を渡せる方式を利用する。

候補:

```text
osascript argv
```

を利用し、

```applescript
on run argv
    display notification item 2 of argv with title item 1 of argv
end run
```

のように引数として渡す。

これによりエスケープ問題を避ける。

---

### 14.1 通知音

macOS の標準通知システムに委ねる。

独自音声再生は行わない。

OS設定を尊重する。

---

## 15. 通知失敗時の扱い

通知は best-effort とする。

原則:

```text
Notification failure
        !=
Agent failure
```

つまり、

* `powershell.exe` が存在しない
* `notify-send` が存在しない
* `osascript` が失敗した
* Desktop Notification Service がない

といった場合でも、Pi の Agent 処理自体は成功のままとする。

通知処理から例外を Pi イベントループへ漏らさない。

---

## 16. 設定ファイル

保存先:

```text
~/.config/pi/notify-config.json
```

初期構造:

```json
{
  "thresholdSeconds": 30
}
```

単一数値ではなく、将来拡張可能な JSON オブジェクトとする。

---

## 17. 設定モデル

初期版:

```ts
export interface NotifyConfig {
  thresholdSeconds: number;
}
```

デフォルト:

```ts
export const DEFAULT_CONFIG: NotifyConfig = {
  thresholdSeconds: 30,
};
```

将来的には以下を追加可能とする。

```ts
interface NotifyConfig {
  thresholdSeconds: number;
  enabled?: boolean;
  sound?: boolean;
}
```

ただし初期版では追加しない。

---

## 18. 設定ロード

以下の優先順位とする。

```text
notify-config.json
       |
       v
valid ?
 |
 +-- Yes --> 使用
 |
 +-- No  --> DEFAULT_CONFIG
```

以下の場合は30秒へフォールバックする。

* ファイルなし
* JSON破損
* `thresholdSeconds` なし
* 数値以外
* NaN
* Infinity
* 負数

設定異常で Extension 自体をロード不能にしない。

---

## 19. 設定保存

保存前に:

```text
~/.config/pi/
```

が存在することを保証する。

```ts
mkdirSync(path.dirname(CONFIG_PATH), {
  recursive: true,
});
```

保存は可能なら一時ファイル経由で安全に行う。

概念:

```text
notify-config.json.tmp
        ↓
rename
        ↓
notify-config.json
```

単純な個人用Extensionとして過剰であれば通常の書き込みでもよいが、設定ファイル破損を防げる範囲で実装する。

---

## 20. `/notify-settings`

正式コマンド名:

```text
/notify-settings
```

`/notify:settings` には依存しない。

Pi の対話UIを利用する。

---

## 21. `/notify-settings` UI

初期フロー:

```text
/notify-settings
       |
       v
Notify Settings
       |
       v
通知閾値
現在: 30秒
       |
       v
新しい秒数を入力
       |
       v
Validation
       |
       +-- NG --> エラー表示
       |
       +-- OK
              |
              v
         設定保存
              |
              v
         即時反映
```

初期版で設定できる値は:

```text
thresholdSeconds
```

のみ。

---

## 22. 入力バリデーション

有効:

```text
0
0.5
1
30
60
300
```

無効:

```text
-1
abc
NaN
Infinity
空文字
```

不正値の場合:

* ファイルを更新しない
* メモリ上の現在値も変更しない
* Pi UI にエラー表示

---

## 23. ディレクトリ構成

推奨:

```text
pi-native-notify/
├── package.json
├── README.md
├── LICENSE
└── extensions/
    ├── index.ts
    ├── config.ts
    ├── notifier.ts
    └── notifiers/
        ├── windows.ts
        ├── linux.ts
        └── macos.ts
```

---

## 24. `extensions/index.ts`

責務:

* Pi Extension エントリポイント
* 設定ロード
* `agent_start`
* `agent_settled`
* `/notify-settings`
* notifier 呼び出し

OS固有コードは置かない。

概念:

```ts
export default function (pi: ExtensionAPI) {
  let runStartedAt: number | null = null;
  let config = loadConfig();

  pi.on("agent_start", async () => {
    runStartedAt = Date.now();
  });

  pi.on("agent_settled", async () => {
    const startedAt = runStartedAt;
    runStartedAt = null;

    if (startedAt === null) {
      return;
    }

    const elapsedSeconds =
      (Date.now() - startedAt) / 1000;

    if (
      elapsedSeconds <
      config.thresholdSeconds
    ) {
      return;
    }

    await notify({
      title: "Pi",
      message:
        `タスクが完了しました（${elapsedSeconds.toFixed(1)}秒）`,
    });
  });

  // register /notify-settings
}
```

---

## 25. `extensions/config.ts`

責務:

* 設定型
* デフォルト値
* Config path 解決
* JSONロード
* バリデーション
* JSON保存

OS固有通知処理には依存しない。

---

## 26. `extensions/notifier.ts`

責務:

* 実行環境判定
* WSL判定
* notifier routing
* 共通エラーハンドリング

概念:

```ts
export async function notify(
  notification: Notification
): Promise<void> {
  try {
    const environment =
      detectEnvironment();

    switch (environment) {
      case "windows":
      case "wsl":
        await notifyWindows(notification);
        break;

      case "linux":
        await notifyLinux(notification);
        break;

      case "macos":
        await notifyMacOS(notification);
        break;
    }
  } catch {
    // Agent processing must not fail.
  }
}
```

---

## 27. `notifiers/windows.ts`

責務:

* PowerShell 実行
* Windows Toast
* 標準通知音
* 安全な文字列受け渡し
* 非同期・非ブロッキング実行

Linux / macOS のコードを含めない。

---

## 28. `notifiers/linux.ts`

責務:

* `notify-send`
* libnotify 利用可能性
* `ENOENT` 処理
* 非同期通知

Shell を介さず実行する。

---

## 29. `notifiers/macos.ts`

責務:

* `osascript`
* AppleScript
* argv による安全な文字列受け渡し
* 非同期通知

---

## 30. `package.json`

Pi が GitHub リポジトリから Extension を認識できる manifest を定義する。

概念:

```json
{
  "name": "pi-native-notify",
  "version": "0.1.0",
  "private": true,
  "pi": {
    "extensions": [
      "./extensions"
    ]
  }
}
```

npm 公開は行わない。

GitHub リポジトリを Pi Package として直接利用できる状態にする。

---

## 31. GitHubインストール

初期版では GitHub から直接インストールする方法のみ正式サポートする。

README に以下を記載する。

* GitHub リポジトリからのインストール方法
* 更新方法
* 削除方法
* 各OSの必要条件

特に Linux については `notify-send` の前提条件を明記する。

---

## 32. Agent Run 状態管理

初期案は:

```ts
let runStartedAt: number | null;
```

とする。

ただし実装前に Pi の Agent イベントモデルを確認する。

同一 Extension インスタンス内で Agent Run が並列発生し得る場合には、Run ID をキーにする。

例:

```ts
const runs =
  new Map<string, number>();
```

Pi が1セッション内で直列処理する保証がある場合は、単一値のままとし、不要な複雑化を避ける。

この点は実装時に Pi API のイベントペイロードを確認して確定する。

---

## 33. セキュリティ

外部コマンド実行では Shell を可能な限り使用しない。

推奨:

```text
execFile
spawn
```

避ける:

```text
exec("command " + userText)
```

特に通知本文は将来的に Agent の生成内容を利用する可能性があるため、以下を防ぐ。

* Shell Injection
* PowerShell Injection
* AppleScript Injection

OSごとに通知テキストを「コード」ではなく「データ」として渡す。

---

## 34. クロスプラットフォーム設計原則

通知バックエンドは以下の優先順位にする。

### Windows / WSL

```text
PowerShell native notification
```

### Linux

```text
notify-send
```

### macOS

```text
osascript
```

共通原則:

```text
OS標準
  >
追加パッケージ
  >
外部通知ライブラリ
```

追加 Node.js 通知ライブラリは初期版では導入しない。

---

## 35. テスト

### Config unit test

確認:

* ファイルなし → 30秒
* 正常JSON → 読み込み
* 壊れたJSON → 30秒
* 負数 → 30秒
* NaN 相当 → 30秒
* 0 → 有効
* 保存 → 再ロード可能

---

### 時間判定

確認:

* 29秒 / threshold 30 → 通知なし
* 30秒 / threshold 30 → 通知あり
* 31秒 / threshold 30 → 通知あり
* threshold 0 → 毎回通知

テストでは実際に30秒待たず、Clock / timestamp を制御可能な構造にする。

---

### Windows

確認:

* Windows ネイティブから通知できる
* WSL から Windows 通知できる
* 日本語が文字化けしない
* 標準通知音が鳴る
* PowerShell失敗でPiがクラッシュしない
* 通知処理がAgentをブロックしない

---

### Linux

確認:

* `notify-send` が呼ばれる
* 日本語を表示できる
* `notify-send` 未導入時にクラッシュしない
* Shell Injection が起こらない
* GNOME / KDE 等の標準通知サービスで表示可能

---

### macOS

確認:

* `osascript` で通知できる
* 日本語を表示できる
* 引数に引用符や改行が含まれても壊れない
* `osascript` 失敗でPiがクラッシュしない

---

### WSL判定

確認:

```text
Linux native
       -> Linux notifier

WSL
       -> Windows notifier
```

誤判定しないことを確認する。

---

## 36. Piイベントテスト

確認:

* `agent_start` で開始時間を保存
* `agent_end` では通知しない
* `agent_settled` で判定
* retry 中に通知しない
* compaction 中に通知しない
* queued follow-up が残っている間は通知しない
* settled 後に一度だけ通知

---

## 37. `/notify-settings` テスト

確認:

* コマンドが登録される
* 現在値を確認できる
* 新しい値を入力できる
* 不正値を拒否する
* 保存後すぐ反映される
* Pi再起動後も値が保持される

---

## 38. 手動E2Eテスト

### Case 1: 短い処理

```text
threshold = 30
処理時間 = 約10秒
```

期待:

```text
通知なし
```

---

### Case 2: 長い処理

```text
threshold = 30
処理時間 >= 30秒
```

期待:

```text
OSネイティブ通知
```

---

### Case 3: 設定変更

```text
/notify-settings

30秒
 ↓
5秒
```

5秒以上のタスクを実行。

期待:

```text
通知あり
```

---

### Case 4: 設定永続化

Pi 再起動後:

```text
threshold = 5
```

が維持される。

---

### Case 5: OS別確認

Windows:

```text
PowerShell notification
```

WSL:

```text
PowerShell.exe -> Windows notification
```

Linux:

```text
notify-send
```

macOS:

```text
osascript
```

それぞれ実通知を確認する。

---

## 39. README

以下を記載する。

### 概要

* 何をするExtensionか
* `agent_settled` を使う理由
* デフォルト30秒

### Supported platforms

* Windows
* WSL
* Linux
* macOS

### Requirements

Windows:

```text
PowerShell
```

Linux:

```text
notify-send
```

macOS:

```text
osascript
```

### Configuration

```text
/notify-settings
```

および:

```text
~/.config/pi/notify-config.json
```

### Troubleshooting

* Windowsで通知されない
* WSLから通知されない
* Linuxで `notify-send` がない
* macOSで通知されない
* 通知音が鳴らない
* 設定ファイルが保存されない

---

## 40. 実装順序

### Phase 1: Pi lifecycle

1. 新規リポジトリ作成
2. `package.json`
3. Pi Extension エントリポイント
4. `agent_start`
5. `agent_settled`
6. 30秒判定

この段階では notifier を簡単なログ出力に置き換えてテスト可能にする。

---

### Phase 2: 通知抽象化

1. `Notification` 型
2. `notifier.ts`
3. OS判定
4. WSL判定
5. backend routing

---

### Phase 3: Windows / WSL

1. PowerShell通知
2. 標準通知音
3. 日本語対応
4. non-blocking
5. Injection対策
6. WSL E2E確認

---

### Phase 4: Linux

1. `notify-send`
2. `ENOENT` 対応
3. 日本語
4. non-blocking
5. Linux E2E確認

---

### Phase 5: macOS

1. `osascript`
2. argv 経由の安全な値受け渡し
3. 日本語
4. non-blocking
5. macOS E2E確認

---

### Phase 6: 設定

1. `config.ts`
2. デフォルト30秒
3. JSONロード
4. JSON保存
5. バリデーション
6. `~/.config/pi/notify-config.json`

---

### Phase 7: `/notify-settings`

1. カスタムコマンド登録
2. Pi対話UI
3. 現在値表示
4. 数値入力
5. Validation
6. 保存
7. 即時反映

---

### Phase 8: 堅牢化

1. 全外部プロセスの例外処理
2. Timeout / zombie process 確認
3. Injection対策
4. WSL判定テスト
5. Agent並列性確認
6. 通知重複確認

---

### Phase 9: GitHub配布

1. README
2. LICENSE
3. GitHubインストール確認
4. クリーン環境で導入確認
5. Windows / Linux / macOS の手順確認

---

## 41. 完了条件

* [ ] GitHubからPiへ直接インストールできる
* [ ] Extensionが正常ロードされる
* [ ] `agent_start` を取得できる
* [ ] `agent_settled` を取得できる
* [ ] デフォルト閾値が30秒
* [ ] 30秒未満では通知しない
* [ ] 30秒以上では通知する
* [ ] Windowsネイティブ通知が動作する
* [ ] WSLからWindows通知が動作する
* [ ] Linux `notify-send` が動作する
* [ ] macOS `osascript` 通知が動作する
* [ ] OSを自動判定できる
* [ ] WSLを通常Linuxと区別できる
* [ ] `/notify-settings` が利用できる
* [ ] UIから閾値変更できる
* [ ] 不正値を拒否できる
* [ ] 設定が `~/.config/pi/notify-config.json` に保存される
* [ ] Pi再起動後も設定が維持される
* [ ] 日本語通知が文字化けしない
* [ ] 通知失敗でPiがクラッシュしない
* [ ] 通知処理がPiをブロックしない
* [ ] 通知本文からコマンドインジェクションできない
* [ ] READMEだけで導入方法を理解できる

---

## 42. 初期版後の拡張候補

必要になった場合のみ追加する。

* 通知ON/OFF
* `/notify-test`
* 通知音ON/OFF
* LLMから呼べる `notify` Tool
* 成功 / 失敗通知
* プロジェクト名表示
* カレントディレクトリ表示
* Git branch表示
* セッション識別
* 最終応答要約
* 通知クリック時アクション
* ntfy
* Android
* Slack / Discord
* npm公開

---

## 43. 設計原則

```text
Pi公式ライフサイクル
    >
独自の完了推定

OSネイティブ通知
    >
外部通知ライブラリ

標準OSコマンド
    >
追加依存

execFile / spawn
    >
shell文字列実行

小さな共通インターフェース
    >
OS固有処理の混在

best-effort notification
    >
通知失敗によるAgent失敗
```

既存 `task-complete-notify` からは、

```text
agent_start
      +
agent_settled
      +
時間閾値
```

という基本設計を採用する。

一方で、元実装の Linux 固定構造は引き継がず、

```text
                 Pi
                  |
          agent_settled
                  |
              notifier
                  |
       +----------+----------+
       |          |          |
    Windows     Linux      macOS
       |          |          |
 PowerShell  notify-send  osascript
```

というクロスプラットフォーム構造にする。
