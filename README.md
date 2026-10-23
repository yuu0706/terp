# terp

ターミナルを複数開いて、素早く切り替えるための macOS 用アプリ。左の一覧で開いているターミナルを確かめ、キー1つで切り替える。`claude`・`codex` などの CLI が、通常のターミナルと同じように動く。

![アイコン](build/icon.png)

## できること

- 左の一覧に、開いているターミナルの名前・動いているプログラム・作業場所・状態を出す。
- `claude` が端末のタイトルに出す会話の題名を、一覧の名前にする。応答が終わると、見ていないターミナルに通知の印を付ける。
- `⌘T` と一覧の下のボタンで、表示中と同じ作業場所に新しいターミナルを開く。
- `⌘1`〜`⌘9`・`⌃Tab`・`⌘⇧[`・`⌘⇧]` で切り替える。`⌘W` で閉じる。
- 右の「ファイル」から文字のファイルをタブで編集し、`⌘S` で保存する。外での変更を自動で取り込み、未保存の変更があれば確認する。
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

`⌘,` で設定の画面を開いて変える。変えたらすぐ反映される。設定は `~/.config/terp/config.json` に書かれ、手で書き換えても保存した瞬間に反映される（メニューの「設定ファイルを開く」で開ける）。画面に無い項目（`agents` など）は設定ファイルに書く。

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
| `agents` | 起動のボタンに足す AI エージェント。`[{ "command": "名前か絶対パス", "label": "表示名", "args": "引数", "bypassArgs": "確認を飛ばす引数" }]`。claude・codex などよく使われるものは書かなくても探す |
| `skipApprovals` | `true` なら、エージェントをファイルの読み書きやコマンドの実行の確認なしで起動する（claude は `--dangerously-skip-permissions` など）。⌥ を押しながらボタンを押すと逆になる。既定は `false` |
| `mainAgent` | タブの並びの隣のボタンで、プルダウンなしで起動するエージェントの `command`。書かなければ、見つかった最初のもの |

ぼかしは macOS の非公開の関数（`CGSSetWindowBackgroundBlurRadius`）を呼んでいる。macOS の更新で使えなくなった場合は、ぼかしだけが無くなり、透過は残る。

## 設計

方針・採らなかった案・既知の落とし穴は [docs/design.md](docs/design.md) にまとめている。

## ライセンス

[MIT](LICENSE)
