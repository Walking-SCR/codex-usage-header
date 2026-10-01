@echo off
setlocal enabledelayedexpansion

if defined CODEX_USAGE_HEADER_HOME (
    set "PLUGIN_ROOT=%CODEX_USAGE_HEADER_HOME%"
) else (
    set "PLUGIN_ROOT=%USERPROFILE%\.codex\plugins\codex-usage-header"
)

set "LAUNCHER=%PLUGIN_ROOT%\src\launcher.mjs"

if not exist "%LAUNCHER%" (
    echo [ERROR] Codex Quota Header is not installed at: %PLUGIN_ROOT% >&2
    echo Run bin\install.ps1 in PowerShell first. >&2
    exit /b 1
)

if defined CODEX_USAGE_HEADER_NODE (
    set "NODE_BIN=%CODEX_USAGE_HEADER_NODE%"
    goto :run
)

where node.exe >nul 2>nul
if %errorlevel% equ 0 (
    set "NODE_BIN=node.exe"
    goto :run
)

if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
    goto :run
)

if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
    goto :run
)

echo [ERROR] Node.js was not found in PATH or standard installation paths. >&2
exit /b 127

:run
"%NODE_BIN%" "%LAUNCHER%" %*
exit /b %errorlevel%
