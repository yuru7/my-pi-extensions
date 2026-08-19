# pi-rollback ExecPlan

## 1. 目的

`pi-rollback` は Pi Agent にインストール可能な拡張機能として実装する。

ユーザーは次の2種類のロールバックを実行できる。

1. 現在のセッションの任意のユーザー会話ターン開始時点へ戻る
2. 現在のセッション開始時点へ戻る

会話ターンへのロールバックでは、

* 対象ユーザーメッセージは残す
* そのメッセージに対する Assistant 応答・Tool 実行以降を会話ツリーから外す
* 対象ターン以降に Pi が変更したファイルを可能な範囲で元に戻す

ものとする。

セッション開始時点へのロールバックでは、

* 当該セッション中に `pi-rollback` が捕捉できた Pi のファイル変更を取り消す
* 元セッションを `parentSession` とした新しい空セッションへ移動する

ものとする。

Pi のセッションは `id` / `parentId` を持つツリー構造であり、コマンドから `ctx.navigateTree()`、`ctx.newSession()` を利用できる。セッション制御APIは command context で提供され、実行中の Agent を止めて安全に操作するため `ctx.waitForIdle()` も利用できる。 Pi のセッションエントリ自体もツリー構造を持ち、ユーザーメッセージの entry ID を安定したターン識別子として使用できる。

---

## 2. 基本方針

Hermes Agent の Checkpoints & Rollback から、次の設計思想を採用する。

* ファイル変更の**実行前**に復元可能な状態を保存する
* 不要なチェックポイントを作らない
* ロールバック直前の状態も退避し、「undo の undo」を可能にする
* 容量上限を設ける
* チェックポイント機能の障害で Agent 本体を停止しない

Hermes は shared shadow Git repository に working directory 全体を保存するため `/` や `$HOME` のような広いディレクトリを除外しているが、`pi-rollback` は**変更対象ファイル単位**の CAS（Content-Addressable Storage：内容ハッシュをキーとする保存領域）を使用する。したがって `/` や `$HOME` 自体は一律除外しない。Hermes の現行仕様では shadow Git、1 directory / turn の重複排除、10 MB/file、500 MB total、non-fatal error などを採用している。

Git には依存しない。

主な理由は次の通り。

* working tree 全体を走査する必要がない
* `$HOME` 内の1ファイルだけでも低コストで保存できる
* Git repository 外のファイルも扱える
* WindowsでもGitの有無に依存しない
* SHA-256 CAS により同一内容を複数回保存しない

---

## 3. 対象環境

正式サポート対象:

* Linux
* macOS
* Windows
* WSL上でPi自体を起動する構成

Pi の `bash` ツールは Windows でも PowerShell や `cmd.exe` ではなく Bash を使用する。現行実装は Git Bash を優先し、PATH上の Bash、Cygwin/MSYS2/WSL系の `bash.exe` も利用する。

したがって command parser は基本的に Bash 構文を対象とし、Windows対応は主として**パス表現の正規化**で行う。

サポートする代表的な形式:

```text
./src/app.ts
../config.json
/home/user/file
~/file

C:\Users\foo\file.txt
C:/Users/foo/file.txt
\\server\share\file.txt

/c/Users/foo/file.txt        # Git Bash / MSYS
/mnt/c/Users/foo/file.txt    # WSL
```

---

## 4. パッケージ構成

Pi Package として配布する。

Pi は `package.json` の `pi.extensions` で拡張を配布でき、npm・git・ローカルパスから `pi install` できる。

想定構成:

```text
pi-rollback/
├── package.json
├── README.md
├── extensions/
│   └── pi-rollback.ts
├── src/
│   ├── config.ts
│   ├── store.ts
│   ├── snapshot.ts
│   ├── mutation-journal.ts
│   ├── rollback.ts
│   ├── session.ts
│   ├── bash/
│   │   ├── lexer.ts
│   │   ├── extract-paths.ts
│   │   └── windows-path.ts
│   ├── platform.ts
│   └── errors.ts
└── test/
    ├── write-edit.test.ts
    ├── bash-paths.test.ts
    ├── rollback.test.ts
    ├── safe-restore.test.ts
    ├── windows-paths.test.ts
    └── store-gc.test.ts
```

