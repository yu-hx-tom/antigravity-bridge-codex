@echo off
chcp 65001 >nul 2>&1
title Antigravity Codex Bridge
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto no_node

if not defined BRIDGE_DATA_DIR set "BRIDGE_DATA_DIR=%LOCALAPPDATA%\AntigravityCodexBridge"
if not exist "%BRIDGE_DATA_DIR%" mkdir "%BRIDGE_DATA_DIR%" >nul 2>&1
echo writable> "%BRIDGE_DATA_DIR%\.write-test" 2>nul
if errorlevel 1 goto portable_data
del "%BRIDGE_DATA_DIR%\.write-test" >nul 2>&1
goto data_ready

:portable_data
set "BRIDGE_DATA_DIR=%~dp0.data"
if not exist "%BRIDGE_DATA_DIR%" mkdir "%BRIDGE_DATA_DIR%" >nul 2>&1

:data_ready
set "STARTUP_LOG=%~dp0bridge-startup.log"

echo 正在启动 Antigravity Codex Bridge...
echo 管理页面将自动在浏览器中打开，请勿关闭此窗口。
echo 数据目录：%BRIDGE_DATA_DIR%
echo [%date% %time%] starting > "%STARTUP_LOG%"

node server.mjs >> "%STARTUP_LOG%" 2>&1
if errorlevel 1 goto start_failed
exit /b 0

:no_node
echo [错误] 未找到 Node.js 18 或更高版本。
echo 请安装 Node.js 后重新双击本文件。
pause
exit /b 1

:start_failed
echo.
echo [错误] 管理服务启动失败，错误日志如下：
echo ------------------------------------------------------------
type "%STARTUP_LOG%"
echo ------------------------------------------------------------
echo 日志文件：%STARTUP_LOG%
pause
exit /b 1
