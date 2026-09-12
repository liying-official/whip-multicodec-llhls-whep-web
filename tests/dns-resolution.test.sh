#!/bin/sh
set -eu
SOURCE_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT HUP INT TERM
mkdir "$TEST_ROOT/bin"
cat > "$TEST_ROOT/bin/getent" <<'GETENT'
#!/bin/sh
set -eu
if [ "$1" = ahostsv6 ]; then
  case "$SCENARIO" in
    aaaa-error) exit 1 ;;
    aaaa-timeout) sleep 10; exit 2 ;;
    *) exit 2 ;;
  esac
fi
case "$SCENARIO" in
  blackhole) sleep 10; exit 2 ;;
  retry)
    n=0; [ ! -f "$DNS_COUNTER" ] || n=$(cat "$DNS_COUNTER")
    n=$((n + 1)); printf '%s\n' "$n" > "$DNS_COUNTER"
    [ "$n" -ge 3 ] || exit 2
    ;;
esac
printf '%s\n' '11.23.45.67 STREAM example.test' '11.23.45.67 DGRAM example.test'
GETENT
chmod 0755 "$TEST_ROOT/bin/getent"
PATH="$TEST_ROOT/bin:$PATH"; export PATH
DNS_COUNTER=$TEST_ROOT/counter; export DNS_COUNTER
for SCENARIO in valid retry aaaa-error aaaa-timeout blackhole; do
  export SCENARIO
  limit=10
  [ "$SCENARIO" != blackhole ] || limit=3
  rc=0
  timeout --kill-after=1s "$limit" /bin/sh "$SOURCE_ROOT/lib/resolve-public-host.sh" example.test service > "$TEST_ROOT/out" 2> "$TEST_ROOT/err" || rc=$?
  case "$SCENARIO" in
    valid|retry) [ "$rc" -eq 0 ]; [ "$(cat "$TEST_ROOT/out")" = 11.23.45.67 ] ;;
    blackhole) [ "$rc" -eq 124 ] ;;
    *) [ "$rc" -eq 1 ] ;;
  esac
  echo "PASS: DNS $SCENARIO rc=$rc"
done
