#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="$HOME/Library/Logs"
LOG_FILE="$LOG_DIR/Codex Quota Header.log"
/bin/mkdir -p "$LOG_DIR"

# 脚本型 App 进程无法响应 Launch Services 的激活事件。如果在本进程内
# 同步执行启动逻辑（可能耗时十几秒）或常驻等待监控器，再次点击图标时
# macOS 就会报"应用程序没有响应"。因此这里改为立即派生后台 worker
# 执行真正逻辑，App 进程本身秒退，之后每次点击都会启动全新实例。
if [[ "${1:-}" != "--__worker" ]]; then
  # 停止之前残留的旧 worker 进程，避免旧的退出重试循环干扰
  old_workers=$(/bin/ps -axww -o pid= -o command= | /usr/bin/awk '($0 ~ "codex-usage-header-launcher" || $0 ~ "Codex Quota Header") && $0 ~ "--__worker" { print $1 }' || true)
  for pid in $old_workers; do
    if [[ -n "$pid" && "$pid" != "$$" ]]; then
      /bin/kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  /bin/rm -rf "${TMPDIR:-/tmp}/codex-quota-header-launcher.lock" 2>/dev/null || true
  {
    printf '\n[%s] Launch requested' "$(/bin/date '+%Y-%m-%d %H:%M:%S')"
    printf ' %q' "$@"
    printf '\n'
  } >> "$LOG_FILE"
  nohup /bin/bash "$0" --__worker "$@" >> "$LOG_FILE" 2>&1 &
  disown || true
  exit 0
fi
shift

LOCK_DIR="${TMPDIR:-/tmp}/codex-quota-header-launcher.lock"

acquire_lock() {
  local count=0
  while ! /bin/mkdir "$LOCK_DIR" 2>/dev/null; do
    local lock_pid
    lock_pid=$(/bin/cat "$LOCK_DIR/pid" 2>/dev/null || true)
    if [[ -n "$lock_pid" ]] && ! /bin/kill -0 "$lock_pid" 2>/dev/null; then
      /bin/rm -rf "$LOCK_DIR" 2>/dev/null || true
      continue
    fi
    # 持有者仍存活：绝不删除活锁，只等待（最多 60 秒），超时则放弃启动
    count=$((count + 1))
    if [[ "$count" -ge 120 ]]; then
      echo "launcher lock held by live process ${lock_pid:-unknown}; giving up" >&2
      return 1
    fi
    /bin/sleep 0.5
  done
  /bin/mkdir -p "$LOCK_DIR"
  echo "$$" > "$LOCK_DIR/pid"
}

release_lock() {
  if [[ -f "$LOCK_DIR/pid" ]] && [[ "$(/bin/cat "$LOCK_DIR/pid" 2>/dev/null || true)" == "$$" ]]; then
    /bin/rm -rf "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap release_lock EXIT
acquire_lock || exit 1

desktop_pids() {
  /bin/ps -axww -o pid= -o command= | /usr/bin/awk '
    $0 ~ "/(ChatGPT|Codex)\\.app/Contents/MacOS/(ChatGPT|Codex)" { print $1 }
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
  if [[ "$initial_rc" -eq 3 ]]; then
    exit 0
  fi
  if [[ "$initial_rc" -ne 10 ]]; then
    show_launch_failure_dialog >/dev/null 2>&1 || true
    exit "$initial_rc"
  fi

  # 打开 Codex Quota Header 就是用户明确要求使用仅限本机回环的调试通道
  # 重新启动桌面客户端。先尝试正常退出应用，不显示类似错误的确认提示。
  # 如果 ChatGPT 的正常退出处理器正在等待渲染器或后台辅助进程，
  # 也不能让 AppleScript 阻塞恢复流程。
  /usr/bin/osascript -e 'tell application "ChatGPT" to quit' >/dev/null 2>&1 &
  /usr/bin/osascript -e 'tell application "Codex" to quit' >/dev/null 2>&1 &
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
    if [[ "$retry_rc" -eq 3 ]]; then
      exit 0
    fi
    show_launch_failure_dialog >/dev/null 2>&1 || true
    exit "$retry_rc"
  fi
fi
exit_code=0
exit "$exit_code"
