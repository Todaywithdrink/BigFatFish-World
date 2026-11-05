@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"

echo ============================================================
echo  BigFatFish World - LAN / PUBLIC listen mode
echo ============================================================
echo.
echo  This starts the world on ALL network interfaces.
echo  Default start-sim.bat listens on 127.0.0.1 only.
echo.
echo  WARNING: plain HTTP, no login. Before exposing it:
echo    - keep INVITE_REQUIRED=1 (never turn off invite codes)
echo    - /api/props/act and /api/minds have NO auth; put a
echo      tunnel or reverse proxy with access control in front
echo    - safer option: keep loopback mode and run
echo      cloudflared tunnel --url http://127.0.0.1:8090
echo.
echo  Set AVB_ORIGINS if the viewer is embedded elsewhere.
echo  Press Ctrl+C to stop.
echo.
if "%HOST%"=="" set "HOST=0.0.0.0"
if "%PORT%"=="" set "PORT=8090"
echo  Listening on %HOST%:%PORT%
echo.
node "%ROOT%sim\server.mjs"
echo.
echo  World stopped.
pause
