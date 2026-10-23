#!/bin/bash
# /Applications/terp.app を、このリポジトリのコードを直接読む形で入れる。
# コードを直したら terp を開き直すだけで反映される（ビルドは要らない）。
# Electron の版を上げたとき・package.json の build を変えたときだけ、もう一度実行する。
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
app="/Applications/terp.app"

if pgrep -f "${app}/Contents/MacOS/terp" > /dev/null; then
  echo "terp が起動しています。⌘Q で閉じてから実行してください。" >&2
  exit 1
fi

cd "${repo}"
npx electron-builder --mac dir > /dev/null
built="${repo}/dist/mac-arm64/terp.app"

# 同梱したコードを外し、リポジトリへのリンクに差し替える
rm -rf "${built}/Contents/Resources/app.asar" "${built}/Contents/Resources/app.asar.unpacked"
ln -s "${repo}" "${built}/Contents/Resources/app"

# 署名の鍵が無いため ad-hoc 署名する。Apple Silicon では署名の無いアプリは起動できない
codesign --force --deep -s - "${built}"

rm -rf "${app}"
ditto "${built}" "${app}"
echo "入れました: ${app} -> ${repo}"
