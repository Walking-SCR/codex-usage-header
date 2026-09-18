#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="${CODEX_USAGE_HEADER_INSTALL_DIR:-$HOME/.codex/plugins/codex-usage-header}"
LAUNCHER_BIN="${CODEX_USAGE_HEADER_LAUNCHER:-$HOME/.local/bin/codex-header}"
APP_DIR="${CODEX_USAGE_HEADER_APP_DIR:-$HOME/Applications/Codex Quota Header.app}"

printf '%s\n' "=== Uninstalling Codex Quota Header (macOS) ==="
rm -rf "$PLUGIN_DIR"
rm -f "$LAUNCHER_BIN"
rm -rf "$APP_DIR"
printf '%s\n' "✓ Removed $PLUGIN_DIR, $LAUNCHER_BIN, and $APP_DIR"
