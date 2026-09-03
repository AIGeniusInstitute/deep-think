#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# 生成 DeepThink 托盘图标（从 desktop/resources/icon.png 派生）
# 输出：
#   desktop/resources/trayTemplate.png      (macOS, 22x22 + @2x)
#   desktop/resources/trayTemplate@2x.png   (macOS retina)
#   desktop/resources/tray.png              (Linux, 32x32)
#   desktop/resources/tray.ico              (Windows, 多尺寸 ico)
# 无 ImageMagick 时静默退出（tray.ts 已 fallback 到空图标，不影响运行）。
# 用法：./scripts/generate-tray-icons.sh
# ──────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/desktop/resources/icon.png"
OUT="$ROOT/desktop/resources"

if [ ! -f "$SRC" ]; then
  echo "⚠️  源图标不存在：$SRC（先准备 icon.png）"; exit 0
fi

if ! command -v convert >/dev/null 2>&1; then
  echo "⚠️  未安装 ImageMagick（convert），跳过托盘图标生成。"
  echo "    安装：apt install imagemagick / brew install imagemagick"
  echo "    托盘将使用空图标 fallback（仅显示 tooltip，不影响功能）。"
  exit 0
fi

echo "▶ 生成托盘图标..."
# macOS Template 图像：纯黑剪影 + alpha，菜单栏随明暗自适应。
# 先提取 alpha 通道作为形状，转纯黑填充，再缩放到目标尺寸。
TMP_MASK="$(mktemp -u).png"
convert "$SRC" -alpha extract -threshold 50% -fill black -colorize 100 \
  "$SRC" -compose DstIn -composite "$TMP_MASK"

# macOS：22x22 基础 + 44x44 retina
convert "$TMP_MASK" -resize 22x22 "$OUT/trayTemplate.png"
convert "$TMP_MASK" -resize 44x44 "$OUT/trayTemplate@2x.png"
# Linux：32x32 彩色
convert "$SRC" -resize 32x32 "$OUT/tray.png"
# Windows：多尺寸 ico（16/24/32/48/256）
convert "$SRC" -define icon:auto-resize=16,24,32,48,256 "$OUT/tray.ico"

rm -f "$TMP_MASK"
echo "✅ 托盘图标已生成到 $OUT/"
