#!/bin/sh
set -eu

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
case "$(uname -m)" in
  x86_64|amd64) HELPER_DEFAULT=$ROOT/bin/helper_linux_amd64 ;;
  aarch64|arm64) HELPER_DEFAULT=$ROOT/bin/helper_linux_arm64 ;;
  *) echo "SKIP: unsupported helper test architecture" >&2; exit 77 ;;
esac
HELPER=${1:-$HELPER_DEFAULT}
[ -x "$HELPER" ] || { echo "missing executable helper: $HELPER" >&2; exit 1; }
for command_name in python3 curl mktemp grep; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "missing WHEP runtime-test command: $command_name" >&2
    exit 1
  }
done

TEST_TMP=$(mktemp -d /tmp/obs-whip-whep-runtime.XXXXXX)
case "$TEST_TMP" in
  /tmp/obs-whip-whep-runtime.*) ;;
  *) echo "unsafe temporary path: $TEST_TMP" >&2; exit 1 ;;
esac
BACKEND_PID=
HELPER_PID=
cleanup() {
  [ -z "$HELPER_PID" ] || kill "$HELPER_PID" 2>/dev/null || true
  [ -z "$HELPER_PID" ] || wait "$HELPER_PID" 2>/dev/null || true
  [ -z "$BACKEND_PID" ] || kill "$BACKEND_PID" 2>/dev/null || true
  [ -z "$BACKEND_PID" ] || wait "$BACKEND_PID" 2>/dev/null || true
  rm -rf -- "$TEST_TMP"
}
trap cleanup EXIT HUP INT TERM

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}
BACKEND_PORT=$(free_port)
HELPER_PORT=$(free_port)
[ "$BACKEND_PORT" != "$HELPER_PORT" ] || HELPER_PORT=$(free_port)

python3 - "$BACKEND_PORT" >"$TEST_TMP/backend.log" 2>&1 <<'PY' &
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port = int(sys.argv[1])
lock = threading.Lock()
stats = {"posts": 0, "options": 0, "redirect_target": 0, "hls_hits": 0}
session = 0

approved = (
    b"v=0\r\n"
    b"m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
    b"a=candidate:1 1 udp 2130706431 8.8.8.8 8189 typ host\r\n"
    b"a=candidate:2 1 udp 2130706430 10.0.0.9 8189 typ host\r\n"
)
unapproved = (
    b"v=0\r\n"
    b"m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
    b"a=candidate:1 1 udp 2130706431 10.0.0.9 8189 typ host\r\n"
)

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        return

    def send_bytes(self, status, body=b"", headers=None):
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        return self.rfile.read(length) if length else b""

    def do_GET(self):
        if self.path == "/stats":
            with lock:
                payload = json.dumps(stats, sort_keys=True).encode()
            self.send_bytes(200, payload, {"Content-Type": "application/json"})
            return
        if self.path == "/redirect-target":
            with lock:
                stats["redirect_target"] += 1
            self.send_bytes(200, b"redirect followed")
            return
        if self.path.split("?")[0].startswith("/live"):
            # Mock MediaMTX HLS namespace. Any hit from a blocked player
            # entry is a FIX-02 regression and fails the counters below.
            with lock:
                stats["hls_hits"] += 1
            self.send_bytes(200, b"#EXTM3U\n", {"Content-Type": "application/vnd.apple.mpegurl"})
            return
        self.send_bytes(404)

    def do_OPTIONS(self):
        with lock:
            stats["options"] += 1
        self.send_bytes(500, b"OPTIONS MUST NOT REACH BACKEND")

    def do_POST(self):
        global session
        if self.path == "/redirect-target":
            with lock:
                stats["redirect_target"] += 1
            self.send_bytes(200, b"redirect followed")
            return
        body = self.read_body()
        with lock:
            stats["posts"] += 1
            session += 1
            sid = session
        if body == b"":
            self.send_bytes(400, b"SECRET_EMPTY_BACKEND_DETAIL")
            return
        if b"BACKEND500" in body:
            self.send_bytes(500, b"SECRET_BACKEND_TOKEN")
            return
        if b"REDIRECT" in body:
            self.send_bytes(
                307,
                approved,
                {
                    "Content-Type": "application/sdp",
                    "Location": f"http://127.0.0.1:{port}/redirect-target",
                },
            )
            return
        answer = unapproved if b"NOAPPROVED" in body else approved
        self.send_bytes(
            201,
            answer,
            {
                "Content-Type": "application/sdp",
                "Location": f"/live/whep/session-{sid}",
                "ETag": f'"session-{sid}"',
            },
        )

    def do_PATCH(self):
        self.read_body()
        self.send_bytes(204)

    def do_DELETE(self):
        self.read_body()
        self.send_bytes(204)

