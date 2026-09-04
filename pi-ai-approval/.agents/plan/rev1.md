# ExecPlan: Pi Approval Guardian のリスクレベル別実行ポリシー対応

## 目的

AI が判定したリスクレベルに応じて、各操作を以下の3種類のポリシーで制御できるようにする。

* `allow`: ユーザー確認なしで実行
* `ask`: ユーザーに Yes / No で確認し、Yes の場合のみ実行
* `deny`: 強制的に拒否

AI 自身には最終的な allow / deny を判断させず、**AI はリスク評価と操作内容の説明に専念させる**。最終的な実行可否はローカル設定によって決定する。

現行実装では Reviewer が `risk_level`、`user_authorization`、`outcome` を返し、その後さらにローカル側で Critical や一部 High を拒否している。これを、`risk_level` を中心とした明確な二段階構造へ整理する。

```text
Tool Call
   ↓
Guardian AI Review
   ↓
RiskLevel + 操作要約 + 判定理由
   ↓
riskActions 設定
   ↓
allow ─────────→ 実行
ask  → Yes/No ─→ Yes: 実行 / No: 拒否
deny ──────────→ 拒否
```

---

## リスクレベル

`RiskLevel` を現在の4段階から以下の6段階へ変更する。

内部値は設定ファイルや JSON で扱いやすい snake_case とする。

```ts
type RiskLevel =
  | "very_low"
  | "low"
  | "medium"
  | "high"
  | "very_high"
  | "critical";
```

### Very Low

読み取り・表示・検証などが中心で、対象データやシステム状態を変更しない。失敗しても影響はほぼない。

例:

* ファイル読み取り
* `ls` / `grep`
* 状態確認
* テスト結果確認
* Git status

### Low

一時ファイル、ログ、キャッシュなど、限定的で復元可能な変更を行う。失敗時は通常の手順で容易に復旧できる。

### Medium

設定、データ、プロセスなどに変更を加える。影響範囲は限定的だが、誤操作や失敗時には確認・復旧作業が必要になる。

### High

重要な設定・データ・サービスに変更を加える。停止、データ不整合、利用者への影響が起こり得るため、事前確認とロールバック手順が必要。

### Very High

本番環境の重要機能、大量データ、権限、ネットワークなどに広範または不可逆な変更を加える。実行前の承認、バックアップ、段階的な実施が必要。

### Critical

データ消去、不可逆な破壊的変更、権限の恒久的な拡大、広域停止などを伴い得る。事業継続やセキュリティに重大な影響を与えるため、原則として自動実行せず、明示的な承認と厳格な保護措置を要する。

この分類を `src/policy.ts` の Guardian system prompt に明示し、Reviewer がこの6段階だけを返すようにする。

---

## Reviewer の責務変更

現在の Reviewer は以下を返している。

```ts
interface GuardianAssessment {
  risk_level: RiskLevel;
  user_authorization: UserAuthorization;
  outcome: "allow" | "deny";
  rationale: string;
}
```

これを次のように簡素化する。

```ts
interface GuardianAssessment {
  risk_level: RiskLevel;
  action_summary: string;
  rationale: string;
}
```

### `risk_level`

操作そのものの危険度を6段階で評価する。

ユーザーがその操作を依頼したかどうかではなく、**その操作が失敗・誤実行された場合の影響度を中心に評価する**。

### `action_summary`

実行予定操作が実際に何を行うものなのかを、ユーザーが判断できる短い自然文で説明する。

例:

```text
現在の Git ブランチを1コミット前の状態へ強制的に戻し、
コミットされていない変更も破棄します。
```

これは承認 UI の「AI コメント」として利用する。

### `rationale`

なぜそのリスクレベルと判断したのかを簡潔に説明する。

例:

```text
未コミット変更を失う可能性があり、通常のファイル変更より復旧コストが高いため High と判断しました。
```

`outcome` は Reviewer の出力から削除する。

`user_authorization` も最終的な allow / deny 判定には使用しないため削除し、ポリシーを単純化する。

