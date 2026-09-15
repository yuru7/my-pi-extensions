[English](./README.md) | 日本語

# pi-ai-approval

コーディングエージェント [Pi](https://pi.dev) 向けの、fail-closed(閉じる側優先)の承認ゲートです。分離された AI レビュワーが対象のツール呼び出しを6段階のリスクレベルに分類し、ローカルの `riskActions` 設定が実行可否を決定します: `allow`(無確認で実行)/ `ask`(Deny / Approve / Approve + Add Rule の確認)/ `deny`(拒否)。

AI が最終的な許可を判断することはありません。AI はリスク評価と操作内容の説明のみを行い、実行可否は必ずローカル設定によって決まります。レビュワーが分類できないものはすべてブロックされます。

## 動作の仕組み

```text
ツール呼び出し
   ↓
AI レビュー(分離されたレビュワーセッション)
   ↓
リスクレベル + instruction alignment + 操作の要約 + 判定理由
   ↓
riskActions 設定
   ↓
allow ─────────→ 実行
ask  → Deny / Approve / Approve + Add Rule
       Approve: この呼び出しのみ実行
       Approve + Add Rule: 許可し、セッションルールを追加
       Deny: ブロック
deny ─────────→ ブロック
```

- **`allow`** はユーザー確認なしでツール呼び出しを実行します。
- **`ask`** は承認プロンプトを表示します。対話 TUI ではプロンプト表示時にターミナルのベルが鳴ります。プロンプトはタイトルと1つの Markdown 文書です: `Approval Required`、`**Risk: <レベル>**`(太字。TUI では太字を描画しない端末でも見えるようレベル別の色も併用: medium/high は warning 色、very_high/critical は error 色)、`Review Information:`(判定に使ったモデルと設定順位の `Risk Assessor:` と `Instruction Alignment`。ルールで分類が下がった場合は `Session Rule:` 行も表示)、`Operation (tool: <ツール名>):`(実行されるツールに合わせた `bash` / `powershell` の言語ラベル付きコードブロック)、`Operation Summary:`、`Reason:` の順に並びます(ラベルはすべてプレーンな行で、見出しは使用しません)。TUI では文書を標準 Markdown コンポーネントで描画し、その上にタイトルを埋め込んだ全幅の罫線(例: `─── Approval Required ─────`)を引くため、プロンプトはセッションのトランスクリプトの続きではなく独立した領域として見えます。プロンプトが画面の高さに収まらない場合は本文をスクロール(マウスホイールまたは `shift+↑`/`shift+↓`)でき、操作中はスクロールバーと残り行数のヒントを表示します(選択肢は固定表示)。コマンドがプレビューの上限(300 文字)を超える場合、`Operation` のコードブロック末尾に `... (truncated, ctrl+o to expand)` を表示し、`ctrl+o` またはフルスクリーン TUI でのこのマーカー文字列自体のクリックで、コマンドの改行を保ったまま全文へ展開できます(展開中は選択肢の下のヘルプ行に `ctrl+o collapse` を表示)。マウス入力がプロンプトに届くのはフルスクリーン時だけなので、通常の TUI では `ctrl+o` を使用します。TUI 以外の選択 UI は展開できないため、従来どおり `… [truncated]` とだけ表示します。選択肢は固定で **Deny / Approve / Approve + Add Rule(初期選択は Deny)** のため、そのまま Enter を押してもブロックされます。「Approve + Add Rule」は現在の呼び出しを許可したうえでセッション承認ルールの入力を開き、Enter で入力を確定、Esc は入力を取り消して選択肢に戻るため、取り消した入力が許可になることはありません。Esc・Ctrl-C・UI が利用できない場合もブロック(fail closed)です。TUI 以外(RPC・print・JSON)ではタイトルを文書の先頭に付けて各クライアントの選択 UI に渡します。
- **`deny`** はツール呼び出しをブロックし、AI の判定理由を「同じ操作を別手段で再試行するな」という指示とともにエージェントへ返します。

Approve(`Approve + Add Rule` を含む)が有効なのは**その1件のツール呼び出しのみ**です。次の呼び出しは改めてレビューされ、セッションルールはレビュワーが確認した分類を1段階下げることだけができ、ルール自体が何かを許可することはありません。`ask` が同時に複数発生した場合はプロンプトが直列化され、常に1件だけ表示されます。

## リスクレベル

リスクは**現在のユーザータスクの文脈**で、その操作を実行することの実質的なリスクとして評価します。失敗・誤用・意図しない副作用がどれだけの損害を起こしうるか、元に戻すコスト、そしてユーザーの指示にどれだけ直接沿っているかです。リスクレベルと合わせて、レビュワーは `instruction_alignment`(`direct` / `implied` / `weak` / `unrelated`)を報告します。

基本原則:

- ユーザーの依頼を直接実現する、対象が限定された、容易に復元できる通常の開発作業は `low` リスクです。プロジェクトのファイルを変更するからという理由だけで引き上げません。
- 明示的なユーザー指示は不確実性を減らしますが、影響範囲・不可逆性・本番への影響・セキュリティ上の結果を消すわけではありません。
- `very_high` と `critical` は明示的に要求されていても、そのレベルから下がりません。

| レベル | 意味 |
| --- | --- |
| `very_low` | 状態を変更しない操作: ファイル読み取り、`grep`/`find`/`ls`、`git status`、テスト結果や設定値の確認 |
| `low` | 依頼された作業を遂行する、通常・限定的・容易に復元可能な変更: 指示されたソースコードの編集、ファイル作成、リファクタリング、formatter/lint、ローカル build/test、生成物の削除 |
| `medium` | 目的には沿うが、通常のコード編集より大きな副作用や復旧作業を伴う操作: 一括変更、依存の追加・更新、ローカル DB migration、開発サービスの再起動、軽度な git 履歴操作、プロジェクト外の設定変更、外部サービスへの書き込み |
| `high` | 重要なデータ・環境・サービスへの影響、または指示から具体的な副作用への飛躍が大きい操作: 本番/共有環境の変更、force push、重要設定、DB データ更新、firewall/IAM/network 変更。明示的に指示された本番作業でも medium〜high の床を維持 |
| `very_high` | 明示的に依頼されていても、影響範囲・復旧コスト・不可逆性のいずれかが大きく人間の再確認が必要な操作: 本番データの一括更新・削除、大量リソース削除、IAM の大幅変更、protected branch の強制更新 |
| `critical` | 指示にかかわらず通常のエージェント自動実行の範囲を超える操作: 秘密情報の外部流出、復旧不能な大量破壊、セキュリティ機構の恒久的無効化、広範な権限付与 |

具体例: 報告されたバグを直すためのファイル編集 → `low`。実装に必要な依存の追加 → `medium`。依頼された `/tmp` 配下の操作 → `very_low`/`low`(`rm -rf /tmp/*` は最大 `medium`、`/tmp` 自体の削除 → `high`)。明示指示された通常のローカル `git commit` → `low`(`--amend` や履歴書き換えは `medium` 以上に据え置き)。独断での `git reset --hard` → `high`(明示指定があれば `medium`)。明示指示があっても本番 DB migration → `high`。本番データの一括削除 → `very_high`。指示があっても秘密情報の外部送信 → `critical`。

## セッション承認ルール

3つ目の選択肢 **Approve + Add Rule** は、現在の呼び出しを許可したうえで、この Pi セッションの残りに適用するルールの入力を求めます。ルールはメモリ内にのみ保持され、ディスクには保存されず、セッションランタイムがリセットされる(セッションの再読み込みや置き換えを含む)と消えます。ルール入力中の Esc は入力を取り消して選択肢に戻り、Enter はサニタイズ済みのテキストを保存します。

ルールが以降の呼び出しに与える影響:

- 有効なルールはレビュワーのシステムプロンプトに追加され、同時に「ルールがリスク分類を変えることはない」という指示も与えられます。レビュワーが報告できるのは、対象操作を明確かつ完全にカバーする1つのルールのIDだけです。
- ローカル層は、有効なルール集合に存在しないルールIDを一致なしとして扱います。
- 報告されたルールが存在する場合、分類をちょうど1段階下げてポリシーを再適用します。これは `ask` と `deny` のどちらにも当てはまります。`allow` はすでに許可されているためルールで変わりません。下限は `very_low` です。
- ルールは判定を `allow` 側に動かすことしかできません。下げたレベルが再び `deny` に割り当てられている（またはそれ以上下げられない）場合は、元の判定と元のレベルを維持します。つまりルールで判定が厳しくなることはありません。`critical` が自動 `allow` になることもありません（1段階下は `very_high` で、ポリシーが allow を許可しないため）。
- 既定ポリシーでは、一致ルールは `high` の deny を `medium` のプロンプトに変え、`very_high` と `critical` はブロックのままです。`medium: allow` の設定なら、ルールで `high` の操作が自動実行されます。
- ルールによって自動 `allow` になった場合は、適用されたルールと元のレベル・有効なレベルを情報通知で報告します。下げたレベルが `ask` の場合は、プロンプトに `Session Rule:` 行を表示し、適用されたルールと下げ元のレベルを示します。

ルールには上限があります。1セッションあたり最大20件、各ルールは制御文字と ANSI エスケープを除去し改行を畳んだ後で最大500文字です。承認プロンプトでは空文字や上限超過を理由付きで拒否し、入力は開いたままになります(無言で切り詰めることはありません)。ルールマネージャでは同じ拒否理由を通知します。

ルールの確認・変更は `/ai-approval session-rules` で行います。有効なルールをID付きで一覧表示し、追加・編集(現在のテキストが入力欄に入った状態で開きます)・削除ができます。各段階で Esc を押すと何も変更されません。

例: あるコマンドが繰り返し `medium` → `ask` になります。**Approve + Add Rule** を選び、`Allow pnpm test and pnpm build in this repository for this session` と入力します。次の呼び出しではレビュワーがルールIDを報告し、ローカルポリシーが `medium` を `low` に下げ、プロンプトの代わりに情報通知付きで実行されます。既定ポリシーでは同じルールで `high` の deny が `medium` のプロンプトに変わり、`very_high` と `critical` はブロックのままです。

## 設定

`ai-approval.json` はグローバルのエージェントディレクトリ(`~/.pi/agent/`)と、信頼済みプロジェクトではプロジェクト側の `.pi/ai-approval.json` から読み込まれます。プロジェクト設定はポリシーを厳しくすることだけができ、緩めることはできません。両方のファイルが存在しない場合は起動時に警告し、`/ai-approval init` で作成するよう案内します。作成されるまではビルトインのデフォルトが有効です。

```json
{
  "primaryModel": "CURRENT",
  "primaryThinkingLevel": "low",
  "secondaryModel": "CURRENT",
  "secondaryThinkingLevel": "low",
  "timeoutMs": 90000,
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

| キー | 設定可能な値 | デフォルト |
| --- | --- | --- |
| `very_low`, `low`, `medium`, `high` | `allow`, `ask`, `deny` | `allow`, `allow`, `ask`, `deny` |
| `very_high`, `critical` | `ask`, `deny` | `deny`, `deny` |

`very_high` と `critical` は `allow` にできません。設定してもパーサが警告して `deny` を使用します。

重要な操作をすべて人間に確認させたい場合は:

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

### レビュワーモデル

`primaryModel` と `secondaryModel` でレビュワーチェーンの2段階を設定し、現在のセッションモデルが常に最後の第3チャネルとして残ります。どちらの設定も明示的な `provider/model-id` か、特殊値 `CURRENT`(デフォルト。「現在のセッションモデルを使用」の意味)を受け付けます。

チェーン内に同じモデルが複数回現れた場合、試行されるのは1回だけです。先頭のチャネルがそのモデルを担当し、2つ目以降の重複はスキップされるため、一時的に利用できないモデルへ何度もリクエストすることはありません。重複判定はモデルのみで行い、思考量の違いで別チャネルになることはありません。たとえば `primaryModel: "openai/gpt-5.6-luna"` が失敗し `secondaryModel: "openai/gpt-5.6-luna"` の場合、思考量が異なっていても secondary はスキップされます。すべてのチャネルが失敗した場合はブロックされます。リスクを推測することはありません。

### レビュワーの思考量

`primaryThinkingLevel` と `secondaryThinkingLevel` で各レビュワーチャネルの思考量を設定します。指定できる値は `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` と、特殊値 `CURRENT`(レビュー時点のセッション思考量を継承)です。デフォルトは `low` です。`CURRENT` 指定時にセッション思考量が取得できない場合は `low` を使います。最後の current-model チャネルは常にセッションの思考量(取得できなければ `low`)を使います。

```json
{
  "primaryThinkingLevel": "low",
  "secondaryThinkingLevel": "CURRENT"
}
```

環境変数での上書き(`PI_AI_APPROVAL_PRIMARY_MODEL`, `PI_AI_APPROVAL_SECONDARY_MODEL`, `PI_AI_APPROVAL_PRIMARY_THINKING_LEVEL`, `PI_AI_APPROVAL_SECONDARY_THINKING_LEVEL`, `PI_AI_APPROVAL_TIMEOUT_MS`, `PI_AI_APPROVAL_POLICY`)にも対応しています。

### 判定コメントの言語

`assessmentLanguage` はレビュワーの `action_summary` と `rationale`(承認プロンプトや拒否理由に表示)の言語を制御します。デフォルトの `auto` は会話のユーザー言語に追従します。固定したい場合は言語名を指定します:

```json
{
  "assessmentLanguage": "Japanese"
}
```

プロジェクト設定がグローバル設定を上書きします。

### fail-closed の保証

以下はすべて、承認プロンプトを表示せずにツール呼び出しをブロックします:

- レビュワーのタイムアウト・失敗・キャンセル・解析不能な出力
- レビュワー応答に含まれる未知のリスクレベル
- すべてのレビュワーチャネルの失敗
- 承認プロンプトが閉じられた、または利用できない

セッション承認ルールが関わる場合も、失敗が許可に変わることはありません。ただし、すべてのルールの問題がブロックになるわけではありません。ルール入力 UI が利用できない場合は診断付きの declined としてブロックします。ルール入力中の Esc は選択肢に戻るだけで許可にはなりません。空文字や上限超過のルールは入力を開いたままにし、レビュワーが報告したルールIDが有効なルール集合に存在しない場合は一致なしとして通常の承認プロンプトに進みます。

拒否サーキットブレーカーがリトライの暴走を止めます。1ターン内に不利な結果(拒否、ユーザーによる却下、レビュー失敗、タイムアウト)が繰り返された場合、エージェントのターンを中断します。

## レビュー対象

どのツール呼び出しをレビューするかは、リスクポリシーとは独立に `review` ルール(ツールパラメータ → スコープ)で制御します:

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

ビルトインのデフォルトは `bash.command: always` と `powershell.command: always`、`read.path` / `grep.path` / `write.path` / `edit.path: outside-or-private`、`find.path` / `ls.path: private-only` です。

ルールキーは `<ツール>.<パラメータ>` です。`bash.command` / `powershell.command` は bash / PowerShell 呼び出しのコマンド文字列を、`read.path` / `grep.path` / `find.path` / `ls.path` は読み取り・検索のスコープを、`write.path` / `edit.path` は変更対象のファイルをルーティングします。ビルトインのルールがなくても文字列の `path` パラメータを持つツール(例: `custom_reader.path`)も指定でき、デフォルトは `private-only` です。

### スコープの値

| スコープ | レビューされる条件 |
| --- | --- |
| `off` | レビューしません。対象ツール/パラメータは完全にスキップされます。 |
| `private-only` | 対象パスが private データと判定された場合のみ。 |
| `outside-or-private` | 対象パスがプロジェクトルートの外に解決されるか、private である場合。`write`/`edit` ではプロジェクト内のセキュリティ関連ファイルも含みます。 |
| `always` | 対象に関係なく常にレビューします。 |

「private」は決定論的なルールカタログで判定されます: 認証情報・秘密ファイル(`.env*`、鍵ファイル、`auth.json`、トークンストア、ブラウザのログインデータなど)、プロジェクト外の private ディレクトリ(`.ssh`、`.gnupg`、`.aws`/`.kube` などのクラウド CLI 設定、ブラウザプロファイル、Pi エージェントデータ)、そして検索ツールの場合はそのようなファイルを含みうるディレクトリスコープや glob。`write`/`edit` の「sensitive」はさらに、CI ワークフロー、コンテナ/デプロイマニフェスト、依存ロックファイル、シェルプロファイル、鍵ファイル(`.pem`、`.key` など)、機密ディレクトリセグメント(`.git`、`secrets`、`terraform`、`k8s` など)を含みます。

`bash.command` と `powershell.command` は特殊で、パスではなくコマンド文字列を対象とします。そのため `off` のときだけスキップされ、それ以外のスコープではすべてのシェルコマンドがレビューされます(private データを参照するコマンドは、ツールなしの制限モードでレビューされます)。

レビュー対象 = ブロックではありません。レビューされた呼び出しは AI レビュワーがリスクレベルを分類し、`riskActions` 設定が allow / ask / deny を決定します。

## コマンド

- `/ai-approval` — ステータス: レビュワーチャネル、タイムアウト、設定ファイルのパス、警告
- `/ai-approval init` — デフォルト設定ファイルを出力します(保存先を選択。既存ファイルがある場合は上書き確認)
- `/ai-approval rules` — レビュー対象マトリクスと実効性のある risk actions
- `/ai-approval session-rules` — セッション承認ルールの一覧・追加・編集・削除(対話式)
- `/ai-approval bypass` / `enable` — レビューの一時無効化/再有効化(対話 TUI のみ。永続的な警告を表示)

## インストール

```bash
pi install npm:@yuru7/pi-ai-approval
```

## 開発

```bash
pnpm install
pnpm typecheck
pnpm test
```

## 謝辞

[pi-approval-guardian](https://github.com/mics8128/pi-approval-guardian) にインスパイアされて作成されました。

## ライセンス

[MIT](./LICENSE)