server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
server.serve_forever()
PY
BACKEND_PID=$!

# Helper readiness alone does not prove the mock backend is listening: the
# helper binds its own socket independently. Poll the backend directly so the
# first /stats fetch in the assertions cannot race a slow interpreter start.
backend_ready=0
for _attempt in 1 2 3 4 5; do
  if curl --silent --fail --noproxy '*' "http://127.0.0.1:$BACKEND_PORT/stats" >/dev/null 2>&1; then
    backend_ready=1
    break
  fi
  sleep 1
done
if [ "$backend_ready" -ne 1 ]; then
  echo "FAIL: mock WHEP backend did not become ready" >&2
  sed -n '1,80p' "$TEST_TMP/backend.log" >&2
  exit 1
fi

# Deliberately poison every conventional proxy variable. Internal HLS/WHEP
# backend traffic must still use the pinned direct transport.
HTTP_PROXY=http://127.0.0.1:9 \
HTTPS_PROXY=http://127.0.0.1:9 \
ALL_PROXY=http://127.0.0.1:9 \
NO_PROXY='' \
  "$HELPER" serve \
    --dir "$ROOT/web" \
    --addr "127.0.0.1:$HELPER_PORT" \
    --hls-backend "http://127.0.0.1:$BACKEND_PORT" \
    --whep-backend "http://127.0.0.1:$BACKEND_PORT" \
    --whep-approved-ips 8.8.8.8 \
    >"$TEST_TMP/helper.log" 2>&1 &
HELPER_PID=$!

ready=0
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl --silent --fail --noproxy '*' "http://127.0.0.1:$HELPER_PORT/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: helper did not become ready" >&2
  sed -n '1,80p' "$TEST_TMP/helper.log" >&2
  exit 1
fi

python3 - "$HELPER_PORT" "$BACKEND_PORT" <<'PY'
import http.client
import json
import sys
import time

helper_port = int(sys.argv[1])
backend_port = int(sys.argv[2])
MAX = 256 << 10
SDP = b"v=0\r\n"

def request(method, path, body=None, headers=None, chunked=False):
    conn = http.client.HTTPConnection("127.0.0.1", helper_port, timeout=20)
    merged = dict(headers or {})
    conn.request(method, path, body=body, headers=merged, encode_chunked=chunked)
    response = conn.getresponse()
    payload = response.read()
    result = (response.status, {k.lower(): v for k, v in response.getheaders()}, payload)
    conn.close()
    return result

def expect(status, method, path, body=None, headers=None, chunked=False):
    got = request(method, path, body, headers, chunked)
    assert got[0] == status, (method, path, got[0], status, got[2][:160])
    return got

def sdp_headers(ip):
    return {"Content-Type": "application/sdp", "X-Forwarded-For": ip}

def retry_value(headers):
    value = int(headers.get("retry-after", "0"))
    assert value > 0, headers
    return value

# OPTIONS is local and does not reach the backend or consume create/session quota.
options = expect(204, "OPTIONS", "/rtc/live/whep", headers={"X-Forwarded-For": "10.20.0.1"})
assert options[1].get("accept-post") == "application/sdp"
backend = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=5)
backend.request("GET", "/stats")
backend_stats = json.loads(backend.getresponse().read())
backend.close()
assert backend_stats["options"] == 0, backend_stats

# MIME and method negative paths are rejected before backend forwarding.
expect(415, "POST", "/rtc/live/whep", SDP, {"X-Forwarded-For": "10.20.0.2"})
expect(415, "POST", "/rtc/live/whep", SDP, {"Content-Type": "text/plain", "X-Forwarded-For": "10.20.0.2"})
empty = expect(400, "POST", "/rtc/live/whep", b"", sdp_headers("10.20.0.2"))
assert b"SECRET_EMPTY_BACKEND_DETAIL" not in empty[2]
for method in ("GET", "PUT", "HEAD"):
    expect(404, method, "/rtc/live/whep", headers={"X-Forwarded-For": "10.20.0.2"})

