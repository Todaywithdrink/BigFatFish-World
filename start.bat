@echo off
chcp 65001 >nul
setlocal
set ROOT=%~dp0
set GAME=%ROOT%runtime\stardew\StardewModdingAPI.exe

if not exist "%GAME%" (
  echo 找不到 %GAME%
  echo 请先确认 runtime\stardew 存在。
  pause
  exit /b 1
)

echo [1/2] 启动 AI 桥接服务（这个窗口别关）...
start "AI Villager Bridge" cmd /k node "%ROOT%bridge\server.mjs"
timeout /t 2 >nul

echo [2/2] 启动开发副本...
start "" "%GAME%"
echo 完成。进游戏读档，走到村民面前按对话键（或控制台敲 av_test Abigail）。
timeout /t 3 >nul
