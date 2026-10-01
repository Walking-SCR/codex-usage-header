# Codex Quota Header - Windows 11 x64 安装程序（PowerShell）
#
# 安全与兼容原则：
# 1. 严格核验 x64 架构与 Node.js v18+；
# 2. 不自动终止正在运行的 ChatGPT/Codex 客户端，保护用户未保存的会话；
# 3. 规范分离 Roaming (%APPDATA%) 与 Local (%LOCALAPPDATA%) 存储；
# 4. 创建桌面与开始菜单启动入口；
# 5. 提供 P0 探针引导。

[CmdletBinding()]
param(
    [switch]$SkipProbe,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

Write-Host "`n=== Codex Quota Header - Windows 11 x64 安装程序 ===" -ForegroundColor Cyan

# 1. 操作系统与架构核验
if ([IntPtr]::Size -ne 8) {
    Write-Host "[ERROR] 本插件仅支持 64 位 (x64) 架构，当前系统为 32 位系统。" -ForegroundColor Red
    exit 1
}

$OsVersion = [Environment]::OSVersion.Version
if ($OsVersion.Build -lt 22000) {
    Write-Host "[WARN] 当前 Windows 版本构建号为 $($OsVersion.Build)（低于 Windows 11 Build 22000）。" -ForegroundColor Yellow
    Write-Host "       首版主要面向 Windows 11 x64 原生环境验证，部分窗口几何测量可能需要进一步微调。" -ForegroundColor Yellow
} else {
    Write-Host "✓ Windows 11 x64 环境检测通过 (Build $($OsVersion.Build))" -ForegroundColor Green
}

# 2. Node.js 运行时核验
$Node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $Node) {
    $Candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )
    foreach ($c in $Candidates) {
        if (Test-Path $c) {
            $Node = Get-Item $c
            break
        }
    }
}

if (-not $Node) {
    Write-Host "[ERROR] 未检测到 Node.js。请先安装 Node.js v18 或更高版本 (https://nodejs.org)。" -ForegroundColor Red
    exit 1
}

