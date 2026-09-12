#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
# 持久推流凭据默认保留，避免一次手工停止令 OBS 已配置的推流码失效。
# --preserve-credentials 为旧参数，凭据行为与新的默认一致，但它同时会跳过
# 下面的 systemctl 快速路径：service-manager.sh 在服务自身的关闭流程里回调
# stop.sh --preserve-credentials，此时再执行 systemctl stop 会等待自己退出。
# --clear-credentials 才会作废 runtime/publish.credentials。
PRESERVE_FLAG=0
CLEAR_CREDENTIALS=0
STOP_CLEANUP_FAILED=0
case "${1:-}" in
  "") ;;
  --preserve-credentials) PRESERVE_FLAG=1 ;;
  --clear-credentials) CLEAR_CREDENTIALS=1 ;;
  *) echo "用法：sudo ./stop.sh [--preserve-credentials|--clear-credentials]" >&2; exit 2 ;;
esac

cleanup_remove() {
  if ! rm -f -- "$@"; then
    STOP_CLEANUP_FAILED=1
    echo "警告：停止过程无法清理：$*" >&2
  fi
  return 0
}

cleanup_credential() {
  cleanup_remove "$ROOT/runtime/publish.credentials"
  if [ -e "$ROOT/runtime/publish.credentials" ] \
     || [ -L "$ROOT/runtime/publish.credentials" ]; then
    STOP_CLEANUP_FAILED=1
    echo "警告：持久推流凭据未能作废。" >&2
  fi
}

if [ "$PRESERVE_FLAG" -eq 0 ] \
   && [ "$(id -u)" -eq 0 ] \
   && [ -d /run/systemd/system ] \
   && command -v systemctl >/dev/null 2>&1; then
  UNIT_NAME=obs-whip-live.service
  UNIT_FILE=/etc/systemd/system/$UNIT_NAME
  OWNERSHIP_HELPER=$ROOT/lib/systemd-unit-ownership.sh
  [ ! -L "$OWNERSHIP_HELPER" ] && [ -f "$OWNERSHIP_HELPER" ] || {
    echo "安全拒绝：ownership helper 缺失、类型错误或为符号链接。" >&2
    exit 1
  }
  helper_uid=$(stat -c %u -- "$OWNERSHIP_HELPER" 2>/dev/null) || {
    echo "安全拒绝：无法读取 ownership helper 的 owner。" >&2
    exit 1
  }
  helper_mode=$(stat -c %a -- "$OWNERSHIP_HELPER" 2>/dev/null) || {
    echo "安全拒绝：无法读取 ownership helper 的 mode。" >&2
    exit 1
  }
  helper_perm=$((0$helper_mode))
  if [ "$helper_uid" -ne 0 ] || [ $((helper_perm & 0022)) -ne 0 ]; then
    echo "安全拒绝：ownership helper 必须由 root 所有且不可被组/其他用户写入。" >&2
    exit 1
  fi

  # shellcheck source=lib/systemd-unit-ownership.sh
  . "$OWNERSHIP_HELPER"
  unit_ownership_snapshot "$ROOT" "$UNIT_FILE" "$UNIT_NAME"
  case "$UNIT_MANAGER_STATE" in
    NOT_FOUND)
      : # no global unit is loaded; continue with current ROOT's local cleanup
      ;;
    SAME_ROOT)
      case "$UNIT_DISK_STATE" in
        ABSENT|SAME_ROOT) ;;
        FOREIGN|MALFORMED)
          echo "安全拒绝：$UNIT_NAME 的 disk/manager ownership 冲突，本次调用未停止它。" >&2
          exit 1
          ;;
      esac
      systemctl stop "$UNIT_NAME"
      SYSTEMD_STOP_STATE_OK=1
      systemd_stop_query_failed=0
      if ! systemd_active_state=$(systemctl show "$UNIT_NAME" -p ActiveState --value 2>/dev/null); then
        systemd_active_state='<query-error>'
        systemd_stop_query_failed=1
      fi
      if ! systemd_sub_state=$(systemctl show "$UNIT_NAME" -p SubState --value 2>/dev/null); then
        systemd_sub_state='<query-error>'
        systemd_stop_query_failed=1
      fi
      if ! systemd_result=$(systemctl show "$UNIT_NAME" -p Result --value 2>/dev/null); then
        systemd_result='<query-error>'
        systemd_stop_query_failed=1
      fi
      if [ "$systemd_stop_query_failed" -ne 0 ]; then
        SYSTEMD_STOP_STATE_OK=0
        echo "错误：服务停止流程已结束，但无法确认 $UNIT_NAME 的停止/清理结果。" >&2
      elif [ "$systemd_active_state" != inactive ] \
        || [ "$systemd_sub_state" != dead ] \
        || [ "$systemd_result" != success ]; then
        SYSTEMD_STOP_STATE_OK=0
        echo "错误：服务停止流程已结束，但 systemd 报告停止/清理结果异常：ActiveState=$systemd_active_state SubState=$systemd_sub_state Result=$systemd_result" >&2
      fi
      if [ "$SYSTEMD_STOP_STATE_OK" -eq 0 ]; then
        echo "请检查：journalctl -u $UNIT_NAME -n 50" >&2
      fi
      if [ "$CLEAR_CREDENTIALS" -eq 1 ]; then
        # Clearing a persistent credential requires the same complete stopped
        # state used by uninstall, including PID and cgroup verification.
        if [ "$SYSTEMD_STOP_STATE_OK" -eq 1 ] && unit_ownership_verify_stopped "$UNIT_NAME"; then
          cleanup_credential
        else
          SYSTEMD_STOP_STATE_OK=0
          echo "警告：未确认服务完整停止；持久推流凭据已保留。" >&2
        fi
      fi
      if [ "$STOP_CLEANUP_FAILED" -ne 0 ]; then
        echo "受管进程停止流程已完成，但运行目录清理不完整；请检查上述警告。" >&2
      fi
      if [ "$SYSTEMD_STOP_STATE_OK" -eq 0 ] || [ "$STOP_CLEANUP_FAILED" -ne 0 ]; then
        exit 1
      fi
      if [ "$CLEAR_CREDENTIALS" -eq 1 ]; then
        echo "systemd 直播服务已停止；持久推流凭据已作废。"
      else
        echo "systemd 直播服务已停止；持久推流凭据已保留。"
      fi
      exit 0
      ;;
    FOREIGN|QUERY_ERROR|MALFORMED)
      echo "安全拒绝：$UNIT_NAME 属于其他部署或 manager ownership 无法安全确认（manager=$UNIT_MANAGER_STATE），本次调用未停止它。" >&2
      exit 1
      ;;
  esac
