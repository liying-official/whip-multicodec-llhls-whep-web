#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
CREDENTIALS="$ROOT/runtime/publish.credentials"

if [ "$(id -u)" -ne 0 ]; then
  echo "凭据仅允许 root 查看；请使用 sudo ./show-credentials.sh。" >&2
  exit 1
fi
[ -f "$CREDENTIALS" ] || {
  echo "没有 systemd 持久凭据。手工 start.sh 会直接显示一次性凭据。" >&2
  exit 1
}
[ ! -L "$CREDENTIALS" ] || { echo "安全拒绝：凭据文件不能是符号链接。" >&2; exit 1; }
[ "$(stat -c %u "$CREDENTIALS")" -eq 0 ] || { echo "安全拒绝：凭据文件必须由 root 所有。" >&2; exit 1; }
credentials_mode=$(stat -c %a "$CREDENTIALS")
credentials_perm=$((0$credentials_mode))
[ $((credentials_perm & 0077)) -eq 0 ] || { echo "安全拒绝：凭据文件必须为 0600。" >&2; exit 1; }

STREAM_KEY=$(sed -n 's/^key=//p' "$CREDENTIALS")
case "$STREAM_KEY" in *[!0-9a-f]*) echo "凭据文件格式无效。" >&2; exit 1 ;; esac
[ "${#STREAM_KEY}" -eq 32 ] || { echo "凭据文件格式无效。" >&2; exit 1; }

printf 'OBS WHIP Stream key : %s\n' "$STREAM_KEY"
printf 'OBS WHIP Bearer     : obs:%s\n' "$STREAM_KEY"
printf 'OBS RTMP Stream key : live?user=obs&pass=%s\n' "$STREAM_KEY"
