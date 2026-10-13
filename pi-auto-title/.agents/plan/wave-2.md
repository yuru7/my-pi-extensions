# ExecPlan: pi-auto-title — Stall Detection

## 1. Purpose

Pi Coding Agentの拡張機能 `pi-auto-title` に、ツール実行中の停滞検出機能を追加する。

ツールが一定時間進捗イベントを発行しない場合、タブタイトルの先頭に停滞状態を示すアイコンを表示する。

目的は、複数のPiセッションを並列実行しているときに、ユーザーの操作待ちや外部応答待ちなど、長時間処理が進んでいない可能性のあるセッションを発見しやすくすること。

本機能はユーザー入力待ちの厳密な判定ではなく、ツール実行中の無更新時間に基づく停滞推定である。

標準ツール、拡張ツール、カスタムツールを区別せず、すべてのツールを監視対象とする。

既存のAIタイトル自動生成機能、モデルフォールバック、セッション管理、設定初期化コマンドは維持する。

## 2. Progress

- [x] 現行実装とPi拡張APIの確認
- [x] 設定スキーマの拡張
- [x] ツール別進捗監視の実装
- [x] 停滞判定タイマーの実装
- [x] タイトル表示の3状態対応
- [x] 並列ツール実行への対応
- [x] セッション切り替え・中断処理への対応
- [x] 単体テスト・統合テスト
- [x] README更新
- [ ] 実機検証 (Windows Terminal + WSL、未実施。下記 §17 参照)

## 3. Configuration

設定ファイル：

    ~/.pi/agent/pi-auto-title.json

デフォルト設定：

```json
{
  "autoTitle": {
    "enabled": true,
    "model": "CURRENT",
    "thinkingLevel": "CURRENT",
    "fallbackToCurrentModel": true
  },
  "statusIndicator": {
    "enabled": true,
    "running": "⏳",
    "idle": "✅",
    "stalled": "⏸️",
    "stallDetection": {
      "enabled": true,
      "thresholdSeconds": 30
    }
  }
}
```

### 3.1 新規設定項目

`statusIndicator.stalled`

- 型：string
- 初期値：`⏸️`
- 停滞状態で表示する文字列
- 任意のUnicode文字列を使用可能
- 空文字列も許可する

`statusIndicator.stallDetection.enabled`

- 型：boolean
- 初期値：true
- falseの場合は停滞監視を行わない
- 無効時は従来どおりrunning/idleの2状態のみ

`statusIndicator.stallDetection.thresholdSeconds`

- 型：number
- 初期値：30
- 1以上の有限数値を許可
- 最後の進捗イベントから停滞判定までの秒数
- 0、負数、NaN、Infinityは不正値とする

### 3.2 既存設定との互換性

既存設定ファイルに新項目が存在しない場合は、デフォルト値を補完する。

既存の設定ファイルを書き換えない。

設定ファイルが存在しない場合も、内部デフォルト値で正常動作する。

初回起動時にはファイルを作成しない。

`/auto-title init` で出力するデフォルト設定には、新しい項目を含める。

既存ファイルがある場合の上書き確認動作は維持する。

## 4. Status Model

管理する状態は次の3種類とする。

```typescript
type AgentStatus =
  | "idle"
  | "running"
  | "stalled";
```

### 4.1 idle

エージェントが処理を完了し、待機している状態。

表示例：

    ✅ Pi - API実装

### 4.2 running

エージェントが実行中で、停滞条件を満たすツールが存在しない状態。

表示例：

    ⏳ Pi - API実装

ツールを実行していないモデル推論中もrunningとする。

### 4.3 stalled

エージェントが実行中であり、監視対象ツールの少なくとも1つが停滞条件を満たしている状態。

表示例：

    ⏸️ Pi - API実装

stalledは処理の停止を保証するものではない。

長時間ビルド、ネットワーク待機、ユーザー入力待ちなど、無更新状態が続くすべてのケースを含む。

### 4.4 状態の優先順位

以下の優先順位を採用する。

    stalled > running > idle

ただし、エージェントの実行状態を最優先の前提とする。

- エージェントが完了・待機中ならidle
- エージェントが実行中で停滞ツールがあればstalled
- それ以外の実行中はrunning

複数ツールのうち1つでも停滞していればstalledとする。

## 5. Stall Detection

### 5.1 使用するイベント

