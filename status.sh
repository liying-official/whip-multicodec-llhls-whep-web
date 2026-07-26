#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PUBLIC_DOMAIN=
TLS_CERT=certs/fullchain.pem
TLS_KEY=certs/privkey.pem
WHIP_IP=
PUBLIC_HOST=
CONFIGURED_INGEST_ALLOW_CIDRS=
INGEST_ALLOW_CIDRS=
INGEST_INTERFACE=
load_config() {
  config_file=$1
  [ -f "$config_file" ] || return 0
  config_line_no=0
  config_seen=""
  while IFS= read -r config_line || [ -n "$config_line" ]; do
    config_line_no=$((config_line_no + 1))
    config_line=$(printf '%s' "$config_line" | tr -d '\r')
    case "$config_line" in
      ""|'#'*) continue ;;
      *=*) config_key=${config_line%%=*}; config_value=${config_line#*=} ;;
      *) echo "config.env 第 $config_line_no 行不是 KEY=VALUE。" >&2; exit 1 ;;
    esac
    case " $config_seen " in
      *" $config_key "*) echo "config.env 重复设置 $config_key。" >&2; exit 1 ;;
    esac
    config_seen="$config_seen $config_key"
    case "$config_key" in
      PUBLIC_DOMAIN) PUBLIC_DOMAIN=$config_value ;;
      TLS_CERT) TLS_CERT=$config_value ;;
      TLS_KEY) TLS_KEY=$config_value ;;
      WHIP_IP) WHIP_IP=$config_value ;;
      PUBLIC_HOST) PUBLIC_HOST=$config_value ;;
      INGEST_ALLOW_CIDRS) CONFIGURED_INGEST_ALLOW_CIDRS=$config_value ;;
      *) echo "config.env 包含未知配置项：$config_key" >&2; exit 1 ;;
    esac
  done < "$config_file"
}
load_config "$ROOT/config.env"
if [ -r "$ROOT/runtime/ingest.detected" ]; then
  while IFS= read -r detected_line || [ -n "$detected_line" ]; do
    case "$detected_line" in
      INGEST_INTERFACE=*) INGEST_INTERFACE=${detected_line#*=} ;;
      WHIP_IP=*) WHIP_IP=${detected_line#*=} ;;
      INGEST_ALLOW_CIDRS=*) INGEST_ALLOW_CIDRS=${detected_line#*=} ;;
    esac
  done < "$ROOT/runtime/ingest.detected"
fi
if [ -z "$WHIP_IP" ] && command -v ip >/dev/null 2>&1; then
  WHIP_IP=$(ip -o -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}' || true)
fi
if [ -n "$WHIP_IP" ] && command -v ip >/dev/null 2>&1; then
  status_interface_record=$(ip -o -4 addr show up scope global 2>/dev/null | awk -v target="$WHIP_IP" '{split($4, a, "/"); if (a[1] == target) {print $2 "|" $4; exit}}' || true)
  if [ -n "$status_interface_record" ]; then
    [ -n "$INGEST_INTERFACE" ] || INGEST_INTERFACE=${status_interface_record%%|*}
    status_interface_cidr=${status_interface_record#*|}
    [ -n "$INGEST_ALLOW_CIDRS" ] || INGEST_ALLOW_CIDRS="$status_interface_cidr,$WHIP_IP/32"
  fi
fi
[ -n "$WHIP_IP" ] || WHIP_IP=127.0.0.1
[ -n "$INGEST_INTERFACE" ] || INGEST_INTERFACE='未检测'
[ -n "$INGEST_ALLOW_CIDRS" ] || INGEST_ALLOW_CIDRS='未检测（发布应失败关闭）'
case "$(uname -m)" in
  x86_64|amd64) HELPER="$ROOT/bin/helper_linux_amd64" ;;
  aarch64|arm64) HELPER="$ROOT/bin/helper_linux_arm64" ;;
  *) echo "unsupported architecture"; exit 1 ;;
esac
show_pid() {
  name=$1; file=$2; expected=$3; state="STOPPED"
  if [ -f "$file" ]; then
    pid=$(cat "$file" 2>/dev/null || true)
    executable=
    case "$pid" in
      ""|*[!0-9]*) ;;
      *) [ -r "/proc/$pid/cmdline" ] && executable=$(tr '\000' '\n' < "/proc/$pid/cmdline" 2>/dev/null | sed -n '1p') ;;
    esac
    if [ "$executable" = "$expected" ] && kill -0 "$pid" 2>/dev/null; then
      state="RUNNING (PID $pid)"
    elif [ -n "$pid" ]; then
      state="STALE PID ($pid)"
    fi
  fi
  printf '%-14s: %s\n' "$name" "$state"
}
show_tcp() {
  name=$1; addr=$2
  if "$HELPER" tcp --addr "$addr" --timeout 500ms >/dev/null 2>&1; then s=LISTENING; else s='NOT LISTENING'; fi
  printf '%-18s: %s\n' "$name" "$s"
}
show_pid MediaMTX "$ROOT/runtime/mediamtx.pid" "$ROOT/bin/mediamtx"
show_pid Gateway "$ROOT/runtime/gateway.pid" "$HELPER"
show_pid Caddy-HTTPS "$ROOT/runtime/caddy.pid" "$ROOT/bin/caddy"
show_tcp 'WHIP 8889/TCP' "$WHIP_IP:8889"
show_tcp 'RTMP 1935/TCP' "$WHIP_IP:1935"
show_tcp 'WebRTC 8189/TCP' "$WHIP_IP:8189"
show_tcp 'HLS 8888/TCP' '127.0.0.1:8888'
show_tcp 'Gateway 8080/TCP' '127.0.0.1:8080'
show_tcp 'Public 443/TCP' '127.0.0.1:443'
if command -v ss >/dev/null 2>&1; then
  if ss -H -lun 2>/dev/null | grep -Eq '(^|[[:space:]])[^[:space:]]*:443[[:space:]]'; then s=LISTENING; else s='NOT LISTENING'; fi
  printf '%-18s: %s\n' 'Public 443/UDP' "$s"
fi
if command -v ss >/dev/null 2>&1; then
  if ss -H -lun 2>/dev/null | grep -Eq '(^|[[:space:]])[^[:space:]]*:8189[[:space:]]'; then s=LISTENING; else s='NOT LISTENING'; fi
  printf '%-18s: %s\n' 'WebRTC 8189/UDP' "$s"
fi

printf '%-18s: %s\n' 'Ingest interface' "$INGEST_INTERFACE ($WHIP_IP)"
printf '%-18s: %s\n' 'Ingest allow CIDRs' "$INGEST_ALLOW_CIDRS"