# Valid create preserves only approved ICE and rewrites the public Location.
created = expect(201, "POST", "/rtc/live/whep", SDP, sdp_headers("10.20.0.3"))
location = created[1]["location"]
assert location.startswith("/rtc/live/whep/session-"), location
assert b"8.8.8.8" in created[2]
assert b"10.0.0.9" not in created[2]
expect(204, "PATCH", location, b"candidate", {"Content-Type": "application/trickle-ice-sdpfrag", "X-Forwarded-For": "10.20.0.3"})
expect(404, "PATCH", location, b"candidate", {"Content-Type": "application/trickle-ice-sdpfrag", "X-Forwarded-For": "10.20.0.4"})
expect(204, "POST", location, headers={"X-WHEP-Keepalive": "1", "X-Forwarded-For": "10.20.0.3"})
expect(405, "POST", location, headers={"X-Forwarded-For": "10.20.0.3"})
expect(405, "GET", location, headers={"X-Forwarded-For": "10.20.0.3"})
expect(405, "PUT", location, headers={"X-Forwarded-For": "10.20.0.3"})
expect(405, "HEAD", location, headers={"X-Forwarded-For": "10.20.0.3"})
expect(204, "DELETE", location, headers={"X-Forwarded-For": "10.20.0.3"})
expect(404, "POST", location, headers={"X-WHEP-Keepalive": "1", "X-Forwarded-For": "10.20.0.3"})

# Fixed-length and chunked/unknown-length requests share the exact 256 KiB boundary.
exact = b"v=0\r\n" + b"x" * (MAX - 5)
assert len(exact) == MAX
known = expect(201, "POST", "/rtc/live/whep", exact, sdp_headers("10.20.0.5"))
expect(204, "DELETE", known[1]["location"], headers={"X-Forwarded-For": "10.20.0.5"})
known_large = expect(413, "POST", "/rtc/live/whep", exact + b"x", sdp_headers("10.20.0.6"))
assert known_large[1].get("cache-control") == "no-store"
chunked = expect(201, "POST", "/rtc/live/whep", iter([exact[:131072], exact[131072:]]), sdp_headers("10.20.0.7"), True)
expect(204, "DELETE", chunked[1]["location"], headers={"X-Forwarded-For": "10.20.0.7"})
chunked_large = expect(413, "POST", "/rtc/live/whep", iter([exact, b"x"]), sdp_headers("10.20.0.8"), True)
assert chunked_large[1].get("cache-control") == "no-store"
assert b"service unavailable" not in chunked_large[2].lower()

# Backend redirect is not followed; backend errors and candidate failures are sanitized.
redirect = expect(502, "POST", "/rtc/live/whep", b"REDIRECT", sdp_headers("10.20.0.9"))
backend500 = expect(500, "POST", "/rtc/live/whep", b"BACKEND500", sdp_headers("10.20.0.10"))
assert b"SECRET_BACKEND_TOKEN" not in backend500[2]
no_candidate = expect(502, "POST", "/rtc/live/whep", b"NOAPPROVED", sdp_headers("10.20.0.11"))
assert b"10.0.0.9" not in no_candidate[2]
backend = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=5)
backend.request("GET", "/stats")
backend_stats = json.loads(backend.getresponse().read())
backend.close()
assert backend_stats["redirect_target"] == 0, backend_stats

# Five active sessions are accepted per source IP; the sixth fails closed.
active_ip = "10.20.1.1"
active = []
for _ in range(5):
    result = expect(201, "POST", "/rtc/live/whep", SDP, sdp_headers(active_ip))
    active.append(result[1]["location"])
sixth = expect(429, "POST", "/rtc/live/whep", SDP, sdp_headers(active_ip))
assert sixth[1].get("x-whep-error") == "session-limit"
for path in active:
    expect(204, "DELETE", path, headers={"X-Forwarded-For": active_ip})

# Create limiter: 10/10s burst and 30/60s minute windows, without active slots.
burst_ip = "10.20.2.1"
for _ in range(10):
    expect(502, "POST", "/rtc/live/whep", b"NOAPPROVED", sdp_headers(burst_ip))
burst = expect(429, "POST", "/rtc/live/whep", b"NOAPPROVED", sdp_headers(burst_ip))
assert 1 <= retry_value(burst[1]) <= 10

minute_ip = "10.20.2.2"
minute_start = time.monotonic()
for batch in range(3):
    for _ in range(10):
        expect(502, "POST", "/rtc/live/whep", b"NOAPPROVED", sdp_headers(minute_ip))
    if batch != 2:
        time.sleep(max(0, minute_start + (batch + 1) * 10.3 - time.monotonic()))
time.sleep(max(0, minute_start + 3 * 10.3 - time.monotonic()))
minute = expect(429, "POST", "/rtc/live/whep", b"NOAPPROVED", sdp_headers(minute_ip))
assert 20 <= retry_value(minute[1]) <= 40, minute[1]

