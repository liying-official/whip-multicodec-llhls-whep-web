#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
UNIT_FILE=/etc/systemd/system/obs-whip-live.service
UNIT_TMP="/etc/systemd/system/.obs-whip-live.service.tmp.$$"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo ./install-systemd.sh。" >&2
  exit 1
fi
if [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null 2>&1; then
  echo "当前系统没有运行 systemd。" >&2
  exit 1
fi
case "$ROOT" in
  *[!A-Za-z0-9_./-]*)
    echo "systemd 安装目录不能含空格、引号或其他特殊字符：$ROOT" >&2
    exit 1
    ;;
esac
case "$ROOT" in
  /opt/*|/usr/local/*) ;;
  *)
    echo "请先将包安装到 /opt 或 /usr/local 下的 root-owned 目录。" >&2
    exit 1
    ;;
esac

mkdir -p "$ROOT/logs" "$ROOT/runtime" "$ROOT/runtime/caddy-data" "$ROOT/runtime/caddy-config"
chmod 700 "$ROOT/logs" "$ROOT/runtime"

{
  printf '%s\n' '[Unit]'
  printf '%s\n' 'Description=OBS WHIP multi-codec live stack'
  printf '%s\n' 'Wants=network-online.target'
  printf '%s\n' 'After=network-online.target'
  printf '\n%s\n' '[Service]'
  printf '%s\n' 'Type=simple'
  printf 'WorkingDirectory=%s\n' "$ROOT"
  printf 'ExecStart=/bin/sh %s/service-manager.sh\n' "$ROOT"
  printf '%s\n' 'Restart=on-failure'
  printf '%s\n' 'RestartSec=3s'
  printf '%s\n' 'TimeoutStartSec=180s'
  printf '%s\n' 'TimeoutStopSec=20s'
  printf '%s\n' 'KillMode=mixed'
  printf '%s\n' 'UMask=0077'
  printf 'Environment=XDG_DATA_HOME=%s/runtime/caddy-data\n' "$ROOT"
  printf 'Environment=XDG_CONFIG_HOME=%s/runtime/caddy-config\n' "$ROOT"
  printf '%s\n' 'NoNewPrivileges=true'
  printf '%s\n' 'PrivateTmp=true'
  printf '%s\n' 'PrivateDevices=true'
  printf '%s\n' 'ProtectSystem=strict'
  printf '%s\n' 'ProtectHome=read-only'
  printf '%s\n' 'ProtectKernelTunables=true'
  printf '%s\n' 'ProtectKernelModules=true'
  printf '%s\n' 'ProtectControlGroups=true'
  printf '%s\n' 'RestrictSUIDSGID=true'
  printf '%s\n' 'LockPersonality=true'
  # start.sh uses iproute2/netlink to auto-detect WHIP_IP and its RFC1918
  # interface prefix. Without AF_NETLINK, the default WHIP_IP= service mode
  # fails before binding any listener and systemd enters a restart loop.
  printf '%s\n' 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK'
  printf '%s\n' 'CapabilityBoundingSet=CAP_NET_BIND_SERVICE'
  printf 'ReadWritePaths=%s/bin %s/web %s/third_party %s/logs %s/runtime %s/certs\n' \
    "$ROOT" "$ROOT" "$ROOT" "$ROOT" "$ROOT" "$ROOT"
  printf '\n%s\n' '[Install]'
  printf '%s\n' 'WantedBy=multi-user.target'
} > "$UNIT_TMP"
chmod 644 "$UNIT_TMP"
mv -f "$UNIT_TMP" "$UNIT_FILE"

systemctl daemon-reload
systemctl enable --now obs-whip-live.service
echo "systemd 服务已安装并启用：obs-whip-live.service"
echo "查看状态：sudo systemctl status obs-whip-live.service"
echo "查看 OBS 凭据：sudo $ROOT/show-credentials.sh"
