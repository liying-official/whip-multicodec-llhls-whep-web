#!/bin/sh
set -eu

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
case "$(uname -m)" in
  x86_64|amd64) CADDY_DEFAULT=$ROOT/bin/caddy_linux_amd64 ;;
  aarch64|arm64) CADDY_DEFAULT=$ROOT/bin/caddy_linux_arm64 ;;
  *) echo "SKIP: unsupported Caddy test architecture" >&2; exit 77 ;;
esac
CADDY=${1:-$CADDY_DEFAULT}
[ -x "$CADDY" ] || { echo "missing executable Caddy: $CADDY" >&2; exit 1; }
"$CADDY" fmt --diff "$ROOT/Caddyfile.template" >/dev/null || {
  echo "FAIL: Caddyfile.template is not canonically formatted" >&2
  exit 1
}
for command_name in curl openssl python3 sed grep mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "missing authority-test command: $command_name" >&2
    exit 1
  }
done
proxy_count=$(grep -Ec '^[[:space:]]*reverse_proxy[[:space:]]' "$ROOT/Caddyfile.template" || true)
explicit_xff_count=$(grep -Fc 'header_up X-Forwarded-For {remote_host}' "$ROOT/Caddyfile.template" || true)
# The bundled Caddy replaces any client-supplied X-Forwarded-For with the real
# peer address by default (verified at runtime for this binary), so an explicit
# header_up X-Forwarded-For only duplicates the default and triggers an
# "Unnecessary header_up" adapter warning on every validate/start.
[ "$proxy_count" -gt 0 ] && [ "$explicit_xff_count" -eq 0 ] || {
  echo "FAIL: reverse_proxy must rely on the default client-IP X-Forwarded-For replacement; explicit header_up X-Forwarded-For is redundant" >&2
  exit 1
}
curl --version | grep -q 'Features:.*HTTP2' || {
  echo "FAIL: curl lacks mandatory HTTP/2 support" >&2
  exit 1
}

TEST_TMP=$(mktemp -d /tmp/obs-whip-caddy-authority.XXXXXX)
case "$TEST_TMP" in
  /tmp/obs-whip-caddy-authority.*) ;;
  *) echo "unsafe temporary path: $TEST_TMP" >&2; exit 1 ;;
esac
CADDY_PID=
BACKEND_PID=
cleanup() {
  [ -z "$CADDY_PID" ] || kill "$CADDY_PID" 2>/dev/null || true
  [ -z "$CADDY_PID" ] || wait "$CADDY_PID" 2>/dev/null || true
  [ -z "$BACKEND_PID" ] || kill "$BACKEND_PID" 2>/dev/null || true
  [ -z "$BACKEND_PID" ] || wait "$BACKEND_PID" 2>/dev/null || true
  rm -rf -- "$TEST_TMP"
}
trap cleanup EXIT HUP INT TERM

DOMAIN=live.example.test
LISTEN_PORT=19443
BACKEND_PORT=19080

fixture_port_available() {
  fixture_protocol=$1
  fixture_port=$2
  python3 - "$fixture_protocol" "$fixture_port" <<'PY'
import socket
import sys

sock_type = socket.SOCK_STREAM if sys.argv[1] == "tcp" else socket.SOCK_DGRAM
with socket.socket(socket.AF_INET, sock_type) as probe:
    try:
        probe.bind(("127.0.0.1", int(sys.argv[2])))
    except OSError:
        raise SystemExit(1)
PY
}

fixture_port_available tcp "$BACKEND_PORT" || {
  echo "FAIL: test fixture port $BACKEND_PORT/TCP is already in use" >&2
  exit 1
}
fixture_port_available tcp "$LISTEN_PORT" || {
  echo "FAIL: test fixture port $LISTEN_PORT/TCP is already in use" >&2
  exit 1
}
fixture_port_available udp "$LISTEN_PORT" || {
  echo "FAIL: test fixture port $LISTEN_PORT/UDP is already in use" >&2
  exit 1
}

mkdir -p "$TEST_TMP/site" "$TEST_TMP/caddy-data" "$TEST_TMP/caddy-config"
printf '%s\n' ok > "$TEST_TMP/site/index.html"
mkdir -p "$TEST_TMP/site/live"
printf 'mock-backend-hls-library\n' > "$TEST_TMP/site/hls.min.js"
printf '#EXTM3U mock-backend-manifest\n' > "$TEST_TMP/site/live/index.m3u8"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN" \
  -keyout "$TEST_TMP/key.pem" -out "$TEST_TMP/cert.pem" >/dev/null 2>&1