# FIX-01 runtime: when the 10/10s burst and 30/60s minute windows trip at the
# same moment, Retry-After must advertise the longest applicable reset. The
# final batch fills the burst window while all thirty creates stay inside the
# minute window, so a burst-only answer (<= 10) would be wrong here.
dual_ip = "10.20.2.3"
dual_start = time.monotonic()
for batch in range(2):
    for _ in range(10):
        expect(502, "POST", "/rtc/live/whep", b"NOAPPROVED", sdp_headers(dual_ip))
    time.sleep(max(0, dual_start + (batch + 1) * 10.3 - time.monotonic()))
for _ in range(10):
    expect(502, "POST", "/rtc/live/whep", b"NOAPPROVED", sdp_headers(dual_ip))
dual = expect(429, "POST", "/rtc/live/whep", b"NOAPPROVED", sdp_headers(dual_ip))
assert 20 <= retry_value(dual[1]) <= 45, dual[1]
assert dual[1].get("x-whep-error") == "rate-limit", dual[1]

# Operation limiter: exact 30/10s burst and true 120/60s minute Retry-After.
operation_ip = "10.20.3.1"
session_result = expect(201, "POST", "/rtc/live/whep", SDP, sdp_headers(operation_ip))
session_path = session_result[1]["location"]
operation_start = time.monotonic()
for _ in range(29):
    expect(204, "POST", session_path, headers={"X-WHEP-Keepalive": "1", "X-Forwarded-For": operation_ip})
operation_burst = expect(429, "POST", session_path, headers={"X-WHEP-Keepalive": "1", "X-Forwarded-For": operation_ip})
assert 1 <= retry_value(operation_burst[1]) <= 10

for batch in (1, 2):
    time.sleep(max(0, operation_start + batch * 10.3 - time.monotonic()))
    for _ in range(30):
        expect(204, "POST", session_path, headers={"X-WHEP-Keepalive": "1", "X-Forwarded-For": operation_ip})
    again = expect(429, "POST", session_path, headers={"X-WHEP-Keepalive": "1", "X-Forwarded-For": operation_ip})
    assert 1 <= retry_value(again[1]) <= 10

time.sleep(max(0, operation_start + 3 * 10.3 - time.monotonic()))
for _ in range(27):
    expect(204, "POST", session_path, headers={"X-WHEP-Keepalive": "1", "X-Forwarded-For": operation_ip})
operation_minute = expect(429, "POST", session_path, headers={"X-WHEP-Keepalive": "1", "X-Forwarded-For": operation_ip})
assert 20 <= retry_value(operation_minute[1]) <= 35, operation_minute[1]

# FIX-02 runtime: the MediaMTX built-in player page and embedded hls.js must
# be unreachable through the public /live namespace and must never reach the
# backend, while manifests, segments, and LL-HLS query variants keep proxying.
def backend_hls_hits():
    conn = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=5)
    conn.request("GET", "/stats")
    value = json.loads(conn.getresponse().read())["hls_hits"]
    conn.close()
    return value

blocked_before = backend_hls_hits()
for path in (
    "/live",
    "/live/",
    "/live/hls.min.js",
    "/live/hls.min.js?v=1",
    "/live/hls.min.js?x=1",
    "/live/hls.min.js.map",
    "/live/hls.min.js.map?v=1",
):
    blocked = expect(404, "GET", path)
    assert "no-store" in blocked[1].get("cache-control", ""), (path, blocked[1])
assert backend_hls_hits() == blocked_before, "blocked /live player entry reached the backend"

for path in (
    "/live/index.m3u8",
    "/live/index.m3u8?_HLS_msn=10&_HLS_part=2",
    "/live/test-segment",
    "/live/test-part",
):
    manifest = expect(200, "GET", path)
    assert manifest[2] == b"#EXTM3U\n", path
assert backend_hls_hits() == blocked_before + 4, "HLS proxy paths did not reach the backend"

print("WHEP helper-binary runtime negative, body-boundary, session, ICE, proxy-bypass, and limiter tests: PASS")
PY

kill -0 "$HELPER_PID" 2>/dev/null || {
  echo "FAIL: helper exited during WHEP runtime tests" >&2
  sed -n '1,120p' "$TEST_TMP/helper.log" >&2
  exit 1
}
if grep -Eiq 'panic:|fatal error:|data race' "$TEST_TMP/helper.log"; then
  echo "FAIL: helper runtime log contains a fatal diagnostic" >&2
  sed -n '1,160p' "$TEST_TMP/helper.log" >&2
  exit 1
fi
echo "V1.35 helper process remained healthy after WHEP runtime regression: PASS"
