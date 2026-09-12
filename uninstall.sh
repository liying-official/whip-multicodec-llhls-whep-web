#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() {
  echo "安全拒绝：$*" >&2
  exit 1
}

usage() {
  echo "用法：sudo ./uninstall.sh [--purge]" >&2
  echo "  停止并移除 obs-whip-live.service。默认保留项目目录（含 config.env、" >&2
  echo "  证书与持久推流凭据）。--purge 会连项目目录一起删除，不可恢复。" >&2
}

PURGE=0
case "${1:-}" in
  "") ;;
  --purge) PURGE=1 ;;
  *) usage; exit 2 ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo ./uninstall.sh。" >&2
  exit 1
fi

case "$0" in
  /*) SCRIPT_INPUT=$0 ;;
  *) SCRIPT_INPUT=$PWD/$0 ;;
esac
[ ! -L "$SCRIPT_INPUT" ] || fail "uninstall.sh 不能是符号链接。"
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)

for marker in start.sh stop.sh install-systemd.sh config.env; do
  [ -f "$ROOT/$marker" ] || fail "$ROOT 不是本项目目录（缺少 $marker）。"
done
[ ! -L "$ROOT" ] || fail "项目目录不能是符号链接。"

case "$ROOT" in
  *[!A-Za-z0-9_./-]*)
    fail "项目路径不能含空格、引号或其他特殊字符：$ROOT"
    ;;
esac
case "$ROOT" in
  /opt/*|/usr/local/*) ;;
  *) fail "只允许卸载 /opt 或 /usr/local 下的项目目录：$ROOT" ;;
esac
case "$ROOT" in
  /opt|/usr/local|/)
    fail "拒绝删除顶层目录：$ROOT"
    ;;
esac

UNIT_NAME=obs-whip-live.service
UNIT_FILE=/etc/systemd/system/$UNIT_NAME
OWNERSHIP_HELPER=$ROOT/lib/systemd-unit-ownership.sh
for required_command in realpath stat systemctl grep mktemp cp mv; do
  command -v "$required_command" >/dev/null 2>&1 \
    || fail "缺少必须命令：$required_command"
done
[ ! -L "$OWNERSHIP_HELPER" ] && [ -f "$OWNERSHIP_HELPER" ] \
  || fail "$OWNERSHIP_HELPER 必须是普通、非符号链接文件。"
helper_uid=$(stat -c %u -- "$OWNERSHIP_HELPER")
helper_mode=$(stat -c %a -- "$OWNERSHIP_HELPER")
helper_perm=$((0$helper_mode))
if [ "$helper_uid" -ne 0 ] || [ $((helper_perm & 0022)) -ne 0 ]; then
  fail "$OWNERSHIP_HELPER 必须由 root 所有且不可被组/其他用户写入。"
fi
STOP_SCRIPT=$ROOT/stop.sh
[ ! -L "$STOP_SCRIPT" ] && [ -f "$STOP_SCRIPT" ] || fail "stop.sh 必须是普通文件。"
stop_uid=$(stat -c %u -- "$STOP_SCRIPT")
stop_mode=$(stat -c %a -- "$STOP_SCRIPT")
[ "$stop_uid" -eq 0 ] && [ $((0$stop_mode & 0022)) -eq 0 ] || fail "stop.sh 必须由 root 所有且不可被组/其他用户写入。"

# shellcheck source=lib/systemd-unit-ownership.sh
. "$OWNERSHIP_HELPER"
unit_ownership_snapshot "$ROOT" "$UNIT_FILE" "$UNIT_NAME"
case "$UNIT_DISK_STATE" in
  ABSENT|SAME_ROOT) ;;
  FOREIGN|MALFORMED)
    fail "$UNIT_NAME 的磁盘归属不是当前部署（disk=$UNIT_DISK_STATE），本次卸载未触碰它。"
    ;;
esac
case "$UNIT_MANAGER_STATE" in
  NOT_FOUND|SAME_ROOT) ;;
  FOREIGN|QUERY_ERROR|MALFORMED)
    fail "$UNIT_NAME 的 manager 归属不是当前部署或无法安全确认（manager=$UNIT_MANAGER_STATE），本次卸载未触碰它。"
    ;;
esac

if [ "$UNIT_MANAGER_STATE" = SAME_ROOT ]; then
  systemctl stop "$UNIT_NAME" || fail "服务停止失败；unit 与项目目录已保留，未执行 purge。"
  unit_ownership_verify_stopped "$UNIT_NAME" || fail "无法确认服务与 cgroup 已完全停止；unit 与项目目录已保留。"
  systemctl reset-failed "$UNIT_NAME" || fail "无法清理服务失败状态；unit 与项目目录已保留。"
  systemctl disable "$UNIT_NAME" || fail "无法禁用服务；unit 与项目目录已保留。"
else
  # A manually started stack has no loaded unit but must also be stopped before
  # purge. --preserve-credentials performs only this root's local cleanup.
  /bin/sh "$STOP_SCRIPT" --preserve-credentials || fail "本地受管进程清理失败；项目目录已保留。"
fi
if [ "$UNIT_DISK_STATE" = SAME_ROOT ]; then
  UNIT_BACKUP=$(mktemp "$UNIT_FILE.uninstall.XXXXXX")
  cp -p -- "$UNIT_FILE" "$UNIT_BACKUP"
  rm -f -- "$UNIT_FILE"
  if ! systemctl daemon-reload; then
    mv -fT -- "$UNIT_BACKUP" "$UNIT_FILE"
    systemctl daemon-reload || echo "警告：unit 文件已恢复，但 manager reload 仍失败。" >&2
    fail "卸载后的 daemon-reload 失败；unit 文件与项目目录已保留。"
  fi
  rm -f -- "$UNIT_BACKUP"
elif [ "$UNIT_MANAGER_STATE" = SAME_ROOT ]; then
  systemctl daemon-reload || fail "服务已停止，但 daemon-reload 失败；项目目录已保留。"
fi

if [ "$PURGE" -eq 1 ]; then
  rm -rf -- "$ROOT"
  echo "已停止并移除 obs-whip-live.service，并删除项目目录：$ROOT"
  echo "config.env、证书、持久推流凭据与运行数据已一并删除。"
else
  echo "已停止并移除 obs-whip-live.service。"
  echo "项目目录已保留：$ROOT（config.env、证书与 runtime/publish.credentials 未动）。"
  echo "如需彻底删除：sudo ./uninstall.sh --purge"
fi