原則として外部runtime dependencyは追加せず、Node.js標準APIで実装する。

---

## 5. 設定

設定ファイルは必須要件通り次を使用する。

```text
~/.pi/agent/pi-rollback.json
```

初期設定案:

```json
{
  "enabled": true,
  "maxFileSizeMB": 10,
  "maxTotalSizeMB": 500,
  "retentionDays": 14,

  "safeRestore": true,

  "bash": {
    "enabled": true,
    "maxFilesPerCall": 5000,
    "maxBytesPerCallMB": 200,
    "warnOnUnresolvedMutation": true
  },

  "excludeGlobs": []
}
```

データ本体は設定ファイルとは分離する。

```text
~/.pi/agent/pi-rollback/
```

設定ファイルが存在しない場合は上記デフォルトを使用する。

設定ファイルの読み込み・JSON parse に失敗した場合も Agent を停止せず、

```text
pi-rollback: Failed to load configuration; using defaults.
```

のように通知する。

---

## 6. ストレージ構成

```text
~/.pi/agent/pi-rollback/
├── objects/
│   └── sha256/
│       └── ab/
│           └── abcdef...
│
├── sessions/
│   └── <pi-session-id>/
│       ├── meta.json
│       ├── mutations.jsonl
│       └── pending/
│           └── <tool-call-id>.json
│
├── rollback-journals/
│   └── <transaction-id>/
│
└── maintenance.json
```

### CAS object

ファイル内容を SHA-256 で識別する。

```text
SHA-256(file bytes)
       ↓
objects/sha256/ab/abcdef...
```

同じ内容は1回しか保存しない。

ファイルのパスは CAS key に含めない。

---

## 7. Snapshot データモデル

ファイル変更前の状態を次のように表現する。

```ts
type FileState =
  | {
      kind: "absent";
    }
  | {
      kind: "file";
      sha256: string;
      size: number;
      mode?: number;
    }
  | {
      kind: "symlink";
      target: string;
    };
```

mutation record:

```ts
interface MutationRecord {
  sequence: number;

  sessionId: string;
  turnEntryId: string;

  toolCallId: string;
  toolName: "write" | "edit" | "bash";

  path: string;

  pre: FileState;
  post: FileState;

  coverage: "exact" | "best-effort";

  timestamp: string;
}
```

`write` / `edit` は `coverage: "exact"`。

`bash` は原則 `coverage: "best-effort"`。

---

## 8. 会話ターンの識別

Pi内部の `turn_start` は「1ユーザープロンプト」と必ずしも1対1ではない。

Tool call による複数回のLLM往復が発生するため、rollback単位には使用しない。

代わりに `tool_call` 時点で

```ts
ctx.sessionManager.getBranch()
```

を取得し、末尾から最も近い

```text
message.role === "user"
```

の session entry を探す。

その entry の `id` を

```text
turnEntryId
```

とする。

これにより、

```text
User entry A
  ↓
Assistant
  ↓
write
  ↓
Assistant
  ↓
edit
  ↓
Assistant
```

のすべてが同じ rollback turn に所属する。

---

## 9. write / edit のスナップショット

Pi の `write` は `path` と `content` を持ち、relative / absolute path の両方を受け取る。

現行 `edit` も1ファイルの `path` と複数の置換 `edits[]` を受け取る。

Pi自身はこれらのパスを cwd 基準で解決しているため、`pi-rollback` も同じ意味になるよう cwd を基準に正規化する。

### tool_call

`tool_call` はツール実行前に発火するため、この時点で pre-image を取得する。

処理:

