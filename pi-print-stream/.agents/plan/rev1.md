# ExecPlan: Pi 非インタラクティブ実行のリアルタイム表示改善

## 1. 目的

`pi -p` 相当の非インタラクティブ実行において、エージェントの進行状況をリアルタイムに確認できる、見やすいストリーミング表示機能を実装する。

既存の `pi-print-stream` の実装方針を参考にし、Pi の `--mode json` が出力する JSONL イベントを逐次処理する。

表示は以下の3種類に分ける。

1. 通常回答

   * リアルタイムで stdout に出力する
   * ターミナルのスクロールバックに残す

2. ツールコール

   * 実行開始・終了を JSONL 形式で随時 stdout に出力する
   * スクロールバックに残す

3. Thinking

   * TTY 上では画面下部付近に最大8画面行だけ一時表示する
   * 内容が増えた場合は古い上側の内容を捨て、最新部分のみ表示する
   * Thinking はスクロールバックに残さない
   * stdout が TTY でない場合は一切出力しない

実行終了時には、トークン使用量・経過時間・TPS をサマリ表示する。

---

## 2. 利用イメージ

例:

```bash
pi -p --stream "このリポジトリをレビューして"
```

実行中:

```text
{"type":"tool_start","id":"tool_1","name":"read","args":{"path":"src/index.ts"}}
{"type":"tool_end","id":"tool_1","name":"read","status":"success","elapsed_ms":42}

この実装では、まずイベントハンドラを確認します。

次に、ストリーミング処理を確認すると……

────────────────────────────────────────
Thinking
  Need inspect how message events are emitted.
  Tool execution should remain persistent.
  Thinking should be transient.
  Need track terminal width.
  message_end probably contains usage.
  Need aggregate across multiple responses.
  Handle resize later if necessary.
  Implement simple renderer abstraction.
────────────────────────────────────────
```

Thinking が増えた場合は常に最新8画面行のみを表示する。

実行完了時:

```text
────────────────────────────────────────
Done

Tokens
  Input        12,481
  Cache read   48,220
  Output        3,842
  Cache write       0

Elapsed        24.8s
Generation     11.6s
TPS            331.2 tok/s
────────────────────────────────────────
```

---

# 3. 基本方針

## 3.1 Pi の JSON モードを利用する

Pi 本体のエージェント実行ロジックは再実装しない。

内部的には以下を実行する。

```bash
pi --mode json -p "..."
```

stdout に流れる JSONL を1行ずつ読み、イベントごとに表示処理へ渡す。

参考実装:

* `robobryce/pi-print-stream`

イベント取得方式については既存実装を可能な限り踏襲する。

---

# 4. アーキテクチャ

処理を以下の責務に分離する。

```text
Pi child process
      │
      │ JSONL
      ▼
Event parser
      │
      ├─ text_delta
      │      │
      │      ▼
      │  Persistent output
      │
      ├─ tool_execution_start
      │      │
      │      ▼
      │  Tool JSON output
      │
      ├─ tool_execution_end
      │      │
      │      ▼
      │  Tool JSON output
      │
      ├─ thinking_delta
      │      │
      │      ▼
      │  Thinking buffer
      │      │
      │      ▼
      │  Transient renderer
      │
      └─ message_end
             │
             ▼
          Usage stats
             │
             ▼
         Final summary
```

想定ファイル構成:

```text
src/
├── extension.ts
├── child.ts
├── events.ts
├── renderer.ts
├── thinking-view.ts
├── stats.ts
└── terminal.ts
```

規模が小さい場合は統合してもよいが、以下の責務は論理的に分離する。

* Pi 子プロセス管理
* JSON イベントパース
* 永続出力
* Thinking 一時表示
* 使用量集計
* ターミナル制御

---

# 5. 出力モデル

出力を2種類に分ける。

## Persistent output

ターミナルのスクロールバックに残す出力。

対象:

* assistant の `text_delta`
* `tool_execution_start`
* `tool_execution_end`
* エラー
* 最終サマリ

## Transient output

画面上には表示するが、スクロールバックには残さない。

対象:

* `thinking_delta`

Transient output は stdout が TTY の場合のみ有効とする。

