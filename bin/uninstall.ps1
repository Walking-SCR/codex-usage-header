# Codex Quota Header - 安全卸载程序（PowerShell）
#
# 原则：
# 1. 先优雅停止核实属于本插件的 Node.js 监控进程，绝不伤害用户正在使用的 ChatGPT 客户端；
# 2. 清理桌面与开始菜单快捷方式；
# 3. 删除插件安装目录；
# 4. 默认保留设置与统计数据（使用 -Purge 开关才彻底清理 %APPDATA% 和 %LOCALAPPDATA%）。

[CmdletBinding()]
param(
    [switch]$Purge
)

$ErrorActionPreference = "SilentlyContinue"

Write-Host "`n=== 卸载 Codex Quota Header (Windows) ===" -ForegroundColor Cyan

$PluginDir = Join-Path $env:USERPROFILE ".codex\plugins\codex-usage-header"
$RoamingDir = Join-Path $env:APPDATA "Codex Quota Header"
$LocalDataDir = Join-Path $env:LOCALAPPDATA "Codex Quota Header"
$tempDir = if ($env:TEMP) { $env:TEMP } elseif ($env:TMP) { $env:TMP } else { "C:\Temp" }
$LockFile = Join-Path $tempDir "codex-usage-header-monitor.lock"
$MonitorPath = Join-Path $PluginDir "src\monitor.mjs"

# 1. 尝试调用启动器优雅拆卸
$Node = Get-Command node.exe -ErrorAction SilentlyContinue
$Launcher = Join-Path $PluginDir "src\launcher.mjs"
if ($Node -and (Test-Path $Launcher)) {
    try {
        & $Node.Source $Launcher --teardown | Out-Null
    } catch {}
}

# 2. 逐一核实并停止属于本插件的 monitor.mjs node 进程（绝不误杀其他 Node 进程或 ChatGPT）
$stopped = 0
try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
        $cmd = $_.CommandLine
        if ($cmd -and ($cmd.IndexOf($MonitorPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $cmd.IndexOf("src/monitor.mjs", [StringComparison]::OrdinalIgnoreCase) -ge 0)) {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            $stopped++
            Write-Host "✓ 已停止插件监控器 (PID: $($_.ProcessId))" -ForegroundColor Green
        }
    }
} catch {}

if ($stopped -eq 0) {
    Write-Host "- 未发现运行中的插件监控进程" -ForegroundColor Gray
}

# 3. 锁文件核验与清理
$lockGone = $true
if (Test-Path $LockFile) {
    try {
        $lockContent = Get-Content $LockFile -Raw
        $lockPid = ($lockContent | ConvertFrom-Json).pid
    } catch {
        $lockPid = $lockContent.Trim()
    }
    if ($lockPid -and (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) {
        Write-Host "! 锁文件正被活动进程 ($lockPid) 持有；保留锁文件" -ForegroundColor Yellow
        $lockGone = $false
    } else {
        Remove-Item -Path $LockFile -Force -ErrorAction SilentlyContinue
    }
}
if ($lockGone) {
    Write-Host "- 单实例监控锁已清理" -ForegroundColor Gray
}

# 4. 删除快捷方式与 CLI 命令入口
$DesktopLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "ChatGPT (Quota Header).lnk"
if (Test-Path $DesktopLnk) {
    Remove-Item -Path $DesktopLnk -Force -ErrorAction SilentlyContinue
    Write-Host "✓ 已移除桌面快捷方式" -ForegroundColor Green
}

$StartMenuLnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\ChatGPT (Quota Header).lnk"
if (Test-Path $StartMenuLnk) {
    Remove-Item -Path $StartMenuLnk -Force -ErrorAction SilentlyContinue
    Write-Host "✓ 已移除开始菜单快捷方式" -ForegroundColor Green
}

$UserBin = Join-Path $env:USERPROFILE ".local\bin"
if (Test-Path $UserBin) {
    Remove-Item -Path (Join-Path $UserBin "codex-header.cmd") -Force -ErrorAction SilentlyContinue
    Remove-Item -Path (Join-Path $UserBin "codex-header.ps1") -Force -ErrorAction SilentlyContinue
    Write-Host "✓ 已移除 CLI 命令包装器" -ForegroundColor Green
}

# 5. 删除插件安装文件
if (Test-Path $PluginDir) {
    Remove-Item -Path $PluginDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "✓ 已移除插件主目录: $PluginDir" -ForegroundColor Green
}

# 6. 数据存储处理
if ($Purge) {
    if (Test-Path $RoamingDir) {
        Remove-Item -Path $RoamingDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $LocalDataDir) {
        Remove-Item -Path $LocalDataDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "✓ 已彻底清空所有设置 (%APPDATA%) 与 Token 统计缓存 (%LOCALAPPDATA%)" -ForegroundColor Green
} else {
    Write-Host "✓ 已保留用户设置 ($RoamingDir) 与统计数据 ($LocalDataDir)" -ForegroundColor Gray
    Write-Host "  (如需完全清理，请重新运行带 -Purge 参数的卸载脚本)" -ForegroundColor Gray
}

Write-Host "`n🎉 卸载完成。" -ForegroundColor Cyan
