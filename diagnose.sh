#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
PUBLIC_DOMAIN=
PUBLIC_HTTPS_PORT=443
TLS_CERT=certs/fullchain.pem
TLS_KEY=certs/privkey.pem
WHIP_IP=
PUBLIC_HOST=
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
      PUBLIC_HTTPS_PORT) PUBLIC_HTTPS_PORT=$config_value ;;
      TLS_CERT) TLS_CERT=$config_value ;;
      TLS_KEY) TLS_KEY=$config_value ;;
      WHIP_IP) WHIP_IP=$config_value ;;
      PUBLIC_HOST) PUBLIC_HOST=$config_value ;;
      INGEST_ALLOW_CIDRS) : ;;
      *) echo "config.env 包含未知配置项：$config_key" >&2; exit 1 ;;
    esac
  done < "$config_file"
}
load_config "$ROOT/config.env"
PUBLIC_HTTPS_PORT_VALID=1
case "$PUBLIC_HTTPS_PORT" in
  ""|*[!0-9]*|0*) PUBLIC_HTTPS_PORT_VALID=0 ;;
esac
if [ "$PUBLIC_HTTPS_PORT_VALID" -eq 1 ] \
   && { [ "${#PUBLIC_HTTPS_PORT}" -gt 5 ] \
        || [ "$PUBLIC_HTTPS_PORT" -gt 65535 ]; }; then
  PUBLIC_HTTPS_PORT_VALID=0
fi
if [ "$PUBLIC_HTTPS_PORT_VALID" -ne 1 ]; then
  PUBLIC_ORIGIN="INVALID(PUBLIC_HTTPS_PORT=$PUBLIC_HTTPS_PORT)"
elif [ "$PUBLIC_HTTPS_PORT" = 443 ]; then
  PUBLIC_ORIGIN="https://${PUBLIC_DOMAIN:-未配置}"
else
  PUBLIC_ORIGIN="https://${PUBLIC_DOMAIN:-未配置}:$PUBLIC_HTTPS_PORT"
fi
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
printf '\n公网 Web: %s/\n' "$PUBLIC_ORIGIN"
printf 'Playlist: %s/live/index.m3u8\n' "$PUBLIC_ORIGIN"
printf 'OBS WHIP: http://%s:8889/live/whip\n' "$WHIP_IP"
printf 'OBS RTMP: rtmp://%s:1935 (兼容 x264/SVT-AV1)\n' "$WHIP_IP"
printf '推流网卡: %s (%s)\n' "${INGEST_INTERFACE:-自动检测}" "$WHIP_IP"
printf '允许发布来源: %s\n' "${INGEST_ALLOW_CIDRS:-启动时自动生成局域网段和本机地址}"
printf 'WHEP: %s/rtc/live/whep\n' "$PUBLIC_ORIGIN"
if [ "$PUBLIC_HTTPS_PORT_VALID" -eq 1 ]; then
  printf '公网端口映射: TCP/UDP %s -> 本机 TCP/UDP 443；Alt-Svc 应通告 h3=\":%s\"\n' "$PUBLIC_HTTPS_PORT" "$PUBLIC_HTTPS_PORT"
else
  printf '公网端口映射: FAIL - PUBLIC_HTTPS_PORT 必须是 1～65535 且无前导零\n'
fi
if [ -n "${PUBLIC_HOST:-}" ] && command -v getent >/dev/null 2>&1; then
  host_a=$(getent ahostsv4 "$PUBLIC_HOST" 2>/dev/null | awk 'NF > 0 && !seen[$1]++ { if (out != "") out=out ","; out=out $1 } END { print out }' || true)
  host_aaaa=$(getent ahostsv6 "$PUBLIC_HOST" 2>/dev/null | awk 'NF > 0 && $1 ~ /:/ && $1 !~ /^::ffff:/ && !seen[$1]++ { if (out != "") out=out ","; out=out $1 } END { print out }' || true)
  printf 'WebRTC PUBLIC_HOST: %s (A: %s; AAAA: %s)\n' "$PUBLIC_HOST" "${host_a:-UNRESOLVED}" "${host_aaaa:-none}"
  if [ -z "$host_a" ]; then
    echo 'WebRTC PUBLIC_HOST: FAIL - 没有 IPv4 A 记录'
  elif [ -n "$host_aaaa" ]; then
    echo 'WebRTC PUBLIC_HOST: FAIL - 检测到 AAAA；IPv4-only ICE 部署要求使用无 AAAA 的 PUBLIC_HOST'
  else
    echo 'WebRTC PUBLIC_HOST: PASS - A-only DDNS hostname'
  fi