$NodeVerStr = (& $Node.Source -v).Trim()
$NodeMajor = [int]($NodeVerStr.TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 18) {
    Write-Host "[ERROR] Node.js 版本过低: $NodeVerStr (需 v18.0.0 以上)。" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Node.js 运行时就绪: $NodeVerStr ($($Node.Source))" -ForegroundColor Green

# 3. 客户端检测与非破坏性提示
$StorePackage = Get-AppxPackage -Name *ChatGPT* -ErrorAction SilentlyContinue
$ExecutionAlias = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\ChatGPT.exe"
$RunningProcesses = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' or Name='Codex.exe'" -ErrorAction SilentlyContinue

if ($StorePackage) {
    Write-Host "✓ 识别到 Store/MSIX 版 ChatGPT: $($StorePackage.Name) (v$($StorePackage.Version))" -ForegroundColor Green
} elseif (Test-Path $ExecutionAlias) {
    Write-Host "✓ 找到 ChatGPT 应用执行别名: $ExecutionAlias" -ForegroundColor Green
} else {
    Write-Host "! 未检测到已安装的 ChatGPT Store 包，安装将继续，但启动器将依赖运行中进程或手动路径" -ForegroundColor Yellow
}

if ($RunningProcesses) {
    Write-Host "`n[提示] 检测到 ChatGPT 客户端正在运行中。" -ForegroundColor Yellow
    Write-Host "       为避免干扰正在进行的会话，本安装程序【不会】强退或自动重启您的客户端。" -ForegroundColor Yellow
    Write-Host "       安装完成后，请在保存工作后关闭客户端，并使用本插件提供的快捷方式启动。" -ForegroundColor Yellow
}

# 4. 目录规划与文件复制
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceDir = Split-Path -Parent $ScriptDir
$PluginDir = Join-Path $env:USERPROFILE ".codex\plugins\codex-usage-header"
$RoamingDir = Join-Path $env:APPDATA "Codex Quota Header"
$LocalDataDir = Join-Path $env:LOCALAPPDATA "Codex Quota Header"

Write-Host "`n正在部署插件文件至: $PluginDir ..." -ForegroundColor Gray

if (-not (Test-Path $PluginDir)) {
    New-Item -ItemType Directory -Path $PluginDir -Force | Out-Null
}
if (-not (Test-Path $RoamingDir)) {
    New-Item -ItemType Directory -Path $RoamingDir -Force | Out-Null
}
if (-not (Test-Path $LocalDataDir)) {
    New-Item -ItemType Directory -Path $LocalDataDir -Force | Out-Null
}

# 复制核心源码、静态资源与启动工具
$FilesToCopy = @("src", "bin", "assets", "package.json", "README.md", "SECURITY.md")
foreach ($item in $FilesToCopy) {
    $srcPath = Join-Path $SourceDir $item
    if (Test-Path $srcPath) {
        Copy-Item -Path $srcPath -Destination $PluginDir -Recurse -Force
    }
}

$LauncherPath = Join-Path $PluginDir "src\launcher.mjs"
if (-not (Test-Path $LauncherPath)) {
    Write-Host "[ERROR] 部署完整性核验失败: 未找到 $LauncherPath" -ForegroundColor Red
    exit 1
}
Write-Host "✓ 插件核心模块与静态资产部署成功" -ForegroundColor Green

# 5. 创建桌面与开始菜单快捷方式（设置原生应用图标）
try {
    $WshShell = New-Object -ComObject WScript.Shell

    # 快捷方式通过无窗口 PowerShell 命令启动 node，避免常驻黑框
    $TargetExe = "powershell.exe"
    $TargetArgs = "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command `"& '$($Node.Source)' '$LauncherPath'`""

    # 解析可用的客户端应用图标
    $IconTarget = if ($ExecutionAlias -and (Test-Path $ExecutionAlias)) {
        $ExecutionAlias
    } elseif ($ChatGPTExePath -and (Test-Path $ChatGPTExePath)) {
        $ChatGPTExePath
    } else {
        $null
    }

    # 桌面快捷方式
    $DesktopDir = [Environment]::GetFolderPath("Desktop")
    $DesktopLnk = Join-Path $DesktopDir "ChatGPT (Quota Header).lnk"
    $Shortcut = $WshShell.CreateShortcut($DesktopLnk)
    $Shortcut.TargetPath = $TargetExe
    $Shortcut.Arguments = $TargetArgs
    $Shortcut.WorkingDirectory = $PluginDir
    $Shortcut.Description = "以额度显示插件启动 ChatGPT"
    if ($IconTarget) {
        $Shortcut.IconLocation = "$IconTarget,0"
    }
    $Shortcut.Save()
    Write-Host "✓ 桌面快捷方式已创建: $DesktopLnk" -ForegroundColor Green

    # 开始菜单快捷方式
    $ProgramsDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
    if (Test-Path $ProgramsDir) {
        $StartMenuLnk = Join-Path $ProgramsDir "ChatGPT (Quota Header).lnk"
        $StartShortcut = $WshShell.CreateShortcut($StartMenuLnk)
        $StartShortcut.TargetPath = $TargetExe
        $StartShortcut.Arguments = $TargetArgs
        $StartShortcut.WorkingDirectory = $PluginDir
        $StartShortcut.Description = "以额度显示插件启动 ChatGPT"
        if ($IconTarget) {
            $StartShortcut.IconLocation = "$IconTarget,0"
        }
        $StartShortcut.Save()
        Write-Host "✓ 开始菜单快捷方式已创建: $StartMenuLnk" -ForegroundColor Green
    }
} catch {
    Write-Host "! 快捷方式创建失败 ($($_.Exception.Message))，您仍可使用 CLI 启动。" -ForegroundColor Yellow
}

# 6. 配置全局命令行 CLI 入口（~/.local/bin/codex-header）
$UserBin = Join-Path $env:USERPROFILE ".local\bin"
try {
    if (-not (Test-Path $UserBin)) {
        New-Item -ItemType Directory -Path $UserBin -Force | Out-Null
    }
    Copy-Item -Path (Join-Path $PluginDir "bin\codex-header.cmd") -Destination $UserBin -Force
    if (Test-Path (Join-Path $PluginDir "bin\codex-header.ps1")) {
        Copy-Item -Path (Join-Path $PluginDir "bin\codex-header.ps1") -Destination $UserBin -Force
    }
    Write-Host "✓ 命令行 CLI 工具已部署至: $UserBin" -ForegroundColor Green
} catch {}

# 7. P0 探针引导
$ProbeScript = Join-Path $PluginDir "bin\win-probe.mjs"
if (-not $SkipProbe -and (Test-Path $ProbeScript)) {
    Write-Host "`n=== 运行 P0 适配探针检验环境 ===" -ForegroundColor Cyan
    & $Node.Source $ProbeScript
}

Write-Host "`n🎉 安装流程已完成！" -ForegroundColor Green
Write-Host "• 启动方式 1: 双击桌面或开始菜单上的 'ChatGPT (Quota Header)'"
Write-Host "• 启动方式 2: 在命令行中运行 'codex-header'（支持 CMD 与 PowerShell）"
Write-Host "• 启动方式 3: 直接通过 Node 启动:"
Write-Host "     $($Node.Source) `"$LauncherPath`""
Write-Host "• 查看 P0 探针结果或手动复测:"
Write-Host "     $($Node.Source) `"$ProbeScript`""