python3 -m http.server "$BACKEND_PORT" --bind 127.0.0.1 \
  --directory "$TEST_TMP/site" >"$TEST_TMP/backend.log" 2>&1 &
BACKEND_PID=$!

request_case() {
  protocol=$1
  authority=$2
  sni=$3
  expected=$4
  public_port=$5
  request_id=$6
  headers=$TEST_TMP/headers-$request_id.txt
  body=$TEST_TMP/body-$request_id.txt
  case "$protocol" in
    h1) protocol_option=--http1.1; expected_version=1.1 ;;
    h2) protocol_option=--http2; expected_version=2 ;;
    h3) protocol_option=--http3-only; expected_version=3 ;;
    *) echo "invalid protocol: $protocol" >&2; exit 1 ;;
  esac

  result=$(curl "$protocol_option" --silent --show-error --insecure --noproxy '*' \
    --resolve "$sni:$LISTEN_PORT:127.0.0.1" -H "Host: $authority" \
    -D "$headers" -o "$body" -w '%{http_version} %{http_code}' \
    "https://$sni:$LISTEN_PORT/")
  actual_version=${result%% *}
  actual_status=${result##* }
  case "$actual_version" in
    "$expected_version"|"$expected_version".*) ;;
    *) echo "FAIL: $protocol negotiated HTTP/$actual_version" >&2; exit 1 ;;
  esac
  if [ "$actual_status" != "$expected" ]; then
    echo "FAIL: $protocol authority=$authority sni=$sni status=$actual_status want=$expected" >&2
    sed -n '1,20p' "$headers" >&2
    exit 1
  fi
  if grep -Eiq '^(server|via):' "$headers"; then
    echo "FAIL: identity header leaked for $protocol authority=$authority" >&2
    exit 1
  fi
  grep -Eiq '^strict-transport-security: max-age=31536000' "$headers" || {
    echo "FAIL: HSTS missing for $protocol authority=$authority status=$expected" >&2; exit 1;
  }
  grep -Eiq '^content-security-policy:' "$headers" || {
    echo "FAIL: CSP missing for $protocol authority=$authority status=$expected" >&2; exit 1;
  }
  grep -Eiq '^x-content-type-options: nosniff' "$headers" || {
    echo "FAIL: nosniff missing for $protocol authority=$authority status=$expected" >&2; exit 1;
  }
  grep -Eiq '^x-frame-options: DENY' "$headers" || {
    echo "FAIL: frame policy missing for $protocol authority=$authority status=$expected" >&2; exit 1;
  }
  if [ "$expected" = 200 ]; then
    grep -Eiq "^alt-svc: h3=\":$public_port\"; ma=2592000" "$headers" || {
      echo "FAIL: Alt-Svc does not advertise public port $public_port" >&2; exit 1;
    }
  elif grep -Eiq '^alt-svc:' "$headers"; then
    echo "FAIL: rejected authority advertised Alt-Svc" >&2
    exit 1
  fi
}

empty_sni_case() {
  public_port=$1
  authority=$2
  response=$TEST_TMP/empty-sni-$public_port.txt
  printf 'GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n' "$authority" |
    openssl s_client -connect "127.0.0.1:$LISTEN_PORT" -noservername -tls1_3 -quiet \
      >"$response" 2>/dev/null || true
  tr -d '\r' < "$response" > "$response.normalized"
  grep -q '^HTTP/1.1 421 ' "$response.normalized" || {
    echo "FAIL: empty SNI was not rejected with HTTP 421" >&2
    sed -n '1,20p' "$response.normalized" >&2
    exit 1
  }
  if grep -Eiq '^(server|via|alt-svc):' "$response.normalized"; then
    echo "FAIL: empty-SNI rejection leaked identity/Alt-Svc headers" >&2
    exit 1
  fi
  grep -Eiq '^strict-transport-security: max-age=31536000' "$response.normalized" || {
    echo "FAIL: empty-SNI rejection omitted HSTS" >&2; exit 1;
  }
  grep -Eiq '^content-security-policy:' "$response.normalized" || {
    echo "FAIL: empty-SNI rejection omitted CSP" >&2; exit 1;
  }
}

