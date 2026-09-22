#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="$HOME/Library/Logs"
LOG_FILE="$LOG_DIR/Codex Quota Header.log"
/bin/mkdir -p "$LOG_DIR"

desktop_pids() {
  /bin/ps -ax -o pid= -o command= | /usr/bin/awk '
    $2 == "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" ||
    $2 == ENVIRON["HOME"] "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" { print $1 }
  '
}

wait_for_desktop_exit() {
  local attempt clear_checks=0
  for attempt in {1..20}; do
    if [[ -z "$(desktop_pids)" ]]; then
      clear_checks=$((clear_checks + 1))
      [[ "$clear_checks" -ge 3 ]] && return 0
    else
      clear_checks=0
    fi
    /bin/sleep 0.5
  done
  return 1
}

force_stop_desktop() {
  local pid
  while read -r pid; do
    [[ -z "$pid" ]] || /bin/kill -TERM "$pid" 2>/dev/null || true
  done <<< "$(desktop_pids)"
  for _ in {1..5}; do
    [[ -z "$(desktop_pids)" ]] && return 0
    /bin/sleep 1
  done
  while read -r pid; do
    [[ -z "$pid" ]] || /bin/kill -KILL "$pid" 2>/dev/null || true
  done <<< "$(desktop_pids)"
  [[ -z "$(desktop_pids)" ]]
}

run_launcher() {
  local launcher_rc
  {
    printf '\n[%s] Starting codex-header' "$(/bin/date '+%Y-%m-%d %H:%M:%S')"
    printf ' %q' "$@"
    printf '\n'
  } >> "$LOG_FILE"
  "$HOME/.local/bin/codex-header" "$@" >> "$LOG_FILE" 2>&1
  launcher_rc=$?
  printf '[%s] codex-header exit=%s\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" "$launcher_rc" >> "$LOG_FILE"
  return "$launcher_rc"
}

show_force_dialog() {
  /usr/bin/osascript <<'APPLESCRIPT'
tell application "System Events" to set frontmost of process "osascript" to true
display dialog "普通退出没有结束 ChatGPT 主进程。只有在确认没有未保存工作时，才可以强制结束主进程并重启。" with title "Codex Quota Header" buttons {"取消", "强制结束并启动"} default button "取消"
APPLESCRIPT
}

show_launch_failure_dialog() {
  /usr/bin/osascript <<'APPLESCRIPT'
tell application "System Events" to set frontmost of process "osascript" to true
display dialog "Codex Quota Header 启动器执行失败。真实错误已写入：~/Library/Logs/Codex Quota Header.log" with title "Codex Quota Header" buttons {"知道了"} default button "知道了"
APPLESCRIPT
}

if run_launcher "$@"; then
  :
else
  initial_rc=$?
  if [[ "$initial_rc" -ne 10 ]]; then
    show_launch_failure_dialog >/dev/null 2>&1 || true
    exit "$initial_rc"
  fi

  # 打开 Codex Quota Header 就是用户明确要求使用仅限本机回环的调试通道
  # 重新启动桌面客户端。先尝试正常退出应用，不显示类似错误的确认提示。
  # 如果 ChatGPT 的正常退出处理器正在等待渲染器或后台辅助进程，
  # 也不能让 AppleScript 阻塞恢复流程。
  /usr/bin/osascript -e 'tell application "ChatGPT" to quit' >/dev/null 2>&1 &
  quit_pid=$!
  if ! wait_for_desktop_exit; then
    kill "$quit_pid" 2>/dev/null || true
    force_choice=$(show_force_dialog 2>/dev/null || true)
    if [[ "$force_choice" != *"强制结束并启动"* ]] || ! force_stop_desktop; then
      exit 1
    fi
  else
    wait "$quit_pid" 2>/dev/null || true
  fi

  if run_launcher "$@"; then
    :
  else
    retry_rc=$?
    show_launch_failure_dialog >/dev/null 2>&1 || true
    exit "$retry_rc"
  fi
fi
exit_code=0

# 实时监控器服务 Codex 窗口期间，保持常规 .app 进程运行，
# 这样 macOS 才会保留可用于固定图标的正常 Dock 菜单。
while pgrep -f 'codex-usage-header/src/monitor\.mjs' >/dev/null 2>&1; do
  sleep 2
done

exit "$exit_code"
