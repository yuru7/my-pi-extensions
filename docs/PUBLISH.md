# pnpm でのパッケージ公開

このリポジトリは単一の pnpm ワークスペースではありません。各パッケージは各自のディレクトリにあり、[npm レジストリ](https://www.npmjs.com/)（`https://registry.npmjs.org`）へ**独立して**公開します。pnpm はクライアントです。pnpm 専用の別レジストリへ上げるわけではありません。

公開に成功し、`keywords` に `pi-package` が入っていれば [Pi Packages](https://pi.dev/packages) の掲載対象にもなります。

## パッケージ

| ディレクトリ | npm 名 | インストール |
| --- | --- | --- |
| [`pi-native-notify/`](../pi-native-notify) | `@yuru7/pi-native-notify` | `pi install npm:@yuru7/pi-native-notify` |
| [`pi-undo/`](../pi-undo) | `@yuru7/pi-undo` | `pi install npm:@yuru7/pi-undo` |
| [`pi-print-stream/`](../pi-print-stream) | `@yuru7/pi-print-stream` | `pi install npm:@yuru7/pi-print-stream` |

どちらもスコープ付きです。スコープ付きパッケージは初回公開時の既定が **restricted**（非公開）なので、少なくとも初回は `--access public` が必要です。

## 初回だけやること

1. `@yuru7` スコープで公開できる npm アカウント（このリポジトリでは `yuru7`）
2. ターミナルからログイン（Web ログイン、またはユーザー名 / パスワード）。認証情報は以降の公開でも使われます

```bash
pnpm login
pnpm whoami
```

2FA を有効にしている場合、`pnpm publish` は OTP を求めます。引数で渡すこともできます。

```bash
pnpm publish --access public --otp 123456
```

## 公開の流れ（毎回）

作業はリポジトリルートではなく、**パッケージディレクトリの中**で行います。

```bash
cd pi-native-notify   # または: cd pi-undo
```

### 1. git の状態を確認する

`pnpm publish` は既定で git を検査します。

- 現在のブランチが `main` または `master`
- 作業ツリーがクリーン
- ローカルブランチが remote と同期している

先に commit と push してください。

### 2. テストする

```bash
pnpm test
```

`pi-undo` では型チェックも実行します。

```bash
pnpm typecheck
```

### 3. アップロードされる中身を確認する

`package.json` の `files` が許可リストです。テスト、`node_modules`、lockfile、計画メモは含まれません。

```bash
pnpm pack --dry-run
```

`--dry-run` なしの `pnpm pack` はローカルに `.tgz` を作ります。必須ではありません。

含まれるべきファイル:

- `pi-native-notify`: `extensions/`、`README.md`、`LICENSE`
- `pi-undo`: `extensions/`、`src/`、`README.md`、`LICENSE`
- `pi-print-stream`: `extensions/`、`src/`、`README.md`、`LICENSE`

### 4. バージョンを上げる

同じバージョンは二度公開できません。公開の**前に**上げます。

```bash
pnpm version patch    # 0.3.3 → 0.3.4
# pnpm version minor  # 0.3.3 → 0.4.0
# pnpm version major  # 0.3.3 → 1.0.0
```

`pnpm publish patch` というコマンドは**ありません**。`publish` の第 1 引数は tarball かフォルダなので、その打ち方だと `patch` というパスを公開しようとします。

**Git タグ:** `pnpm version` は commit と annotated tag（`v0.3.4`）も作ります。このリポジトリはパッケージが 2 つでタグ空間は 1 つなので、`v*` は衝突します。タグなしでバージョンだけ上げる方が安全です。

```bash
pnpm version patch --no-git-tag-version
git add package.json
git commit -m "0.3.4"
git push
```

タグを残すなら、既定の `v` ではなくパッケージ名のプレフィックスを付けます。

```bash
pnpm version patch --tag-version-prefix @yuru7/pi-native-notify-v
```

### 5. 公開する

```bash
pnpm publish --access public
```

`--access public` はスコープ付きパッケージの**初回**公開では必須です。2 回目以降は省略できますが、付けたままでも問題ありません。

アップロードせずに確認する:

```bash
pnpm publish --access public --dry-run
```

### 6. 確認する

```bash
npm view @yuru7/pi-native-notify version
# npm view @yuru7/pi-undo version
```

- npm: `https://www.npmjs.com/package/@yuru7/pi-native-notify`
- インストール: `pi install npm:@yuru7/pi-native-notify` のあと `/reload`
- ギャラリー: [pi.dev/packages](https://pi.dev/packages) — インデックス反映は遅れることがあります。パッケージページはあるのに検索に出ないこともあります（公開直後やダウンロードが少ない場合）。再インデックスの定石は、新しいバージョンを上げることです。

## チェックリスト

- [ ] パッケージディレクトリへ `cd` した
- [ ] `pnpm whoami` が `yuru7`
- [ ] テストが通る（`pi-undo` と `pi-print-stream` は typecheck も）
- [ ] `pnpm pack --dry-run` に意図したファイルだけが出る
- [ ] `package.json` の `version` がレジストリ上にまだ無い
- [ ] `keywords` に `pi-package` がある
- [ ] git がクリーンで push 済み、または `--no-git-checks` を意図して付けた
- [ ] `pnpm publish --access public`

## よくある失敗

| 症状 | 原因 |
| --- | --- |
| `pnpm publish patch` が失敗する | そういうサブコマンドはない。`pnpm version patch` のあと `pnpm publish` |
| `You cannot publish over the previously published versions` | そのバージョンはすでに npm にある。先に上げる |
| `This package has been marked as private` / 402 / 有料プランが必要 | スコープ付きなのに `--access public` を付けていない |
| git 検査エラー（ブランチ / dirty / 未同期） | commit と push、または `--no-git-checks` |
| OTP / 401 | もう一度 `pnpm login`、または `--otp` を付ける |
| Pi ギャラリーの検索に出ない | ギャラリーは `keywords:pi-package` の npm 検索から作られる。別レジストリではない。待つか、新しいバージョンを公開する |
