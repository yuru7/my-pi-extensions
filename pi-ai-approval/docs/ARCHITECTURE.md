# アーキテクチャ — pi-ai-approval

> 構造的・セキュリティ的に重要な変更を行う前に必ず読むこと。
> 関連ドキュメント: `README.md`（ユーザー向けの動作・設定リファレンス）、
> `README_ja.md`（その日本語訳）。

## 1. 目的

`pi-ai-approval` は Pi 向けのフェイルクローズドな承認ゲートであり、Pi
拡張として配布される（`package.json` → `pi.extensions: ["./extensions/index.ts"]`）。

- 審査対象のツール呼び出しはすべて、**隔離された AI レビュアー**によって 6 段階の
  リスクレベル（`very_low` … `critical`）と `instruction_alignment`
  （`direct` / `implied` / `weak` / `unrelated`）に分類される。
- **ローカルの `riskActions` ポリシー**が各レベルを `allow` / `ask` / `deny`
  に割り当てる。
- AI が最終結果を決めることはない。AI の役割はリスク評価と操作内容の説明のみであり、
  判定は常にローカル設定が行う。分類できなかったものはすべてブロックする。
- `ask` プロンプトには第三の選択肢「Approve + Add Rule」があり、ユーザーはその
  セッション中だけ有効な承認ルールを追加できる。ルールはレビュアーに参照情報として
  渡されるだけでリスク分類を変えず、ローカル層が一致を検証し、`ask` と `deny` の
  分類を1段階下げて再適用する（`allow` は変化なし。下げた先が `deny` なら元の判定を
  維持し、判定が厳しくなることはない）。

フェイルクローズドの要点: レビュアーのタイムアウト・失敗・キャンセル・解析不能な
出力・未知のリスクレベル・全チャネル失敗・プロンプトの破棄や UI 不可 → 確認を求めず
ブロックする。

## 2. ディレクトリ構成

```text
pi-ai-approval/
  extensions/index.ts   # 唯一の Pi エントリポイント: イベント配線、review+decide の統括、/ai-approval コマンド
  src/                  # ゲートの全ロジック（純粋層 + レビュアー周辺）
  tests/                # node:test 群。src/*.test.ts に対応 + extension.test.ts
  docs/ARCHITECTURE.md  # このファイル
  AGENTS.md             # このファイルへのポインタ
  ai-approval.json      # リポジトリ外の実行時設定（グローバル ~/.pi/agent/ + 信頼済み .pi/ プロジェクト）
```

## 3. エントリポイント

`extensions/index.ts`（`aiApproval(pi, options)`）が Pi のライフサイクル配線を一手に担う:

- `tool_call` → `loadApprovalConfig` → `actionFromToolCall` → サーキットブレーカーの
  確認 → `reviewAction` → `decideAction`（セッションルールの検証・低下適用）→
  `lockAllowedToolInput`。
  非許可の結果はすべて `{ block: true, reason }` を返す。
- `tool_execution_end` → 変更系ツールの実行後に `DirectoryScanCache` をクリアし、
  バッチ単位のサーキットブレーカー集計を締める。
- `session_start` / `session_shutdown` / `before_agent_start` / `message_start`
  / `input` → 実行時状態（セッション承認ルールを含む）のリセットと直接ユーザー
  入力の来歴追跡。
- `pi.registerCommand("ai-approval")` → status / `rules` / `session-rules` /
  `init` / `bypass` / `enable`（status の詳細は `src/reviewer-status.ts`、
  `session-rules` は `src/session-rules-command.ts`）。

テスト・利用者向けの再エクスポート: `risk-policy`、`reviewer-channels`、
`tool-actions`、`tool-input-lock` の各ヘルパー。

## 4. リクエストフロー

