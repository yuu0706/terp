# terp

ターミナルを複数開いて、素早く切り替えるための macOS 用アプリ。左の一覧で開いているターミナルを確かめ、キー1つで切り替える。`claude`・`codex` などの CLI が、通常のターミナルと同じように動く。

![アイコン](build/icon.png)

## できること

- 左の一覧に、開いているターミナルの名前・動いているプログラム・作業場所・状態を出す。
- `claude` が端末のタイトルに出す会話の題名を、一覧の名前にする。応答が終わると、見ていないターミナルに通知の印を付ける。
- `⌘T` と一覧の下のボタンで、表示中と同じ作業場所に新しいターミナルを開く。
- `⌘1`〜`⌘9`・`⌃Tab`・`⌘⇧[`・`⌘⇧]` で切り替える。`⌘W` で閉じる。
- テーマ・強調色・フォント・背景の透過とぼかしを設定ファイルで変える。Ghostty のテーマをそのまま読む。

## 動かす

macOS（Apple Silicon）と Node.js が要る。

```sh
npm install
npm start
```

`/Applications` に入れるときは次のどちらかを使う。

| コマンド | 入れ方 |
| --- | --- |
| `npm run link-app` | アプリがこのリポジトリのコードを直接読む。コードを直したら、terp を開き直すだけで反映される |
| `npm run install-app` | コードを同梱する |

署名の鍵が無いため、どちらも ad-hoc 署名で入れる。手元でビルドしたアプリは、そのまま Finder から起動できる。

## 設定

`~/.config/terp/config.json` に置く。保存すると、開いているターミナルにすぐ反映される。メニューの「設定ファイルを開く」（`⌘,`）で開ける。

```json
{
  "theme": "Catppuccin Mocha",
  "accent": null,
  "fontFamily": "\"JetBrains Mono\", Menlo, monospace",
  "fontSize": 14,
  "backgroundOpacity": 0.85,
  "backgroundBlur": 20
}
```

| 項目 | 内容 |
| --- | --- |
| `theme` | Ghostty のテーマの名前。`~/.config/terp/themes`・`~/.config/ghostty/themes`・Ghostty.app 付属のテーマの順に探す |
| `accent` | 強調色。`null` ならテーマのカーソルの色 |
| `backgroundOpacity` | 背景の不透明度（0.2〜1） |
| `backgroundBlur` | 窓の後ろのぼかし。`true`（半径 20）か半径の数値 |

ぼかしは macOS の非公開の関数（`CGSSetWindowBackgroundBlurRadius`）を呼んでいる。macOS の更新で使えなくなった場合は、ぼかしだけが無くなり、透過は残る。

## 設計

方針・採らなかった案・既知の落とし穴は [docs/design.md](docs/design.md) にまとめている。

## ライセンス

[MIT](LICENSE)
