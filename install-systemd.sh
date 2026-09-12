#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

CHECK_ONLY=0
case "${1:-}" in
  "") ;;
  --check-only) CHECK_ONLY=1 ;;
  *) echo "用法：sudo ./install-systemd.sh [--check-only]" >&2; exit 2 ;;
esac

fail() {
  echo "安全拒绝：$*" >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo ./install-systemd.sh。" >&2
  exit 1
fi
for required_command in realpath stat dirname; do
  command -v "$required_command" >/dev/null 2>&1 || fail "缺少必须命令：$required_command"
done

# Resolve both the caller-visible path and the physical path. A symlink in any
# component (including ROOT itself) makes these differ and is rejected before
# package configuration is read or a systemd unit is touched.
case "$0" in
  /*) SCRIPT_INPUT=$0 ;;
  *) SCRIPT_INPUT=$PWD/$0 ;;
esac
SCRIPT_LEXICAL=$(realpath -s -m -- "$SCRIPT_INPUT") || fail "无法规范化安装器路径。"
ROOT_LEXICAL=$(dirname -- "$SCRIPT_LEXICAL")
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
[ "$ROOT_LEXICAL" = "$ROOT" ] || fail "项目路径包含符号链接：$ROOT_LEXICAL"
[ "$SCRIPT_LEXICAL" = "$ROOT/install-systemd.sh" ] || fail "必须直接执行项目内的 install-systemd.sh。"
[ ! -L "$SCRIPT_LEXICAL" ] || fail "install-systemd.sh 是符号链接。"

case "$ROOT" in
  *[!A-Za-z0-9_./-]*)
    fail "systemd 安装目录不能含空格、引号或其他特殊字符：$ROOT"
    ;;
esac
case "$ROOT" in
  /opt/*|/usr/local/*) ;;
  *) fail "请先将包安装到 /opt 或 /usr/local 下的 root-owned 目录。" ;;
esac

secure_owned_path() {
  secure_path=$1
  secure_kind=${2:-x}
  [ ! -L "$secure_path" ] || fail "$secure_path 是符号链接。"
  [ -e "$secure_path" ] || fail "缺少 $secure_path"
  secure_uid=$(stat -c %u -- "$secure_path")
  secure_mode=$(stat -c %a -- "$secure_path")
  secure_perm=$((0$secure_mode))
  if [ "$secure_uid" -ne 0 ] || [ $((secure_perm & 0022)) -ne 0 ]; then
    fail "$secure_path 必须由 root 所有且不可被组/其他用户写入。"
  fi
  case "$secure_kind" in
    d) [ -d "$secure_path" ] || fail "$secure_path 不是目录。" ;;
    f) [ -f "$secure_path" ] || fail "$secure_path 不是普通文件。" ;;
  esac
}

check_parent_chain() {
  secure_parent=$ROOT
  while :; do
    [ ! -L "$secure_parent" ] || fail "父目录 $secure_parent 是符号链接。"
    [ -d "$secure_parent" ] || fail "父路径 $secure_parent 不是目录。"
    secure_uid=$(stat -c %u -- "$secure_parent")
    secure_mode=$(stat -c %a -- "$secure_parent")
    secure_perm=$((0$secure_mode))
    if [ "$secure_uid" -ne 0 ] || [ $((secure_perm & 0022)) -ne 0 ]; then
      fail "父目录 $secure_parent 必须由 root 所有且不可被组/其他用户写入。"
    fi
    [ "$secure_parent" = / ] && break
    secure_parent=$(dirname -- "$secure_parent")
  done
}

check_parent_chain
secure_owned_path "$ROOT" d
for secure_dir in \
  "$ROOT/bin" "$ROOT/web" "$ROOT/src" "$ROOT/third_party" "$ROOT/patches" \
  "$ROOT/certs" "$ROOT/lib" "$ROOT/tools"; do
  secure_owned_path "$secure_dir" d
done
for secure_file in \
  "$ROOT/install-systemd.sh" "$ROOT/service-manager.sh" "$ROOT/start.sh" \
  "$ROOT/stop.sh" "$ROOT/status.sh" "$ROOT/diagnose.sh" \
  "$ROOT/mediamtx-supervisor.sh" "$ROOT/show-credentials.sh" \
  "$ROOT/config.env" "$ROOT/Caddyfile.template" "$ROOT/mediamtx.template.yml" \
  "$ROOT/SHA256SUMS" "$ROOT/lib/systemd-unit-ownership.sh" \
  "$ROOT/tools/release-managed-files.txt" \
  "$ROOT/web/index.html" "$ROOT/web/app.js" "$ROOT/web/app.css" \
  "$ROOT/web/hls.min.js" "$ROOT/web/hls-weak-network-policy.js" \
  "$ROOT/third_party/HLSJS-LICENSE.txt" "$ROOT/third_party/HLSJS-VERSION.txt" \
  "$ROOT/src/helper.go" "$ROOT/src/helper_test.go" \
  "$ROOT/bin/helper_linux_amd64" "$ROOT/bin/helper_linux_arm64" \
  "$ROOT/bin/mediamtx_linux_amd64" "$ROOT/bin/mediamtx_linux_arm64" \
  "$ROOT/bin/caddy_linux_amd64" "$ROOT/bin/caddy_linux_arm64"; do
  secure_owned_path "$secure_file" f
done
for secure_binary in \
  "$ROOT/bin/helper_linux_amd64" "$ROOT/bin/helper_linux_arm64" \
  "$ROOT/bin/mediamtx_linux_amd64" "$ROOT/bin/mediamtx_linux_arm64" \
  "$ROOT/bin/caddy_linux_amd64" "$ROOT/bin/caddy_linux_arm64"; do
  [ -x "$secure_binary" ] || fail "$secure_binary 不可执行。"
done
for secure_optional_dir in "$ROOT/logs" "$ROOT/runtime" \
  "$ROOT/runtime/caddy-data" "$ROOT/runtime/caddy-config"; do
  if [ -e "$secure_optional_dir" ] || [ -L "$secure_optional_dir" ]; then
    secure_owned_path "$secure_optional_dir" d
  fi
done

# config.env must already be configured before the unit is installed and
# started: start.sh exits 1 on an empty PUBLIC_DOMAIN/PUBLIC_HOST, and the
# enabled unit would just flap in its restart backoff instead of serving.
# Only shell builtins are used so --check-only also works in minimal chroots.
config_cr=$(printf '\r')
config_domain=
config_host=
while IFS= read -r config_line || [ -n "$config_line" ]; do
  case "$config_line" in
    PUBLIC_DOMAIN=*) config_domain=${config_line#PUBLIC_DOMAIN=} ;;
    PUBLIC_HOST=*) config_host=${config_line#PUBLIC_HOST=} ;;
  esac
done < "$ROOT/config.env"
config_domain=${config_domain%"$config_cr"}
config_host=${config_host%"$config_cr"}
if [ -z "$config_domain" ] || [ -z "$config_host" ]; then
  fail "config.env 尚未配置：PUBLIC_DOMAIN 和 PUBLIC_HOST 为空会令 start.sh 拒绝启动，已启用的服务将反复重启。请先填写 config.env 再安装。"
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "install-systemd 信任边界检查：PASS"
  exit 0
fi

if [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null 2>&1; then
  echo "当前系统没有运行 systemd。" >&2
  exit 1
fi
for required_command in mktemp systemd-analyze systemd-notify systemctl timeout flock sha256sum grep sort; do
  command -v "$required_command" >/dev/null 2>&1 || fail "缺少必须命令：$required_command"
done

# The canonical list is independent of SHA256SUMS. Consuming both files in
# lockstep makes missing, extra, duplicate, malformed, and out-of-root entries
# fail before any systemd side effect. config.env remains mutable content, but
# it is still mandatory and subject to path/type/owner/mode checks.
managed_path_is_canonical() {
  managed_path=$1
  case "$managed_path" in
    ""|/*|./*|-*|.|..|../*|*/.|*/..|*//*|*/../*|*/./*|*/|*[!A-Za-z0-9_./-]*)
      return 1
      ;;
  esac
  return 0
}

