#!/bin/sh
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$ROOT"

HLSJS_VERSION="1.6.16"

PUBLIC_DOMAIN=
TLS_CERT=certs/fullchain.pem
TLS_KEY=certs/privkey.pem
WHIP_IP=
PUBLIC_HOST=
CONFIGURED_INGEST_ALLOW_CIDRS=
INGEST_ALLOW_CIDRS=
INGEST_INTERFACE=

# config.env is data, not shell code. Parsing only known KEY=VALUE fields avoids
# executing arbitrary commands when start.sh is launched with sudo.
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

if [ "$(uname -s)" != "Linux" ]; then
  echo "本包仅支持 Linux / Debian 13。" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64"; HELPER="$ROOT/bin/helper_linux_amd64" ;;
  aarch64|arm64) ARCH="arm64"; HELPER="$ROOT/bin/helper_linux_arm64" ;;
  *) echo "不支持的 CPU 架构: $(uname -m)" >&2; exit 1 ;;
esac
MEDIAMTX_BUNDLED="$ROOT/bin/mediamtx_linux_$ARCH"
[ -f "$HELPER" ] || {
  echo "错误：缺少当前架构的启动辅助程序：$HELPER" >&2
  exit 1
}
chmod +x "$HELPER"

if [ -r /etc/os-release ]; then
  . /etc/os-release
  if [ "${ID:-}" != "debian" ] || [ "${VERSION_ID:-}" != "13" ]; then
    echo "提示：检测到 ${PRETTY_NAME:-未知系统}；本包按 Debian 13 构建和测试。"
  fi
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "HTTPS 公网模式需要绑定 TCP/443 和 UDP/443。请使用：" >&2
  echo "  sudo ./start.sh" >&2
  exit 1
fi

case "$PUBLIC_DOMAIN" in
  "" )
    echo "错误：请先在 config.env 设置 PUBLIC_DOMAIN=你的直播域名" >&2
    exit 1
    ;;
  *[!A-Za-z0-9.-]*|.*|*..*|*.)
    echo "错误：PUBLIC_DOMAIN 格式不合法：$PUBLIC_DOMAIN" >&2
    exit 1
    ;;
esac

if [ -n "$PUBLIC_HOST" ]; then
  case "$PUBLIC_HOST" in
    *[!A-Za-z0-9.:-]*) echo "PUBLIC_HOST 只能是 ASCII 主机名、IPv4 或 IPv6 地址。" >&2; exit 1 ;;
  esac
fi

if ! command -v ip >/dev/null 2>&1; then
  echo "错误：缺少 iproute2 的 ip 命令，无法安全识别局域网网卡和掩码。" >&2
  exit 1
fi

