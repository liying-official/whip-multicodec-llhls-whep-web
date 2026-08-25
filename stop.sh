#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PRESERVE_CREDENTIALS=0
case "${1:-}" in
  "") ;;
  --preserve-credentials) PRESERVE_CREDENTIALS=1 ;;
  *) echo "用法：sudo ./stop.sh [--preserve-credentials]" >&2; exit 2 ;;
esac

if [ "$PRESERVE_CREDENTIALS" -eq 0 ] \
   && [ "$(id -u)" -eq 0 ] \
   && command -v systemctl >/dev/null 2>&1 \
   && systemctl is-active --quiet obs-whip-live.service 2>/dev/null; then
  systemctl stop obs-whip-live.service
  rm -f "$ROOT/runtime/publish.credentials"
  echo "systemd 直播服务已停止；持久推流凭据已删除。"
  exit 0
fi
stop_one() {
  file=$1
  expected=$2
  if [ -f "$file" ]; then
    pid=$(cat "$file" 2>/dev/null || true)
    executable=
    case "$pid" in
      ""|*[!0-9]*) ;;
      *)
        # start.sh 失败时，后台 PID 可能仍处于 nohup/fork -> exec 过渡期。
        # 短暂等待命令行稳定后再判断归属，既能终止本包进程，也不会误杀复用 PID。
        i=0
        while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do
          if [ -r "/proc/$pid/cmdline" ]; then
            executable=$(tr '\000' '\n' < "/proc/$pid/cmdline" 2>/dev/null | sed -n '1p')
          fi
          [ "$executable" = "$expected" ] && break
          sleep 0.05
          i=$((i + 1))
        done
        ;;
    esac
    if [ "$executable" = "$expected" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      i=0
      while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
      kill -9 "$pid" 2>/dev/null || true
    elif [ -n "$pid" ]; then
      echo "警告：忽略不属于本包的陈旧 PID：$pid" >&2
    fi
    rm -f "$file"
  fi
}
case "$(uname -m)" in
  x86_64|amd64) HELPER="$ROOT/bin/helper_linux_amd64" ;;
  aarch64|arm64) HELPER="$ROOT/bin/helper_linux_arm64" ;;
  *) HELPER= ;;
esac
stop_one "$ROOT/runtime/caddy.pid" "$ROOT/bin/caddy"
stop_one "$ROOT/runtime/gateway.pid" "$HELPER"
# Tell the supervisor that this shutdown is intentional before stopping the
# current child, otherwise it would immediately recreate MediaMTX.
touch "$ROOT/runtime/mediamtx.stop"
if [ -f "$ROOT/runtime/mediamtx.pid" ]; then
  child=$(cat "$ROOT/runtime/mediamtx.pid" 2>/dev/null || true)
  case "$child" in ""|*[!0-9]*) ;; *) kill -INT "$child" 2>/dev/null || true ;; esac
fi
stop_one "$ROOT/runtime/mediamtx-supervisor.pid" "/bin/sh"
stop_one "$ROOT/runtime/mediamtx.pid" "$ROOT/bin/mediamtx"
rm -f "$ROOT/runtime/mediamtx.stop"
rm -f "$ROOT/runtime/mediamtx.generated.yml" "$ROOT/runtime/Caddyfile"
if [ "$PRESERVE_CREDENTIALS" -eq 1 ]; then
  echo "直播服务器已停止；systemd 推流凭据已保留。"
else
  rm -f "$ROOT/runtime/publish.credentials"
  echo "直播服务器已停止；本次随机推流码已失效。"
fi