```text
tool_call(write/edit)
        │
        ▼
canonical path 解決
        │
        ▼
この turn ですでに snapshot 済み？
   │ yes              │ no
   ▼                  ▼
何もしない       pre-image 保存
                       │
                       ▼
                 pending journal 保存
```

同じターンで同じファイルを10回編集しても、**最初の変更直前のファイルを1回だけ保存する**。

これにより「ターン開始状態」へ戻せる。

### tool_result

成功・失敗にかかわらず post-state を確認する。

Tool が error を返しても途中までファイルを変更した可能性があるため、

```text
isError === true
```

だけを理由に snapshot を破棄してはいけない。

```text
pre == post
    ↓
mutationなし
    ↓
pending破棄

pre != post
    ↓
MutationRecord確定
```

新規ファイルなら、

```text
pre.kind  = absent
post.kind = file
```

になる。

rollback では削除する。

---

## 10. Pi の並列Tool Callへの対応

Pi は通常、同じ Assistant message の sibling tool calls を実行時には並列化できるが、`tool_call` preflight は順番に処理してから実行を開始する。

この性質を利用して、

```text
write A ─┐
write B ─┼─ tool_call preflight
edit C  ─┘
          ↓
全 pre-image 完了
          ↓
並列実行
```

とする。

さらに内部で

```ts
Map<canonicalPath, Promise<void>>
```

による path lock を用意し、同じファイルに対する snapshot の競合を防ぐ。

pending state は必ず `toolCallId` 単位で管理する。

---

## 11. bash のパス抽出

`bash` は完全な変更検知を保証しない。

Hermes のように「破壊的コマンド名を regex で判定したから安全」とは扱わない。

`pi-rollback` における bash snapshot は明確に

> Best effort

とする。

### 11.1 軽量lexer

完全な Bash AST parser は導入しない。

次を理解する小さな lexer を実装する。

* `'...'`
* `"..."`
* `\` escape
* whitespace
* `;`
* `&&`
* `||`
* pipe
* redirect
* `$(...)` は opaque expression として扱う
* `$VAR` は原則 unresolved

### 11.2 パス候補

まず明示的な path-like token を取得する。

例:

```text
./foo
../foo
/foo
~/foo
foo/bar

C:\foo
C:/foo
\\server\share

/c/foo
/mnt/c/foo
```

さらに代表的なファイル変更コマンドについて位置を理解する。

対象例:

```text
rm
rmdir
cp
mv
install
touch
mkdir
truncate
shred
sed -i
tee
chmod
chown
find
dd of=
git checkout
git restore
git clean
```

redirect も取得する。

```bash
echo foo > file.txt
cat a >> output.log
command 2> error.log
```

### 11.3 Interpreter

例えば、

```bash
python script.py
node script.js
```

では `script.py` / `script.js` 自体は抽出できるが、

```python
Path("/etc/foo").write_text(...)
```

の対象までは静的解析しない。

したがって interpreter 内部の副作用は保証対象外。

---

## 12. bash のディレクトリsnapshot

抽出したパスが既存ディレクトリなら、その配下を再帰的に対象候補とする。

デフォルト上限:

```text
5000 files / bash call
200 MB / bash call
10 MB / file
```

上限を超えた時点で走査を打ち切り、

```text
pi-rollback: Bash snapshot limit reached.
Rollback coverage for this command is partial.
```

と表示する。

Tool 自体は止めない。

### 実行前

```text
candidate directory
        ↓
walk
        ↓
regular files の pre-image
        ↓
pre manifest
```

### 実行後

同じ範囲を再走査する。

```text
pre manifest
     +
post filesystem
     ↓
compare
     ↓
