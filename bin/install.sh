#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PLUGIN_DIR="${CODEX_USAGE_HEADER_INSTALL_DIR:-$HOME/.codex/plugins/codex-usage-header}"
LAUNCHER_BIN="${CODEX_USAGE_HEADER_LAUNCHER:-$HOME/.local/bin/codex-header}"
APP_DIR="${CODEX_USAGE_HEADER_APP_DIR:-$HOME/Applications/Codex Quota Header.app}"

printf '%s\n' "=== Installing Codex Quota Header (macOS) ==="

# 清理历史可能残留的旧 launcher worker 进程与临时锁文件
old_workers=$(/bin/ps -ax -o pid= -o command= | /usr/bin/awk '($0 ~ "codex-usage-header-launcher" || $0 ~ "Codex Quota Header") && $0 ~ "--__worker" { print $1 }' || true)
for pid in $old_workers; do
  if [[ -n "$pid" ]]; then
    /bin/kill -TERM "$pid" 2>/dev/null || true
  fi
done
pkill -f "codex-usage-header-launcher" 2>/dev/null || true
rm -rf "${TMPDIR:-/tmp}/codex-quota-header-launcher.lock" 2>/dev/null || true

mkdir -p "$PLUGIN_DIR" "$(dirname "$LAUNCHER_BIN")"

if [[ "$ROOT_DIR" != "$PLUGIN_DIR" ]]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude '.git' "$ROOT_DIR/" "$PLUGIN_DIR/"
  else
    cp -R "$ROOT_DIR/." "$PLUGIN_DIR/"
  fi
fi

install -m 0755 "$ROOT_DIR/bin/codex-header" "$LAUNCHER_BIN"
chmod 0755 "$PLUGIN_DIR/bin/install.sh" "$PLUGIN_DIR/bin/uninstall.sh" "$PLUGIN_DIR/bin/codex-header"

mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
install -m 0755 "$ROOT_DIR/bin/codex-usage-header-launcher.sh" "$APP_DIR/Contents/MacOS/Codex Quota Header"
install -m 0644 "$ROOT_DIR/bin/CodexUsageHeaderLauncher-Info.plist" "$APP_DIR/Contents/Info.plist"

printf '%s\n' "✓ Plugin copied to $PLUGIN_DIR"
printf '%s\n' "✓ Launcher installed to $LAUNCHER_BIN"
printf '%s\n' "✓ No-terminal app installed to $APP_DIR"
printf '%s\n' "Run 'codex-header --status' to inspect the injection channel."
printf '%s\n' "Open 'Codex Quota Header.app' from Applications or pin it to the Dock."
