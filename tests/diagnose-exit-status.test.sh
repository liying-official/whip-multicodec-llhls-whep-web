#!/bin/sh
set -eu

PACKAGE_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT HUP INT TERM

mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/certs" "$TEST_ROOT/logs" \
  "$TEST_ROOT/runtime" "$TEST_ROOT/web" "$TEST_ROOT/test-bin"
cp "$PACKAGE_ROOT/status.sh" "$PACKAGE_ROOT/diagnose.sh" "$TEST_ROOT/"
cp "$PACKAGE_ROOT/web/app.js" "$TEST_ROOT/web/app.js"

case "$(uname -m)" in
  x86_64|amd64) TEST_ARCH=amd64 ;;
  aarch64|arm64) TEST_ARCH=arm64 ;;
  *) echo 'SKIP: unsupported test architecture'; exit 0 ;;
esac
for component in helper mediamtx caddy; do
  cp "$PACKAGE_ROOT/bin/${component}_linux_${TEST_ARCH}" "$TEST_ROOT/bin/"
done
chmod 0755 "$TEST_ROOT/status.sh" "$TEST_ROOT/diagnose.sh" "$TEST_ROOT/bin/"*

FAKE_CURL_LOG=$TEST_ROOT/fake-curl.log
export FAKE_CURL_LOG
cat > "$TEST_ROOT/test-bin/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_CURL_LOG"
exit 7
EOF
chmod 0755 "$TEST_ROOT/test-bin/curl"

printf '%s\n' \
  'PUBLIC_DOMAIN=' \
  'PUBLIC_HTTPS_PORT=443' \
  'TLS_CERT=certs/fullchain.pem' \
  'TLS_KEY=certs/privkey.pem' \
  'WHIP_IP=127.0.0.2' \
  'INGEST_ALLOW_CIDRS=' \
  'PUBLIC_HOST=' > "$TEST_ROOT/config.env"

if "$TEST_ROOT/status.sh" >/dev/null 2>&1; then
  echo 'FAIL: status.sh returned success for an unstarted package' >&2
  exit 1
fi
if PATH="$TEST_ROOT/test-bin:$PATH" "$TEST_ROOT/diagnose.sh" >/dev/null 2>&1; then
  echo 'FAIL: diagnose.sh returned success for an unhealthy package' >&2
  exit 1
fi

[ -s "$FAKE_CURL_LOG" ] || {
  echo 'FAIL: diagnose.sh did not invoke the isolated fake curl' >&2
  exit 1
}
[ "$(wc -l < "$FAKE_CURL_LOG")" -eq 2 ] \
  && grep -F 'http://127.0.0.1:9998/metrics' "$FAKE_CURL_LOG" >/dev/null \
  && grep -F 'http://127.0.0.1:8080/__internal/whep-sessions' "$FAKE_CURL_LOG" >/dev/null || {
  echo 'FAIL: diagnose.sh curl calls did not stay inside the expected fake endpoints' >&2
  sed -n '1,10p' "$FAKE_CURL_LOG" >&2
  exit 1
}

echo 'PASS: status.sh and diagnose.sh return nonzero; all diagnose curl calls used the isolated fake'