CANONICAL_MANAGED_FILES=$ROOT/tools/release-managed-files.txt
canonical_count=0
while IFS= read -r canonical_path || [ -n "$canonical_path" ]; do
  managed_path_is_canonical "$canonical_path" \
    || fail "canonical managed-file list 包含不安全路径：$canonical_path"
  canonical_count=$((canonical_count + 1))
done < "$CANONICAL_MANAGED_FILES"
[ "$canonical_count" -gt 0 ] || fail "canonical managed-file list 为空。"
LC_ALL=C sort -c -u "$CANONICAL_MANAGED_FILES" >/dev/null 2>&1 \
  || fail "canonical managed-file list 必须按 LC_ALL=C 排序且路径唯一。"

exec 7< "$CANONICAL_MANAGED_FILES"
exec 8< "$ROOT/SHA256SUMS"
manifest_count=0
manifest_cr=$(printf '\r')
manifest_separator='  '
while IFS= read -r canonical_path <&7 || [ -n "$canonical_path" ]; do
  manifest_line=
  if ! IFS= read -r manifest_line <&8 && [ -z "$manifest_line" ]; then
    fail "SHA256SUMS 缺少 managed file 条目：$canonical_path"
  fi
  case "$manifest_line" in
    ""|*"$manifest_cr"*) fail "SHA256SUMS 包含空行或 CR 控制字符。" ;;
  esac
  manifest_hash=${manifest_line%%"$manifest_separator"*}
  manifest_path=${manifest_line#*"$manifest_separator"}
  if [ "$manifest_line" != "$manifest_hash$manifest_separator$manifest_path" ] \
     || [ "${#manifest_hash}" -ne 64 ]; then
    fail "SHA256SUMS 包含非规范条目。"
  fi
  case "$manifest_hash" in
    *[!0-9a-f]*) fail "SHA256SUMS hash 必须是 64 位 lowercase hex。" ;;
  esac
  managed_path_is_canonical "$manifest_path" \
    || fail "SHA256SUMS 包含不安全路径：$manifest_path"
  [ "$manifest_path" = "$canonical_path" ] \
    || fail "SHA256SUMS 与 canonical managed-file set 不一致：expected=$canonical_path actual=$manifest_path"

  managed_file=$ROOT/$manifest_path
  secure_owned_path "$managed_file" f
  managed_real=$(realpath -e -- "$managed_file" 2>/dev/null) \
    || fail "无法解析 managed file：$manifest_path"
  [ "$managed_real" = "$managed_file" ] \
    || fail "managed file 不是 ROOT 内的规范普通文件：$manifest_path"
  if [ "$manifest_path" != config.env ]; then
    if ! managed_hash_output=$(sha256sum -- "$managed_real"); then
      fail "无法计算 managed file SHA-256：$manifest_path"
    fi
    managed_hash=${managed_hash_output%% *}
    [ "$managed_hash" = "$manifest_hash" ] \
      || fail "项目文件与 SHA256SUMS 不一致：$manifest_path"
  fi
  manifest_count=$((manifest_count + 1))