# WHIP_IP 留空时，优先使用默认路由的 RFC1918 地址；如果默认路由使用
# 公网地址，则从已启用的全局 IPv4 网卡中选择第一个 RFC1918 地址。
if [ -z "$WHIP_IP" ]; then
  default_source=$(ip -o -4 route get 1.1.1.1 2>/dev/null | awk '{
    for (i = 1; i <= NF; i++) {
      if ($i == "src" && (i + 1) <= NF) {
        print $(i + 1)
        exit
      }
    }
  }' || true)
  if [ -n "$default_source" ]; then
    default_cidr=$(ip -o -4 addr show up scope global 2>/dev/null | awk -v target="$default_source" '
      {
        split($4, address, "/")
        if (address[1] == target) {
          print $4
          exit
        }
      }' || true)
    if [ -n "$default_cidr" ] \
       && "$HELPER" private-cidrs --value "$default_cidr" >/dev/null 2>&1; then
      WHIP_IP=$default_source
    fi
  fi
fi
if [ -z "$WHIP_IP" ]; then
  for candidate_cidr in $(ip -o -4 addr show up scope global 2>/dev/null | awk '{print $4}'); do
    if "$HELPER" private-cidrs --value "$candidate_cidr" >/dev/null 2>&1; then
      WHIP_IP=${candidate_cidr%/*}
      break
    fi
  done
fi
case "$WHIP_IP" in
  ""|*[!0-9.]*|.*|*..*|*.)
    echo "错误：未找到已启用的 RFC1918 局域网 IPv4；可在 config.env 指定本机私网 WHIP_IP。" >&2
    exit 1
    ;;
esac

interface_record=$(ip -o -4 addr show up scope global 2>/dev/null | awk -v target="$WHIP_IP" '
  {
    split($4, address, "/")
    if (address[1] == target) {
      print $2 "|" $4
      exit
    }
  }' || true)
if [ -z "$interface_record" ]; then
  echo "错误：WHIP_IP=$WHIP_IP 不是本机已启用网卡的全局 IPv4。" >&2
  exit 1
fi
INGEST_INTERFACE=${interface_record%%|*}
INGEST_INTERFACE_CIDR=${interface_record#*|}
if ! "$HELPER" private-cidrs --value "$INGEST_INTERFACE_CIDR" >/dev/null 2>&1; then
  echo "错误：WHIP_IP=$WHIP_IP 不属于 RFC1918 局域网，拒绝开放推流服务。" >&2
  exit 1
fi

# 发布 ACL 每次启动都从真实网卡地址和掩码重建。只允许该局域网网段以及
# 服务器自身的精确 /32 地址，不接受配置文件扩大范围。
INGEST_ALLOW_CIDRS="$INGEST_INTERFACE_CIDR,$WHIP_IP/32"
if [ -n "$CONFIGURED_INGEST_ALLOW_CIDRS" ]; then
  echo "提示：已忽略旧版 INGEST_ALLOW_CIDRS；发布范围由启动时网卡检测强制生成。"
fi

abspath() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$ROOT" "$1" ;;
  esac
}
TLS_CERT_ABS=$(abspath "$TLS_CERT")
TLS_KEY_ABS=$(abspath "$TLS_KEY")

for v in "$PUBLIC_DOMAIN" "$TLS_CERT_ABS" "$TLS_KEY_ABS"; do
  case "$v" in
    *'"'*|*'\'*) echo "配置包含不支持的引号或反斜杠。" >&2; exit 1 ;;
  esac
  if printf '%s' "$v" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    echo "配置包含不支持的控制字符。" >&2
    exit 1
  fi
done

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

if ! INGEST_CIDRS_JSON=$("$HELPER" private-cidrs --value "$INGEST_ALLOW_CIDRS"); then
  echo "错误：自动生成的发布范围未通过 RFC1918 安全校验。" >&2
  exit 1
fi
INGEST_ALLOW_CIDRS=$(printf '%s' "$INGEST_CIDRS_JSON" | tr -d '[]" ')
mkdir -p "$ROOT/bin" "$ROOT/web" "$ROOT/logs" "$ROOT/runtime" "$ROOT/third_party" "$ROOT/certs"
chmod 755 "$ROOT/bin" "$ROOT/web" "$ROOT/third_party"
chmod 700 "$ROOT/logs" "$ROOT/runtime" "$ROOT/certs"
INGEST_STATE_TMP="$ROOT/runtime/ingest.detected.tmp.$$"
{
  printf 'INGEST_INTERFACE=%s\n' "$INGEST_INTERFACE"
  printf 'WHIP_IP=%s\n' "$WHIP_IP"
  printf 'INGEST_ALLOW_CIDRS=%s\n' "$INGEST_ALLOW_CIDRS"
} > "$INGEST_STATE_TMP"
chmod 600 "$INGEST_STATE_TMP"
mv -f "$INGEST_STATE_TMP" "$ROOT/runtime/ingest.detected"

# MediaMTX v1.19.3-r8 是本包随附的修补构建；不能下载官方二进制替换，
# 否则 AOM AV1 RTMP 空 sequence-start 和 WHIP OBU/HLS 兼容修复都会丢失。
[ -f "$MEDIAMTX_BUNDLED" ] || {
  echo "错误：缺少当前架构的修补版 MediaMTX：$MEDIAMTX_BUNDLED" >&2
  exit 1
}

# 首次启动自动获取并校验其余官方依赖；以后无需联网。
"$HELPER" fetch-hlsjs --version "$HLSJS_VERSION" \
  --out "$ROOT/web/hls.min.js" --license "$ROOT/third_party/HLSJS-LICENSE.txt" \
  --version-file "$ROOT/third_party/HLSJS-VERSION.txt"
"$HELPER" fetch-caddy --arch "$ARCH" --out "$ROOT/bin/caddy" \
  --license "$ROOT/third_party/Caddy-LICENSE.txt" \
  --version-file "$ROOT/third_party/Caddy-VERSION.txt"
chmod +x "$MEDIAMTX_BUNDLED" "$ROOT/bin/caddy"

# 公网证书必须有效、密钥匹配且覆盖 PUBLIC_DOMAIN。
"$HELPER" check-cert --cert "$TLS_CERT_ABS" --key "$TLS_KEY_ABS" --domain "$PUBLIC_DOMAIN"

is_managed() {
  pidfile=$1
  expected=$2
  [ -f "$pidfile" ] || return 1
  pid=$(cat "$pidfile" 2>/dev/null || true)
  case "$pid" in ""|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  [ -r "/proc/$pid/cmdline" ] || return 1
  executable=$(tr '\000' '\n' < "/proc/$pid/cmdline" 2>/dev/null | sed -n '1p')
  [ "$executable" = "$expected" ]
}
pid_alive() {
  pidfile=$1
  [ -f "$pidfile" ] || return 1
  pid=$(cat "$pidfile" 2>/dev/null || true)
  case "$pid" in ""|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null
}
stop_managed() {
  pidfile=$1
  expected=$2
  if is_managed "$pidfile" "$expected"; then
    pid=$(cat "$pidfile")
    kill "$pid" 2>/dev/null || true
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
    kill -9 "$pid" 2>/dev/null || true
  elif [ -f "$pidfile" ]; then
    echo "警告：忽略不属于本包的陈旧 PID 文件：$pidfile" >&2
  fi
  rm -f "$pidfile"
}

# 重启即轮换推流码。
stop_managed "$ROOT/runtime/caddy.pid" "$ROOT/bin/caddy"
stop_managed "$ROOT/runtime/gateway.pid" "$HELPER"
stop_managed "$ROOT/runtime/mediamtx.pid" "$ROOT/bin/mediamtx"
rm -f "$ROOT/runtime/mediamtx.generated.yml" "$ROOT/runtime/Caddyfile"

# 在旧进程停止后原子安装当前架构的修补版，支持在原目录安全升级/重启。
cp "$MEDIAMTX_BUNDLED" "$ROOT/bin/mediamtx.install"
chmod 755 "$ROOT/bin/mediamtx.install"
mv -f "$ROOT/bin/mediamtx.install" "$ROOT/bin/mediamtx"

# TCP/443 必须空闲，稍后由 Caddy 同时提供 HTTP/1.1 / HTTP/2。
if "$HELPER" tcp --addr 127.0.0.1:443 --timeout 250ms >/dev/null 2>&1; then
  echo "错误：TCP/443 已被其他服务占用。" >&2
  exit 1
fi
# 如果系统有 ss，也提前检查 UDP/443 是否已被占用。
if command -v ss >/dev/null 2>&1; then
  if ss -H -lun 2>/dev/null | grep -Eq '(^|[[:space:]])[^[:space:]]*:443[[:space:]]'; then
    echo "错误：UDP/443 已被其他服务占用。" >&2
    exit 1
  fi
  if ss -H -lun 2>/dev/null | grep -Eq '(^|[[:space:]])[^[:space:]]*:8189[[:space:]]'; then
    echo "错误：UDP/8189 已被其他服务占用。" >&2
    exit 1
  fi
fi
for addr in "$WHIP_IP:8889" 127.0.0.1:8888 127.0.0.1:8080 "$WHIP_IP:1935" 127.0.0.1:8189; do
  if "$HELPER" tcp --addr "$addr" --timeout 250ms >/dev/null 2>&1; then
    echo "错误：$addr 已被其他程序占用。" >&2
    exit 1
  fi
done

KEYOUT=$("$HELPER" genkey)
STREAM_KEY=$(printf '%s\n' "$KEYOUT" | sed -n 's/^key=//p')
PASS_HASH=$(printf '%s\n' "$KEYOUT" | sed -n 's/^hash=//p')
[ -n "$STREAM_KEY" ] && [ -n "$PASS_HASH" ] || { echo "随机推流码生成失败" >&2; exit 1; }
BEARER_TOKEN="obs:$STREAM_KEY"

if [ -n "$PUBLIC_HOST" ]; then
  ADDITIONAL_HOSTS="[\"$PUBLIC_HOST\"]"
else
  ADDITIONAL_HOSTS="[]"
fi

PASS_HASH_SED=$(escape_sed_replacement "$PASS_HASH")
PUBLISH_IPS_SED=$(escape_sed_replacement "$INGEST_CIDRS_JSON")
INGEST_IP_SED=$(escape_sed_replacement "$WHIP_IP")
ADDITIONAL_HOSTS_SED=$(escape_sed_replacement "$ADDITIONAL_HOSTS")
sed \
  -e "s|__PUBLISH_PASS_HASH__|$PASS_HASH_SED|g" \
  -e "s|__PUBLISH_IPS__|$PUBLISH_IPS_SED|g" \
  -e "s|__INGEST_IP__|$INGEST_IP_SED|g" \
  -e "s|__WEBRTC_ADDITIONAL_HOSTS__|$ADDITIONAL_HOSTS_SED|g" \
  "$ROOT/mediamtx.template.yml" > "$ROOT/runtime/mediamtx.generated.yml"
chmod 600 "$ROOT/runtime/mediamtx.generated.yml"

PUBLIC_DOMAIN_SED=$(escape_sed_replacement "$PUBLIC_DOMAIN")
TLS_CERT_SED=$(escape_sed_replacement "$TLS_CERT_ABS")
TLS_KEY_SED=$(escape_sed_replacement "$TLS_KEY_ABS")
sed \
  -e "s|__PUBLIC_DOMAIN__|$PUBLIC_DOMAIN_SED|g" \
  -e "s|__TLS_CERT__|$TLS_CERT_SED|g" \
  -e "s|__TLS_KEY__|$TLS_KEY_SED|g" \
  -e "s|__INGEST_IP__|$INGEST_IP_SED|g" \
  "$ROOT/Caddyfile.template" > "$ROOT/runtime/Caddyfile"
chmod 600 "$ROOT/runtime/Caddyfile"

if grep -Eq '__[A-Z0-9_]+__' "$ROOT/runtime/mediamtx.generated.yml" "$ROOT/runtime/Caddyfile"; then
  echo "错误：生成配置仍包含未替换的模板占位符。" >&2
  exit 1
fi

# Caddy 强校验：HTTP/1.1 + HTTP/2 + HTTP/3，且 TLS 仅 1.3。
if ! "$ROOT/bin/caddy" validate --config "$ROOT/runtime/Caddyfile" --adapter caddyfile >"$ROOT/logs/caddy-validate.log" 2>&1; then
  cat "$ROOT/logs/caddy-validate.log" >&2
  echo "Caddy 配置校验失败。" >&2
  exit 1
fi

printf '\033[2J\033[H'
printf '%s\n' '============================================================'
printf '%s\n' ' OBS WHIP 多编码直播 - Debian 13 公网安全版'
printf '%s\n' ' Web: HTTP/1.1 + HTTP/2 + HTTP/3，TLS 1.3 ONLY'
printf '%s\n' ' H.264 / HEVC -> LL-HLS；AV1 -> 自动 HLS/WHEP'
printf '%s\n' '============================================================'
printf '\n服务器尚未启动。请先复制下面的 OBS 信息。\n\n'
printf 'OBS 服务      : WHIP\n'
printf 'OBS Server    : http://%s:8889/live/whip\n' "$WHIP_IP"
printf '推流网卡      : %s (%s)\n' "$INGEST_INTERFACE" "$WHIP_IP"
[ -n "$PUBLIC_HOST" ] && printf 'WebRTC ICE Host: %s\n' "$PUBLIC_HOST"
printf 'Stream key    : %s\n' "$STREAM_KEY"
printf 'Bearer Token  : %s\n' "$BEARER_TOKEN"
printf '允许发布来源  : %s\n' "$INGEST_ALLOW_CIDRS"
printf '\n兼容入口（x264/SVT-AV1 断流时使用）：\n'
printf 'OBS 服务      : 自定义\n'
printf 'RTMP Server   : rtmp://%s:1935\n' "$WHIP_IP"
printf 'RTMP Stream key: live?user=obs&pass=%s\n' "$STREAM_KEY"
printf '\n公网网页       : https://%s/\n' "$PUBLIC_DOMAIN"
printf '公网 HLS      : https://%s/live/index.m3u8\n' "$PUBLIC_DOMAIN"
printf '网页声音       : 自动播放初始静音，请点右上角“开启声音”\n'
printf '音频兼容       : WHIP/WHEP=Opus；RTMP/AAC 请使用 LL-HLS\n'
printf '\n公网 Web 同时监听 TCP/443 与 UDP/443；不开放 TCP/80，且 TLS 仅允许 1.3。\n'
printf 'DNS 只需正常 A/AAAA 即可访问；HTTPS/SVCB RR 现在是可选优化，不再是必须项。\n'
printf '\n复制完成后按 Enter 启动服务器，Ctrl+C 取消。\n'
IFS= read -r _

: > "$ROOT/logs/mediamtx.log"
: > "$ROOT/logs/gateway.log"
: > "$ROOT/logs/caddy.log"

nohup "$ROOT/bin/mediamtx" "$ROOT/runtime/mediamtx.generated.yml" >> "$ROOT/logs/mediamtx.log" 2>&1 &
echo $! > "$ROOT/runtime/mediamtx.pid"

# 内部 Web/HLS 网关只绑定 loopback，公网只能经过 Caddy TLS 1.3 边缘。
nohup "$HELPER" serve --dir "$ROOT/web" --addr "127.0.0.1:8080" \
  --hls-backend "http://127.0.0.1:8888" >> "$ROOT/logs/gateway.log" 2>&1 &
echo $! > "$ROOT/runtime/gateway.pid"

nohup "$ROOT/bin/caddy" run --config "$ROOT/runtime/Caddyfile" --adapter caddyfile \
  >> "$ROOT/logs/caddy.log" 2>&1 &
echo $! > "$ROOT/runtime/caddy.pid"

ready=0
i=0
while [ "$i" -lt 60 ]; do
  if "$HELPER" tcp --addr "$WHIP_IP:8889" --timeout 250ms >/dev/null 2>&1 \
     && "$HELPER" tcp --addr 127.0.0.1:8888 --timeout 250ms >/dev/null 2>&1 \
     && "$HELPER" tcp --addr "$WHIP_IP:1935" --timeout 250ms >/dev/null 2>&1 \
     && "$HELPER" tcp --addr 127.0.0.1:8189 --timeout 250ms >/dev/null 2>&1 \
     && "$HELPER" tcp --addr 127.0.0.1:8080 --timeout 250ms >/dev/null 2>&1 \
     && "$HELPER" tcp --addr 127.0.0.1:443 --timeout 250ms >/dev/null 2>&1 \
     && is_managed "$ROOT/runtime/mediamtx.pid" "$ROOT/bin/mediamtx" \
     && is_managed "$ROOT/runtime/gateway.pid" "$HELPER" \
     && is_managed "$ROOT/runtime/caddy.pid" "$ROOT/bin/caddy"; then
    ready=1; break
  fi

  # nohup 后的子进程可能仍处于 fork -> exec 过渡期，此时 PID 已存在，
  # 但 /proc/<pid>/cmdline 还不是目标程序。至少等待 1 秒；只有 PID 确实
  # 退出才提前失败，避免把较慢的 Caddy exec 误判为陈旧 PID。
  if [ "$i" -ge 4 ]; then
    if ! pid_alive "$ROOT/runtime/mediamtx.pid" \
       || ! pid_alive "$ROOT/runtime/gateway.pid" \
       || ! pid_alive "$ROOT/runtime/caddy.pid"; then
      break
    fi
  fi
  sleep 0.25
  i=$((i + 1))
done

if [ "$ready" -ne 1 ]; then
  echo "启动自检失败。最近日志：" >&2
  echo "--- MediaMTX ---" >&2; tail -n 50 "$ROOT/logs/mediamtx.log" >&2 2>/dev/null || true
  echo "--- Gateway ---" >&2; tail -n 50 "$ROOT/logs/gateway.log" >&2 2>/dev/null || true
  echo "--- Caddy ---" >&2; tail -n 80 "$ROOT/logs/caddy.log" >&2 2>/dev/null || true
  echo "--- Caddy validate ---" >&2; tail -n 80 "$ROOT/logs/caddy-validate.log" >&2 2>/dev/null || true
  echo "--- Background PIDs ---" >&2
  for pidfile in "$ROOT/runtime/mediamtx.pid" "$ROOT/runtime/gateway.pid" "$ROOT/runtime/caddy.pid"; do
    pid=$(cat "$pidfile" 2>/dev/null || true)
    printf '%s: %s\n' "$pidfile" "${pid:-missing}" >&2
    case "$pid" in
      ""|*[!0-9]*) ;;
      *) ps -p "$pid" -o pid=,stat=,args= >&2 2>/dev/null || true ;;
    esac
  done
  "$ROOT/stop.sh" >/dev/null 2>&1 || true
  exit 1
fi

# WHIP/RTMP 必须只监听 WHIP_IP。即使模板或未来升级发生回归，也不允许
# 发布控制端口在 0.0.0.0、* 或 IPv6 wildcard 上继续运行。
if command -v ss >/dev/null 2>&1; then
  if ss -H -lnt 2>/dev/null | grep -Eq '(^|[[:space:]])(0\.0\.0\.0|\*|\[::\]):(8889|1935)[[:space:]]'; then
    echo "安全自检失败：TCP/8889 或 TCP/1935 正在 wildcard 地址上监听。" >&2
    "$ROOT/stop.sh" >/dev/null 2>&1 || true
    exit 1
  fi
fi

# 兼容模式要求 TCP/443 和 UDP/443 都可用。
if ! "$HELPER" tcp --addr 127.0.0.1:443 --timeout 500ms >/dev/null 2>&1; then
  echo "启动自检失败：TCP/443 未监听，HTTP/1.1 / HTTP/2 回退不可用。" >&2
  tail -n 80 "$ROOT/logs/caddy.log" >&2 2>/dev/null || true
  "$ROOT/stop.sh" >/dev/null 2>&1 || true
  exit 1
fi

UDP443="UNKNOWN"
if command -v ss >/dev/null 2>&1; then
  if ss -H -lun 2>/dev/null | grep -Eq '(^|[[:space:]])[^[:space:]]*:443[[:space:]]'; then UDP443="LISTENING"; else UDP443="NOT LISTENING"; fi
fi
if [ "$UDP443" = "NOT LISTENING" ]; then
  echo "安全自检失败：UDP/443 未监听。Caddy 日志：" >&2
  tail -n 80 "$ROOT/logs/caddy.log" >&2 2>/dev/null || true
  "$ROOT/stop.sh" >/dev/null 2>&1 || true
  exit 1
fi

printf '\n%s\n' '============================================================'
printf '%s\n' ' 启动成功 - 公网 Web 安全策略已启用'
printf '%s\n' '============================================================'
printf '公网网页       : https://%s/\n' "$PUBLIC_DOMAIN"
printf '公网 HLS      : https://%s/live/index.m3u8\n' "$PUBLIC_DOMAIN"
printf 'Web 协议      : HTTP/1.1 + HTTP/2 + HTTP/3\n'
printf 'TLS           : TLS 1.3 only\n'
printf '0-RTT         : disabled\n'
printf 'TCP/443       : LISTENING (HTTP/1.1 + HTTP/2)\n'
printf 'UDP/443       : %s\n' "$UDP443"
printf '内部 Gateway  : 127.0.0.1:8080\n'
printf '内部 HLS      : 127.0.0.1:8888\n'
printf 'OBS WHIP      : http://%s:8889/live/whip\n' "$WHIP_IP"
printf 'OBS RTMP      : rtmp://%s:1935\n' "$WHIP_IP"
printf '推流网卡      : %s (%s)\n' "$INGEST_INTERFACE" "$WHIP_IP"
printf '允许发布来源  : %s\n' "$INGEST_ALLOW_CIDRS"
printf '公网 WHEP     : https://%s/rtc/live/whep\n' "$PUBLIC_DOMAIN"
printf 'MediaMTX      : v1.19.3-r8（AOM AV1 RTMP/WHIP/HLS 修补版）\n'
printf '网页声音       : 初始静音，请点“开启声音”；RTMP/AAC 请使用 LL-HLS\n'
printf '\nOBS Stream key: %s\n' "$STREAM_KEY"
printf 'Bearer Token  : %s\n' "$BEARER_TOKEN"
printf 'RTMP key      : live?user=obs&pass=%s\n' "$STREAM_KEY"
printf '\nDNS           : A/AAAA 即可；HTTPS/SVCB RR 可选\n'
printf '\n停止：sudo ./stop.sh\n诊断：sudo ./diagnose.sh\n'
printf '\n按 Enter 只关闭本信息界面；服务继续后台运行。\n'
IFS= read -r _ || true
