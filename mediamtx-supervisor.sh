#!/bin/sh
set -u
umask 077

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
BIN="$ROOT/bin/mediamtx"
CONFIG="$ROOT/runtime/mediamtx.generated.yml"
PIDFILE="$ROOT/runtime/mediamtx.pid"
STOPFILE="$ROOT/runtime/mediamtx.stop"
LOG="$ROOT/logs/mediamtx.log"

child=""
# shellcheck disable=SC2317
# cleanup is invoked indirectly by the INT/TERM/EXIT traps below.
cleanup() {
  touch "$STOPFILE" 2>/dev/null || true
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
    kill -INT "$child" 2>/dev/null || true
    i=0
    while kill -0 "$child" 2>/dev/null && [ "$i" -lt 50 ]; do
      sleep 0.1
      i=$((i + 1))
    done
    kill -TERM "$child" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
}
trap cleanup INT TERM EXIT

rm -f "$STOPFILE"
backoff=1
while [ ! -e "$STOPFILE" ]; do
  started=$(date +%s)
  printf '%s SUPERVISOR starting MediaMTX\n' "$(date '+%Y/%m/%d %H:%M:%S')" >> "$LOG"
  "$BIN" "$CONFIG" >> "$LOG" 2>&1 &
  child=$!
  printf '%s\n' "$child" > "$PIDFILE.tmp.$$"
  chmod 600 "$PIDFILE.tmp.$$"
  mv -f "$PIDFILE.tmp.$$" "$PIDFILE"

  set +e
  wait "$child"
  rc=$?
  set -e
  ended=$(date +%s)
  uptime=$((ended - started))
  child=""
  rm -f "$PIDFILE"

  [ -e "$STOPFILE" ] && break
  printf '%s SUPERVISOR MediaMTX exited rc=%s uptime=%ss; restart in %ss\n' \
    "$(date '+%Y/%m/%d %H:%M:%S')" "$rc" "$uptime" "$backoff" >> "$LOG"

  # A normally long-running process that survived for at least a minute gets
  # the fast-restart budget back. Repeated immediate crashes use capped
  # exponential backoff to avoid a restart storm.
  if [ "$uptime" -ge 60 ]; then
    backoff=1
  fi
  sleep "$backoff"
  case "$backoff" in
    1) backoff=2 ;;
    2) backoff=4 ;;
    4) backoff=8 ;;
    *) backoff=15 ;;
  esac
done

rm -f "$PIDFILE"
exit 0
