# wave-2 調査記録: 誘導文言の最適化とトークン測定

`.agents/plan/wave-2.md` の Milestone 1(基準測定)・Milestone 2(実装)・Milestone 3(テスト)・Milestone 4(モデル評価)・Milestone 5(調整)の結果を記録する。

## 1. 比較基準

| 項目 | 値 |
|---|---|
| 比較対象 | `juicesharp/rpiv-mono` `packages/rpiv-ask-user-question` |
| 比較対象コミット | `d3c6f0812140605a4e55e0a660eb83edc12abbc5` |
| 取得検証 | SHA 固定で再取得し、初回取得ファイルと完全一致(`cmp` 確認済み) |
| ベース | 本リポジトリ `pi-ask-user`(変更前 HEAD `5c0b0a3`) |
| トークナイザー | `gpt-tokenizer` の `o200k_base`(全測定で共通) |

**注意**: トークン数は o200k_base による推定値であり、各プロバイダ(Amazon Bedrock / Anthropic / OpenAI など)の実際の課金トークン数でも、プロバイダ固有の内部表現(チャットテンプレート展開など)を含む値でもない。相対比較用の目安。

## 2. プロンプト増加量の測定

### 測定方法

- **システムプロンプト部分**: Pi の `buildSystemPrompt` が埋め込む `Available tools:` の 1 行(`- ask_user: <promptSnippet>`)と `promptGuidelines` の各行(`src/guidance.ts` → `src/ask-user-question.ts` → pi `dist/core/system-prompt.js` で確認)。
- **ツール定義部分**: Anthropic Messages 形式の `{ name, description, input_schema }` ペイロード(pi-ai `dist/api/anthropic-messages.js` の変換と同一形)。JSON Schema の説明文を含む。

### 結果(`scripts/measure.ts` の出力、トークン / 文字)

| 測定対象 | rpiv 版 | yuru7 旧版(変更前) | yuru7 新版(変更後・採用) |
|---|---|---|---|
| snippet 行(システムプロンプト) | 25 tok / 113 chars | 21 tok / 109 chars | 45 tok / 277 chars |
| promptGuidelines 行(計) | 242 tok / 1,219 chars | 0 | 0 |
| **システムプロンプト合計** | **268 tok** | **21 tok** | **45 tok** |
| description | 320 tok / 1,641 chars | 105 tok / 500 chars | 99 tok / 536 chars |
| Schema 内 description のみ(集計) | 283 tok | 67 tok | 67 tok |
| Schema JSON 単体 | 441 tok | 221 tok | 221 tok |
| ツール定義全体(desc + Schema) | 785 tok / 3,763 chars | 340 tok / 1,554 chars | 333 tok / 1,590 chars |
| 　うち description 抜き(name + input_schema) | 452 tok | 231 tok | 231 tok |
| **リクエスト合計(システム + ツール定義)** | **1,053 tok / 5,099 chars** | **361 tok / 1,663 chars** | **378 tok / 1,867 chars** |

質問への回答:

- **変更前(現行ツール)の推定増加**: システムプロンプト +21 トークン、ツール定義込みで +361 トークン。
- **rpiv 版の推定増加**: システムプロンプト +268 トークン、ツール定義込みで +1,053 トークン。
- **実装後の推定増加**: システムプロンプト +45 トークン、ツール定義込みで +378 トークン(rpiv 版比 −675 トークン、**約 64% 削減**。rpiv 版の約 36% の量)。

補足: ツール定義はキャッシュ単位が異なるため厳密にはシステムプロンプトと同列に扱えないが、毎リクエスト送出される点は同じ。旧版と新版のシステムプロンプト増加は +21 → +45 となった(4 質問場面の列挙と抑制条件を snippet に移したため)。一方 description は 105 → 99 トークンで、guidelines は空を維持。

## 3. ツール選択評価(Milestone 4/5)

### ハーネス(`scripts/eval.ts`)

