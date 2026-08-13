#!/bin/bash
# Yanluo（言落）· 清除 Gatekeeper 隔离属性（未公证包下载后可能报「已损坏」）
# 双击本文件即可；优先 Yanluo.app，兼容 QuietType.app / 旧路径
set -euo pipefail

cd "$(dirname "$0")"

pick_app() {
  local candidate
  for candidate in \
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
echo "  Yanluo · 修复「已损坏 / 无法打开」"
echo "========================================"
echo

APP="$(pick_app)" || {
  echo "未找到 Yanluo.app。"
  echo "请先把 Yanluo 拖到「应用程序」，再双击本脚本；"
  echo "或把本脚本放到 Yanluo.app 同一文件夹后再试。"
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