fi

# Reaching this point on a systemd host means the ownership snapshot safely
# classified the manager as NOT_FOUND. A pristine tree has no local process,
# sentinel, pidfile, or credential to clean, so keep the no-op side-effect free.
if [ ! -e "$ROOT/runtime" ] && [ ! -L "$ROOT/runtime" ]; then
  echo "未检测到运行目录；没有需要停止的本地进程。"
  exit 0
fi

managed_pid_matches() {
  match_pid=$1
  match_expected=$2
  match_alternate=${3:-}
  match_required_arg=${4:-}
  [ -r "/proc/$match_pid/cmdline" ] || return 1
  match_executable=$(tr '\000' '\n' < "/proc/$match_pid/cmdline" 2>/dev/null | sed -n '1p')
  match_managed_arg=$(tr '\000' '\n' < "/proc/$match_pid/cmdline" 2>/dev/null | sed -n '2p')
  if [ "$match_executable" != "$match_expected" ] \
     && { [ -z "$match_alternate" ] || [ "$match_executable" != "$match_alternate" ]; }; then
    return 1
  fi
  [ -z "$match_required_arg" ] || [ "$match_managed_arg" = "$match_required_arg" ]
}

stop_one() {
  file=$1
  expected=$2
  alternate=${3:-}
  required_arg=${4:-}
  if [ -f "$file" ]; then
    pid=$(cat "$file" 2>/dev/null || true)
    case "$pid" in
      ""|*[!0-9]*) ;;
      *)
        # start.sh 失败时，后台 PID 可能仍处于 nohup/fork -> exec 过渡期。
        # 短暂等待命令行稳定后再判断归属，既能终止本包进程，也不会误杀复用 PID。
        i=0
        while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do
          managed_pid_matches "$pid" "$expected" "$alternate" "$required_arg" && break
          sleep 0.05
          i=$((i + 1))
        done
        ;;
    esac
    if kill -0 "$pid" 2>/dev/null \
       && managed_pid_matches "$pid" "$expected" "$alternate" "$required_arg"; then
      kill "$pid" 2>/dev/null || true
      i=0
      while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
      if kill -0 "$pid" 2>/dev/null; then
        if managed_pid_matches "$pid" "$expected" "$alternate" "$required_arg"; then
          kill -9 "$pid" 2>/dev/null || true
        else
          echo "警告：PID $pid 在 SIGKILL 前身份已变化或无法确认；未发送 SIGKILL。" >&2
        fi
      fi
      # Do not erase the recovery PID or report success while a matching
      # process is still alive (for example an uninterruptible task).
      stop_verify_wait=0
      while kill -0 "$pid" 2>/dev/null && managed_pid_matches "$pid" "$expected" "$alternate" "$required_arg" \
        && [ "$stop_verify_wait" -lt 10 ]; do
        sleep 0.1
        stop_verify_wait=$((stop_verify_wait + 1))
      done
      if kill -0 "$pid" 2>/dev/null && managed_pid_matches "$pid" "$expected" "$alternate" "$required_arg"; then
        STOP_CLEANUP_FAILED=1
        echo "错误：受管进程 $pid 仍未退出，保留 PID 文件：$file" >&2
        return 0
      fi
    elif [ -n "$pid" ]; then
      echo "警告：忽略不属于本包的陈旧 PID：$pid" >&2
    fi
    cleanup_remove "$file"
  fi
}
case "$(uname -m)" in
  x86_64|amd64)
    HELPER="$ROOT/bin/helper_linux_amd64"
    MEDIAMTX="$ROOT/bin/mediamtx_linux_amd64"
    CADDY="$ROOT/bin/caddy_linux_amd64"
    ;;
  aarch64|arm64)
    HELPER="$ROOT/bin/helper_linux_arm64"
    MEDIAMTX="$ROOT/bin/mediamtx_linux_arm64"
    CADDY="$ROOT/bin/caddy_linux_arm64"
    ;;
  *) HELPER=; MEDIAMTX=; CADDY= ;;