実際に変化した path だけ
MutationRecord に確定
```

変更されなかった候補ファイルの一時snapshotは削除する。

このため bash でディレクトリを指定しても、恒久的なmetadataには**実際に差分があったファイルだけ**が残る。

---

## 13. Windowsパス処理

Pi の Windows版 `bash` は Git Bash 等を使用するため、Bash token parser 自体は共通化する。

path normalization のみ platform adapter を分ける。

### ネイティブ

```text
C:\foo\bar
C:/foo/bar
```

→ Node.js Windows path として解決。

### MSYS / Git Bash

```text
/c/Users/foo
```

→

```text
C:\Users\foo
```

### WSL

```text
/mnt/c/Users/foo
```

→

```text
C:\Users\foo
```

と変換可能な範囲で変換する。

WSL固有の

```text
/home/user/foo
```

など Windows Node.js process から直接アクセスできないパスについては、ローカル変換を試みず coverage gap とする。

必要なら将来 `wslpath -w` を利用するadapterを追加できるようインターフェースを分離しておく。

---

## 14. `/` と `$HOME` の扱い

一律禁止しない。

例えば、

```text
/home/user/.gitconfig
C:\Users\foo\.config\app.json
/etc/example.conf
```

を `write` / `edit` が直接変更する場合は、そのファイルだけ snapshot する。

ただし次は対象外とする。

POSIX:

```text
/proc
/sys
/dev
/run
```

配下の仮想・device filesystem。

Windows:

```text
\\.\...
```

などの device namespace。

socket、FIFO、device file など regular file ではない特殊オブジェクトも snapshot しない。

symlink は無条件にリンク先を再帰走査せず、実際の write/edit semantics と一致するよう既存pathについて canonical target を解決して扱う。

---

## 15. Safe Restore

デフォルト:

```json
"safeRestore": true
```

各 Pi mutation 後に

```text
post SHA-256
```

を保存する。

rollback 時:

```text
recorded post SHA
        │
        ├── current SHA と同じ
        │       ↓
        │    Piの最後の変更状態
        │       ↓
        │    restore可能
        │
        └── current SHA と違う
                ↓
          Pi変更後に別変更あり
                ↓
              skip
```

表示例:

```text
Restored: 7 files
Skipped: 2 files modified after Pi's last write

  src/config.ts
  README.md

Use /rollback 3 --force to overwrite them.
```

`--force` の場合のみ current hash を無視して復元する。

---

## 16. Safe Restore の意味上の制約

この方式で保護できるのは、

> Pi がそのファイルを最後に変更した後に行われた外部編集

である。

次のようなケース:

```text
Pi edit
↓
User edit
↓
Pi edit
```

では最後の Pi edit がユーザー変更も上書きしている可能性がある。

この状態から「Pi変更だけを数学的に取り除いてUser変更だけ残す」ことは full-file pre-image 方式では保証しない。

v1では3-way mergeやoperation-level inverse patchは実装しない。

---

## 17. 会話ターンへのrollback

コマンド:

```text
/rollback
```

現在の active session branch の user entries を一覧表示する。

例:

```text
1  10:45  Fix authentication bug       3 files
2  10:31  Add login endpoint           5 files
3  10:12  Investigate failing tests    no file changes
```

番号は newest-first の表示番号。

実行:

```text
/rollback 3
```

### 処理順

```text
ctx.waitForIdle()
      ↓
target user entry 解決
      ↓
restore plan 作成
      ↓
safe-restore conflict 判定
      ↓
現在状態を rollback journal に保存
      ↓
filesystem restore
      ↓
ctx.navigateTree(targetUserEntryId)
```

`navigateTree()` は selected user entry 自体を leaf にする。

したがって、

```text
User: このバグを直して
```

は残るが、その後の

```text
Assistant
Tool calls
Tool results
```

は active conversation path から外れる。

Pi の `navigateTree()` は command context から利用できる。

branch summary は作成しない。

```ts
await ctx.navigateTree(targetId, {
  summarize: false
});
```

とする。

---

## 18. ターン復元アルゴリズム

対象ターンから現在までの mutation を新しい順に処理する。

```text
Turn 5
Turn 4
Turn 3 ← target
```

なら、

```text
Turn 5 mutations
↓
Turn 4 mutations
↓
Turn 3 mutations
```

の逆順restoreを行う。

これにより、同じファイルが複数turnで変更されていても段階的にpre-imageへ戻せる。

ただし safe restore で external edit が検出されたpathは以降そのpathのrestoreを停止する。

---

## 19. セッション開始時点へのrollback

コマンド:

```text
/rollback start
```

現在のセッション中に記録された mutation をすべて逆順にrestoreする。

その後、

```ts
const parentSession = ctx.sessionManager.getSessionFile();