以下のPi拡張イベントを利用する。

```typescript
pi.on("tool_execution_start", ...);
pi.on("tool_execution_update", ...);
pi.on("tool_execution_end", ...);
```

各イベントは `toolCallId` によって関連付ける。

全ツールを対象とし、標準ツールかどうかの判定は行わない。

### 5.2 監視データ

ツールごとに以下の情報を保持する。

```typescript
interface ToolWatch {
  toolCallId: string;
  toolName: string;
  lastActivityAt: number;
  stalled: boolean;
  generation: number;
}
```

監視対象はMapで管理する。

```typescript
const activeTools = new Map<string, ToolWatch>();
```

`generation` はセッション切り替え、リロード、非同期処理の競合を防止するための識別子とする。

時刻の測定には、可能な限り単調増加時計を使用する。

### 5.3 tool_execution_start

イベントを受信したら以下を実行する。

1. toolCallIdを取得する。
2. 監視対象に登録する。
3. lastActivityAtを現在時刻に設定する。
4. stalledをfalseに設定する。
5. 監視タイマーを開始・再スケジュールする。

このイベントの時刻を無更新監視の起点とする。

ただしPiの並列実行モードでは、tool_execution_startが実際のツール本体実行より前のpreflight段階で発火する場合がある。

そのため、preflightや承認フックでの待機も無更新時間に含まれる可能性がある。

この挙動は今回の目的に対して許容する。

### 5.4 tool_execution_update

イベントを受信したら以下を実行する。

1. toolCallIdから監視対象を取得する。
2. lastActivityAtを現在時刻に更新する。
3. stalledをfalseに戻す。
4. 次の停滞判定時刻を再計算する。
5. 全体の表示状態を再評価する。

今回の初期実装では、updateイベントの受信自体を進捗の証拠として扱う。

partialResultの内容比較は行わない。

同じ内容のupdateが繰り返された場合でもタイマーをリセットする。

ただし、将来的な検出精度向上のため、進捗イベントの発生頻度や性質は調査結果として記録する。

### 5.5 tool_execution_end

イベントを受信したら以下を実行する。

1. toolCallIdから監視対象を取得する。
2. 対象をactiveToolsから削除する。
3. 残存ツールの状態を確認する。
4. 全体の表示状態を再評価する。
5. 監視対象がなくなった場合はタイマーを停止する。

ツールが正常終了したかエラー終了したかによって、stalledの解除挙動を変えない。

他に停滞したツールがある場合はstalledを維持する。

すべてのツールが終了しても、エージェントが処理中であればrunningを維持する。

エージェントの最終完了判定は既存のライフサイクル管理に従う。

## 6. Stall Threshold

### 6.1 判定条件

次の条件をすべて満たした場合に停滞と判定する。

1. エージェントが実行中である。
2. ツールがactiveToolsに登録されている。
3. `now - lastActivityAt >= thresholdSeconds * 1000` を満たす。
4. 対象ツールが終了していない。

判定後、該当ツールのstalledをtrueにする。

### 6.2 タイムライン例

閾値が30秒の場合：

    00秒 tool_execution_start
         lastActivityAt = 00秒

    20秒 tool_execution_update
         lastActivityAt = 20秒

    49秒 更新なし
         runningを維持

    50秒 更新なし30秒到達
         stalledへ変更

    65秒 tool_execution_update
         runningへ戻す
         lastActivityAt = 65秒

    95秒 再び更新なし30秒
         stalledへ変更

    110秒 tool_execution_end
          停滞監視から除外

### 6.3 ツールごとの独立判定

並列実行されるツールは、各toolCallId単位で独立して経過時間を計算する。

例：

    Tool A: 最終更新から35秒 → stalled
    Tool B: 最終更新から10秒 → running

この場合、全体の表示はstalledとする。

Tool Aが終了した場合、Tool Bが停滞していなければrunningに戻す。

### 6.4 監視対象がない場合

モデル推論中など、実行中のツールが存在しない場合は停滞判定しない。

モデル推論が長時間続いた場合もrunningのままとする。

今回の停滞監視はツール実行期間だけを対象にする。

## 7. Timer Management

### 7.1 実装方式

監視はNode.jsのタイマーを使用する。

固定間隔で常時ポーリングする方式ではなく、次に停滞条件を満たす時刻に合わせた単発タイマー方式を優先する。