done
extra_manifest_line=
if IFS= read -r extra_manifest_line <&8 || [ -n "$extra_manifest_line" ]; then
  fail "SHA256SUMS 包含 canonical set 之外的额外条目。"
fi
exec 7<&-
exec 8<&-
[ "$manifest_count" -eq "$canonical_count" ] \
  || fail "SHA256SUMS 与 canonical managed-file set 条目数不一致。"

UNIT_DIR=/etc/systemd/system
UNIT_NAME=obs-whip-live.service
UNIT_FILE=$UNIT_DIR/$UNIT_NAME
secure_owned_path "$UNIT_DIR" d

# Prevent concurrent root invocations from interleaving unit generation and
# daemon-reload. /run is root-managed; the lock itself contains no data.
exec 9>/run/obs-whip-live.install.lock
flock -n 9 || fail "另一个安装进程正在运行。"

# shellcheck source=lib/systemd-unit-ownership.sh
. "$ROOT/lib/systemd-unit-ownership.sh"
unit_ownership_snapshot "$ROOT" "$UNIT_FILE" "$UNIT_NAME"
if [ "$UNIT_DISK_STATE" = ABSENT ] && [ "$UNIT_MANAGER_STATE" = NOT_FOUND ]; then
  : # first install
elif [ "$UNIT_DISK_STATE" = SAME_ROOT ] && [ "$UNIT_MANAGER_STATE" = SAME_ROOT ]; then
  : # exact same-root reinstall
else
  fail "obs-whip-live.service 属于其他部署，或 disk/manager ownership 状态无法安全确认（disk=$UNIT_DISK_STATE manager=$UNIT_MANAGER_STATE）。"
fi

mkdir -p "$ROOT/logs" "$ROOT/runtime" "$ROOT/runtime/caddy-data" "$ROOT/runtime/caddy-config"
chown root:root "$ROOT/logs" "$ROOT/runtime" "$ROOT/runtime/caddy-data" "$ROOT/runtime/caddy-config"
chmod 700 "$ROOT/logs" "$ROOT/runtime" "$ROOT/runtime/caddy-data" "$ROOT/runtime/caddy-config"

