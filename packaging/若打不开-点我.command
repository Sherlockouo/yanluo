#!/bin/bash
# Sayi · 清除 Gatekeeper 隔离属性（未公证包下载后可能报「已损坏」）
# 双击本文件即可；优先 Sayi.app，兼容旧品牌 Yanluo.app / QuietType.app 路径
set -euo pipefail

cd "$(dirname "$0")"

pick_app() {
  local candidate
  for candidate in \
    "/Applications/Sayi.app" \
    "./Sayi.app" \
    "/Applications/Yanluo.app" \
    "./Yanluo.app" \
    "/Applications/QuietType.app" \
    "./QuietType.app"; do
    if [[ -d "${candidate}" ]]; then
      echo "${candidate}"
      return
    fi
  done
  # DMG / 文件夹里偶发其它名字
  local found
  found="$(find . -maxdepth 1 -name '*.app' -type d 2>/dev/null | head -1 || true)"
  if [[ -n "${found}" ]]; then
    echo "${found}"
    return
  fi
  return 1
}

echo "========================================"
echo "  Sayi · 修复「已损坏 / 无法打开」"
echo "========================================"
echo

APP="$(pick_app)" || {
  echo "未找到 Sayi.app。"
  echo "请先把 Sayi 拖到「应用程序」，再双击本脚本；"
  echo "或把本脚本放到 Sayi.app 同一文件夹后再试。"
  echo
  read -r -p "按回车关闭…" _
  exit 1
}

echo "目标：$APP"
echo "正在清除隔离属性…"
xattr -cr "$APP" || true

echo "正在重新签名（adhoc，本机）…"
codesign --force --deep --sign - "$APP" 2>/dev/null || true

echo
echo "完成。正在打开…"
open "$APP" || true
echo
read -r -p "按回车关闭…" _