esac
stop_one "$ROOT/runtime/caddy.pid" "$CADDY" "$ROOT/bin/caddy"
stop_one "$ROOT/runtime/gateway.pid" "$HELPER"
# Tell the supervisor that this shutdown is intentional before stopping the
# current child, otherwise it would immediately recreate MediaMTX.
# 全新解压、从未启动过的树没有 runtime/ 目录；容忍 touch 失败，避免 set -e 令无害的
# 停止操作以非零退出（此时也不存在需要通知的 mediamtx-supervisor）。
if ! touch "$ROOT/runtime/mediamtx.stop" 2>/dev/null; then
  STOP_CLEANUP_FAILED=1
  echo "警告：停止过程无法创建 mediamtx.stop sentinel；仍将尝试停止全部受管进程。" >&2
fi
stop_one "$ROOT/runtime/mediamtx-supervisor.pid" "/bin/sh" "" "$ROOT/mediamtx-supervisor.sh"
stop_one "$ROOT/runtime/mediamtx.pid" "$MEDIAMTX" "$ROOT/bin/mediamtx"
cleanup_remove "$ROOT/runtime/mediamtx.stop"
cleanup_remove "$ROOT/runtime/mediamtx.generated.yml" "$ROOT/runtime/Caddyfile"
if [ "$CLEAR_CREDENTIALS" -eq 1 ]; then
  # Attempt every managed stop and required cleanup before authorizing clear.
  if [ "$STOP_CLEANUP_FAILED" -eq 0 ]; then
    cleanup_credential
  else
    echo "警告：停止或清理未完整成功；持久推流凭据已保留。" >&2
  fi
fi
if [ "$STOP_CLEANUP_FAILED" -ne 0 ]; then
  echo "受管进程停止流程已完成，但运行目录清理不完整；请检查上述警告。" >&2
  exit 1
fi
if [ "$CLEAR_CREDENTIALS" -eq 1 ]; then
  echo "直播服务器已停止；持久推流凭据已作废（OBS 需更换新密钥）。"
else
  echo "直播服务器已停止；持久推流凭据已保留（如需作废请使用 --clear-credentials）。"
fi
