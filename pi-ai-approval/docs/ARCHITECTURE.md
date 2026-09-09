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
  確認 → `reviewAction` → `decideAction` → `lockAllowedToolInput`。
  非許可の結果はすべて `{ block: true, reason }` を返す。
- `tool_execution_end` → 変更系ツールの実行後に `DirectoryScanCache` をクリアし、
  バッチ単位のサーキットブレーカー集計を締める。
- `session_start` / `session_shutdown` / `before_agent_start` / `message_start`
  / `input` → 実行時状態のリセットと直接ユーザー入力の来歴追跡。
- `pi.registerCommand("ai-approval")` → status / `rules` / `init` / `bypass` /
  `enable`（詳細は `src/reviewer-status.ts`）。

テスト・利用者向けの再エクスポート: `risk-policy`、`reviewer-channels`、
`tool-actions`、`tool-input-lock` の各ヘルパー。

## 4. リクエストフロー

```text
tool_call イベント
  ↓ actionFromToolCall(event, cwd, review rules, cache)   [src/tool-actions.ts]
  │  undefined = 審査対象外 → そのまま返す（審査なし）
  ↓ ReviewAction { tool, payload, cwd }
  ↓ DenialCircuitBreaker.isOpen()? → { block, "circuit-open" }
  ↓ reviewAction: buildReviewerChannels → runReviewWithFallbackChain
  │    primary → secondary → current-model（モデル同一性で重複排除）
  │    各試行: ReviewerSessionController.review(action, messages)
  │    failure/timeout → 次チャネルへ; cancel → フォールバックせずフェイルクローズド
  ↓ ReviewResult: assessed | allowed | user-approved | user-declined |
  │               denied | timeout | failure | cancelled | circuit-open
  ↓ decideAction: applyRiskPolicy(assessment, riskActions)
  │    allow → allowed（実行）· deny → denied（ブロック）
  │    ask → ApprovalQueue.runExclusive(showApprovalPrompt) → user-approved / user-declined
  │    assessed 以外の結果はそのまま通過
  ↓ lockAllowedToolInput(event, result): 承認済み入力を deep-freeze; 失敗 → ブロック
  ↓ allowed/user-approved → 実行（+ info 通知）; それ以外はブロック + rejectionReason
```

トランスクリプトの扱い: `src/authorization-provenance.ts` の
`collectReviewMessages(branch)` は、対話・RPC 入力と相関が取れたものだけを
`direct_user` とし、それ以外はレビュアー向けの `untrusted` な証拠として残す。
`src/review.ts` はサイズ制限付きの JSON-lines トランスクリプトを構築する
（最新 + 先頭のユーザーメッセージを優先し、次に直近の非ユーザー entries）。

## 5. モジュールの責務

| モジュール | 役割 |
| --- | --- |
| `src/config.ts` | 設定スキーマ、既定値、ファイル・環境変数の読み込み、優先順位、厳格化のみのマージ、警告。`riskActions`、`review` ルール、`primaryModel` / `secondaryModel`（`CURRENT` = セッションモデル）、`primaryThinkingLevel` / `secondaryThinkingLevel`（思考量または `CURRENT` = セッション継承、既定 `low`）、`timeoutMs`、`assessmentLanguage`、`policy`。 |
| `src/tool-actions.ts` | `tool_call` → `ReviewAction \| undefined`。`bash.command`、`read/grep/find/ls.path`、`write/edit.path`、および汎用 `<tool>.path`（既定 `private-only`）を振り分ける。`private_data_read` を付与。 |
| `src/gate.ts` | ゲート共通基盤: `ReviewResult`・決定型、`DenialCircuitBreaker`、`ReviewBatchTracker`、パス分類（`classifyMutationPath`、`classifyReadPath`、`shouldReviewPath`）、ディレクトリのプライベートデータ走査。 |
| `src/path-rules.ts` | プライベート読み取り・センシティブ変更ルールの監査可能なリテラルカタログ（認証系ベース名、プライベートセグメント、サフィックス、Pi データパス）。I/O なし。 |
| `src/shell-private-data.ts` | `bash.command` 用ヒューリスティクス: シェルをトークン化し `~` を展開、リテラルパス・glob を `path-rules` カタログに `classifyReadPath` で照合。 |
| `src/review.ts` | レビュアー契約: `RiskLevel`、`RiskAssessment`、文字数制限付きのプロンプト・トランスクリプト構築、`parseRiskAssessment`（未知レベル・要約/根拠欠落を拒否する厳密検証）。 |
| `src/policy.ts` | レビュアーのシステムプロンプト（Codex Guardian 由来。`UPSTREAM_GUARDIAN_COMMIT` 参照）。レビュアーが適用すべき 6 段階ルーブリックを定義。明示依頼の通常ローカル commit は `low`、履歴書き換え系は `medium` 以上に据え置く。 |
| `src/reviewer-session.ts` | 隔離されたレビュアー用エージェントセッション（`ReviewerSessionController`）: 直列キュー、full/delta カーソルによるセッション再利用、試行ごとの期限、最大 3 試行、リトライ可能失敗のみ再試行、破棄。チャンネルごとの `thinkingLevel` で生成する。レビュアーには読み取り専用 `read/grep/find/ls` ツール群か無しを与える。 |
| `src/reviewer-channels.ts` | `primary → secondary → current-model` 連鎖: モデル同一性で重複排除（思考量は同一性に含めない）、`CURRENT` 思考量の解決（`resolveReviewerThinkingLevel`。セッション値がなければ `low`）、`reviewerHealth`、`shouldFallbackReview`（failure/timeout のみ）、`runReviewWithFallbackChain`。current-model チャネルは常にセッション思考量を使う。 |
| `src/reviewer-tools.ts` | レビュアー側ツールのサンドボックス: プライベート範囲に触れる調査は漏洩させる代わりに例外化するガード付き読み取り専用ツール定義。 |
| `src/risk-policy.ts` | 純粋な `assessment → allow/ask/deny` 変換（`resolveRiskAction` / `applyRiskPolicy`）。手作り設定で迂回されても `very_high` / `critical` の `allow` を拒否。I/O・UI なし。 |
| `src/approval-prompt.ts` | `ask` の UX: `No/Yes` 選択肢で `No` が初期選択（Enter = ブロック）、対話 TUI + TTY では表示時に BEL でベルを鳴らす（失敗してもプロンプト継続、RPC/JSON/print では鳴らさない）、`ApprovalQueue` で並行プロンプトを直列化、UI エラー → declined。 |
| `src/review-presentation.ts` | 人・ agent 向け文面: `riskLabel`、操作プレビュー、`formatReviewResult`（UI 通知用）、`rejectionReason`（agent 向けブロック理由。回避策禁止の指示付き）。 |
| `src/reviewer-status.ts` | `/ai-approval` の status・`rules` 出力、起動時ヘルス同期、フォールバック通知。両方の設定ファイルが存在しない場合の起動時 `/ai-approval init` 案内を含む。 |
| `src/authorization-provenance.ts` | `DirectUserInputTracker` + `collectReviewMessages`: 展開前入力と保存済みユーザーメッセージを突合し、完全一致した対話・RPC のみを `direct_user` とする。 |
| `src/directory-scan-cache.ts` | 短命（1 秒、LRU-128）のプロセス内キャッシュ（制限付きディレクトリ走査用）。変更系ツールの実行後は必ずクリアすること。 |
| `src/tool-input-lock.ts` | 承認後 TOCTOU ガード: 承認済み `event.input` を deep-freeze し、凍結不能な入力は `failure`（ブロック）にする。 |