---

# 6. TTY 判定

起動時に以下を確認する。

```ts
const isTTY = process.stdout.isTTY === true;
```

## TTY の場合

以下をすべて表示する。

* 通常回答
* ツールイベント
* Thinking
* 最終サマリ

Thinking は transient 表示とする。

## TTY でない場合

例えば以下。

```bash
pi -p --stream "..." > result.txt
```

```bash
pi -p --stream "..." | jq ...
```

```bash
pi -p --stream "..." | tee result.log
```

この場合は以下のみ出力する。

* 通常回答
* ツールイベント
* 最終サマリ

Thinking は完全に破棄する。

ANSI 制御シーケンスも出力しない。

---

# 7. Thinking 表示

## 要件

Thinking は内容が長くなりやすいため、通常の stdout へ出力しない。

TTY の画面下部付近に一時表示する。

最大表示量は:

```text
8画面行
```

とする。

単なる改行ベースの8行ではなく、ターミナル幅による折り返しを含めた「実際の表示行数」で制限する。

---

# 8. ThinkingBuffer

Thinking は delta 単位で到着するため、内部では連結したテキストとして保持する。

例:

```ts
class ThinkingBuffer {
  private text = "";

  append(delta: string) {
    this.text += delta;
  }

  clear() {
    this.text = "";
  }

  getVisibleLines(columns: number, maxLines = 8): string[] {
    // terminal width を考慮して表示行へ変換
    // 最後の maxLines 行のみ返す
  }
}
```

ただし、無制限に Thinking 全文をメモリ保持する必要はない。

一定サイズを超えた場合は古い部分を削除してよい。

例:

```text
最大 32 KiB〜128 KiB 程度
```

実際の制限値は実装時に決定する。

表示には常に最新部分のみ必要である。

---

# 9. 画面幅の扱い

ターミナル幅:

```ts
process.stdout.columns
```

を使用する。

文字列幅については、以下のようなケースを正しく扱う必要がある。

* 日本語
* 全角文字
* 絵文字
* ANSI エスケープシーケンス

単純な `string.length` は使用しない。

必要に応じて `string-width` 等を使用する。

例:

```ts
import stringWidth from "string-width";
```

表示幅を計算しながら論理行を terminal width ごとの画面行へ分割する。

---

# 10. Thinking の描画方式

スクロール領域そのものを分割する方法は採用しない。

`DECSTBM` 等を利用すると、ターミナル実装によってスクロールバックの扱いが不安定になる可能性があるため。

代わりに、現在表示中の Thinking 行数を記録し、ANSI / Node.js readline API を使って上書きする。

基本処理:

```text
Thinking 更新
    ↓
現在の transient 領域を消去
    ↓
最新8画面行を計算
    ↓
Thinking 領域を再描画
```

例:

```ts
import * as readline from "node:readline";

function clearTransient(lines: number) {
  if (lines <= 0) {
    return;
  }

  readline.moveCursor(process.stdout, 0, -lines);
  readline.cursorTo(process.stdout, 0);
  readline.clearScreenDown(process.stdout);
}
```

---

# 11. Persistent output と Thinking の競合処理

Thinking 表示中に以下が到着する可能性がある。

* assistant text
* tool start
* tool end
* error

その場合は必ず以下の順序で処理する。

```text
1. Thinking の transient 表示を消す
2. Persistent output を stdout に書く
3. Thinking が継続中なら再描画する
```

例:

```ts
renderer.withPersistentOutput(() => {
  process.stdout.write(text);
});
```

内部的には:

```ts
clearThinkingView();
writePersistent();
renderThinkingView();
```

とする。

これにより、通常出力と Thinking が混ざらないようにする。

---

# 12. Thinking ライフサイクル

`thinking_delta` が開始した時点で Thinking セッションを開始する。

以下の場合に一時表示を消去する。

* assistant の通常 text 出力開始
* tool execution 開始
* assistant message 完了
* 実行完了
* エラー終了

Thinking の内容自体を途中で破棄するか、同一 assistant message 内で継続するかは Pi のイベント順序に合わせる。

基本的には assistant message 単位で ThinkingBuffer をリセットする。

---

# 13. ツールコール表示