await ctx.newSession({
  parentSession
});
```

で新しい空セッションを作る。

`newSession()` は現在セッションから replacement session へ正式に切り替えるAPIであり、old session teardown / new `session_start` のlifecycleを通る。

---

## 20. 「セッション開始状態」の正確な定義

軽量性を維持するため、session start 時にディスク全体をsnapshotしない。

したがって `/rollback start` は、

> このセッション中に pi-rollback が捕捉した Pi の変更をすべて取り消した状態

と定義する。

例えば、

```text
Session start
↓
Userが外部Editorで foo.txt を編集
↓
Piが初めて foo.txt を編集
```

なら、Pi edit 直前に保存されるのは**User編集後の foo.txt**。

`/rollback start` でもUser編集は保存する。

これは厳密な「session start 時刻のbyte列」よりも、

> Piが行った変更だけをundoし、ユーザー変更を破壊しない

ことを優先した仕様である。

---

## 21. Rollback transaction

Hermes と同様、rollback の rollback を可能にする。

restore対象ファイルの現在状態を最初に

```text
rollback-journals/<transaction-id>
```

へ保存する。

その後 filesystem restore を実施する。

もし、

* filesystem restore途中で失敗
* `navigateTree()` が他extensionにcancelされる
* `newSession()` がcancelされる

などが発生した場合、

rollback journal から可能な限り元状態へ戻す。

つまり、

```text
current
   ↓ journal
restore
   ↓
session transition失敗
   ↓
journalからcompensating restore
```

とする。

rollback自体を「ほぼtransaction」として扱う。

---

## 22. エラー処理

最重要原則:

> pi-rollback の snapshot エラーを理由に write / edit / bash を止めない。

すべての tool event handler を次の形にする。

```ts
try {
  await snapshot(...);
} catch (error) {
  notifyRollbackError(error);
  return undefined;
}
```

`tool_call` handler から

```ts
{ block: true }
```

を返さない。

エラー例:

```text
pi-rollback: Could not snapshot /etc/foo:
EACCES: permission denied

The tool will continue without rollback coverage for this file.
```

同一原因を大量表示しないよう、

```text
session + turn + error category
```

単位でnotificationをdedupeする。

---

## 23. Crash recovery

`tool_call` でpre-imageを取得した時点で、

```text
pending/<toolCallId>.json
```

を永続化する。

その後ツールが実行される。

正常終了時:

```text
pending
 ↓
post comparison
 ↓
mutation record
 ↓
pending削除
```

Pi process が途中で落ちた場合は pending journal が残る。

次回 `session_start` 時に検出し、

```text
Previous Pi run ended with an unfinished rollback journal.
1 potentially modified file can still be restored.
```

と通知する。

これにより「ファイルを変更した直後にPiがクラッシュした」という最もrollbackが欲しいケースを可能な範囲で救済する。

---

## 24. 容量管理

デフォルト:

```text
maxFileSizeMB     = 10
maxTotalSizeMB    = 500
retentionDays     = 14
```

Hermes の 10 MB/file と 500 MB total を初期値として踏襲する。

GC は毎Tool Callでは実行しない。

次の場合だけ実行する。

* session startup。ただし前回GCから24時間以上経過時のみ
* store size cap に近づいた時
* session shutdown 時の軽量cleanup

削除順:

```text
expired inactive sessions
        ↓
old inactive sessions
        ↓