fi
printf '音频: WHIP/WHEP 使用 Opus；RTMP/AAC 请使用 LL-HLS；网页需点“开启声音”。\n'
if grep -q 'BEGIN R33 WHEP OPUS STEREO' "$ROOT/web/app.js" \
  && grep -q 'sprop-stereo=1' "$ROOT/web/app.js"; then
  echo 'WHEP Opus 立体声协商: PASS - offer stereo=1 / answer stereo=1;sprop-stereo=1'
else
  echo 'WHEP Opus 立体声协商: FAIL - web/app.js 缺少 R33 stereo SDP 修复'
fi
printf 'DNS: PUBLIC_DOMAIN 可使用 A/AAAA；PUBLIC_HOST 必须 A-only；HTTPS/SVCB RR 为可选 HTTP/3 优化。\n\n'
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
printf '\n--- HTTP/3 UDP socket buffer ---\n'
if command -v sysctl >/dev/null 2>&1; then
  RCV=$(sysctl -n net.core.rmem_max 2>/dev/null || true)
  SND=$(sysctl -n net.core.wmem_max 2>/dev/null || true)
  printf 'net.core.rmem_max: %s\n' "${RCV:-UNKNOWN}"
  printf 'net.core.wmem_max: %s\n' "${SND:-UNKNOWN}"
  case "$RCV" in
    ''|*[!0-9]*) ;;
    *)
      case "$SND" in
        ''|*[!0-9]*) ;;
        *)
          if [ "$RCV" -lt 7500000 ] || [ "$SND" -lt 7500000 ]; then
            echo 'HTTP3: WARN - UDP socket buffer is below 7,500,000 bytes; HTTP/3 can still work but QUIC throughput may be reduced.'
          else
            echo 'HTTP3: PASS - UDP socket buffer is at least 7,500,000 bytes.'
          fi
          ;;
      esac
      ;;
  esac
else
  echo 'sysctl command not available'
fi
printf '\n--- UDP/TCP listeners ---\n'
if command -v ss >/dev/null 2>&1; then ss -lntup 2>/dev/null | grep -E '(:443|:1935|:8080|:8888|:8889|:8189|:9998)' || true; else echo 'ss command not available'; fi
if command -v curl >/dev/null 2>&1; then
  metrics_body=$(curl --noproxy '*' -fsS --max-time 2 'http://127.0.0.1:9998/metrics' 2>/dev/null || true)
  if printf '%s\n' "$metrics_body" | grep -Eq '^webrtc_sessions(\{|[[:space:]])' \
     && printf '%s\n' "$metrics_body" | grep -q '^paths{name="live"'; then
    echo 'Metrics: PASS - loopback Prometheus metrics 含 live path 与 WebRTC session 指标'
  else
    echo 'Metrics: WARN - 127.0.0.1:9998 不可读取或缺少预期指标'
  fi
fi
if command -v curl >/dev/null 2>&1; then
  viewer_map=$(curl --noproxy '*' -fsS --max-time 2 'http://127.0.0.1:8080/__internal/whep-sessions' 2>/dev/null || true)
  if printf '%s' "$viewer_map" | grep -q '"sessions"'; then
    echo 'WHEP viewer-map: PASS - loopback session ID -> viewer IP 映射接口可读'
  else
    echo 'WHEP viewer-map: WARN - 127.0.0.1:8080/__internal/whep-sessions 不可读取'
  fi
fi
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
printf '\n--- MediaMTX AV1/VP9/HLS/WebRTC errors (last 120 matches) ---\n'
if [ -f "$ROOT/logs/mediamtx.log" ]; then
  grep -Ei 'ERR|AV1|VP9|HLS|muxer|WebRTC|processing error|RTP' "$ROOT/logs/mediamtx.log" 2>/dev/null | tail -n 120 || true
else
  echo '(not found)'
fi

printf '\n--- MediaMTX supervisor ---\n'
if [ -f "$ROOT/runtime/mediamtx-supervisor.pid" ]; then
  spid=$(cat "$ROOT/runtime/mediamtx-supervisor.pid" 2>/dev/null || true)
  case "$spid" in
    ""|*[!0-9]*) echo "Supervisor: INVALID PID" ;;
    *) if kill -0 "$spid" 2>/dev/null; then echo "Supervisor: RUNNING (PID $spid)"; else echo "Supervisor: STOPPED/STALE (PID $spid)"; fi ;;
  esac
else
  echo "Supervisor: STOPPED"
fi
if [ -f "$ROOT/logs/mediamtx.log" ]; then
  restarts=$(grep -c 'SUPERVISOR MediaMTX exited' "$ROOT/logs/mediamtx.log" 2>/dev/null || true)
  echo "Unexpected MediaMTX exits observed in current log: ${restarts:-0}"
fi
