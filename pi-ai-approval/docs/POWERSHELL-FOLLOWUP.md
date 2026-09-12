# PowerShell ツールのレビュー対応（引き継ぎ資料）

> これは別タスクとして扱うための引き継ぎメモです。`docs/ARCHITECTURE.md` §7.1
> （フェイルクローズド）に記載した既知のギャップの詳細と、着手時の判断材料をまとめています。

## 1. 結論（要約）

Pi 0.85.1 は `powershell` という名前のツールを持ちますが、`pi-ai-approval` は
`bash` しかレビュー対象にしていません。PowerShell のコマンド呼び出しは `path` を
持たないため `pathReadAction` が `undefined` を返し、**レビューされずに素通りします
（fail-open）**。

## 2. 再現経路（このリポジトリのコード）

| 箇所 | 内容 |
| --- | --- |
| `src/tool-actions.ts:75` | `actionFromToolCall` は `isToolCallEventType("bash", event)` のみを特別扱いする |
| `src/tool-actions.ts:132` | それ以外のツールは `pathReadAction(event.toolName, event.input, cwd, rules[`${event.toolName}.path`] ?? "private-only", cache)` に落ちる |
| `src/tool-actions.ts:141` | `pathReadAction` は `input.path` が文字列でない場合、`level === "always"` またはディレクトリ検索ツール（`grep` / `find` / `ls`）でなければ `return;`（＝レビュー対象外） |
| `src/config.ts:92` | `DEFAULT_REVIEW_RULES` に `powershell.command` は無い（`bash.command: "always"` のみ） |
| `src/config.ts:524` | `isReviewRuleKey` は既定ルールのキーと `<tool>.path` のみ許可するため、`powershell.command` は現状「Unsupported review」警告になる（既定ルールへ追加すれば有効化される） |

PowerShell ツールの入力は `{ command: string }`（`path` なし）なので、既定 level
`private-only` のままでは常に `undefined` が返ります。

## 3. Pi 側の事実（0.85.1 で確認）

- `@earendil-works/pi-coding-agent` の `dist/core/tools/powershell.js`:
  `name: "powershell"`, `shellName: "PowerShell"`, `prompt: "PS>"`。
- `dist/core/tools/index.js` に `case "powershell"` があり、ツールとして登録される
  （有効になる条件＝プラットフォームやツール設定は未確認。Windows での既定を想定）。
- 参考: bash ツールの表示は `$ <command>`
  （`dist/modes/interactive/components/bash-execution.js:37`）。

## 4. 影響

- `docs/ARCHITECTURE.md` §7.1（すべてのエラーパスはブロック）と §7.5 の前提が、
  PowerShell ツールが有効な環境では成立しない。
- `riskActions`（allow / ask / deny）も `review` ルールも適用されないため、
  `deny` 相当の操作が確認なしで実行されうる。
- bash ツールのみが有効な環境（現行の Linux / macOS 想定）では影響しない。
  有効化条件の確認は §7 の未決事項。

## 5. 対応案

### 案A（推奨）: bash と対称に `powershell` を特別扱いする

- `actionFromToolCall` に `isToolCallEventType("powershell", event)` 分岐を追加し、
  `tool: "powershell"`、`payload.command`、
  `private_data_read: commandReferencesPrivateData(command, cwd)` を設定する。
- `DEFAULT_REVIEW_RULES` に `"powershell.command": "always"` を追加する
  （`review` の厳格化マージ・警告・`/ai-approval rules` 表示はそのまま乗る）。
- 表示側は対応済み: `PS> ` プレビュー（`src/review-presentation.ts`）と、
  承認ダイアログのコードブロック言語ラベル `powershell`
  （`src/approval-prompt.ts` / `src/approval-dialog.ts`）。

### 案B: 「`command` を持つツール」を一般化してレビューする

- `input.command` を持つ未知ツールを既定でレビューする。将来のシェル追加に強い一方、
  MCP ツールなど意図しない拡張がレビュー対象になる可能性がある。

### 案C: 未知ツールを既定でレビューする（fail-closed 化）

- `pathReadAction` の `return;` を「レビューする」側へ倒す。最も安全側だが、
  すべての MCP ツールがレビュー対象になり、レイテンシとプロンプト頻度が増える。
  案A とは別の設計判断として議論する。

## 6. 実装チェックリスト（案A の場合）

- [ ] `src/tool-actions.ts`: powershell 分岐、`rules["powershell.command"]`、private data 判定
- [ ] `src/config.ts`: `DEFAULT_REVIEW_RULES` へ `"powershell.command": "always"` を追加
- [ ] `src/reviewer-status.ts`: `/ai-approval rules` の説明文（「Unconfigured tools…」）に PowerShell を反映
- [ ] `src/shell-private-data.ts`: PowerShell 記法（`$env:USERPROFILE`、`Get-Content`、`-Path ~/...`）で
      bash 用ヒューリスティクスが機能するか確認し、必要なら拡張
- [ ] `tests/tool-actions.test.ts`: powershell コマンドがレビュー対象になること、`off` で対象外になること
- [ ] `tests/config.test.ts`: 既定値・厳格化マージ・不正キー警告の更新
- [ ] `tests/extension.test.ts`: `tool_call` 配線（ask / deny 経路）の確認
- [ ] ドキュメント: `README.md` / `README_ja.md`（レビュー対象一覧）、
      `docs/ARCHITECTURE.md` §4 フロー・§5 モジュール表・§7

## 7. 着手時に決めること

1. `powershell.command` の既定を `always` にするか（bash と揃える想定。`allow` 判定なら
   レビュー後に素通りする）。
2. PowerShell ツールが有効になる条件（プラットフォーム・設定）と、検証環境の用意方法。
3. PowerShell 特有のパス記法を private data 判定にどこまで取り込むか。
4. 案B / 案C（未知ツールの扱い）を同時に扱うか、別ゴールに分けるか。

## 8. 検証手順

```bash
pnpm check   # = tsc -p tsconfig.json && node --test tests/*.test.ts
```

`tests/extension.test.ts` のハーネスで `powershell` の `tool_call` を流し、
レビュアーに渡ること・`riskActions` に従って allow / ask / deny になることを確認する。

## 9. 関連ファイル

- 変更対象: `src/tool-actions.ts`、`src/config.ts`、`src/reviewer-status.ts`、`src/shell-private-data.ts`
- 対応済み: `src/review-presentation.ts`（`PS> ` プレビュー）、
  `src/approval-prompt.ts` / `src/approval-dialog.ts`（`powershell` コードブロックラベル）
- テスト: `tests/tool-actions.test.ts`、`tests/config.test.ts`、`tests/extension.test.ts`
