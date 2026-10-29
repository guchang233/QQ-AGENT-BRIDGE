#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "未找到 Node.js（需要 24+）"; exit 1; }
[ -d node_modules ] || npm install
[ -f console/dist/index.html ] || npm run build
while true; do
  node bin/qab.mjs start || true
  echo "进程已退出，5 秒后重启（Ctrl+C 停止）"; sleep 5
done