```text
tool_call イベント
  ↓ branch snapshot（`getBranch()` はここだけで1回。以降は同じスナップショット）
  ↓ actionFromToolCall(event, cwd, review rules, cache)   [src/tool-actions.ts]
  │  undefined = 審査対象外 → そのまま返す（審査なし）
  │  bash/powershell: RTK 呼び出しを検出し、レビュアーガイダンスの
  │  付与条件に使用 [src/rtk-detection.ts]
  ↓ ReviewAction { tool, payload, cwd }
  ↓ DenialCircuitBreaker.isOpen()? → { block, "circuit-open" }
  ↓ reviewAction
  │    collectReviewMessages(branch)
  │    collectActionReasoning(branch, toolCallId)
  │    buildReviewerChannels → runReviewWithFallbackChain
  │    primary → secondary → current-model（モデル同一性で重複排除）
  │    各試行: ReviewerSessionController.review(action, messages, signal, { actionReasoning })
  │    actionReasoning は full / delta のどちらでも、トランスクリプト差分とは別に毎回渡す
  │    failure/timeout → 次チャネルへ; cancel → フォールバックせずフェイルクローズド
  ↓ ReviewResult: assessed | allowed | user-approved | user-declined |
  │               denied | timeout | failure | cancelled | circuit-open
  ↓ decideAction: applySessionRulePolicy(assessment, riskActions, 一致ルールの有無)
  │    allow → allowed（実行。ルールは何も変えない）
  │    ask/deny + 一致ルール → 1段階下げて再適用。allow なら適用ルールと
  │    元/有効レベルを情報通知、ask なら Session Rule 行付きでプロンプト表示、
  │    下げた先が deny なら元の判定と元レベルを維持
  │    ask → ApprovalQueue.runExclusive(showApprovalPrompt) → user-approved / user-declined
  │    （第三の選択肢は入力されたルールを検証・保存してから user-approved にする）
  │    assessed 以外の結果はそのまま通過
  ↓ lockAllowedToolInput(event, result): 承認済み入力を deep-freeze; 失敗 → ブロック
  ↓ allowed/user-approved → 実行（+ info 通知）; それ以外はブロック + rejectionReason
```

トランスクリプトの扱い: `src/authorization-provenance.ts` の
`collectReviewMessages(branch)` は、対話・RPC 入力と相関が取れたものだけを
`direct_user` とし、それ以外はレビュアー向けの `untrusted` な証拠として残す。
`src/review.ts` はサイズ制限付きの JSON-lines トランスクリプトを構築する
（最新 + 先頭のユーザーメッセージを優先し、次に直近の非ユーザー entries）。
thinking は通常トランスクリプトには混ぜない。`src/action-reasoning.ts` の
`collectActionReasoning(branch, toolCallId)` が、対象 ToolCall と直前の
ToolCall の間にある visible な thinking だけを current action reasoning として
取り出し、プロンプトの専用セクションで `provenance: "untrusted"` として渡す。
`thinkingSignature` と redacted 本文は送らない。reasoning が無くてもレビューは
失敗しない。

## 5. モジュールの責務

