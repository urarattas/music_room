@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

REM 可修改：端口与监听地址
set "PORT=3000"
set "HOST=0.0.0.0"

echo.
echo   ==========================================
echo      音 乐 听 歌 房  ·  Music Room
echo   ==========================================
echo.

REM ---------- 1. 找到 Node.js ----------
where node >nul 2>&1
if errorlevel 1 goto no_node
echo   [1/2] 已找到 Node.js
node -v
goto node_ok

:no_node
echo   [1/2] 未在 PATH 中找到 Node.js
echo.
echo   请先安装 Node.js 18 或更高版本：
echo       https://nodejs.org/
echo.
echo   安装时保持默认选项即可，装完重新运行本脚本。
echo.
pause
exit /b 1

:node_ok
REM ---------- 2. 检查 Node 版本 ----------
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% lss 18 goto old_node
echo   [2/2] Node.js 版本检查通过
goto node_ver_ok

:old_node
echo   [2/2] Node.js 版本过低（当前 v%NODE_MAJOR%，需要 ^>= 18）
echo         WebRTC 与原生 ES Module 需要 Node 18 或更高版本
echo.
pause
exit /b 1

:node_ver_ok
REM ---------- 打印访问地址 ----------
set "LAN_IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do set "LAN_IP=%%a"
set "LAN_IP=%LAN_IP: =%"

echo.
echo   ==========================================
echo     启动中...
echo.
echo     本机访问:   http://localhost:%PORT%
if not "%LAN_IP%"=="" echo     局域网访问: http://%LAN_IP%:%PORT%
echo.
echo     停止服务: 按 Ctrl+C
echo   ==========================================
echo.

node server\index.js

echo.
echo   服务已停止。
pause