現行 `policy.ts` に存在する、

```text
low -> allow
medium -> allow
high -> 条件付き allow
critical -> deny
```

という Outcome Policy も削除し、Reviewer は分類だけを行うよう変更する。現状は AI がリスク分類と実行判断の両方を担っているため、この部分を分離する。

Reviewer の JSON 出力は例えば以下とする。

```json
{
  "risk_level": "medium",
  "action_summary": "プロジェクト設定ファイルを書き換え、アプリケーションの動作設定を変更します。",
  "rationale": "限定された設定変更ですが、誤った値ではアプリケーションが正常に動作しなくなる可能性があります。"
}
```

---

## リスクレベル別ポリシー設定

`approval-guardian.json` に `riskActions` を追加する。

```json
{
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

デフォルト値は上記とする。

型は以下。

```ts
type RiskAction = "allow" | "ask" | "deny";

interface RiskActions {
  very_low: RiskAction;
  low: RiskAction;
  medium: RiskAction;
  high: RiskAction;
  very_high: "ask" | "deny";
  critical: "ask" | "deny";
}
```

`very_high` と `critical` では `allow` を禁止する。

したがって、

```json
{
  "riskActions": {
    "critical": "allow"
  }
}
```

のような設定は invalid として警告し、安全側のデフォルト `deny` を使用する。

Very High についても同様とする。

### Global / Project 設定

既存 `review` 設定と同じく、

* Global config
* Project config

をサポートする。現行設定にも Global / Project のマージ処理と「Project から安全性を弱めない」仕組みが存在するため、この考え方を維持する。

強度は以下とする。

```text
allow < ask < deny
```

Project config は Global config より厳しい方向への変更だけ許可する。

例:

```text
Global: medium = ask
Project: medium = deny
→ deny

Global: medium = deny
Project: medium = ask
→ deny
```

Very High / Critical を `ask` にしたい場合は Global config で明示的に設定する。

---

## リスクポリシー判定層を追加

Reviewer と `tool_call` ハンドラの間に、純粋関数としてポリシー判定層を設ける。

新規ファイル例:

```text
src/risk-policy.ts
```

主要 API:

```ts
function resolveRiskAction(
  riskLevel: RiskLevel,
  config: GuardianConfig,
): RiskAction
```

ここには AI 処理や UI 処理を含めない。

これにより、

```text
AIによる分類
↓
ローカルポリシー判定
↓
UI / 実行制御
```

を明確に分離し、単体テストしやすくする。

---

## `ask` のユーザー確認 UI

`rpiv-ask-user-question` の実装を参考にするが、汎用 Questionnaire は取り込まない。

この用途ではフリー入力、複数質問、プレビューなどは不要なので、Pi の `ctx.ui.select()` を利用した専用の軽量実装とする。

`rpiv-ask-user-question` でも RPC 環境向けフォールバックとして `ctx.ui.select()` が利用されており、この用途には十分である。

表示イメージ:

```text
Guardian approval required

Risk: Medium

Operation:
$ git reset --hard HEAD~1

AI assessment:
現在のブランチを1コミット前へ強制的に戻し、
コミットされていない変更も破棄します。

Reason:
未コミット変更を失う可能性があるため Medium と判断しました。

Proceed?

> No
  Yes
```

選択肢は必ず、

```ts
["No", "Yes"]
```

の順序とする。

初期カーソルも `No` に置く。

したがって Enter をそのまま押した場合は `No` になる。

操作結果は以下。

```text
No
→ tool call を block

Yes
→ 対象 tool call のみ実行

Esc / Ctrl-C
→ No と同等に block

UIが利用できない
→ fail closed で block
```

ユーザーが `Yes` を選択しても、「以後同じ種類の操作を許可する」といったセッション単位の権限にはしない。

**承認対象は現在の `toolCallId` に対応する1操作だけ**とする。

---

## 実行予定操作の表示

既存 `review-presentation.ts` にはすでに `actionPreview()` があり、

* bash → コマンド
* その他 → tool 名 + path

を表示する処理がある。

これを承認 UI でも再利用できるよう、private function から共通 formatter へ切り出す。

例:

```ts
formatActionPreview(action)
```

可能であれば tool ごとに少し情報量を増やす。

```text
bash
→ 実行コマンド