- 3 バリアント(A: rpiv 誘導文言 / B: yuru7 旧文言 / C: 提案版)が**同一ツール名 `ask_user`・同一 Schema・同一システムプロンプト雛形**で、description・promptSnippet・promptGuidelines のみ異なる状態で比較。A の文言内に自身のツール名 `ask_user_question` が現れる箇所は `ask_user` に正規化して比較条件を揃えた。
- ツール呼び出し引数は本拡張の実行時バリデータ(`validateQuestionnaire`)と Schema 上限で検証。
- プロバイダがツール引数を拒否した場合(HTTP 400)は `invalid_args`、輸送エラー・レート制限は `error` として分離し、再現率・誤呼び出し率の分母から除外。

### 実行結果

**run1**(2026-10-20、Groq `openai/gpt-oss-120b`、temperature 0.7、12 ケース3反復=108 呼び出し、生データ `scripts/eval-results.json`):

| バリアント | 有効呼び出し | エラー | 質問再現率(有効分母) | 誤呼び出し(有効分母) | Schema 違反 |
|---|---|---|---|---|---|
| A rpiv | 12/36 | 24(429:18 / HTTP400:6) | 6/6 | 2/4 | 1(reserved label) |
| B yuru7 旧 | 13/36 | 23(429:16 / HTTP400:7) | 8/8 | 2/3 | 3(reserved label) |
| C 提案版 | 12/36 | 24(429:18 / HTTP400:6) | 6/6 | 4/6 | 1(reserved label) |

**この表は比較証拠として不十分**である。理由:

1. エラー(主に Groq の TPD=日次トークン上限)が変異量と相関して発生し、有効サンプルが各バリアント 12〜13 件(全会倒の 1/3)に減った。特に T04 は 3 バリアントすべて有効サンプル 0 件。
2. エラーを分母から除くこと自体がサンプル偏りを生む(質問を出した長い応答ほど先に制限に達した可能性)。
3. run1 当時のハーネスには検証関数の不整合とエラー行の分母混入があり、初回公開集計(再現率 6〜8/18 など)は誤りだった。上の表が訂正後の値。

**再実行の試みと失敗**: 検証関数・エラー分離・ツール名正規化を修正したハーネスで A/B/C の再実行を試みたが、run1 の後、試した 3 モデル(`gpt-oss-120b`・`gpt-oss-20b`・`qwen3.8-27b`)のすべてで 429(retry-after 数百秒)が繰り返され、回避できなかった(エラーメッセージ上は tokens per day 制限。上限が組織横断で共通かは未確認)。**Plan §8 の「モデル評価を実行できない環境では制約を明記して静的テストまでを完了させる」に従い、ここで打ち切り。**

### run1 から言えること(参考・非統計)

- 有効サンプル内では 3 バリアントとも「質問すべき」ケースの再現率 100%、「質問すべきでない」ケースでの誤呼び出しが A: 2/4、B: 2/3、C: 4/6。C の誤呼び出しは T05(既存規約ありのログ追加)に集中するが、**ハーネスが単発 1 ターンでコードベースを参照できない**ため、A/B も「どのファイルに」「どのヘルパーで」といった本来コードを見れば判別できる質問を出した。文言起因と断定できない。
- T09 の質問集約は全バリアントの有効呼び出しで 2 問以上の 1 回呼び出しを達成。T11(質問禁止の明示)は B のみ 1 件の有効サンプルがあり違反。A と C は T11 の有効サンプルが 0 件のため、C の遵守は判定できない。
- Schema 違反は全体で 5 件/37 有効呼び出し、すべて reserved label "Other"。C は description に予約ラベル 3 種を明示して維持しており、B と同程度の発生率。
- **同等性・優越性は未実証**。特に「C の誤呼び出し率が目標( rpiv 版を上回らない)を満たすか」は未検証のまま残る。

### Milestone 5 の調整

