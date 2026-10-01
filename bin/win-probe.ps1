# Codex Quota Header - Windows 11 x64 P0 可行性探针启动器
#
# 用法:
#   .\bin\win-probe.ps1 [-Port 9229] [-Json] [-ReportPath <path>]
[CmdletBinding()]
param(
    [int]$Port = 9229,
    [switch]$Json,
    [string]$ReportPath = ""
)

$ErrorActionPreference = "Stop"

Write-Host "=== Codex Quota Header - P0 可行性探针 ===" -ForegroundColor Cyan

# 1. 核验 Node.js 可用性
$Node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $Node) {
    # 尝试在标准目录查找
    $Candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:ProgramFiles(x86)\nodejs\node.exe"
    )
    foreach ($cand in $Candidates) {
        if (Test-Path $cand) {
            $Node = Get-Item $cand
            break
        }
    }
}

if (-not $Node) {
    Write-Host "[ERROR] 未找到 Node.js 执行程序。请先安装 Node.js v18+ (https://nodejs.org)" -ForegroundColor Red
    exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProbeScript = Join-Path $ScriptDir "win-probe.mjs"

if (-not (Test-Path $ProbeScript)) {
    Write-Host "[ERROR] 未找到探针脚本: $ProbeScript" -ForegroundColor Red
    exit 1
}

$ArgsList = @($ProbeScript, "--port", $Port)
if ($Json) {
    $ArgsList += "--json"
}
if ($ReportPath) {
    $ArgsList += @("--report", $ReportPath)
}

& $Node.Source @ArgsList
$ExitCode = $LASTEXITCODE

if ($ExitCode -eq 12) {
    Write-Host "`n[STOP] 触发 P0 止损：Windows 客户端顶栏不可注入，已停止内嵌式顶栏方案！" -ForegroundColor Red
} elseif ($ExitCode -eq 0) {
    Write-Host "`n[SUCCESS] P0 探针所有关键门槛验证通过，可以推进 Windows 原生核心版！" -ForegroundColor Green
}

exit $ExitCode
