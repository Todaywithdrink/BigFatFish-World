@echo off
chcp 65001 >nul
setlocal
set ROOT=%~dp0

echo [1/3] 启动 AI 桥接（村民台词）
start "bridge" cmd /k node "%ROOT%bridge\server.mjs"
timeout /t 2 >nul

echo [2/3] 启动世界服务器
start "world" cmd /k node "%ROOT%sim\server.mjs"
timeout /t 2 >nul

echo [3/3] 打开观测窗口
start "" "http://127.0.0.1:8090/"
echo.
echo 关掉那两个黑窗就是停止世界。
timeout /t 3 >nul