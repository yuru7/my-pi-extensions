# pi-advisor

[English](./README.md) | 日本語

[Pi](https://pi.dev) の拡張です。実行モデルが引数なしの `advisor` ツールで、より強いモデルに今の会話を渡し、計画・修正・停止のいずれかの助言を受け取ってから作業を続けます。

モデルを選ぶまで、この助言用の説明は実行モデルのシステムプロンプトに入りません。未設定のあいだはツールを有効一覧から外すので、説明も指針も送られません。

## インストール

```sh
pi install npm:@yuru7/pi-advisor
```

インストール後に Pi を起動し直してください。

## 使い方

`/advisor` を実行します。Pi に認証済みのモデルが一覧されます。モデル名、プロバイダ名、`provider/modelId` の一部を打つと絞り込めます。モデルを選ぶと、思考に対応している場合は思考量の選択に進みます。`high` に recommended と出ます。

`Advisor: <provider/modelId>, <effort>` と出れば、このセッション以降も `advisor` ツールが有効です。

**No advisor** で無効にします。モデル一覧で Esc を押すと、今の選択は変わりません。思考量の一覧で Esc を押すと、モデルはそのまま保存し、思考量は送りません。

`/advisor` は対話端末が必要です。`pi --print` や RPC では `/advisor requires interactive mode` と出ます。

## 実行モデルへの指示

プロンプトモードは `standard` だけです。ツールが有効なあいだ、Pi は短い説明と 7 つの指針を足します。書く、編集する、解釈を確定する、仮定の上に積む、といった本格的な作業の前、成果物を保存したうえでの完了宣言の前、行き詰まり、収束しないとき、結果が合わないとき、方針転換のときに相談する、という内容です。ファイルを探すなどの下調べでは呼ぶ必要はありません。複数ステップでは、方針が固まる前の最初の相談が最も効き、直前のツール出力で次の一手が決まっているときは次の相談を省きます。助言は、自己テストが通っただけでは覆りません。手元の証拠と食い違ったら、両方を述べてもう一度相談します。次にユーザーへ見せる応答では、助言の要点を引用か言い換えで書きます。ツール説明には、Advisor がこれまでのツール呼び出しと結果をすでに見ていることも書いてあります。

Advisor 自身への指示（計画・修正・停止のいずれかで答え、ツールは呼ばない）は、Advisor を呼んだリクエストにだけ付きます。

## 呼び出しで送られるもの

`advisor()` に引数はありません。拡張が現在の会話分岐を読み、コンパクションやブランチ要約を含め、実行中の `advisor` 呼び出しを除いてから、ツール一覧を先頭に足します。Advisor へのリクエストは `tools: []` です。返答はツール結果としてだけ返り、ユーザー発言としては追加されません。

別プロバイダのモデルを選ぶと、ツール結果を含む会話がそのプロバイダへ送られます。その内容を預けてよい相手だけを選んでください。API キーは設定ファイルにもログにも書きません。会話そのものをこの拡張がファイルへ保存することもありません。

## 設定

設定ファイルは `~/.pi/agent/pi-advisor.json`（Pi のエージェントディレクトリ）です。`/advisor` での保存が初めて成功したときに作られ、可能なときは権限 `0600` になります。ファイルが無いときは Advisor はオフです。JSON が壊れているときは警告して既定値で動きます。`/advisor` が書き換えるのは `model` と `effort` だけなので、手で書いた項目は残ります。

| キー | 型 | 既定 | 意味 |
| --- | --- | --- | --- |
| `model` | string | なし | レビューモデル。`provider/modelId` |
| `effort` | string | なし | 思考量。無いときは `reasoning` を送らない |
| `promptMode` | string | `standard` | 実行モデル向けの定型文。実装されているのは `standard` だけ |
| `disabledForModels` | array | `[]` | Advisor を出さない実行モデル |
| `toolInventory` | string | `full` | Advisor に渡すツール情報の量 |
| `guidance` | object | 組み込みの文 | `promptSnippet` と `promptGuidelines` の上書き |

```json
{
  "model": "anthropic/claude-opus-4-5",
  "effort": "high",
  "promptMode": "standard",
  "toolInventory": "full",
  "disabledForModels": [
    "anthropic/claude-opus-4-5",
    { "model": "openai/gpt-5.2", "minEffort": "high" }
  ]
}
```

`toolInventory` は `full`（登録済み全ツールの説明とパラメータ）、`active`（今有効なツールだけ）、`names`（名前だけ）です。既定の `full` は参考実装と同じ情報量です。JSON はキー順を固定し、名前・説明・スキーマが変わるまで同じ文字列を再利用します。

`guidance` は拡張の読み込み時に一度だけ読みます。書き換えたあとは Pi を読み込み直してください。`toolInventory` は Advisor を呼ぶたびに読みます。`disabledForModels` はセッション開始時と、実行モデルや思考量を変えたときに反映されます。

`disabledForModels` の文字列は、その実行モデルでは思考量に関係なく無効です。`minEffort` 付きのオブジェクトは、実行側の思考量がその値以上のときだけ無効です（`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。未設定や `off` は `minEffort` に一致しません。古い `provider:modelId` 形式も、`provider/modelId` として比較します。

項目の詳細は [docs/configuration.md](./docs/configuration.md)、ツール結果の形は [docs/tool-reference.md](./docs/tool-reference.md) です。

## プロンプトの大きさ

rpiv-advisor 2.13.8 の実行モデル向け文面より、`standard` の追加トークンは少なくなっています。数値は Pi の `buildSystemPrompt` が実際に挿入する行と、ツール定義の JSON を `o200k_base` で数えた推定です。プロバイダの請求トークンそのものではありません。詳細は [docs/comparison.md](./docs/comparison.md) です。

| | Original | Standard |
| --- | ---: | ---: |
| ツール定義 | 95 | 52 |
| プロンプト指針 | 412 | 282 |
| 拡張が追加する合計 | 507 | 334 |
| 元実装からの削減 | — | 34.1% |

Advisor がオフのときは、この文面は追加されません。

## トラブルシューティング

| 症状 | 対処 |
| --- | --- |
| 一覧が **No advisor** だけ | Pi の `/login` でプロバイダを認証してから、もう一度 `/advisor` |
| `Advisor (<model>) has no API key available.` | そのプロバイダを認証し直す。OAuth モデルは、ホストが実行時 API を出しているときはその認証を使う |
| `Previously configured advisor model <key> is no longer available` | 保存していたモデルがレジストリから消えている。`/advisor` で選び直す |
| `Failed to save advisor selection` | 設定ファイルを書けなかった。以前の選択はそのまま |
| 今のモデルで Advisor が出ない | その実行モデルが、今の思考量で `disabledForModels` に入っている |

## 既知の制限

- Advisor はファイルを編集せず、ツールも実行せず、実行モデルも切り替えません。
- プロンプトモードは `standard` だけです。別の `promptMode` は無視され、`standard` を使います。
- モデルを使った呼び出し率の比較は行っていません。テストは、短くした指針が必要な判断条件をまだ含んでいることと、トークン数が減っていることを確認します。モデルが実際に何回呼ぶかは測っていません。
- `guidance` の変更は、次に拡張を読み込んだときに反映されます。

## 謝辞

この拡張は [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) の [`rpiv-advisor`](https://github.com/juicesharp/rpiv-mono/tree/1ffa165c224b5489fb5774a6652ef2e1c3bc6b2a/packages/rpiv-advisor) 2.13.8 にインスパイアされて作成しました。

## ライセンス

MIT。Copyright (c) 2026 yuru7。
