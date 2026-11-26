#!/bin/sh
# Rust 版を .app にまとめる。macOS の通知は .app から起動したときだけ届く。
# 出力: terp-rs/target/release/bundle/terp.app（ad-hoc 署名）
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$ROOT/.." && pwd)
# Mac 全体の開発の道具の向け先は変えず、ビルドのときだけ Xcode を使う
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export PATH="$HOME/.cargo/bin:$PATH"

cargo build --release --manifest-path "$ROOT/Cargo.toml"

APP="$ROOT/target/release/bundle/terp.app"
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -1)
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/target/release/terp" "$APP/Contents/MacOS/terp"
cp "$REPO/build/icon.icns" "$APP/Contents/Resources/terp.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>terp</string>
  <key>CFBundleIdentifier</key><string>${TERP_BUNDLE_ID:-local.terp.gpui}</string>
  <key>CFBundleName</key><string>terp</string>
  <key>CFBundleDisplayName</key><string>terp</string>
  <key>CFBundleIconFile</key><string>terp</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
PLIST
# 手元の署名用の証明書（既定は「terp local signing」）があれば、それで署名する。
# アドホック署名は作り直すたびに別のアプリとみなされ、macOS の許可を毎回求められるため。無ければアドホック署名にする
IDENTITY="${TERP_SIGN_IDENTITY:-terp local signing}"
if security find-identity -p codesigning 2>/dev/null | grep -qF "\"$IDENTITY\""; then
  codesign --force --deep -s "$IDENTITY" "$APP"
else
  echo "署名用の証明書「$IDENTITY」が無いため、アドホック署名にする（作り直すたびに macOS の許可を求められる）" >&2
  codesign --force --deep -s - "$APP"
fi
echo "$APP"