write
→ 対象ファイルパス

edit
→ 対象ファイルパス + edit 件数

read
→ 読み取り対象

grep/find
→ path + pattern
```

巨大な `content` や tool payload 全体は承認 UI に表示しない。

ただし bash コマンドなど、ユーザーが実行対象を判断するために必要な情報については十分な長さを確保し、切り詰めた場合は明示的に `… [truncated]` と表示する。

---

## tool_call フロー変更

現在の概略フローは、

```text
actionFromToolCall
↓
reviewAction
↓
enforceActionRequirements
↓
lockAllowedToolInput
↓
allow / block
```

となっている。

これを以下へ変更する。

```text
actionFromToolCall
↓
reviewAction
↓
GuardianAssessment
↓
resolveRiskAction
↓
┌ allow
│   ↓
│ lockAllowedToolInput
│   ↓
│ execute
│
├ ask
│   ↓
│ showApprovalPrompt
│   ↓
│ Yes → lockAllowedToolInput → execute
│ No  → block
│
└ deny
    ↓
   block
```

既存 `enforceActionRequirements()` に入っている、

* Critical は自動許可しない
* High + authorization による制御
* private data + authorization による制御

などは、新しい `riskActions` ベースの判定へ整理する。

特に Critical / Very High の `allow` 禁止は AI 判定ではなく、設定パーサおよびポリシー判定層によって保証する。

---

## Reviewer models

リスク評価用モデルは Primary / Secondary の2系統を設定可能とし、既存の model / fallbackModel 機構を維持する。Primary が失敗・タイムアウト・利用不可の場合のみ Secondary へフォールバックする。Secondary も失敗した場合はリスクを推測せず fail closed で対象操作を拒否する。

---

## AI レビュー失敗時

以下は現在どおり fail closed を維持する。

```text
Reviewer timeout
Reviewer failure
Reviewer cancelled
Reviewer response parse failure
Fallback reviewer 全失敗
```

これらを `ask` にフォールバックさせない。

AI がリスクレベルを判定できなかった状態で、

```text
「ユーザーが Yes と言ったから実行」
```

とはしない。

必ず block する。

---

## ユーザーによる No の扱い

`No` を選択した場合は通常の deny と同じく tool call を block する。

Agent 側へ返す reason には、

```text
The user declined this exact action.
Do not retry the same action through an equivalent command or workaround.
Choose a materially safer alternative or ask the user in conversation.
```

相当の意味を含める。

これにより Agent が、

```text
rm -rf ...
↓ No
↓
別の shell 記法で再実行
```

のような回避を試みることを抑制する。

既存の rejection reason にも「workaround / indirect execution / policy circumvention を試すな」という制御があるため、その思想を維持する。

---

## 複数 tool call の扱い

複数 tool call が並列・連続で `ask` になった場合、承認 UI が重ならないようにする。

専用の approval queue または mutex を設け、

```text
Tool A → ask
Tool B → ask
Tool C → ask
```

の場合、

```text
A の確認
↓
B の確認
↓
C の確認
```

と順番に処理する。

複数操作をまとめて1回の Yes で承認する機能は今回は実装しない。

承認範囲を曖昧にしないため、1 tool call = 1 approval を維持する。

---

## Circuit Breaker

既存の Denial Circuit Breaker は維持する。

以下を adverse outcome として扱う。

```text
risk policy = deny
user selected No
approval UI cancelled
review failure
review timeout
```

ユーザーが一度 No を選択した操作を Agent が何度も形を変えて再試行するケースを抑制する。

`Yes` と `allow` は adverse outcome としない。

---

## 表示系の整理

レビュー結果の表示も新しいモデルに合わせる。

現在は、

```text
Guardian · allowed · high risk · auth medium
```

のように `user_authorization` を表示している。

これを例えば、

```text
Guardian · allowed · Very Low risk
Guardian · approved by user · Medium risk
Guardian · blocked · High risk
```

へ変更する。

`ask → Yes` については、自動 allow と区別できるよう、

```text
approved by user
```

とする。

---

## テスト

最低限、以下を追加・更新する。

### RiskLevel

6段階すべてを Reviewer response として parse できること。

```text
very_low
low
medium
high
very_high
critical
```

未知の値は review failure として fail closed になること。

### riskActions

以下を確認する。

```text
very_low / low / medium / high
  allow
  ask
  deny

