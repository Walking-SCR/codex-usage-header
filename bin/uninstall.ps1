 # Codex Quota Header - Windows Uninstaller (PowerShell)
 $ErrorActionPreference = "SilentlyContinue"
 
 Write-Host "=== Uninstalling Codex Quota Header (Windows) ===" -ForegroundColor Cyan
 
 $PluginDir = Join-Path $env:USERPROFILE ".codex\plugins\codex-usage-header"
 if (Test-Path $PluginDir) {
     Remove-Item -Path $PluginDir -Recurse -Force
     Write-Host "✓ Removed plugin directory." -ForegroundColor Green
 }
 
 $ShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "ChatGPT (Quota Header).lnk"
 if (Test-Path $ShortcutPath) {
     Remove-Item -Path $ShortcutPath -Force
     Write-Host "✓ Removed desktop shortcut." -ForegroundColor Green
 }
 
 Write-Host "🎉 Uninstallation complete. Zero residues." -ForegroundColor Cyan