## 6. 設定の優先順位

`loadApprovalConfig({ cwd, projectTrusted, agentDir, env })`:

- モデル・思考量・タイムアウト（`primaryModel`、`secondaryModel`、`primaryThinkingLevel`、`secondaryThinkingLevel`、`timeoutMs`）:
  環境変数 > 信頼済みプロジェクトファイル > グローバルファイル > 組み込み既定値
  （モデル `CURRENT` = セッションモデルであり、既定値でもある。思考量 `CURRENT` = セッション思考量の継承。思考量の既定値は `low`、current-model チャネルは常にセッション思考量）。
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

1. **フェイルクローズド**: すべてのエラーパスはブロックする。`decideAction` が許可するのは、
   明示的な `allow` ポリシーヒットか明示的なユーザーの `Yes` のみ。
2. **レビュアーは何も決めない**: 唯一の allow/ask/deny 決定権は `risk-policy` であり、
   レビュアー出力は `parseRiskAssessment` で検証される untrusted データである。
3. **プライベートデータの封じ込め**: `private_data_read` 付きの操作ではレビュアーは
   ツールなしモードで動作し（`reviewerToolsForAction` → `[]`）、プライベート範囲に
   触れるレビュアーのツール呼び出しは例外化する（`reviewer-tools` のガード）。
4. **来歴の規律**: ユーザー意図を確立するのは `provenance: "direct_user"` の
   トランスクリプト行のみであり、content 内テキストが来歴を作ることはない。
   拡張機能・展開済みコンテンツは `untrusted` のままである。
5. **承認の完全性**: 1 回の `Yes` = 1 回のツール呼び出しのみ。`ApprovalQueue` が
   プロンプトを直列化し、`No` が初期選択、Esc/Ctrl-C/UI 不可 = ブロック。
6. **TOCTOU ロック**: 承認済み入力は `tool-input-lock` で凍結され、ロック失敗は
   ブロックする。
7. **リトライループの遮断**: `DenialCircuitBreaker`（連続 3 回または直近 50 件中 10 回の
   adverse 結果で、そのターンの agent を abort する）。バッチ追跡は並行ツール呼び出しを
   またぐため、分割リトライも集計される。
8. **bypass は TUI 専用・可視・一時的**: `bypass` は対話 TUI のみ、永続警告を表示し、
   モデルコンテキストには一切入らず、セッション再読み込みでリセットされる。

## 8. 検証

```bash
pnpm install
pnpm check   # = tsc -p tsconfig.json && node --test tests/*.test.ts
```

- `tests/*.test.ts` は `src/` の各モジュール（`gate`、`config`、`review`、
  `risk-policy`、`reviewer-*`、`approval-prompt`、`authorization-provenance`）に対応し、
  配線用に `extension.test.ts` がある。
- `src/policy.ts` のルーブリック、`src/path-rules.ts` のカタログ、
  `src/shell-private-data.ts` のヒューリスティクス、または §7 の不変条件に触れたら、
  対応するテストとこのファイルを更新すること。
