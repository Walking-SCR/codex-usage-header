#!/usr/bin/env bash
# Codex Quota Header - 安全卸载（macOS）
#
# 顺序：先从运行中的渲染器移除组件并停止已核实的插件监控进程，
# 再删除安装文件。默认保留设置与统计数据（--purge 才彻底清除）。
set -uo pipefail

PLUGIN_DIR="${CODEX_USAGE_HEADER_INSTALL_DIR:-$HOME/.codex/plugins/codex-usage-header}"
LAUNCHER_BIN="${CODEX_USAGE_HEADER_LAUNCHER:-$HOME/.local/bin/codex-header}"
APP_DIR="${CODEX_USAGE_HEADER_APP_DIR:-$HOME/Applications/Codex Quota Header.app}"
DATA_DIR="$HOME/Library/Application Support/Codex Quota Header"
LOCK_FILE="${CODEX_USAGE_HEADER_LOCK:-${TMPDIR:-/tmp}/codex-usage-header-monitor.lock}"
CDP_PORT="${CODEX_USAGE_HEADER_CDP_PORT:-9229}"
PURGE=0
for arg in "$@"; do
  [[ "$arg" == "--purge" ]] && PURGE=1
done

validate_target() {
  local path="$1" leaf="$2"
  if [[ "$path" != /* || "$path" == "/" || -L "$path" || "$(/usr/bin/basename "$path")" != "$leaf" ]]; then
    printf '%s\n' "! Refusing unsafe uninstall target: $path" >&2
    exit 2
  fi
}
validate_target "$PLUGIN_DIR" codex-usage-header
validate_target "$LAUNCHER_BIN" codex-header
validate_target "$APP_DIR" 'Codex Quota Header.app'
validate_target "$DATA_DIR" 'Codex Quota Header'

printf '%s\n' "=== Uninstalling Codex Quota Header (macOS) ==="

# 1. 让 launcher 做受控 teardown：移除渲染器组件 + 停止已核实的监控进程
if [[ -x "$LAUNCHER_BIN" ]]; then
  "$LAUNCHER_BIN" --teardown --port "$CDP_PORT" 2>/dev/null || true
fi

# 2. 兜底：核实锁文件中的进程确实属于本插件，再停止
if [[ -f "$LOCK_FILE" ]]; then
  lock_pid="$(/usr/bin/python3 -c 'import json,sys; data=open(sys.argv[1]).read().strip(); print(json.loads(data).get("pid", "") if data.startswith("{") else data)' "$LOCK_FILE" 2>/dev/null || true)"
  if [[ -n "${lock_pid:-}" ]] && /bin/kill -0 "$lock_pid" 2>/dev/null; then
    lock_cmd="$(/bin/ps -p "$lock_pid" -o command= 2>/dev/null || true)"
    if [[ "$lock_cmd" == *"$PLUGIN_DIR/src/monitor.mjs"* ]]; then
      /bin/kill "$lock_pid" 2>/dev/null || true
      for _ in {1..20}; do
        /bin/kill -0 "$lock_pid" 2>/dev/null || break
        /bin/sleep 0.1
      done
      # 再次核实 PID、完整命令行和锁所有权，防止退出后 PID 被复用。
      lock_cmd="$(/bin/ps -p "$lock_pid" -o command= 2>/dev/null || true)"
      lock_now="$(/usr/bin/python3 -c 'import json,sys; data=open(sys.argv[1]).read().strip(); print(json.loads(data).get("pid", "") if data.startswith("{") else data)' "$LOCK_FILE" 2>/dev/null || true)"
      if [[ "$lock_now" == "$lock_pid" && "$lock_cmd" == *"$PLUGIN_DIR/src/monitor.mjs"* ]]; then
        /bin/kill -9 "$lock_pid" 2>/dev/null || true
      fi
      printf '%s\n' "✓ Stopped verified plugin monitor (pid $lock_pid)."
    else
      printf '%s\n' "! Lock held by unrelated process ($lock_pid); left untouched."
    fi
  fi
  # 仅过期且仍属于当前安装目录的锁可清理。
  lock_dir="$(/usr/bin/python3 -c 'import json,sys; data=open(sys.argv[1]).read().strip(); print(json.loads(data).get("installDir", "") if data.startswith("{") else "")' "$LOCK_FILE" 2>/dev/null || true)"
  if [[ "$lock_dir" == "$PLUGIN_DIR" && -n "${lock_pid:-}" ]] && ! /bin/kill -0 "$lock_pid" 2>/dev/null; then
    /bin/rm -f "$LOCK_FILE" 2>/dev/null || true
  fi
fi

# 如果本插件的监控进程仍活着，停止卸载，不删除正在使用的文件。
if [[ -f "$LOCK_FILE" ]]; then
  live_pid="$(/usr/bin/python3 -c 'import json,sys; data=open(sys.argv[1]).read().strip(); print(json.loads(data).get("pid", "") if data.startswith("{") else data)' "$LOCK_FILE" 2>/dev/null || true)"
  if [[ -n "$live_pid" ]] && /bin/kill -0 "$live_pid" 2>/dev/null; then
    live_cmd="$(/bin/ps -p "$live_pid" -o command= 2>/dev/null || true)"
    if [[ "$live_cmd" == *"$PLUGIN_DIR/src/monitor.mjs"* ]]; then
      printf '%s\n' "! Plugin monitor $live_pid is still running; uninstall aborted." >&2
      exit 1
    fi
  fi
fi

# 3. 删除安装文件
/bin/rm -rf "$PLUGIN_DIR"
/bin/rm -f "$LAUNCHER_BIN"
/bin/rm -rf "$APP_DIR"
printf '%s\n' "✓ Removed $PLUGIN_DIR, $LAUNCHER_BIN, and $APP_DIR"

# 4. 数据：默认保留，--purge 才删除
if [[ "$PURGE" == "1" ]]; then
  /bin/rm -rf "$DATA_DIR"
  printf '%s\n' "✓ Purged settings and statistics ($DATA_DIR)."
else
  printf '%s\n' "✓ Kept settings and statistics in $DATA_DIR (use --purge to remove)."
fi

printf '%s\n' "🎉 Uninstallation complete."