| モジュール | 役割 |
| --- | --- |
| `src/config.ts` | 設定スキーマ、既定値、ファイル・環境変数の読み込み、優先順位、厳格化のみのマージ、警告。`riskActions`、`review` ルール、`primaryModel` / `secondaryModel`（`CURRENT` = セッションモデル）、`primaryThinkingLevel` / `secondaryThinkingLevel`（思考量または `CURRENT` = セッション継承、既定 `low`）、`timeoutMs`（レビュアー期限）、`askTimeoutSeconds`（ask プロンプトの秒数。`null` と 0 以下は期限なし）、`assessmentLanguage`、`policy`。 |
| `src/tool-actions.ts` | `tool_call` → `ReviewAction \| undefined`。`bash.command` / `powershell.command`、`read/grep/find/ls.path`、`write/edit.path`、および汎用 `<tool>.path`（既定 `private-only`）を振り分ける。`private_data_read` を付与。 |
| `src/gate.ts` | ゲート共通基盤: `ReviewResult`・決定型、`DenialCircuitBreaker`、`ReviewBatchTracker`、パス分類（`classifyMutationPath`、`classifyReadPath`、`shouldReviewPath`）、ディレクトリのプライベートデータ走査。 |
| `src/path-rules.ts` | プライベート読み取り・センシティブ変更ルールの監査可能なリテラルカタログ（認証系ベース名、プライベートセグメント、サフィックス、Pi データパス）。I/O なし。 |
| `src/shell-private-data.ts` | `bash.command` / `powershell.command` 用ヒューリスティクス: シェルをトークン化し `~`・`$HOME`・`$env:NAME`（`USERPROFILE` / `HOME` / `APPDATA` / `LOCALAPPDATA`）を展開、リテラルパス・glob を `path-rules` カタログに `classifyReadPath` で照合。 |
| `src/rtk-detection.ts` | `pi-rtk-optimizer` が rewrite した `rtk ...` 呼び出しを検出する純粋関数。引用符・エスケープ・heredoc 本文を区別し、`&&`・`||`・`;`・`|`・`&`・改行で区切った各コマンド位置の `rtk` のみを検出する。実行コマンドの変更や正規化は行わない。 |
| `src/review.ts` | レビュアー契約: `RiskLevel`、`RiskAssessment`（任意の `matched_rule_id` を含む）、文字数制限付きのプロンプト・トランスクリプト構築、`CURRENT ACTION REASONING` セクション（常に `untrusted`）、`parseRiskAssessment`（未知レベル・要約/根拠欠落・不正な `matched_rule_id` を拒否する厳密検証）。 |
| `src/policy.ts` | レビュアーのシステムプロンプト（Codex Guardian のポリシーを改変。ファイル先頭に由来を記載）。レビュアーが適用すべき 6 段階ルーブリックを定義。明示依頼の通常ローカル commit は `low`、履歴書き換え系は `medium` 以上に据え置く。`/tmp` 配下は依頼済みなら `low` 以下・未依頼でも `medium` 上限、`/tmp` 自体の削除は `high`。`buildActionReviewSystemPrompt` は RTK を含むときだけ、RTK の用途と `do not assume low risk` を含む短い注意書き（`RTK_COMMAND_REVIEW_GUIDANCE`）を、private 判定時だけ封じ込め指示を追加する。セッション承認ルールがあるときだけ `Session Approval Rules` 節を追加し、ルールが `risk_level` を変えないこと・明確にカバーする1件だけを `matched_rule_id` として返すことを指示する。 |
| `src/reviewer-session.ts` | 隔離されたレビュアー用エージェントセッション（`ReviewerSessionController`）: 直列キュー、full/delta カーソルによるセッション再利用、試行ごとの期限、最大 3 試行、リトライ可能失敗のみ再試行、破棄。`actionReasoning` はトランスクリプト差分とは別に毎回プロンプトへ載せる。チャンネルごとの `thinkingLevel` で生成する。レビュアーには読み取り専用 `read/grep/find/ls` ツール群か無しを与える。 |
| `src/reviewer-channels.ts` | `primary → secondary → current-model` 連鎖: モデル同一性で重複排除（思考量は同一性に含めない）、`CURRENT` 思考量の解決（`resolveReviewerThinkingLevel`。セッション値がなければ `low`）、`reviewerHealth`、`shouldFallbackReview`（failure/timeout のみ）、`runReviewWithFallbackChain`。current-model チャネルは常にセッション思考量を使う。 |
| `src/reviewer-tools.ts` | レビュアー側ツールのサンドボックス: プライベート範囲に触れる調査は漏洩させる代わりに例外化するガード付き読み取り専用ツール定義。 |
| `src/risk-policy.ts` | 純粋な `assessment → allow/ask/deny` 変換（`resolveRiskAction` / `applyRiskPolicy`）。手作り設定で迂回されても `very_high` / `critical` の `allow` を拒否。I/O・UI なし。 |
| `src/approval-prompt.ts` | `ask` の UX と文面: プロンプトのタイトル（`Approval Required`）と本文を1つの Markdown 文書（`**Risk: …**` / `Review Information:` / `Operation (tool: <ツール名>):` + 言語ラベル付きコードブロック / `Operation Summary:` / `Reason:`。見出しは使わず、すべてプレーンな行 + コードブロック）として単一定義し、非 TUI にはタイトルを本文先頭に付けた同じ文書を渡す（TUI はタイトルを罫線に埋め込む）。`Review Information:` には、ルールで分類が下がった場合のみ `Session Rule:` 行（ID・本文・下げ元レベル）を追加する。操作プレビューのシェル別プレフィックス（`$ ` / `PS> `）と言語ラベル（`bash` / `powershell`）、動的値の制御文字/ANSI 除去・単一行化・400 文字上限、リスク行は太字に加えてレベル別の強調色（medium/high = `warning`、very_high/critical = `error`。太字を描画しない端末向け）、選択肢は `Deny / Approve / Approve + Add Rule` の3択で `Deny` が初期選択（Enter = ブロック）、第三選択肢は `ctx.ui.input` を開き Enter で確定・Esc で選択肢に再表示、空入力・上限超過・入力 UI 失敗では許可しない、対話 TUI + TTY では表示時に BEL でベルを鳴らす（失敗してもプロンプト継続、RPC/JSON/print では鳴らさない）、`ApprovalQueue` で並行プロンプトを直列化、UI エラー → declined。`askTimeoutSeconds` が正のとき、表示開始からの期限で選択肢とルール入力の両方を閉じ、期限後の Approve は許可しない。TUI は残り秒数を `Times out in Ns` としてピン留めし、それ以外は `ui.select` / `ui.input` の `timeout` に残ミリ秒を渡す。TUI では `approval-dialog`、それ以外は `ui.select` に振り分ける。コマンドがプレビュー上限で切れた場合のみ省略ヒント `... (truncated, ctrl+o to expand)` を付け、同じ文書の展開版（`expansion`）を TUI にだけ渡す（非 TUI は `… [truncated]` のまま）。 |
| `src/session-rules.ts` | セッション承認ルールの純粋ロジック: メモリ内ストア（追加・編集・削除・全消去、`rule-N` の安定ID）、サニタイズ（制御文字/ANSI 除去・単一行化）、空文字・500字・20件の上限検証、`lowerRiskLevel`（1段階のみ、`very_low` 据え置き）、`applySessionRulePolicy`（一致ルールで `ask`/`deny` を1段階下げて再適用。`allow` は変化なし、下げた先が `deny` なら元の判定と元レベルを維持し、判定を強化しない）。I/O・UI なし。 |
| `src/session-rules-command.ts` | `/ai-approval session-rules` の対話マネージャ: 一覧（ID・本文）、追加（`ui.input`）、編集（`ui.editor` に現在のテキストを prefill）、削除。`ui.select` / `ui.input` / `ui.editor` のみを使い `ui.custom` は使わないため RPC でも動作する。Esc（`undefined`）は常に無変更で戻る。 |
| `src/approval-dialog.ts` | TUI 承認ダイアログ: 最上部にタイトル（theme の `accent` 色）を埋め込んだ全幅の罫線（dashes は `border` 色）を固定表示してセッション表示との境界を示し、渡された Markdown 文書を標準の `Markdown` コンポーネントで描画し（コードブロックの言語ラベルとシンタックスハイライトを含む）、リスク行だけをテーマ色で組み直して強調する。罫線 1 行を高さ計算に含め、端末行数から本文ビューポートを算出してスクロール（`shift+↑↓`・ホイール・一時表示スクロールバー）し、選択肢は本文の外側に固定する。`ui.custom()` が `signal` を受け付けないため abort を自前で購読する。`timeoutMs` があるときは選択肢の上に残り秒数を出し、0 で Esc と同じく declined にする。`expansion` を持つときは `ctrl+o`、または省略マーカー文字列そのものの左クリック（マーカー行でも文字列の外側は無反応。折り返し時は開始行のマーカー位置から終了行のマーカー末尾までが対象）で本文を展開版に差し替え、展開中はヘルプ行に `ctrl+o collapse` を出す（選択中の選択肢とスクロール位置は維持し、ピン留めした選択肢は常に見えたまま）。マウス入力が届くのはフルスクリーン表示のときだけで、通常会話表示では `ctrl+o` のみ。 |
| `src/review-presentation.ts` | 人・ agent 向け文面: `riskLabel`、操作プレビュー、`formatReviewResult`（UI 通知用）、`rejectionReason`（agent 向けブロック理由。回避策禁止の指示付き）。`shellCommandPreview` はシェルコマンドの折りたたみ形（300 文字上限・マーカー無し）と展開形（改行保持・上限無し）を返し、展開できるのはシェルコマンドだけ。 |
| `src/reviewer-status.ts` | `/ai-approval` の status・`rules` 出力、起動時ヘルス同期、フォールバック通知。両方の設定ファイルが存在しない場合の起動時 `/ai-approval init` 案内を含む。 |
| `src/authorization-provenance.ts` | `DirectUserInputTracker` + `collectReviewMessages`: 展開前入力と保存済みユーザーメッセージを突合し、完全一致した対話・RPC のみを `direct_user` とする。 |
| `src/action-reasoning.ts` | `collectActionReasoning`: レビュー対象 ToolCall と直前の ToolCall の間の visible thinking を、上限付きの current action reasoning として取り出す。`thinkingSignature` と redacted 本文は含めない。authorization provenance とは別責務。 |
| `src/directory-scan-cache.ts` | 短命（1 秒、LRU-128）のプロセス内キャッシュ（制限付きディレクトリ走査用）。変更系ツールの実行後は必ずクリアすること。 |
| `src/tool-input-lock.ts` | 承認後 TOCTOU ガード: 承認済み `event.input` を deep-freeze し、凍結不能な入力は `failure`（ブロック）にする。 |