ツールイベントは JSONL として stdout に1行ずつ出力する。

Pretty JSON は使わない。

理由:

* 画面バッファを節約できる
* grep / jq / ログ解析と相性がよい
* 1イベント単位で読みやすい
* ストリーミングとの相性がよい

---

# 14. tool start

例:

```json
{"type":"tool_start","id":"tool_123","name":"read","args":{"path":"src/index.ts"}}
```

最低限以下を含める。

```ts
type ToolStartEvent = {
  type: "tool_start";
  id: string;
  name: string;
  args: unknown;
};
```

---

# 15. tool end

例:

```json
{"type":"tool_end","id":"tool_123","name":"read","status":"success","elapsed_ms":42}
```

エラー:

```json
{"type":"tool_end","id":"tool_123","name":"bash","status":"error","elapsed_ms":814}
```

型:

```ts
type ToolEndEvent = {
  type: "tool_end";
  id: string;
  name: string;
  status: "success" | "error";
  elapsed_ms: number;
};
```

---

# 16. Tool result 本文

初期実装では tool result 本文は出力しない。

理由:

* `read`
* `grep`
* `bash`
* Web取得

などは結果が非常に大きくなる可能性がある。

ツールを呼び出した事実と成功/失敗が確認できれば、進行状況表示としては十分である。

将来的に必要であればオプション化する。

例:

```bash
--stream-tool-results
```

初期スコープには含めない。

---

# 17. Tool elapsed time

`tool_execution_start` 受信時に時刻を記録する。

```ts
Map<string, number>
```

例:

```ts
toolStartedAt.set(toolCallId, performance.now());
```

終了時:

```ts
const elapsedMs =
  performance.now() - toolStartedAt.get(toolCallId);
```

終了イベント JSON に追加する。

---

# 18. 通常回答

`text_delta` は受信した順番で stdout に即時出力する。

```ts
process.stdout.write(delta);
```

ただし Thinking 表示中の場合は必ず、

```text
Thinking消去
↓
delta出力
↓
必要ならThinking再描画
```

を経由する。

---

# 19. 実行統計

実行終了時に以下を表示する。

* Input tokens
* Cache read tokens
* Output tokens
* Cache write tokens
* Elapsed
* Generation
* TPS

Pi 内部の usage 名称に合わせる。

```text
Input
Cache read
Output
Cache write
```

「キャッシュ入力」「キャッシュ出力」ではなく、実際の意味が分かる名称を使用する。

---

# 20. Usage 集計

assistant message ごとの usage を加算する。

想定フィールド:

```ts
usage.input
usage.output
usage.cacheRead
usage.cacheWrite
```

複数回モデルが呼ばれるエージェント実行では、すべて合算する。

```ts
class RunStats {
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
}
```

message end 時:

```ts
stats.input += usage.input;
stats.output += usage.output;
stats.cacheRead += usage.cacheRead;
stats.cacheWrite += usage.cacheWrite;
```

---

# 21. 経過時間

全体の経過時間:

```text
Elapsed
```

定義:

```text
プロセス実行開始
↓
最終イベント処理完了
```

例:

```ts
const startedAt = performance.now();
```

終了時:

```ts
const elapsedMs = performance.now() - startedAt;
```

---

# 22. Generation time

モデル生成速度を正しく計算するため、全経過時間とは別に Generation time を記録する。

Generation time は assistant message の生成時間の合計とする。

例:

```text
message_start
↓
message_update...
↓
message_end
```

この区間を加算する。

ツール実行時間は含めない。

---

# 23. TPS

TPS は以下で定義する。

```text
TPS = Output tokens / Generation seconds
```

例:

```text
Output       3,842 tokens
Generation  11.6 sec

TPS = 331.2 tok/s
```

全体経過時間を denominator にしない。

理由:

エージェントでは以下の時間が含まれるため。

* shell execution
* file read
* network access
* external tool
* retry wait

これらを含めるとモデル自体の生成速度を正しく表せない。

---

# 24. RunStats

概念実装:

```ts
class RunStats {
  readonly startedAt = performance.now();

  private generationStartedAt?: number;
  private generationMs = 0;

  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;

  startGeneration() {
    this.generationStartedAt = performance.now();
  }

  endGeneration(usage: Usage) {
    if (this.generationStartedAt !== undefined) {
      this.generationMs +=
        performance.now() - this.generationStartedAt;

      this.generationStartedAt = undefined;
    }

    this.input += usage.input ?? 0;
    this.output += usage.output ?? 0;
    this.cacheRead += usage.cacheRead ?? 0;
    this.cacheWrite += usage.cacheWrite ?? 0;
  }

  snapshot() {
    const elapsedMs =
      performance.now() - this.startedAt;

    return {
      input: this.input,
      output: this.output,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,

      elapsedMs,
      generationMs: this.generationMs,

      tps:
        this.generationMs > 0
          ? this.output / (this.generationMs / 1000)
          : 0,
    };
  }
}
```

---

# 25. 最終サマリ

終了前に Thinking transient 表示を完全に消去する。

その後 Persistent output として以下を表示する。

例:

```text
────────────────────────────────────────
Done

Tokens
  Input        12,481
  Cache read   48,220
  Output        3,842
  Cache write       0

Elapsed        24.8s
Generation     11.6s
TPS            331.2 tok/s
────────────────────────────────────────
```

最低限以下を満たす。

* token は3桁区切り
* 時間は秒表示
* TPS は小数1桁程度
* usage 不明の場合でもクラッシュしない
* Generation = 0 の場合 TPS は `-` または `0` とする

---

# 26. エラー時

エラー終了時も可能な限りサマリを出力する。

例:

```text
────────────────────────────────────────
Failed

Tokens
  Input         1,820
  Cache read    4,150
  Output          442
  Cache write       0

Elapsed         8.2s
Generation      3.1s
TPS           142.6 tok/s
────────────────────────────────────────
```

Thinking transient は必ず消去してから終了する。

子プロセスの exit code はそのまま呼び出し元へ伝播させる。

---

# 27. シグナル処理

以下を考慮する。

* `SIGINT`
* `SIGTERM`

終了時:

1. Thinking transient を消去
2. 子 Pi プロセスへシグナルを伝播
3. 必要に応じて途中までの stats を表示
4. 適切な exit code で終了

Ctrl+C 後に Thinking の残骸がターミナルへ残らないことを重視する。

---

# 28. ターミナルサイズ変更

初期実装では必須ではないが、TTY の `resize` を処理できる設計にする。

```ts
process.stdout.on("resize", () => {
  renderer.repaintThinking();
});
```

ターミナル幅変更時は:

```text
ThinkingBuffer
↓
新しい columns で再wrap
↓
最新8画面行を再描画
```

とする。

---

# 29. Renderer インターフェース

描画処理をイベント処理から分離する。

```ts
interface Renderer {
  writeText(delta: string): void;

  writeToolEvent(event: unknown): void;

  appendThinking(delta: string): void;

  clearThinking(): void;

  finish(stats: StatsSnapshot): void;

  fail(stats: StatsSnapshot): void;
}
```

Renderer 内部で TTY 判定を扱う。

イベント処理側は、

```ts
if (!isTTY) thinking を捨てる
```

という条件を毎回持たなくてよい設計にする。

例:

```ts
appendThinking(delta: string) {
  if (!this.isTTY) {
    return;
  }

  ...
}
```

---

# 30. 非 TTY 出力

非 TTY 時は機械的に扱いやすいことを優先する。

以下は出力する。

```text
assistant text
tool JSONL
summary
```

以下は出力しない。

```text
Thinking
ANSI cursor control
screen clearing
decorative transient UI
```

これにより、

```bash
pi -p --stream "..." > output.txt
```

でも不要な Thinking がログを汚さない。

---

# 31. 初期スコープ外

以下は初期実装には含めない。

* tool result 全文表示
* Thinking 全文ログ保存
* Markdown の高度なリアルタイムレンダリング
* syntax highlighting
* TUI フレームワーク導入
* Ink / blessed 等によるフルスクリーン UI
* JSON イベント自体の永続ログ保存
* セッション復元
* 並列 tool call の高度な UI 表示

まずは ANSI + stdout ベースの軽量実装とする。

---