UNIT_TMP=$(mktemp "$UNIT_DIR/.obs-whip-live.service.tmp.XXXXXX")
VERIFY_DIR=$(mktemp -d /run/obs-whip-live-unit-verify.XXXXXX)
cleanup_install() {
  [ -z "${UNIT_TMP:-}" ] || rm -f -- "$UNIT_TMP"
  [ -z "${VERIFY_DIR:-}" ] || rm -rf -- "$VERIFY_DIR"
}
trap cleanup_install EXIT HUP INT TERM

{
  printf '%s\n' '[Unit]'
  printf '%s\n' 'Description=OBS WHIP multi-codec live stack'
  printf '%s\n' 'Wants=network-online.target'
  printf '%s\n' 'After=network-online.target'
  printf '\n%s\n' '[Service]'
  printf '%s\n' 'Type=notify'
  printf '%s\n' 'NotifyAccess=all'
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
  printf '%s\n' 'ProtectHome=true'
  printf '%s\n' 'ProtectKernelTunables=true'
  printf '%s\n' 'ProtectKernelModules=true'
  printf '%s\n' 'ProtectControlGroups=true'
  printf '%s\n' 'ProtectKernelLogs=true'
  printf '%s\n' 'ProtectClock=true'
  printf '%s\n' 'ProtectHostname=true'
  printf '%s\n' 'ProtectProc=invisible'
  printf '%s\n' 'ProcSubset=pid'
  printf '%s\n' 'RestrictSUIDSGID=true'
  printf '%s\n' 'RestrictNamespaces=true'
  printf '%s\n' 'RestrictRealtime=true'
  printf '%s\n' 'LockPersonality=true'
  printf '%s\n' 'MemoryDenyWriteExecute=true'
  printf '%s\n' 'SystemCallArchitectures=native'
  printf '%s\n' 'RemoveIPC=true'
  # start.sh uses iproute2/netlink to auto-detect WHIP_IP and its RFC1918
  # interface prefix. Removing AF_NETLINK breaks service-mode startup.
  printf '%s\n' 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK'
  printf '%s\n' 'CapabilityBoundingSet=CAP_NET_BIND_SERVICE'
  printf 'ReadOnlyPaths=%s\n' "$ROOT"
  printf 'ReadWritePaths=%s/logs %s/runtime\n' "$ROOT" "$ROOT"
  printf '\n%s\n' '[Install]'
  printf '%s\n' 'WantedBy=multi-user.target'
} > "$UNIT_TMP"
chown root:root "$UNIT_TMP"
chmod 644 "$UNIT_TMP"

# Verify a correctly named copy before the atomic replacement, then verify the
# installed inode again. mktemp prevents symlink pre-creation and mv replaces a
# prior regular unit atomically without ever exposing partial content.
cp -- "$UNIT_TMP" "$VERIFY_DIR/obs-whip-live.service"
chmod 644 "$VERIFY_DIR/obs-whip-live.service"
systemd-analyze verify "$VERIFY_DIR/obs-whip-live.service"
mv -fT -- "$UNIT_TMP" "$UNIT_FILE"
UNIT_TMP=
chown root:root "$UNIT_FILE"
chmod 644 "$UNIT_FILE"
[ ! -L "$UNIT_FILE" ] || fail "$UNIT_FILE 安装后变成符号链接。"
[ "$(readlink -f -- "$UNIT_FILE")" = "$UNIT_FILE" ] || fail "$UNIT_FILE 安装路径解析异常。"
systemd-analyze verify "$UNIT_FILE"