## 6. 設定の優先順位

`loadApprovalConfig({ cwd, projectTrusted, agentDir, env })`:

- モデル・思考量・レビュアー期限（`primaryModel`、`secondaryModel`、`primaryThinkingLevel`、`secondaryThinkingLevel`、`timeoutMs`）:
  環境変数 > 信頼済みプロジェクトファイル > グローバルファイル > 組み込み既定値
  （モデル `CURRENT` = セッションモデルであり、既定値でもある。思考量 `CURRENT` = セッション思考量の継承。思考量の既定値は `low`、current-model チャネルは常にセッション思考量）。
- `askTimeoutSeconds`: 信頼済みプロジェクトファイル > グローバルファイル > 既定値 `null`（期限なし）。`null` と 0 以下は期限なし。不正な値は警告して無視し、次のソースへ落ちる。
- `assessmentLanguage`: 信頼済みプロジェクトファイル > グローバルファイル > 既定値（`auto`）。
- `policy`: 上書きではなく連結 —
  グローバルファイル → 信頼済みプロジェクトファイル → `PI_AI_APPROVAL_POLICY` 環境変数。
- `review` / `riskActions`: グローバルファイルが既定値を上書きし、信頼済み
  プロジェクトファイルは厳格化のみ可能（review 範囲
  `off < private-only < outside-or-private < always`、操作の重大度
  `allow < ask < deny`）。未信頼プロジェクトではプロジェクトファイル全体が無視される。