unreferenced CAS objects
```

active session の rollback history は自動的には削除しない。

active session だけで容量上限を超えた場合は、

```text
pi-rollback: Store limit reached.
New snapshots will be skipped until space is freed.
```

と警告し、過去historyを黙って破棄しない。

Tool は継続する。

---

## 25. CAS GC

incremental reference count は持たない。

クラッシュするとrefcountとmanifestが不整合になるためである。

代わりに mark-and-sweep を採用する。

```text
all retained mutation manifests
            ↓
referenced SHA set
            ↓
objects directory scan
            ↓
unreferenced object delete
```

GC頻度が低いため、この単純な方式で十分。

---

## 26. diff preview

Hermes の `/rollback diff` に相当する機能を追加する。

```text
/rollback diff 3
```

表示:

```text
Rollback to turn 3

M src/auth.ts
D src/generated.ts
A config/default.json

3 files will be restored
1 user-edited file will be skipped
2 bash changes had partial coverage
```

text file はサイズが小さい場合のみ unified diff を表示可能にする。

binary / large file は、

```text
binary changed: 1.4 MB -> 1.3 MB
```

のようなsummaryだけ表示する。

---

## 27. コマンド仕様

MVPで実装する。

```text
/rollback
/rollback <N>
/rollback <N> --force
/rollback diff <N>
/rollback start
/rollback start --force
/rollback status
```

`/rollback status`:

```text
pi-rollback enabled

Session:
  tracked turns: 12
  tracked files: 37

Store:
  41.8 MB / 500 MB

Coverage:
  write/edit: exact
  bash: 8 commands tracked
  bash partial: 2