tls_cases() {
  if openssl s_client -connect "127.0.0.1:$LISTEN_PORT" -servername "$DOMAIN" \
      -tls1_2 </dev/null >"$TEST_TMP/tls12.out" 2>&1; then
    echo "FAIL: TLS 1.2 handshake unexpectedly succeeded" >&2
    exit 1
  fi
  openssl s_client -connect "127.0.0.1:$LISTEN_PORT" -servername "$DOMAIN" \
    -tls1_3 </dev/null >"$TEST_TMP/tls13.out" 2>&1 || {
      echo "FAIL: TLS 1.3 handshake failed" >&2
      sed -n '1,30p' "$TEST_TMP/tls13.out" >&2
      exit 1
    }
  grep -q 'Protocol  *: TLSv1.3\|New, TLSv1.3' "$TEST_TMP/tls13.out" || {
    echo "FAIL: TLS 1.3 was not negotiated" >&2; exit 1;
  }
}


# FIX-02 public-entry regression: the MediaMTX built-in HLS player page and
# its embedded hls.js must be unreachable through the public site, while the
# project player assets and the HLS/LL-HLS media namespace keep proxying to
# the (mock) gateway. Body markers prove requests really reached the backend.
player_entry_case() {
  protocol=$1
  entry_path=$2
  expected=$3
  want_body=$4
  request_id=$5
  case "$protocol" in
    h1) protocol_option=--http1.1 ;;
    h2) protocol_option=--http2 ;;
    *) echo "invalid player-entry protocol: $protocol" >&2; exit 1 ;;
  esac
  headers=$TEST_TMP/player-headers-$request_id.txt
  body=$TEST_TMP/player-body-$request_id.txt
  result=$(curl "$protocol_option" --silent --show-error --insecure --noproxy '*' \
    --resolve "$DOMAIN:$LISTEN_PORT:127.0.0.1" -H "Host: $DOMAIN:$public_port" \
    -D "$headers" -o "$body" -w '%{http_code}' \
    "https://$DOMAIN:$LISTEN_PORT$entry_path")
  if [ "$result" != "$expected" ]; then
    echo "FAIL: player entry $protocol $entry_path status=$result want=$expected" >&2
    sed -n '1,20p' "$headers" >&2
    exit 1
  fi
  if [ "$expected" = 404 ]; then
    grep -Eiq '^cache-control: .*no-store' "$headers" || {
      echo "FAIL: blocked player entry $entry_path lacks Cache-Control no-store" >&2
      sed -n '1,20p' "$headers" >&2
      exit 1
    }
  else
    if [ "$(cat "$body")" != "$want_body" ]; then
      echo "FAIL: proxied entry $entry_path body mismatch" >&2
      cat "$body" >&2
      exit 1
    fi
  fi
}
stop_caddy() {
  [ -z "$CADDY_PID" ] && return
  kill "$CADDY_PID"
  wait "$CADDY_PID" 2>/dev/null || true
  CADDY_PID=
}