監視対象がない場合はタイマーを作成しない。

### 7.2 次の判定時刻

停滞していない各ツールについて、以下を計算する。

    deadline =
      lastActivityAt + thresholdMilliseconds

最も近いdeadlineにタイマーを設定する。

タイマー発火時には、すべてのactiveToolsの状態を再評価する。

判定後、必要に応じて次のタイマーを設定する。

すでにstalledになったツールについては、更新または終了イベントが届くまで繰り返しタイマーを設定しない。

### 7.3 タイマーの解放

以下の場合はタイマーを確実に解除する。

- 監視対象ツールがすべて終了した
- エージェントの処理が終了した
- セッションが切り替わった
- 拡張機能がリロードされた
- 停滞検出が無効になった
- 拡張機能の終了処理が行われた場合

タイマー解放後に古いコールバックが実行されても、現在のタイトルを変更できないようにgenerationで保護する。

プロセス終了や拡張のリロードによるクリーンアップについては、Piの公開ライフサイクルAPIと実際の挙動を確認し、利用可能な方法で実装する。

## 8. Title Rendering

タイトル表示は既存の共通関数を拡張する。

```typescript
function formatTitle(
  status: AgentStatus,
  title: string,
  config: Config
): string;
```

出力例：

    running → ⏳ Pi - API実装
    stalled → ⏸️ Pi - API実装
    idle    → ✅ Pi - API実装

`statusIndicator.enabled = false` の場合：

    Pi - API実装

`stallDetection.enabled = false` の場合は、stalled状態を使用しない。

ステータス文字列とAIタイトルは独立して管理する。

AIタイトル生成完了時には、現在の状態を維持したままタイトル部分のみ更新する。

タイトル文字列が変化しない場合はsetTitleを実行しない。

## 9. Session Lifecycle

### 9.1 セッション開始

- 設定を読み込む。
- タイトルを復元する。
- 監視対象を初期化する。
- 実行状態を確認してタイトルを設定する。

### 9.2 エージェント開始

- runningに変更する。
- 前回実行の監視データが残っていれば破棄する。
- 新しい実行の監視を開始する。

### 9.3 エージェント完了

- idleに変更する。
- activeToolsをクリアする。
- 監視タイマーを解除する。

完了判定は導入済みPiのイベント仕様に合わせる。

`agent_settled` が利用可能なら優先するが、存在しないバージョンでは適切な完了判定に置き換える。

### 9.4 中断・エラー

ユーザーによる中断、ツールエラー、セッション切り替え時に監視情報を適切に破棄する。

中断後もstalledアイコンが残り続けないようにする。

中断と実行完了を区別できる場合は、実際のアイドル状態を確認して更新する。

### 9.5 非同期競合

AIタイトル生成、ツール監視、セッション切り替えが並列に発生しても、古いイベントで新しいセッションのタイトルを上書きしない。

セッション世代IDを利用して監視データとタイマーを分離する。

## 10. Integration with Existing Features

### 10.1 AIタイトル生成

既存のAIタイトル生成機能は維持する。

- 生成モデルの指定
- CURRENT指定
- 思考量指定
- CURRENT思考量
- モデルフォールバック
- フォールバック通知
- 最大30文字
- セッション単位のタイトル保存

停滞監視はAIタイトル生成処理を監視対象に含めない。

監視するのはPi本体のtool_executionイベントとして報告されるツール実行のみ。

### 10.2 設定初期化

`/auto-title init` による生成・リセットを維持する。

新しい停滞検出設定も初期化対象に含める。

初期化後は新設定を実行中の拡張へ適用する。

### 10.3 既存利用者への影響

既存の設定ファイルやタイトル履歴を維持する。

新規項目が存在しない場合はデフォルト値を使用する。

設定ファイルの自動書き換えは行わない。

## 11. Implementation Structure

既存コードの責務分離に合わせて実装する。

推奨構成：

    pi-auto-title/
      index.ts
      config.ts
      title.ts
      generator.ts
      model.ts
      session.ts
      stall-monitor.ts
      tests/
        config.test.ts
        title.test.ts
        stall-monitor.test.ts
        integration.test.ts
      README.md

`stall-monitor.ts` に監視ロジックを集約する。

タイマー処理、ツール管理、停滞判定を独立して単体テストできるようにする。

