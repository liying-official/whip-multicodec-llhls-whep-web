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
[ -n "$WHIP_IP" ] || WHIP_IP=$(hostname -I 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+\./) {print $i; exit}}' || true)
[ -n "$WHIP_IP" ] || WHIP_IP=127.0.0.1
case "$(uname -m)" in
  x86_64|amd64) HELPER="$ROOT/bin/helper_linux_amd64" ;;
  aarch64|arm64) HELPER="$ROOT/bin/helper_linux_arm64" ;;
  *) echo "unsupported architecture"; exit 1 ;;
esac
"$ROOT/status.sh" || true
printf '\n公网 Web: https://%s/\n' "${PUBLIC_DOMAIN:-未配置}"
printf 'Playlist: https://%s/live/index.m3u8\n' "${PUBLIC_DOMAIN:-未配置}"
printf 'OBS WHIP: http://%s:8889/live/whip\n' "$WHIP_IP"
printf 'OBS RTMP: rtmp://%s:1935 (兼容 x264/SVT-AV1)\n' "$WHIP_IP"
printf '推流网卡: %s (%s)\n' "${INGEST_INTERFACE:-自动检测}" "$WHIP_IP"
printf '允许发布来源: %s\n' "${INGEST_ALLOW_CIDRS:-启动时自动生成局域网段和本机地址}"
printf 'WHEP: https://%s/rtc/live/whep\n' "${PUBLIC_DOMAIN:-未配置}"
printf '音频: WHIP/WHEP 使用 Opus；RTMP/AAC 请使用 LL-HLS；网页需点“开启声音”。\n'
printf 'DNS: A/AAAA 即可；HTTPS/SVCB RR 为可选 HTTP/3 优化。\n\n'
if [ -x "$ROOT/bin/mediamtx" ]; then
  printf 'MediaMTX: '
  "$ROOT/bin/mediamtx" --version 2>/dev/null || echo '(version query failed)'
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$ROOT/bin/mediamtx"
  fi
fi
if [ -n "${PUBLIC_DOMAIN:-}" ]; then
  cert=${TLS_CERT:-certs/fullchain.pem}; key=${TLS_KEY:-certs/privkey.pem}
  case "$cert" in /*) ;; *) cert="$ROOT/$cert" ;; esac
  case "$key" in /*) ;; *) key="$ROOT/$key" ;; esac
  "$HELPER" check-cert --cert "$cert" --key "$key" --domain "$PUBLIC_DOMAIN" || true
fi
if [ -x "$ROOT/bin/caddy" ] && [ -f "$ROOT/runtime/Caddyfile" ]; then
  printf '\n--- Caddy validate ---\n'
  "$ROOT/bin/caddy" validate --config "$ROOT/runtime/Caddyfile" --adapter caddyfile || true
fi
printf '\n--- UDP/TCP listeners ---\n'
if command -v ss >/dev/null 2>&1; then ss -lntup 2>/dev/null | grep -E '(:443|:1935|:8080|:8888|:8889|:8189)' || true; else echo 'ss command not available'; fi
if command -v ss >/dev/null 2>&1; then
  if ss -H -lnt 2>/dev/null | grep -Eq '(^|[[:space:]])(0\.0\.0\.0|\*|\[::\]):(8889|1935)[[:space:]]'; then
    echo 'SECURITY: FAIL - TCP/8889 或 TCP/1935 正在 wildcard 地址监听'
  else
    echo 'SECURITY: PASS - 发布控制端口未使用 wildcard 监听'
  fi
fi
for f in mediamtx.log gateway.log caddy.log caddy-validate.log; do
  printf '\n--- logs/%s (last 80 lines) ---\n' "$f"
  tail -n 80 "$ROOT/logs/$f" 2>/dev/null || echo '(not found)'
done
printf '\n--- MediaMTX AV1/HLS/WebRTC errors (last 120 matches) ---\n'
if [ -f "$ROOT/logs/mediamtx.log" ]; then
  grep -Ei 'ERR|AV1|HLS|muxer|WebRTC|processing error|RTP' "$ROOT/logs/mediamtx.log" 2>/dev/null | tail -n 120 || true
else
  echo '(not found)'
fi
