@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE goto NONODE
"%NODE_EXE%" pc-launcher.mjs --mode=gui %*
if errorlevel 1 pause
exit /b 0
:NONODE
echo [ERROR] Node.js not found in PATH or standard install locations.
echo Install Node.js LTS from https://nodejs.org/ then double-click again.
echo Details are written to logs\launcher-*.log
pause
exit /b 1
