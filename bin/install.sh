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

APPS_BASE_DIR="$(dirname "$APP_DIR")"
for client_label in "Claude" "Antigravity"; do
  client_app_dir="$APPS_BASE_DIR/${client_label} Quota Header.app"
  mkdir -p "$client_app_dir/Contents/MacOS" "$client_app_dir/Contents/Resources"
  install -m 0755 "$ROOT_DIR/bin/codex-usage-header-launcher.sh" "$client_app_dir/Contents/MacOS/Codex Quota Header"
  install -m 0644 "$ROOT_DIR/bin/CodexUsageHeaderLauncher-Info.plist" "$client_app_dir/Contents/Info.plist"
done

if [[ "$(uname -s)" == "Darwin" ]] && command -v clang >/dev/null 2>&1; then
  node "$ROOT_DIR/src/claude-overlay/build-overlay.mjs" >/dev/null 2>&1 || true
  MAIN_M_HASH=$(/usr/bin/shasum -a 256 "$ROOT_DIR/src/claude-overlay/main.m" | /usr/bin/awk '{print $1}')
  PREV_M_HASH=$(cat "$ROOT_DIR/bin/.claude-overlay-helper.sha256" 2>/dev/null || true)
  HELPER_BIN="$ROOT_DIR/bin/claude-overlay-helper"
  if [[ ! -x "$HELPER_BIN" || "$MAIN_M_HASH" != "$PREV_M_HASH" ]]; then
    clang -O2 -framework Cocoa -framework WebKit -framework ApplicationServices "$ROOT_DIR/src/claude-overlay/main.m" -o "$HELPER_BIN" 2>/dev/null || true
    chmod 0755 "$HELPER_BIN" 2>/dev/null || true
    printf '%s' "$MAIN_M_HASH" > "$ROOT_DIR/bin/.claude-overlay-helper.sha256"
  fi
  if [[ -x "$HELPER_BIN" ]] && ! cmp -s "$HELPER_BIN" "$PLUGIN_DIR/bin/claude-overlay-helper" 2>/dev/null; then
    cp -p "$HELPER_BIN" "$PLUGIN_DIR/bin/claude-overlay-helper" 2>/dev/null || true
  fi
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
  PLIST_NAME="com.codex-usage-header.monitor.plist"
  mkdir -p "$LAUNCH_AGENTS_DIR"
  NODE_BIN=""
  for candidate in "${CODEX_USAGE_HEADER_NODE:-}" /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
  if [[ -n "$NODE_BIN" ]]; then
    cat <<PLIST > "$LAUNCH_AGENTS_DIR/$PLIST_NAME"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codex-usage-header.monitor</string>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>--max-old-space-size=192</string>
        <string>${PLUGIN_DIR}/src/monitor.mjs</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/Codex Quota Header.monitor.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/Codex Quota Header.monitor.err.log</string>
</dict>
</plist>
PLIST
    if [[ -z "${CODEX_USAGE_HEADER_LOCK:-}" ]]; then
      launchctl bootout "gui/$(id -u)/com.codex-usage-header.monitor" 2>/dev/null || true
      # 清理可能从开发目录或旧版本手动启动、未被 launchd 托管的残余监控进程与旧版伴侣进程
      stale_monitors=$(/bin/ps -ax -o pid= -o command= | /usr/bin/awk '/codex-usage-header\/src\/monitor\.mjs/ { print $1 }' || true)
      for mpid in $stale_monitors; do
        if [[ -n "$mpid" ]]; then
          /bin/kill -TERM "$mpid" 2>/dev/null || true
        fi
      done
      for _ in {1..20}; do
        alive=$(/bin/ps -ax -o pid= -o command= | /usr/bin/awk '/codex-usage-header\/src\/monitor\.mjs/ { print $1 }' || true)
        [[ -z "$alive" ]] && break
        /bin/sleep 0.1
      done
      stale_helpers=$(/bin/ps -ax -o pid= -o comm= | /usr/bin/awk '/claude-overlay-helper$/ { print $1 }' || true)
      for hpid in $stale_helpers; do
        if [[ -n "$hpid" ]]; then
          /bin/kill -TERM "$hpid" 2>/dev/null || true
        fi
      done
      launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$PLIST_NAME" 2>/dev/null || launchctl load "$LAUNCH_AGENTS_DIR/$PLIST_NAME" 2>/dev/null || true
    fi
  fi
fi

printf '%s\n' "✓ Plugin copied to $PLUGIN_DIR"
printf '%s\n' "✓ Launcher installed to $LAUNCHER_BIN"
printf '%s\n' "✓ No-terminal app installed to $APP_DIR"
printf '%s\n' "Run 'codex-header --status' to inspect the injection channel."
printf '%s\n' "Open 'Codex Quota Header.app' from Applications or pin it to the Dock."
