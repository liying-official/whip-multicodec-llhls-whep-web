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

/bin/sh "$ROOT/start.sh" --service

case "$(uname -m)" in
  x86_64|amd64) HELPER="$ROOT/bin/helper_linux_amd64" ;;
  aarch64|arm64) HELPER="$ROOT/bin/helper_linux_arm64" ;;
  *) echo "不支持的 CPU 架构。" >&2; exit 1 ;;
esac

is_expected_process() {
  pidfile=$1
  expected=$2
  [ -f "$pidfile" ] || return 1
  managed_pid=$(cat "$pidfile" 2>/dev/null || true)
  case "$managed_pid" in ""|*[!0-9]*) return 1 ;; esac
  kill -0 "$managed_pid" 2>/dev/null || return 1
  [ -r "/proc/$managed_pid/cmdline" ] || return 1
  managed_executable=$(tr '\000' '\n' < "/proc/$managed_pid/cmdline" 2>/dev/null | sed -n '1p')
  [ "$managed_executable" = "$expected" ]
}

while :; do
  if ! is_expected_process "$ROOT/runtime/mediamtx-supervisor.pid" "/bin/sh" \
     || ! is_expected_process "$ROOT/runtime/gateway.pid" "$HELPER" \
     || ! is_expected_process "$ROOT/runtime/caddy.pid" "$ROOT/bin/caddy"; then
    echo "受管进程意外退出；停止同组服务并交由 systemd 重启。" >&2
    /bin/sh "$ROOT/stop.sh" --preserve-credentials
    exit 1
  fi
  sleep 2
done
