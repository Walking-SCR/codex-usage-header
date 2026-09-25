 # Codex Quota Header - 安全卸载（PowerShell）
 #
 # 顺序：先停止已核实属于本插件的监控进程，再删除安装文件。
 # 默认保留设置与统计数据（-Purge 才彻底清除）。
 param([switch]$Purge)
 $ErrorActionPreference = "SilentlyContinue"

 Write-Host "=== Uninstalling Codex Quota Header (Windows) ===" -ForegroundColor Cyan

 $PluginDir = Join-Path $env:USERPROFILE ".codex\plugins\codex-usage-header"
 $DataDir = Join-Path $env:APPDATA "Codex Quota Header"
 $LockFile = Join-Path $env:TEMP "codex-usage-header-monitor.lock"
 $MonitorPath = Join-Path $PluginDir "src\monitor.mjs"

 # 与 macOS 一样，先通过插件自己的启动器摘除运行中的组件。
 $Node = Get-Command node.exe -ErrorAction SilentlyContinue
 $Launcher = Join-Path $PluginDir "src\launcher.mjs"
 if ($Node -and (Test-Path $Launcher)) {
     & $Node.Source $Launcher --teardown | Out-Null
 }

 # 1. 只停止命令行中包含本插件 monitor.mjs 的 node 进程（逐个核实，不误杀）
 $stopped = 0
 Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
     $cmd = $_.CommandLine
     if ($cmd -and $cmd.IndexOf($MonitorPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
         Stop-Process -Id $_.ProcessId -Force
         $stopped++
         Write-Host "✓ Stopped plugin monitor (pid $($_.ProcessId))." -ForegroundColor Green
     }
 }
 if ($stopped -eq 0) { Write-Host "- No plugin monitor process found." -ForegroundColor Gray }

 # 2. 锁文件：确认无活进程持有后再清理
 $lockGone = $true
 if (Test-Path $LockFile) {
     try {
         $lockPid = (Get-Content $LockFile -Raw | ConvertFrom-Json).pid
     } catch {
         $lockPid = (Get-Content $LockFile -Raw).Trim()
     }
     if ($lockPid -and (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) {
         Write-Host "! Lock held by live process ($lockPid); left untouched." -ForegroundColor Yellow
         $lockGone = $false
     } else {
         Remove-Item -Path $LockFile -Force
     }
 }
 if ($lockGone) { Write-Host "- Monitor lock cleaned." -ForegroundColor Gray }

 # 3. 删除安装文件
 if (Test-Path $PluginDir) {
     Remove-Item -Path $PluginDir -Recurse -Force
     Write-Host "✓ Removed plugin directory." -ForegroundColor Green
 }

 $ShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "ChatGPT (Quota Header).lnk"
 if (Test-Path $ShortcutPath) {
     Remove-Item -Path $ShortcutPath -Force
     Write-Host "✓ Removed desktop shortcut." -ForegroundColor Green
 }

 # 4. 数据：默认保留，-Purge 才删除
 if ($Purge) {
     if (Test-Path $DataDir) {
         Remove-Item -Path $DataDir -Recurse -Force
         Write-Host "✓ Purged settings and statistics." -ForegroundColor Green
     }
 } else {
     Write-Host "✓ Kept settings and statistics in $DataDir (use -Purge to remove)." -ForegroundColor Gray
 }

 Write-Host "🎉 Uninstallation complete." -ForegroundColor Cyan