read_startup_snapshot() {
  active_state='<unavailable>'
  sub_state='<unavailable>'
  result_state='<unavailable>'
  main_pid='<unavailable>'
  restart_count='<unavailable>'
  seen_active=0
  seen_sub=0
  seen_result=0
  seen_pid=0
  seen_restarts=0
  if ! startup_snapshot=$(systemctl show "$UNIT_NAME" \
    -p ActiveState -p SubState -p Result -p MainPID -p NRestarts \
    2>/dev/null); then
    return 1
  fi
  while IFS= read -r snapshot_line; do
    case "$snapshot_line" in
      ActiveState=*)
        [ "$seen_active" -eq 0 ] || return 1
        active_state=${snapshot_line#ActiveState=}
        seen_active=1
        ;;
      SubState=*)
        [ "$seen_sub" -eq 0 ] || return 1
        sub_state=${snapshot_line#SubState=}
        seen_sub=1
        ;;
      Result=*)
        [ "$seen_result" -eq 0 ] || return 1
        result_state=${snapshot_line#Result=}
        seen_result=1
        ;;
      MainPID=*)
        [ "$seen_pid" -eq 0 ] || return 1
        main_pid=${snapshot_line#MainPID=}
        seen_pid=1
        ;;
      NRestarts=*)
        [ "$seen_restarts" -eq 0 ] || return 1
        restart_count=${snapshot_line#NRestarts=}
        seen_restarts=1
        ;;
      *) return 1 ;;
    esac
  done <<EOF
$startup_snapshot
EOF
  [ "$seen_active" -eq 1 ] && [ "$seen_sub" -eq 1 ] \
    && [ "$seen_result" -eq 1 ] && [ "$seen_pid" -eq 1 ] \
    && [ "$seen_restarts" -eq 1 ]
}

startup_snapshot_is_stable() {
  [ "$active_state" = active ] && [ "$sub_state" = running ] \
    && [ "$result_state" = success ] || return 1
  case "$main_pid" in ""|*[!0-9]*) return 1 ;; esac
  [ "$main_pid" -gt 0 ] || return 1
  case "$restart_count" in ""|*[!0-9]*) return 1 ;; esac
  return 0
}

startup_acceptance_failed() {
  failure_kind=$1
  if [ "$failure_kind" = query ]; then
    echo "错误：无法确认 $UNIT_NAME 的稳定启动状态；unit 已安装但启动验收失败。" >&2
  else
    echo "错误：$UNIT_NAME 未通过稳定启动验收；unit 已安装但启动验收失败。" >&2
  fi
  echo "状态：ActiveState=$active_state SubState=$sub_state Result=$result_state MainPID=$main_pid NRestarts=$restart_count" >&2
  if [ -n "${initial_main_pid:-}" ] && [ -n "${initial_restart_count:-}" ]; then
    echo "初始：MainPID=$initial_main_pid NRestarts=$initial_restart_count" >&2
  fi
  echo "请运行：systemctl status $UNIT_NAME" >&2
  echo "以及：journalctl -u $UNIT_NAME -n 50" >&2
  exit 1
}

systemctl daemon-reload
if ! systemctl enable --now "$UNIT_NAME"; then
  # A failed notify start must not leave an automatic restart loop behind.
  unit_ownership_snapshot "$ROOT" "$UNIT_FILE" "$UNIT_NAME"
  if [ "$UNIT_DISK_STATE" = SAME_ROOT ] && [ "$UNIT_MANAGER_STATE" = SAME_ROOT ]; then
    systemctl stop "$UNIT_NAME" || echo "警告：启动失败后的服务停止未完成。" >&2
  fi
  echo "错误：unit 已安装，但服务未确认就绪；启动验收失败。请检查 journalctl -u $UNIT_NAME。" >&2
  exit 1
fi
read_startup_snapshot || startup_acceptance_failed query
startup_snapshot_is_stable || startup_acceptance_failed state
initial_main_pid=$main_pid
initial_restart_count=$restart_count

# Type=notify already waited for explicit startup readiness. Keep the existing
# 152-second observation gate to detect delayed process failure/restart; this
# window is additional stability evidence, not a substitute for readiness.
STARTUP_STABILITY_WINDOW_SECONDS=152
STARTUP_STABILITY_SAMPLE_SECONDS=2
stability_elapsed=0
while [ "$stability_elapsed" -lt "$STARTUP_STABILITY_WINDOW_SECONDS" ]; do
  sleep "$STARTUP_STABILITY_SAMPLE_SECONDS"
  read_startup_snapshot || startup_acceptance_failed query
  startup_snapshot_is_stable || startup_acceptance_failed state
  if [ "$main_pid" != "$initial_main_pid" ] \
    || [ "$restart_count" != "$initial_restart_count" ]; then
    startup_acceptance_failed state
  fi
  stability_elapsed=$((stability_elapsed + STARTUP_STABILITY_SAMPLE_SECONDS))
done
echo "systemd 服务已安全安装并启用：$UNIT_NAME"
echo "查看状态：sudo systemctl status $UNIT_NAME"
echo "查看 OBS 凭据：sudo $ROOT/show-credentials.sh"
