 # Codex Quota Header - Windows Installer (PowerShell)
 $ErrorActionPreference = "Stop"
 
 Write-Host "=== Installing Codex Quota Header (Windows) ===" -ForegroundColor Cyan
 
 $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
 $RootDir = Split-Path -Parent $ScriptDir
 $PluginDir = Join-Path $env:USERPROFILE ".codex\plugins\codex-usage-header"
 
 if (!(Test-Path $PluginDir)) {
     New-Item -ItemType Directory -Path $PluginDir -Force | Out-Null
 }
 
 Copy-Item -Path "$RootDir\*" -Destination $PluginDir -Recurse -Force
 Write-Host "✓ Plugin copied to $PluginDir" -ForegroundColor Green
 
 # Create a desktop shortcut if possible
 try {
     $WshShell = New-Object -ComObject WScript.Shell
     $ShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "ChatGPT (Quota Header).lnk"
     $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
     $Shortcut.TargetPath = "node.exe"
     $Shortcut.Arguments = "`"$PluginDir\src\launcher.mjs`""
     $Shortcut.Description = "Start ChatGPT with Codex Quota Header"
     $Shortcut.Save()
     Write-Host "✓ Desktop shortcut created: $ShortcutPath" -ForegroundColor Green
 } catch {
     Write-Host "Note: Desktop shortcut creation skipped." -ForegroundColor Yellow
 }
 
 Write-Host "🎉 Installation complete! Run with: node `"$PluginDir\src\launcher.mjs`"" -ForegroundColor Cyan