Piのイベントハンドラは薄く保つ。

時計とタイマーはテスト時に差し替え可能な構造にする。

過度な抽象化や不要な外部ライブラリの導入は避ける。

## 12. Testing

### 12.1 基本動作

- ツール開始時に監視登録される。
- 閾値未満ではrunningを維持する。
- 閾値到達時にstalledになる。
- updateで閾値のカウントがリセットされる。
- stalled中のupdateでrunningに戻る。
- endで監視対象から除外される。
- 監視対象がなくなるとタイマーが解除される。

### 12.2 ツール種別

- bashが監視対象になる。
- readが監視対象になる。
- write/editが監視対象になる。
- 拡張ツールが監視対象になる。
- ツール名に依存せず監視される。
- 進捗イベントを出さないツールでも検出される。

### 12.3 並列実行

- 複数ツールを同時に監視できる。
- toolCallIdごとに独立した時刻を保持する。
- 1つがstalledになれば全体がstalledになる。
- 停滞中のツール終了時に残りの状態が正しく反映される。
- 別ツールのupdateで停滞状態が誤って解除されない。
- イベント到着順が交錯しても監視情報が破綻しない。

### 12.4 タイマー

- 指定された閾値で判定する。
- タイマーが重複登録されない。
- 無監視状態でタイマーが残らない。
- セッション切り替えでタイマーが解除される。
- 古いタイマーから現在のセッションが更新されない。
- 実時間で待機せず、偽時計で境界値を検証できる。

### 12.5 設定

- デフォルト値が適用される。
- 閾値を変更できる。
- stallDetectionを無効化できる。
- statusIndicator全体を無効化できる。
- stalled文字列を変更できる。
- 不正な閾値を検出できる。
- 既存設定ファイルとの互換性を維持する。
- `/auto-title init` で新項目を出力する。

### 12.6 ライフサイクル

- エージェント完了後はidleになる。
- 中断後にstalledが残らない。
- 新規セッションで状態がリセットされる。
- セッション再開時に前回のタイマーが残らない。
- AIタイトル更新でステータスが変化しない。
- 非TUIモードで不要なUI操作をしない。

### 12.7 実機検証

Windows Terminal + WSL環境で確認する。

検証ケース：

1. 通常の短時間ツール実行
2. 30秒を超える無出力コマンド
3. 途中で定期的に出力するコマンド
4. ユーザー入力を待機するカスタムツール
5. 並列ツール実行
6. ツール実行中の処理中断
7. 複数のPiセッションでの同時実行

タイムラインとタイトルの変化を確認する。

## 13. Milestones

### Milestone 1 — Investigation

- Piの導入済みバージョンを確認する。
- ツール実行イベントの挙動を確認する。
- 並列実行時の発火順序を確認する。
- 終了・中断・セッション変更時のイベントを確認する。

### Milestone 2 — Stall Monitor

- ツール管理Mapを実装する。
- 最終更新時刻の記録を実装する。
- 閾値による停滞判定を実装する。
- タイマー管理と解除処理を実装する。

### Milestone 3 — Title Integration

- stalled状態を追加する。
- タイトル描画関数を拡張する。
- 既存のAIタイトル生成機能と統合する。
- 状態切り替え時の重複更新を抑制する。

### Milestone 4 — Configuration

- 設定スキーマを拡張する。
- デフォルト値補完を実装する。
- `/auto-title init` を更新する。

### Milestone 5 — Verification

- 単体テストを実施する。
- 並列実行と非同期競合を検証する。
- Windows Terminal + WSLで動作確認する。
- READMEを更新する。

## 14. Acceptance Criteria

以下をすべて満たすこと。

1. 標準ツールと拡張ツールの両方を監視できる。
2. ツールごとに無更新時間を独立して測定する。
3. 設定した閾値を超えるとstalledになる。
4. ツールの進捗更新でrunningへ戻る。
5. ツール終了時に監視対象を解除する。
6. 並列ツールで状態判定が正しく行われる。
7. エージェント完了時にはidleへ戻る。
8. 監視タイマーのリークがない。
9. 停滞検出を設定で無効化できる。
10. 停滞表示文字を設定で変更できる。
11. 既存設定ファイルと互換性がある。
12. AIタイトル生成機能が従来どおり動作する。
13. `/auto-title init` が新設定を出力する。
14. 既存のPi本体の動作を阻害しない。
15. 単体テストと実機検証が成功する。