very_high / critical
  ask
  deny
```

Very High / Critical に `allow` を指定すると警告され、`deny` になること。

### Global / Project merge

```text
allow → ask
allow → deny
ask → deny
```

の強化は可能。

```text
deny → ask
deny → allow
ask → allow
```

の弱体化は Project config からできないこと。

### ask UI

```text
No → block
Yes → execute
Esc → block
undefined → block
UI unavailable → block
```

を確認する。

初期選択が必ず `No` であることもテストする。

### tool input locking

`allow` および `ask → Yes` の双方で、現在の `lockAllowedToolInput()` による tool input 保護が維持されること。

### AI review failure

```text
timeout
failure
cancel
invalid JSON
unknown risk level
```

では確認 UI を表示せず、そのまま block すること。

### approval scope

Yes が現在の tool call だけに作用し、次の同種 tool call は再度ポリシー評価されること。

### concurrency

複数 `ask` が発生しても複数の approval UI が同時表示されず、順番に処理されること。

---

## 主な変更対象

既存構成を維持する場合、主に以下を変更する。

```text
src/review.ts
  RiskLevel を6段階化
  GuardianAssessment を変更
  Reviewer response parser を変更

src/policy.ts
  6段階の Risk Taxonomy を定義
  user_authorization / outcome 判定を削除
  action_summary を生成させる

src/config.ts
  riskActions を追加
  RiskAction validation / merge を追加

src/risk-policy.ts
  新規追加
  RiskLevel → allow / ask / deny の純粋な判定処理

src/approval-prompt.ts
  新規追加
  Yes / No 専用 UI

src/review-presentation.ts
  actionPreview の共通化
  新しい risk 表示へ対応

src/tool-actions.ts
  旧 enforceActionRequirements の整理

extensions/index.ts
  review → risk policy → ask/allow/deny の制御を追加
  approval queue を管理

tests/*
  上記に対応する単体・統合テスト
```

---

## 初期デフォルト

初期状態は安全性と通常操作の使いやすさのバランスを取り、以下とする。

```json
{
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

ユーザーが明示的に設定すれば、

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

のような「危険な操作はすべて人間に確認する」構成も可能とする。

ただし、

```json
{
  "riskActions": {
    "very_high": "allow",
    "critical": "allow"
  }
}
```

は常に禁止する。

---

## 完了条件

実装完了時、以下が成立すること。

```text
1. Guardian AI が6段階の RiskLevel を返す
2. AI は最終的な allow / deny を決定しない
3. RiskLevel ごとの allow / ask / deny を設定できる
4. Very High / Critical では allow を設定できない
5. ask では実行予定操作と AI の説明が表示される
6. 選択肢は上から No / Yes
7. 初期選択は No
8. Yes の場合のみ、その1 tool call を実行する
9. No / Esc / UI failure はすべて fail closed
10. Reviewer 自体の失敗時も fail closed
11. 複数承認 UI が競合しない
12. 既存の tool input lock、fallback reviewer、circuit breaker の安全性を維持する
```

今回の変更では、汎用的な権限管理 UI、Yes to all、セッション中の恒久許可、自由入力、リスクレベルの手動上書きなどは対象外とする。まずは **「AIによる6段階評価 → 設定による決定 → 必要なら1操作ずつ確認」** という単純なモデルを完成させる。

