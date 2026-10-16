#!/bin/bash
# 构建 CBCT 每日精读 原生应用并安装到 ~/Applications
set -euo pipefail
cd "$(dirname "$0")"
ROOT_DIR="$(cd .. && pwd)"

# 1. 图标（没有缓存时生成）
if [ ! -f AppIcon.icns ]; then
  swift make-icon.swift AppIcon.iconset
  iconutil -c icns AppIcon.iconset -o AppIcon.icns
fi

# 2. 编译
swift build -c release

# 3. 先完整组装并验证新包，成功后才替换既有安装。
INSTALL_DIR="$HOME/Applications"
APP="$INSTALL_DIR/CBCT每日精读.app"
mkdir -p "$INSTALL_DIR"
STAGING_DIR="$(mktemp -d "$INSTALL_DIR/.cbct-build.XXXXXX")"
STAGED_APP="$STAGING_DIR/CBCT每日精读.app"
BACKUP_APP="$STAGING_DIR/previous.app"
cleanup() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ] && [ -e "$BACKUP_APP" ] && [ ! -e "$APP" ]; then
    if ! mv "$BACKUP_APP" "$APP"; then
      echo "恢复旧应用失败，备份保留在：$BACKUP_APP" >&2
      return
    fi
  fi
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$STAGED_APP/Contents/MacOS" "$STAGED_APP/Contents/Resources"
cp .build/release/CBCTReading "$STAGED_APP/Contents/MacOS/CBCTReading"

cat > "$STAGED_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>CBCTReading</string>
    <key>CFBundleIdentifier</key><string>com.cbct.reading</string>
    <key>CFBundleName</key><string>CBCT每日精读</string>
    <key>CFBundleDisplayName</key><string>CBCT每日精读</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>CFBundleIconFile</key><string>AppIcon</string>
</dict>
</plist>
PLIST

cp AppIcon.icns "$STAGED_APP/Contents/Resources/AppIcon.icns"
mkdir -p "$STAGED_APP/Contents/Resources/scripts"
cp scripts/formula_ocr.py scripts/install_formula_ocr.sh "$STAGED_APP/Contents/Resources/scripts/"
# 数据根目录（papers/library/queue.json 所在处）写进资源，应用启动时读取
printf '%s' "$ROOT_DIR" > "$STAGED_APP/Contents/Resources/ROOT.txt"
codesign --force -s - "$STAGED_APP"
codesign --verify --deep --strict "$STAGED_APP"
if [ -e "$APP" ]; then mv "$APP" "$BACKUP_APP"; fi
mv "$STAGED_APP" "$APP"

echo "安装完成：$APP"
echo "   启动：open \"$APP\""