- 誤呼び出し抑制を狙った提案 v2(D: snippet に "Prefer finding answers in the codebase or existing conventions to asking.")を追加評価したが、run1 と同条件の再検証が Groq 制限で不可能になり、効果を確認できないため**不採用**。採用文言は C のまま、予約ラベル明示と preview×multiSelect 禁止を description に補強した(下記)。
- C から D への変更はトークン +10 程度で、効果の裏付けがない変更を積まない判断。

### 最終採用文言と選定理由

- `DEFAULT_PROMPT_SNIPPET`: 4 質問場面(好み・曖昧な要件・実装判断・代替案)+「ユーザー入力が結果に実質的に影響するか」基準 + 作業停止不要 + 既存規約で判別できる軽微な質問の抑制 + 集約を 1 行に集約。rpiv 版 snippet(25 tok)をやや上回るが(45 tok)、guidelines 4 本(242 tok)を不要にした。
- `DEFAULT_TOOL_DESCRIPTION`: snippet と同一の判断基準で矛盾を排除。Schema が運べない 3 点(推奨選択肢の `(Recommended)` 規約、予約ラベル 3 種の列挙、preview×multiSelect 禁止)のみ保持し、UI 詳細・数値制約は Schema に委譲。105 → 99 トークン。なお、予約ラベル明示と preview×multiSelect 禁止は run1 の**後**に追加したものであり、**この最終文言でのモデル品質は未評価**である。
- `DEFAULT_PROMPT_GUIDELINES`: 空配列を維持(計画どおり)。

## 4. 実装・テスト

- `src/guidance.ts`: 上記 2 定数を更新(`guidance.*` 設定による上書きロジックは無変更)。
- `tests/questionnaire.test.ts`: 旧判断条件への完全一致依存のアサーションを廃止し、4 質問場面・実質的影響基準・作業停止不要・抑制・集約・Schema 外の使用上の注意(推奨規約/予約ラベル 3 種/preview×multiSelect)を個別に検証するよう更新。トークン上限テスト(`REFERENCE_PROMPT_CHARS = 2944`)は維持。
- `tests/registration.test.ts`(新規): 既定誘導文言での登録、`guidance.*` による全上書き・部分上書き、Schema の同一性を検証。
- `pnpm run check`(typecheck + biome lint + 36 テスト)成功。`git diff --check` クリア。

## 5. 未検証事項・既知の制約

- **実モデル評価は完了していない**。run1 は Groq `openai/gpt-oss-120b` による単発 1 ターンの代理評価で、Pi 本体の実際のシステムプロンプト・セッション文脈・コードベース探索を含まない。さらにレート制限により有効サンプルが 1/3 に減衰し、上記の訂正済み数値も比較証拠とは言えない。加えて run1 は A の文言内に未正規化のツール名 `ask_user_question` が残った状態で実行しており、修正済みハーネス(`scripts/eval.ts`)での A/B/C 再実行が今後の課題。
- 「C の誤呼び出し率が rpiv 版を上回らない」という合格目標は**未達のまま未検証**。run1 の有効サンプルでは C が 4/6 と worst だが、サンプル偏りがあるため文言起因とは主張しない。
- 反復数とケース数の制約上、統計的有意性は未検証。C 再実行時の生データは無い(コンソール記録のみだった初期再試行の結果は破棄)。保存済み `eval-results.json` の summary は `scripts/reaggregate-run1.ts` で訂正済み。
- トークン数は o200k_base 推定値(プロバイダ実課金値・内部表現を含まない)。
- 評価ハーネスはタイムアウト・回答チャネル等の実行時機能を対象外とする(回帰確認は既存 36 テストで担保)。
- `biome.json` は無変更(研究スクリプト自体を lint 対象として修正済み)。評価ハーネスの引数検証は実行時バリデータ + Schema 上限の手書きチェックであり、TypeBox による完全な Schema 検証ではない。