run_matrix() {
  public_port=$1
  config=$TEST_TMP/Caddyfile-$public_port
  sed \
    -e "s|:443|:$LISTEN_PORT|g" \
    -e "s|127.0.0.1:8080|127.0.0.1:$BACKEND_PORT|g" \
    -e "s|__PUBLIC_DOMAIN__|$DOMAIN|g" \
    -e "s|__PUBLIC_HTTPS_PORT__|$public_port|g" \
    -e "s|__TLS_CERT__|$TEST_TMP/cert.pem|g" \
    -e "s|__TLS_KEY__|$TEST_TMP/key.pem|g" \
    "$ROOT/Caddyfile.template" > "$config"

  XDG_DATA_HOME=$TEST_TMP/caddy-data XDG_CONFIG_HOME=$TEST_TMP/caddy-config \
    "$CADDY" validate --adapter caddyfile --config "$config" >/dev/null
  XDG_DATA_HOME=$TEST_TMP/caddy-data XDG_CONFIG_HOME=$TEST_TMP/caddy-config \
    "$CADDY" run --adapter caddyfile --config "$config" \
    >"$TEST_TMP/caddy-$public_port.log" 2>&1 &
  CADDY_PID=$!
  ready=0
  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    if curl --http1.1 --silent --insecure --noproxy '*' \
      --resolve "$DOMAIN:$LISTEN_PORT:127.0.0.1" \
      -H "Host: $DOMAIN:$public_port" "https://$DOMAIN:$LISTEN_PORT/" \
      >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "FAIL: Caddy did not become ready for public port $public_port" >&2
    sed -n '1,80p' "$TEST_TMP/caddy-$public_port.log" >&2
    exit 1
  fi

  for protocol in h1 h2; do
    if [ "$public_port" = 443 ]; then
      request_case "$protocol" "$DOMAIN" "$DOMAIN" 200 "$public_port" "$public_port-$protocol-host"
      request_case "$protocol" "$DOMAIN:443" "$DOMAIN" 200 "$public_port" "$public_port-$protocol-explicit"
      request_case "$protocol" "LIVE.EXAMPLE.TEST:443" "$DOMAIN" 200 "$public_port" "$public_port-$protocol-case"
      request_case "$protocol" "$DOMAIN:8443" "$DOMAIN" 421 "$public_port" "$public_port-$protocol-wrong-port"
    else
      request_case "$protocol" "$DOMAIN:$public_port" "$DOMAIN" 200 "$public_port" "$public_port-$protocol-explicit"
      request_case "$protocol" "$DOMAIN" "$DOMAIN" 421 "$public_port" "$public_port-$protocol-implicit"
      request_case "$protocol" "$DOMAIN:443" "$DOMAIN" 421 "$public_port" "$public_port-$protocol-default-port"
      request_case "$protocol" "$DOMAIN:9443" "$DOMAIN" 421 "$public_port" "$public_port-$protocol-wrong-port"
    fi
    request_case "$protocol" "wrong.example.test:$public_port" "$DOMAIN" 421 "$public_port" "$public_port-$protocol-wrong-host"
    request_case "$protocol" "127.0.0.1:$public_port" "$DOMAIN" 421 "$public_port" "$public_port-$protocol-ipv4-host"
    request_case "$protocol" "[::1]:$public_port" "$DOMAIN" 421 "$public_port" "$public_port-$protocol-ipv6-host"
    request_case "$protocol" "$DOMAIN:$public_port" wrong.example.test 421 "$public_port" "$public_port-$protocol-wrong-sni"
  done

  for protocol in h1 h2; do
    player_entry_case "$protocol" /live 404 x "$public_port-$protocol-entry-live"
    player_entry_case "$protocol" /live/ 404 x "$public_port-$protocol-entry-live-slash"
    player_entry_case "$protocol" /live/hls.min.js 404 x "$public_port-$protocol-entry-live-hlsjs"
    player_entry_case "$protocol" "/live/hls.min.js?v=1" 404 x "$public_port-$protocol-entry-live-hlsjs-query"
    player_entry_case "$protocol" "/live/hls.min.js?x=1" 404 x "$public_port-$protocol-entry-live-hlsjs-query2"
    player_entry_case "$protocol" /live/hls.min.js.map 404 x "$public_port-$protocol-entry-live-hlsjsmap"
    player_entry_case "$protocol" "/live/hls.min.js.map?v=1" 404 x "$public_port-$protocol-entry-live-hlsjsmap-query"
    player_entry_case "$protocol" / 200 ok "$public_port-$protocol-entry-root"
    player_entry_case "$protocol" /hls.min.js 200 mock-backend-hls-library "$public_port-$protocol-entry-web-hlsjs"
    player_entry_case "$protocol" /live/index.m3u8 200 '#EXTM3U mock-backend-manifest' "$public_port-$protocol-entry-manifest"
    player_entry_case "$protocol" "/live/index.m3u8?_HLS_msn=10&_HLS_part=2" 200 '#EXTM3U mock-backend-manifest' "$public_port-$protocol-entry-manifest-query"
  done
  echo "FIX-02 public-entry regression (blocked player + proxied HLS): PASS (public port $public_port)"

  empty_sni_case "$public_port" "$DOMAIN:$public_port"
  tls_cases

  if curl --version | grep -q 'Features:.*HTTP3'; then
    request_case h3 "$DOMAIN:$public_port" "$DOMAIN" 200 "$public_port" "$public_port-h3-valid"
    request_case h3 "$DOMAIN:9443" "$DOMAIN" 421 "$public_port" "$public_port-h3-wrong-port"
    request_case h3 "wrong.example.test:$public_port" "$DOMAIN" 421 "$public_port" "$public_port-h3-wrong-host"
    echo "HTTP/3 authority regression: PASS (public port $public_port)"
  else
    echo "HTTP/3 authority regression: BLOCKED (curl lacks HTTP3 support)"
  fi
  stop_caddy
  echo "HTTP/1.1 + HTTP/2 authority regression: PASS (public port $public_port)"
}

run_matrix 443
run_matrix 8443
echo "Caddy authority, SNI, security-header, and Alt-Svc regression tests: PASS"
