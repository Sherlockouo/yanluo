#!/bin/bash
# 言落 · 清除 Gatekeeper 隔离属性（未公证包下载后可能报「已损坏」）
# 双击本文件即可；会处理 /Applications/Yanluo.app 或同目录下的 Yanluo.app
set -euo pipefail

cd "$(dirname "$0")"

pick_app() {
  if [[ -d "/Applications/Yanluo.app" ]]; then
    echo "/Applications/Yanluo.app"
    return
  fi
  if [[ -d "./Yanluo.app" ]]; then
    echo "./Yanluo.app"
    return
  fi
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
echo "  言落 · 修复「已损坏 / 无法打开」"
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
