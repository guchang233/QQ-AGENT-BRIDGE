#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "未找到 Node.js（需要 24+）"; exit 1; }
node -e "process.exit(+process.versions.node.split('.')[0] >= 24 ? 0 : 1)" || { echo "需要 Node.js 24+"; exit 1; }
[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund
[ -f console/dist/index.html ] || npm run build
export QAB_SUPERVISED=1
while true; do
  node bin/qab.mjs start || true
  echo "进程已退出，5 秒后重启（Ctrl+C 停止）"; sleep 5
done
