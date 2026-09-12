#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)

if [ "$(id -u)" -ne 0 ]; then
  echo "service-manager.sh 必须由 root/systemd 运行。" >&2
  exit 1
fi

shutdown_service() {
  trap - INT TERM HUP
  /bin/sh "$ROOT/stop.sh" --preserve-credentials
  exit 0
}
trap shutdown_service INT TERM HUP

# Child programs (notably Caddy) can emit their own READY notification. Only
# this supervisor may acknowledge the complete stack's startup checks.
(unset NOTIFY_SOCKET; exec /bin/sh "$ROOT/start.sh" --service)

# start.sh returns only after all process identities, listeners and exposure
# checks pass. Notify the current systemd start job, never a stale disk marker.
if [ -n "${NOTIFY_SOCKET:-}" ]; then
  if ! systemd-notify --ready --status='Live stack startup checks passed'; then
    echo "无法向 systemd 确认服务就绪。" >&2
    /bin/sh "$ROOT/stop.sh" --preserve-credentials
    exit 1
  fi
fi

case "$(uname -m)" in
  x86_64|amd64) HELPER="$ROOT/bin/helper_linux_amd64"; CADDY="$ROOT/bin/caddy_linux_amd64" ;;
  aarch64|arm64) HELPER="$ROOT/bin/helper_linux_arm64"; CADDY="$ROOT/bin/caddy_linux_arm64" ;;
  *) echo "不支持的 CPU 架构。" >&2; exit 1 ;;
esac

is_expected_process() {
  pidfile=$1
  expected=$2
  required_arg=${3:-}
  [ -f "$pidfile" ] || return 1
  managed_pid=$(cat "$pidfile" 2>/dev/null || true)
  case "$managed_pid" in ""|*[!0-9]*) return 1 ;; esac
  kill -0 "$managed_pid" 2>/dev/null || return 1
  [ -r "/proc/$managed_pid/cmdline" ] || return 1
  managed_executable=$(tr '\000' '\n' < "/proc/$managed_pid/cmdline" 2>/dev/null | sed -n '1p')
  [ "$managed_executable" = "$expected" ] || return 1
  if [ -n "$required_arg" ]; then
    managed_arg=$(tr '\000' '\n' < "/proc/$managed_pid/cmdline" 2>/dev/null | sed -n '2p')
    [ "$managed_arg" = "$required_arg" ] || return 1
  fi
  return 0
}

while :; do
  if ! is_expected_process "$ROOT/runtime/mediamtx-supervisor.pid" "/bin/sh" "$ROOT/mediamtx-supervisor.sh" \
     || ! is_expected_process "$ROOT/runtime/gateway.pid" "$HELPER" \
     || ! is_expected_process "$ROOT/runtime/caddy.pid" "$CADDY"; then
    echo "受管进程意外退出；停止同组服务并交由 systemd 重启。" >&2
    /bin/sh "$ROOT/stop.sh" --preserve-credentials
    exit 1
  fi
  sleep 2
done