- `very_high` / `critical` を `allow` にはできない（パーサーが強制変換 + 警告し、
  `risk-policy` が再ガードする）。

不正な entries は警告され（UI + `/ai-approval` status に表示）、無視される。
有効な設定と既定値はそのまま有効であり続ける。

## 7. セキュリティ不変条件（明示的なレビューなしに緩めないこと）

1. **フェイルクローズド**: すべてのエラーパスはブロックする。`decideAction` が実行を
   許可するのは、明示的な `allow` ポリシーヒットか、明示的なユーザーの `Approve`
   （`Approve + Add Rule` を含む）だけである。ルールによる1段階低下で `allow` に
   なった場合もこの1経路である。`deny` が一致ルールで `ask` に変わるのは実行許可では
   なく、実行にはそのプロンプトでの `Approve` が改めて必要になる。ルール入力の
   Esc は選択肢に戻るだけで許可にはならず、
   空文字・上限超過のルールは入力を開いたまま許可しない。ルール入力 UI の失敗は
   declined（ブロック）とし、レビュアーが報告した未知のルールIDは一致なしとして
   通常の `ask` プロンプトに戻す。
   レビュー対象は `bash` / `powershell` のコマンド文字列、`read`/`grep`/`find`/`ls` の
   スコープ、`write`/`edit` の対象、および汎用 `<tool>.path` で決まる
   （`src/tool-actions.ts`）。その他の top-level 文字列 `path` を持つツールは
   `<tool>.path` ルールで追加できる。command のみを持つ未知ツールは未対応（別課題）。
2. **レビュアーは何も決めない**: 唯一の allow/ask/deny 決定権は `risk-policy` とその
   セッションルール適用層にあり、レビュアー出力は `parseRiskAssessment` で検証される
   untrusted データである。`matched_rule_id` も untrusted であり、レビュアーはリスク
   分類を変えられない。ルールで分類を下げられるのは、ローカル層が報告されたIDを
   現存ルールと照合できた場合だけで、カバレッジの判定はレビュアーに依存する
   untrusted な判断である。低下は1段階に限り、下げたレベルは `allow` 禁止ガードを含む
   通常のポリシーで再評価される（`src/session-rules.ts`）。
3. **プライベートデータの封じ込め**: `private_data_read` 付きの操作ではレビュアーは
   ツールなしモードで動作し（`reviewerToolsForAction` → `[]`）、プライベート範囲に
   触れるレビュアーのツール呼び出しは例外化する（`reviewer-tools` のガード）。
4. **来歴の規律**: ユーザー意図を確立するのは `provenance: "direct_user"` の
   トランスクリプト行のみであり、content 内テキストが来歴を作ることはない。
   拡張機能・展開済みコンテンツは `untrusted` のままである。assistant reasoning は
   常に `untrusted` であり、許可の根拠にもリスクを下げる根拠にもならない。
   `thinkingSignature` と redacted reasoning 本文はレビュアーへ送らない。
