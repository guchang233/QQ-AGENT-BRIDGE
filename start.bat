@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo 未找到 Node.js，请先安装 Node.js 24 或更高版本：https://nodejs.org/ & pause & exit /b 1)
node -e "process.exit(+process.versions.node.split('.')[0] >= 24 ? 0 : 1)" || (echo 需要 Node.js 24 或更高版本，当前版本过低，请到 https://nodejs.org/ 升级 & pause & exit /b 1)
if not exist node_modules (
  echo 首次运行，正在安装依赖...
  call npm install --omit=dev --no-audit --no-fund || (pause & exit /b 1)
)
if not exist console\dist\index.html (
  echo 正在构建控制台...
  call npm run build || (pause & exit /b 1)
)
:loop
node bin\qab.mjs start
echo.
echo 进程已退出，5 秒后自动重启（关闭窗口即可停止）...
timeout /t 5 >nul
goto loop
