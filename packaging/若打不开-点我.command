#!/bin/bash
# QuietType（言落）· 清除 Gatekeeper 隔离属性（未公证包下载后可能报「已损坏」）
# 双击本文件即可；会处理 /Applications/QuietType.app 或同目录下的 QuietType.app（兼容旧版 Yanluo.app）
set -euo pipefail

cd "$(dirname "$0")"

pick_app() {
  local candidate
  for candidate in \
    "/Applications/QuietType.app" \
    "./QuietType.app" \
    "/Applications/Yanluo.app" \
    "./Yanluo.app"; do
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
echo "  QuietType · 修复「已损坏 / 无法打开」"
echo "========================================"
echo

APP="$(pick_app)" || {
  echo "未找到 QuietType.app。"
  echo "请先把 QuietType 拖到「应用程序」，再双击本脚本；"
  echo "或把本脚本放到 QuietType.app 同一文件夹后再试。"
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