5. **承認の完全性**: 1 回の `Approve`（第三の選択肢 `Approve + Add Rule` を含む）
   = 1 回のツール呼び出しのみ。追加されたルール自体は何も許可せず、以降の
   レビューでレビュアーが報告した一致IDをローカル層が検証して初めて意味を持つ。
   `ApprovalQueue` が
   プロンプトを直列化し、`Deny` が初期選択、Esc/Ctrl-C/UI 不可/ask タイムアウト = ブロック。ask の期限切れは承認にならない（ルール入力中を含む）。TUI ダイアログはタイトルを罫線に、本文全体を標準 Markdown として描画する（明示的なユーザー判断）。動的値は制御文字/ANSI の除去・単一行化・400 文字上限のみを行い、レビュアー出力に含まれる Markdown の見出し・箇条書き・リンクはそのまま描画されうる点を既知の残存リスクとして扱う。例外はコマンドの省略表示で、300 文字で切れた場合だけ `... (truncated, ctrl+o to expand)` と表示し、`ctrl+o` またはマーカークリックで Operation ブロックを展開版に差し替える。展開版も制御文字/ANSI は除去し（改行だけを残す）、`fencedCode` が値より長いフェンスで囲むため、改行やバッククォートで文書構造を崩せない。文字数の上限は置かない（クリックか `ctrl+o` を押したときだけ描画される表示専用の文字列であり、判定には一切使わない）。展開は表示の切り替えのみで、1 回の `Approve` = 1 回のツール呼び出しは不変。
6. **TOCTOU ロック**: 承認済み入力は `tool-input-lock` で凍結され、ロック失敗は
   ブロックする。
7. **リトライループの遮断**: `DenialCircuitBreaker`（連続 3 回または直近 50 件中 10 回の
   adverse 結果で、そのターンの agent を abort する）。バッチ追跡は並行ツール呼び出しを
   またぐため、分割リトライも集計される。
8. **bypass は TUI 専用・可視・一時的**: `bypass` は対話 TUI のみ、永続警告を表示し、
   モデルコンテキストには一切入らず、セッション再読み込みでリセットされる。
9. **RTK は検出のみ**: `commandContainsRtk` は `event.input.command` に副作用を
   与えず、実行されるコマンド文字列を一切変更しない。プロンプトには実コマンドを
   1回だけ載せ、private 判定は実コマンド中の引数・パスに対して従来どおり行う。
   `rtk` は一律 safe でも read-only でもないため、レビュアーには RTK を含む
   ときだけ `Assess the operation it wraps` と `do not assume low risk` の
   注意書きを付ける。
10. **セッション承認ルールはメモリ内・1段階・判定を強化しない**: ルールはディスクに
    保存されず、`session_start` / `session_shutdown` の `resetRuntime` で消去される
    （`bypass` では消えない）。件数（
    `SESSION_RULE_MAX_COUNT`）と文字数（`SESSION_RULE_MAX_CHARS`）を超える入力は
    拒否し、切り詰めない（内容が変わるため）。低下は1段階のみで、`ask` と `deny` の
    両方に適用されるが、下げた先が `deny` に割り当てられている場合は元の判定と
    元レベルを維持する（判定を厳しくしない）。`critical` の1段階下は `very_high` で、
    そちらは `allow` にできないため、ルールで `critical` が自動 `allow` になることは
    ない。ルール本文は制御文字/ANSI を除去して1行化し、
    プロンプトの節を偽造できない形でのみ埋め込む。ルール集合はレビュアーセッション
    の再利用キーに含め、変更後に古いルールを持つセッションを再利用しない
    （`extensions/index.ts`）。

## 8. 検証

```bash
pnpm install
pnpm check   # = tsc -p tsconfig.json && node --test tests/*.test.ts
```

- `tests/*.test.ts` は `src/` の各モジュール（`gate`、`config`、`review`、
  `risk-policy`、`session-rules`、`session-rules-command`、`reviewer-*`、
  `approval-prompt`、`approval-dialog`、`review-presentation`、
  `authorization-provenance`、`action-reasoning`、`rtk-detection`）に対応し、
  配線用に `extension.test.ts` がある。前者はサニタイズ・上限・ID 安定性・
  1段階低下表（`deny` からの低下を含む）・判定を強化しないこと・未知ID無視を、後者は第三選択肢の
  追加承認・Esc での選択肢復帰・ルール変更時のレビュアー再生成・
  ライフサイクル消去・コマンド動作を検証する。
- `src/policy.ts` のルーブリック、`src/path-rules.ts` のカタログ、
  `src/shell-private-data.ts` のヒューリスティクス、`src/rtk-detection.ts` の
  検出ルール、`src/session-rules.ts` の上限・低下規則、または §7 の不変条件に
  触れたら、対応するテストとこのファイルを更新すること。