```

---

## 28. bash coverage の表示

bash を「完全に守れている」と誤解させない。

mutation record / rollback point に

```text
coverage: exact
coverage: best-effort
coverage: partial
```

を持たせる。

例えば、

```bash
python scripts/migrate.py
```

について `scripts/migrate.py` しかpathを抽出できなかった場合、

```text
bash rollback coverage: partial
```

を記録する。

この情報は `/rollback` と `/rollback diff` に表示する。

---

## 29. 除外対象

デフォルトでは `.env` や `$HOME` を名前だけで除外しない。

Piが変更した対象ならrollback可能である方を優先する。

ただしユーザーが必要なら、

```json
{
  "excludeGlobs": [
    "**/*.iso",
    "**/node_modules/**",
    "D:/huge-data/**"
  ]
}
```

で除外できる。

snapshot store 自身、

```text
~/.pi/agent/pi-rollback/**
```

は常に強制除外する。

再帰的に自分自身をsnapshotする事故を防ぐためである。

---

## 30. ファイル属性

v1で保証するもの:

* file content
* file existence / absence
* symlink target
* POSIX executable bit を含む基本mode

保証しないもの:

* mtimeの完全復元
* owner/group
* POSIX ACL
* extended attributes
* macOS resource fork
* Windows ACL
* NTFS Alternate Data Streams

目的は「コード・設定ファイルのundo」であり、filesystem backup toolにはしない。

---

## 31. Pi lifecycle integration

使用event:

```text
session_start
tool_call
tool_result
session_shutdown
session_tree
```

Pi の lifecycle 上、`tool_call` はツール実行直前、`tool_result` は実行後に発火するため pre/post snapshot に利用できる。

### session_start

* config load
* session metadata初期化
* orphan pending確認
* 必要ならGC

### tool_call

* turn entry ID特定
* path抽出
* pre snapshot
* pending journal

### tool_result

* post state確認
* actual mutationのみcommit
* pending削除

### session_shutdown

* metadata flush
* temporary files cleanup

### session_tree

外部 `/tree` 操作を検知する。

v1では filesystem を自動変更しない。

built-in `/tree` は会話だけを移動し、filesystem rollbackを意味しないことをREADMEに明記する。

filesystemとconversationを同時に戻したい場合は `/rollback` を使用する。

---

## 32. Remote / overridden tool の扱い

Pi の write/edit/bash はoperationsを差し替え、SSH等のremote backendへ委譲できる設計になっている。`write` / `edit` の現行実装にも pluggable operations が存在する。

pi-rollback v1 は、

> Pi process と同じローカルfilesystemを変更する built-in write/edit/bash

を正式対象とする。

他extensionがtoolをremote executionへ差し替えている場合のremote snapshotはv1では保証しない。

将来、

```ts
SnapshotBackend
```

interface を追加できる設計にする。

---

## 33. 実装順序

### Milestone 1 — package skeleton

* [ ] Pi Packageを作成
* [ ] extension entrypointを作成
* [ ] config loaderを実装
* [ ] `/rollback status` を仮実装
* [ ] Linux/macOS/Windows CIを準備

### Milestone 2 — CAS

* [ ] SHA-256 object store
* [ ] atomic object write
* [ ] FileState
* [ ] session manifest
* [ ] pending journal
* [ ] mark-and-sweep GC
* [ ] capacity check

### Milestone 3 — write/edit

* [ ] `tool_call(write)` interception
* [ ] `tool_call(edit)` interception
* [ ] cwd / absolute path normalization
* [ ] per-turn path dedupe
* [ ] post-state hash
* [ ] mutation record commit
* [ ] new-file handling
* [ ] symlink handling
* [ ] large-file warning

### Milestone 4 — safe restore

* [ ] current hash comparison
* [ ] user edit skip
* [ ] `--force`
* [ ] rollback journal
* [ ] compensating restore

### Milestone 5 — conversation rollback

* [ ] active branch user entries列挙
* [ ] `/rollback`
* [ ] `/rollback <N>`
* [ ] `ctx.waitForIdle()`
* [ ] reverse mutation restore
* [ ] `ctx.navigateTree()`
* [ ] cancelled navigation compensation

### Milestone 6 — session start rollback

* [ ] `/rollback start`
* [ ] whole-session reverse restore
* [ ] `ctx.newSession({ parentSession })`
* [ ] cancelled newSession compensation
* [ ] old/new session lifecycle test

### Milestone 7 — bash

* [ ] lightweight Bash lexer
* [ ] explicit path token extraction
* [ ] redirect extraction
* [ ] common mutating command rules
* [ ] directory pre-walk
* [ ] directory post-walk
* [ ] actual mutation filtering
* [ ] max file / byte limit
* [ ] partial coverage reporting

### Milestone 8 — Windows

* [ ] drive path
* [ ] UNC path
* [ ] `/c/...`
* [ ] `/mnt/c/...`
* [ ] case-insensitive canonicalization
* [ ] Git Bash integration test
* [ ] WSL native execution test

### Milestone 9 — UX / maintenance

* [ ] `/rollback diff`
* [ ] `/rollback status`
* [ ] startup pending recovery
* [ ] notification dedupe
* [ ] retention cleanup
* [ ] README
* [ ] install/uninstall documentation

---

## 34. 必須テスト

### write

```text
existing file
→ write
→ rollback
→ exact original bytes
```

```text
nonexistent file
→ write creates it
→ rollback
→ file absent
```

### edit

```text
edit same file 3 times in one user turn
→ only first pre-image retained
→ rollback turn
→ state before first edit
```

### multiple turns

```text
T1 edit A
T2 edit A
T3 edit A

rollback T2
→ A = T1終了時点
```

### safe restore

```text
Pi edit
→ external editor edit
→ rollback
→ file skipped
```

```text
same case + --force
→ snapshot restored
```

### bash

```text
rm file
cp src dst
mv a b
sed -i ...
echo x > file
find dir ... -delete
```

をテスト。

### directory

```text
bash targets directory
→ existing file modified
→ new file created
→ existing file deleted
→ unchanged fileあり
```

結果としてmutation recordには3変更だけ残り、unchanged fileの永続snapshotは残らないこと。

### tool error

```text
bash modifies file
→ exits 1
```

でもmutationを記録すること。

### extension error

snapshot storeをread-onlyにする。

```text
write tool
```

自体は正常に実行され、pi-rollback warningだけ表示されること。

### crash recovery

```text
pre snapshot
→ pending journal
→ process crashを模擬
→ next startup
```

でpendingが検出されること。

---

## 35. Windows必須テストケース

```text
C:\Users\test\a.txt
C:/Users/test/a.txt
```

が同一canonical pathとして扱われること。

```text
/c/Users/test/a.txt
```

をGit Bash環境でWindows pathへ解決できること。

```text
\\server\share\foo.txt
```

をUNCとして壊さないこと。

Windowsはcase-insensitive filesystemを考慮し、

```text
C:\Foo\bar.txt
c:\foo\BAR.txt
```

を可能な範囲で同一snapshot keyへ正規化する。

---

## 36. 性能受入基準

通常の `write` / `edit` について、

* project-wide directory walkを発生させない
* 対象ファイル以外をreadしない
* 同一turn / 同一pathのpre-imageは1回だけread
* CAS hit時はblobを重複保存しない

こと。

簡易benchmarkを追加する。

対象:

```text
1 KB
100 KB
1 MB
10 MB
```

のwrite/edit。

baseline Piと比較し、snapshot overheadを測定する。

bash directory snapshotについては通常操作とは別枠とし、

```text
100 files
1000 files
5000 files
```

で測定する。

---

## 37. Acceptance Criteria

以下をすべて満たしたらv1完成とする。

* [ ] `write` が変更した既存ファイルを任意の会話ターンまで復元できる
* [ ] `write` が作成した新規ファイルをrollback時に削除できる
* [ ] `edit` が変更したファイルを任意の会話ターンまで復元できる
* [ ] 同一turn・同一fileのsnapshotを重複作成しない
* [ ] rollbackすると対象user messageを残してPi session treeがその位置へ移動する
* [ ] `/rollback start` でPiによる当該sessionの変更をundoし、新しい空sessionへ移動する
* [ ] user/external editをデフォルトで上書きしない
* [ ] `--force` で明示的に上書きできる
* [ ] bashの明示pathをbest-effortでsnapshotできる
* [ ] bash directory対象を上限付きで再帰snapshotできる
* [ ] bashで実際に変化しなかったファイルを恒久snapshotとして残さない
* [ ] bash commandがexit errorでも実際の変更を記録する
* [ ] `/` および `$HOME` 配下の通常ファイルを扱える
* [ ] Linux / macOS / Windowsで動作する
* [ ] Windows drive path / Git Bash pathを処理できる
* [ ] snapshot失敗時もwrite/edit/bash本体を止めない
* [ ] snapshot失敗をユーザーへ通知する
* [ ] total store limitを超えて無制限にディスクを消費しない
* [ ] rollback途中の障害で可能な限り元状態へcompensating restoreできる
* [ ] Pi crash後にunfinished pending journalを検出できる

---

## 38. v1で意図的に対応しないもの

* arbitrary shell programの完全な副作用検出
* `strace` / eBPF / filesystem filter driverによるwrite interception
* Docker / SSH / remote filesystem rollback
* Windows filesystem filter driver
* user editとPi editのsemantic 3-way merge
* database rollback
* registry rollback
* environment variable rollback
* filesystem ACL完全復元
* Pi組み込み以外の任意custom toolの自動snapshot

これらを実装すると「軽量なPi extension」という要件から大きく外れるため、v1には入れない。

---

## 39. 設計上の最重要原則

優先順位は以下とする。

```text
1. Pi Agent本体を壊さない
2. ユーザーの後編集を壊さない
3. 正確に捕捉できる write/edit を確実に戻す
4. bash は可能な範囲で保護する
5. 不要なsnapshotを保存しない
6. rollback機構自身のディスク使用量を制限する
```

Hermes の「working directory全体をShadow Gitへ保存する」方式をそのまま移植するのではなく、

```text
Pi tool event
    +
file-level pre-image
    +
SHA-256 CAS
    +
Pi session tree
```

を組み合わせる。

この方式を `pi-rollback` の中核アーキテクチャとする。