## 15. Non-Goals

以下は今回の実装対象外とする。

- ユーザー入力待ちかどうかの厳密な判定
- OSプロセスのCPU・メモリ・I/O監視
- 標準ツールの除外機能
- ツール名別の監視閾値
- ツール実行の自動キャンセル
- 停滞時のデスクトップ通知
- 停滞したツールの自動再実行
- モデル推論中の停滞検出
- 停滞原因のAI分析
- 停滞履歴の永続化

## 16. Decision Log

- すべてのツールを監視する。
- 無更新時間を基準に停滞を推定する。
- 初期閾値は30秒とする。
- 閾値は設定ファイルから変更可能とする。
- 停滞表示の初期値は `⏸️` とする。
- 少なくとも1つのツールが停滞していればstalledを表示する。
- 進捗updateを受信したら、該当ツールのタイマーをリセットする。
- 同じ内容のupdateも進捗として扱う。
- 監視対象がない場合はタイマーを動かさない。
- 既存のAIタイトル生成や設定仕様は維持する。
- 誤検出よりもシンプルな実装と汎用性を優先する。

## 17. Outcomes & Retrospective

実装結果 (2026-10-13 時点、実機検証を除く):

- 使用したPiのバージョン: `@earendil-works/pi-coding-agent` 1.1.0
- 採用したイベント: `tool_execution_start` / `tool_execution_update` / `tool_execution_end` (`toolCallId` で関連付け)。完了判定は既存実装と同様に `agent_settled` を使用。監視の破棄は `agent_start`・`agent_settled`・`session_start`・`session_tree`・`session_shutdown` で行う。ソース確認済み: ツールイベントは agent-session.js の `_emitExtensionEvent` がエージェントループ内で発火し、`agent_settled` は中断を含む各実行の終了時に必ず発火する (`_emitAgentSettled`)。セッション切替・fork・リロードでは extension runner が無効化され `session_start` が再発行される (agent-session.js の `invalidate` と reload 経路)。並列実行時の発火順序の実測は未確認のため、ハンドラ側で `agentRunning`・`disposed`・セッションID を確認し、実行待機中や終了後の遅延イベントは無視する構造にした。それでも保証できない競合は実機検証に譲る
- 実装ファイル:
  - `src/stall-monitor.ts` (新規): 監視Map・単発タイマー (次に到来する期限に1本だけ設定し、変化のたびに張り直し、世代番号で古いコールバックを無効化)・しきい値判定。時計とタイマーは注入可能
  - `src/config.ts`: `statusIndicator.stalled`・`statusIndicator.stallDetection` を追加。既存設定ファイルとの互換性を維持 (未指定はデフォルト補完、ファイルは書き換えない)
  - `src/title.ts`: `TitleStatus` に `"stalled"` を追加、`formatTitle` に stalled マーカーを追加
  - `extensions/index.ts`: ツールイベントのハンドラは薄く、監視は `StallMonitor` に集約。表示状態は `agentRunning` と `monitor.stalled` から導出し、遷移漏れでマーカーが残らない構造にした。`/auto-title init` 後は `monitor.refresh()` で新しいしきい値で再評価
  - テスト: `tests/stall-monitor.test.ts` (新規)、`tests/config.test.ts`・`tests/title.test.ts`・`tests/integration.test.ts` に停滞検出の項目を追加。偽時計 `tests/helpers.ts` `createStallClock`
- テスト結果: 164件すべて合格 (`pnpm run check`: typecheck + biome lint + node:test)
- 停滞判定の実測挙動: 未実施 (実機検証はこの環境では未実施。§12.7 を参照)
- 誤検出が発生したケース: 未確認 (実機検証に譲る)
- 残存する制約:
  - `tool_execution_start` は preflight/承認待ちでも発火するため、その待ち時間も無更新時間に含まれる (計画 §5.3 で許容)
  - update の内容は比較せず、受信自体を進捗として扱う (計画 §5.4 どおり)
  - モデル推論中は監視対象外 (計画 §6.4 どおり)
  - 実機検証 (Windows Terminal + WSL、§12.7 の7ケース) は未実施
- 今後の改善候補: partialResult の内容比較による誤検出抑制、ツール別の監視しきい値、停滞時の通知