# 32. 受け入れ条件

## AC-1 通常回答

Given:
Pi が `text_delta` を複数回出力する

When:
ストリーミング実行する

Then:
各 delta が到着時点で stdout に表示される

And:
実行完了まで待たずに回答内容を確認できる

---

## AC-2 ツール開始

Given:
Pi が tool execution を開始する

When:
`tool_execution_start` を受信する

Then:
以下の情報を含む JSONL を即座に出力する

* type
* id
* tool name
* args

---

## AC-3 ツール終了

Given:
tool execution が終了する

When:
`tool_execution_end` を受信する

Then:
以下の情報を含む JSONL を出力する

* type
* id
* tool name
* success/error
* elapsed_ms

---

## AC-4 Thinking 表示

Given:
stdout が TTY

When:
Thinking delta を受信する

Then:
Thinking は画面下部付近に一時表示される

And:
最大8画面行だけ表示される

And:
8行を超えた古い内容は上側から見えなくなる

And:
Thinking はスクロールバックに残らない

---

## AC-5 Thinking と通常出力

Given:
Thinking が表示中

When:
通常回答または tool event が発生する

Then:
Thinking 表示を一度消去する

And:
Persistent output を出力する

And:
必要であれば Thinking を再描画する

And:
両者の表示が混ざらない

---

## AC-6 非 TTY

Given:
stdout が TTY ではない

When:
Thinking delta を受信する

Then:
Thinking を stdout に出力しない

And:
ANSI 制御コードを出力しない

And:
通常回答・tool event・summary は通常どおり出力する

---

## AC-7 Usage

Given:
複数の assistant message が生成される

When:
処理が完了する

Then:
すべての usage を合算する

And:
以下を表示する

* Input
* Cache read
* Output
* Cache write

---

## AC-8 TPS

Given:
assistant generation が複数回発生する

When:
処理が完了する

Then:
assistant generation time の合計を計測する

And:

```text
Output tokens / Generation seconds
```

で TPS を算出する

And:
tool execution time は TPS 計算に含めない

---

## AC-9 終了表示

Given:
Pi の実行が正常終了する

When:
最後のイベント処理が完了する

Then:
Thinking transient を消去する

And:
最終サマリを Persistent output として表示する

---

## AC-10 異常終了

Given:
Pi が異常終了する

When:
子プロセスが非ゼロ exit code で終了する

Then:
Thinking transient を消去する

And:
取得済みの統計情報を可能な範囲で表示する

And:
子プロセスの exit code を呼び出し元へ伝播する

---

# 33. 実装優先順位

以下の順に実装する。

1. `pi --mode json -p` の子プロセス実行
2. JSONL event parser
3. `text_delta` のリアルタイム表示
4. tool start/end の JSONL 表示
5. TTY 判定
6. ThinkingBuffer
7. Thinking transient renderer
8. persistent / transient の排他描画
9. usage 集計
10. elapsed / generation / TPS
11. 最終サマリ
12. SIGINT / SIGTERM 対応
13. terminal resize 対応

---

# 34. 実装上の原則

* Pi 本体のエージェントロジックを再実装しない
* `--mode json` を唯一のイベントソースとする
* Thinking は表示上の補助情報として扱う
* Thinking をログやリダイレクト出力に混ぜない
* ツールイベントは機械可読性を維持する
* フル TUI 化せず stdout / ANSI ベースに留める
* exit code や signal semantics を壊さない
* Pi の usage 定義を勝手に再解釈しない
* TPS の定義をコード内・README に明記する

---

# 35. 完了条件

以下を満たした時点で初期バージョンを完了とする。

```bash
pi -p --stream "..."
```

を TTY 上で実行した際に、

* 回答がリアルタイム表示される
* tool call が JSONL で随時表示される
* Thinking は最大8画面行の一時表示になる
* Thinking がスクロールバックを埋めない
* 終了時に usage / elapsed / generation / TPS が表示される

また、

```bash
pi -p --stream "..." > output.txt
```

のような非 TTY 出力では、

* Thinking が一切含まれない
* ANSI 制御コードが含まれない
* 通常回答
* tool event
* 最終サマリ

のみが出力されること。
