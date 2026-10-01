# Codex Quota Header CLI for PowerShell
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ArgsList
)

$PluginRoot = if ($env:CODEX_USAGE_HEADER_HOME) {
    $env:CODEX_USAGE_HEADER_HOME
} else {
    Join-Path $env:USERPROFILE ".codex\plugins\codex-usage-header"
}
$Launcher = Join-Path $PluginRoot "src\launcher.mjs"

if (-not (Test-Path $Launcher)) {
    Write-Error "[ERROR] Codex Quota Header is not installed at: $PluginRoot`nPlease run bin\install.ps1 in PowerShell first."
    exit 1
}

$NodeBin = if ($env:CODEX_USAGE_HEADER_NODE) {
    $env:CODEX_USAGE_HEADER_NODE
} else {
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $nodeCmd.Source
    } else {
        $cand = @(
            "$env:ProgramFiles\nodejs\node.exe",
            "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
            "$env:ProgramFiles(x86)\nodejs\node.exe"
        ) | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($cand) { $cand } else { $null }
    }
}

if (-not $NodeBin) {
    Write-Error "[ERROR] Node.js was not found in PATH or standard installation paths."
    exit 127
}

& $NodeBin $Launcher @ArgsList
exit $LASTEXITCODE
