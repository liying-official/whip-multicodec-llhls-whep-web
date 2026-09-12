#!/bin/sh
# start.sh enforces a single 30-second timeout around this entire DNS phase.
set -eu
host=$1
mode=$2
attempts=1
[ "$mode" != service ] || attempts=30
ipv4s=
while [ "$attempts" -gt 0 ]; do
  if answer=$(timeout --kill-after=1s 5s getent ahostsv4 "$host" 2>/dev/null); then
    ipv4s=$(printf '%s\n' "$answer" | awk 'NF && !seen[$1]++ { out=out sep $1; sep="," } END { print out }')
    [ -z "$ipv4s" ] || break
  fi
  attempts=$((attempts - 1))
  [ "$attempts" -eq 0 ] || sleep 1
done
[ -n "$ipv4s" ] || { echo "PUBLIC_HOST 无法解析出 IPv4 A 记录。" >&2; exit 1; }

# A timeout/error cannot prove the absence of AAAA records. getent exit 2 is
# its normal no-record result; any other failure is unsafe to accept.
ipv6_rc=0
answer=$(timeout --kill-after=1s 5s getent ahostsv6 "$host" 2>/dev/null) || ipv6_rc=$?
case "$ipv6_rc" in
  0|2) ;;
  *) echo "PUBLIC_HOST AAAA 查询失败，无法确认 A-only 安全策略。" >&2; exit 1 ;;
esac
ipv6s=$(printf '%s\n' "$answer" | awk 'NF && $1 ~ /:/ && $1 !~ /^::ffff:/ && !seen[$1]++ { out=out sep $1; sep="," } END { print out }')
printf '%s\n%s\n' "$ipv4s" "$ipv6s"
