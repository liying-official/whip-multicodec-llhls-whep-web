package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRequestHasBody(t *testing.T) {
	t.Run("empty GET", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		if requestHasBody(req) {
			t.Fatal("empty GET was reported as having a body")
		}
	})

	t.Run("known length", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", strings.NewReader("x"))
		if !requestHasBody(req) {
			t.Fatal("known-length body was not detected")
		}
	})

	t.Run("chunked", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Body = io.NopCloser(strings.NewReader("x"))
		req.ContentLength = -1
		req.TransferEncoding = []string{"chunked"}
		if !requestHasBody(req) {
			t.Fatal("chunked body was not detected")
		}
	})

	t.Run("unknown length", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Body = io.NopCloser(strings.NewReader("x"))
		req.ContentLength = -1
		if !requestHasBody(req) {
			t.Fatal("unknown-length body was not detected")
		}
	})
}

func TestFixedLimiterEnforcesPerIPLimit(t *testing.T) {
	limiter := newFixedLimiter(2, time.Minute)
	firstAllowed := limiter.allow("192.0.2.1")
	secondAllowed := limiter.allow("192.0.2.1")
	if !firstAllowed || !secondAllowed {
		t.Fatal("requests within the limit were rejected")
	}
	if limiter.allow("192.0.2.1") {
		t.Fatal("request above the limit was accepted")
	}
	if !limiter.allow("192.0.2.2") {
		t.Fatal("one client incorrectly exhausted another client's limit")
	}
}

func TestFixedLimiterCleansExpiredEntries(t *testing.T) {
	limiter := newFixedLimiter(1, time.Minute)
	limiter.entries["192.0.2.1"] = rateEntry{
		window: time.Now().Add(-2 * time.Minute),
		count:  1,
	}
	limiter.lastCleanup = time.Now().Add(-2 * time.Minute)

	if !limiter.allow("192.0.2.2") {
		t.Fatal("new client was rejected after cleanup")
	}
	if _, ok := limiter.entries["192.0.2.1"]; ok {
		t.Fatal("expired entry was not removed")
	}
}

func TestFixedLimiterBoundsClientTable(t *testing.T) {
	limiter := newFixedLimiter(1, time.Minute)
	for i := 0; i < maxRateLimiterEntries; i++ {
		ip := "client-" + strings.Repeat("x", i%16) + "-" + string(rune(i))
		if !limiter.allow(ip) {
			t.Fatalf("client %d was rejected before the table reached its bound", i)
		}
	}
	if limiter.allow("one-client-too-many") {
		t.Fatal("client table grew beyond its bound")
	}
	if len(limiter.entries) != maxRateLimiterEntries {
		t.Fatalf("entry count = %d, want %d", len(limiter.entries), maxRateLimiterEntries)
	}
}

func TestClientIP(t *testing.T) {
	t.Run("trusted loopback proxy", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("X-Forwarded-For", "198.51.100.8, 127.0.0.1")
		if got := clientIP(req); got != "198.51.100.8" {
			t.Fatalf("clientIP() = %q, want %q", got, "198.51.100.8")
		}
	})

	t.Run("untrusted direct peer", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "192.0.2.20:12345"
		req.Header.Set("X-Forwarded-For", "198.51.100.8")
		if got := clientIP(req); got != "192.0.2.20" {
			t.Fatalf("clientIP() = %q, want %q", got, "192.0.2.20")
		}
	})
}

func TestNormalizePrivateCIDRs(t *testing.T) {
	got, err := normalizePrivateCIDRs("10.123.45.67/24, 172.20.30.40/32,10.123.45.0/24")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"10.123.45.0/24", "172.20.30.40/32"}
	if len(got) != len(want) {
		t.Fatalf("normalizePrivateCIDRs() = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("normalizePrivateCIDRs()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestNormalizePrivateCIDRsRejectsPublicOrBroadNetworks(t *testing.T) {
	for _, value := range []string{
		"0.0.0.0/0",
		"192.168.0.0/15",
		"172.0.0.0/8",
		"203.0.113.1/32",
		"::1/128",
		"",
	} {
		if _, err := normalizePrivateCIDRs(value); err == nil {
			t.Fatalf("normalizePrivateCIDRs(%q) unexpectedly succeeded", value)
		}
	}
}

func TestWhepGuardBurstAndMinuteLimits(t *testing.T) {
	guard := newWhepGuard()
	ip := "198.51.100.10"
	base := time.Now()

	for i := 0; i < whepShortLimit; i++ {
		ok, _, reason := guard.reserveCreate(ip, base.Add(time.Duration(i)*100*time.Millisecond))
		if !ok {
			t.Fatalf("burst request %d rejected: %s", i+1, reason)
		}
		guard.cancelReservation(ip)
	}
	if ok, retry, reason := guard.reserveCreate(ip, base.Add(2*time.Second)); ok || reason != "burst-rate-limit" || retry < 1 || retry > 10 {
		t.Fatalf("11th burst request = ok:%v retry:%d reason:%q", ok, retry, reason)
	}

	guard = newWhepGuard()
	for i := 0; i < whepMinuteLimit; i++ {
		ok, _, reason := guard.reserveCreate(ip, base.Add(time.Duration(i)*2*time.Second))
		if !ok {
			t.Fatalf("minute request %d rejected: %s", i+1, reason)
		}
		guard.cancelReservation(ip)
	}
	if ok, retry, reason := guard.reserveCreate(ip, base.Add(59*time.Second)); ok || reason != "minute-rate-limit" || retry < 1 {
		t.Fatalf("31st minute request = ok:%v retry:%d reason:%q", ok, retry, reason)
	}
}

func TestWhepGuardActiveSessionLimitAndRelease(t *testing.T) {
	guard := newWhepGuard()
	ip := "198.51.100.20"
	now := time.Now()

	for i := 0; i < whepMaxActivePerIP; i++ {
		ok, _, reason := guard.reserveCreate(ip, now.Add(time.Duration(i)*time.Millisecond))
		if !ok {
			t.Fatalf("active reservation %d rejected: %s", i+1, reason)
		}
		key := fmt.Sprintf("/rtc/live/whep/session-%d", i)
		if !guard.commitSession(ip, key, "session-test", now) {
			t.Fatalf("failed to commit %s", key)
		}
	}

	if ok, _, reason := guard.reserveCreate(ip, now.Add(time.Second)); ok || reason != "active-session-limit" {
		t.Fatalf("6th active session = ok:%v reason:%q", ok, reason)
	}

	guard.releaseSession(ip, "/rtc/live/whep/session-0")
	if ok, _, reason := guard.reserveCreate(ip, now.Add(2*time.Second)); !ok {
		t.Fatalf("reservation after DELETE release rejected: %s", reason)
	}
}

func TestWhepGuardHeartbeatAndStaleCleanup(t *testing.T) {
	guard := newWhepGuard()
	ip := "198.51.100.30"
	base := time.Now()
	key := "/rtc/live/whep/live-session"
	ok, _, reason := guard.reserveCreate(ip, base)
	if !ok {
		t.Fatal(reason)
	}
	if !guard.commitSession(ip, key, "session-test", base) {
		t.Fatal("commit failed")
	}
	if !guard.touchSession(ip, key, base.Add(4*time.Minute)) {
		t.Fatal("heartbeat did not refresh an owned session")
	}
	if !guard.ownsSession(ip, key, base.Add(6*time.Minute)) {
		t.Fatal("refreshed session expired too early")
	}

	guard.mu.Lock()
	session := guard.sessions[key]
	session.lastSeen = base.Add(-whepSessionTTL - time.Minute)
	guard.sessions[key] = session
	guard.lastCleanup = base.Add(-2 * time.Minute)
	guard.mu.Unlock()

	if guard.ownsSession(ip, key, base) {
		t.Fatal("stale session survived cleanup")
	}
	guard.mu.Lock()
	active := 0
	if state := guard.clients[ip]; state != nil {
		active = state.active
	}
	guard.mu.Unlock()
	if active != 0 {
		t.Fatalf("active count after stale cleanup = %d, want 0", active)
	}
}

func TestWhepGatewaySanitizesCodecError(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/live/whep" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, "codecs not supported by client: internal backend detail")
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	gateway := newWhepGateway(target)

	req := httptest.NewRequest(http.MethodPost, "http://viewer/rtc/live/whep", strings.NewReader("v=0\r\n"))
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("X-Forwarded-For", "198.51.100.40")
	req.Header.Set("Content-Type", "application/sdp")
	rr := httptest.NewRecorder()
	gateway.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
	if got := rr.Header().Get("X-WHEP-Error"); got != "unsupported-codec" {
		t.Fatalf("X-WHEP-Error = %q", got)
	}
	body := rr.Body.String()
	if strings.Contains(body, "internal backend detail") || strings.Contains(body, "codecs not supported by client:") {
		t.Fatalf("raw MediaMTX error leaked to viewer: %q", body)
	}
}

func TestWhepGatewayTracksFiveSessionsAndDelete(t *testing.T) {
	var mu sync.Mutex
	next := 0
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			mu.Lock()
			next++
			id := next
			mu.Unlock()
			w.Header().Set("Content-Type", "application/sdp")
			w.Header().Set("Location", fmt.Sprintf("/live/whep/s-%d", id))
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, "v=0\r\n")
		case http.MethodDelete:
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	gateway := newWhepGateway(target)
	ip := "198.51.100.50"

	create := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "http://viewer/rtc/live/whep", strings.NewReader("v=0\r\n"))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("X-Forwarded-For", ip)
		req.Header.Set("Content-Type", "application/sdp")
		rr := httptest.NewRecorder()
		gateway.ServeHTTP(rr, req)
		return rr
	}

	locations := make([]string, 0, whepMaxActivePerIP)
	for i := 0; i < whepMaxActivePerIP; i++ {
		rr := create()
		if rr.Code != http.StatusCreated {
			t.Fatalf("create %d status = %d body=%q", i+1, rr.Code, rr.Body.String())
		}
		locations = append(locations, rr.Header().Get("Location"))
	}
	blocked := create()
	if blocked.Code != http.StatusTooManyRequests || blocked.Header().Get("X-WHEP-Error") != "session-limit" {
		t.Fatalf("6th create status=%d class=%q", blocked.Code, blocked.Header().Get("X-WHEP-Error"))
	}

	del := httptest.NewRequest(http.MethodDelete, "http://viewer"+locations[0], nil)
	del.RemoteAddr = "127.0.0.1:12345"
	del.Header.Set("X-Forwarded-For", ip)
	delRR := httptest.NewRecorder()
	gateway.ServeHTTP(delRR, del)
	if delRR.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d", delRR.Code)
	}
	if rr := create(); rr.Code != http.StatusCreated {
		t.Fatalf("create after DELETE status = %d body=%q", rr.Code, rr.Body.String())
	}
}

func TestWhepCreateRequiresSDPBeforeRateLimit(t *testing.T) {
	var backendCalls int
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backendCalls++
		// A generic backend rejection releases the reserved active slot while the
		// creation attempt still counts toward the legitimate WHEP rate window.
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, "backend detail that must not be exposed")
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	gateway := newWhepGateway(target)
	ip := "198.51.100.60"

	for i := 0; i < whepShortLimit+5; i++ {
		req := httptest.NewRequest(http.MethodPost, "http://viewer/rtc/live/whep", strings.NewReader("not-an-sdp"))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("X-Forwarded-For", ip)
		req.Header.Set("Content-Type", "text/plain")
		rr := httptest.NewRecorder()
		gateway.ServeHTTP(rr, req)
		if rr.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("invalid content type request %d status=%d, want 415", i+1, rr.Code)
		}
		if got := rr.Header().Get("Accept-Post"); got != "application/sdp" {
			t.Fatalf("Accept-Post=%q, want application/sdp", got)
		}
	}
	if backendCalls != 0 {
		t.Fatalf("invalid content types reached backend %d times", backendCalls)
	}

	// The invalid cross-site-style requests above must not consume quota. Ten
	// valid application/sdp POSTs are therefore still admitted to the backend.
	for i := 0; i < whepShortLimit; i++ {
		req := httptest.NewRequest(http.MethodPost, "http://viewer/rtc/live/whep", strings.NewReader("v=0\r\n"))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("X-Forwarded-For", ip)
		req.Header.Set("Content-Type", "application/sdp; charset=utf-8")
		rr := httptest.NewRecorder()
		gateway.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("valid SDP attempt %d status=%d, want backend 400", i+1, rr.Code)
		}
	}
	if backendCalls != whepShortLimit {
		t.Fatalf("backend calls=%d, want %d", backendCalls, whepShortLimit)
	}

	// The next valid SDP request should now hit the actual 10/10s limit.
	req := httptest.NewRequest(http.MethodPost, "http://viewer/rtc/live/whep", strings.NewReader("v=0\r\n"))
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("X-Forwarded-For", ip)
	req.Header.Set("Content-Type", "application/sdp")
	rr := httptest.NewRecorder()
	gateway.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests || rr.Header().Get("X-WHEP-Error") != "rate-limit" {
		t.Fatalf("11th valid SDP status=%d class=%q", rr.Code, rr.Header().Get("X-WHEP-Error"))
	}
	if backendCalls != whepShortLimit {
		t.Fatalf("rate-limited request reached backend; calls=%d", backendCalls)
	}
}

func TestSanitizeHLSResponsePreservesSuccessAndRedirect(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusFound} {
		body := "backend-body"
		resp := &http.Response{
			StatusCode:    status,
			Header:        make(http.Header),
			Body:          io.NopCloser(strings.NewReader(body)),
			ContentLength: int64(len(body)),
		}
		resp.Header.Set("Content-Type", "application/vnd.apple.mpegurl")
		resp.Header.Set("Server", "mediamtx")
		resp.Header.Set("Via", "1.1 backend")
		if err := sanitizeHLSResponse(resp); err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(resp.Body)
		if string(got) != body {
			t.Fatalf("status %d body changed to %q", status, got)
		}
		if resp.Header.Get("Server") != "" || resp.Header.Get("Via") != "" {
			t.Fatalf("backend identity headers survived status %d: %v", status, resp.Header)
		}
	}
}

func TestSanitizeHLSResponseRemovesBackendErrorBody(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   string
	}{
		{http.StatusUnauthorized, "HLS request rejected\n"},
		{http.StatusNotFound, "HLS stream unavailable\n"},
		{http.StatusInternalServerError, "HLS service unavailable\n"},
	} {
		secret := `{"status":"error","error":"SECRET-MEDIAMTX-DETAIL"}`
		resp := &http.Response{
			StatusCode:    tc.status,
			Header:        make(http.Header),
			Body:          io.NopCloser(strings.NewReader(secret)),
			ContentLength: int64(len(secret)),
		}
		resp.Header.Set("Content-Type", "application/json")
		resp.Header.Set("Content-Encoding", "gzip")
		resp.Header.Set("ETag", `"backend-etag"`)
		resp.Header.Set("X-MediaMTX-Debug", "SECRET-HEADER")
		if err := sanitizeHLSResponse(resp); err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(resp.Body)
		if string(got) != tc.want {
			t.Fatalf("status %d body=%q, want %q", tc.status, got, tc.want)
		}
		if strings.Contains(string(got), "SECRET-MEDIAMTX-DETAIL") {
			t.Fatal("MediaMTX error detail leaked")
		}
		if resp.Header.Get("Content-Type") != "text/plain; charset=utf-8" || resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("sanitized headers=%v", resp.Header)
		}
		if resp.Header.Get("Content-Encoding") != "" || resp.Header.Get("ETag") != "" || resp.Header.Get("X-MediaMTX-Debug") != "" {
			t.Fatalf("backend error headers survived: %v", resp.Header)
		}
	}
}

func TestHLSProxyRewritePreservesTrustedForwardingAndStripsPrefix(t *testing.T) {
	var gotPath, gotXFF, gotProto string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotXFF = r.Header.Get("X-Forwarded-For")
		gotProto = r.Header.Get("X-Forwarded-Proto")
		_, _ = io.WriteString(w, "#EXTM3U\n")
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}

	proxy := newProxy(target, "/hls")
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/hls/live/index.m3u8", nil)
	req.RemoteAddr = "127.0.0.1:45678"
	req.Header.Set("X-Forwarded-For", "203.0.113.42")
	req.Header.Set("X-Forwarded-Proto", "https")
	rr := httptest.NewRecorder()
	proxy.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%q", rr.Code, rr.Body.String())
	}
	if gotPath != "/live/index.m3u8" {
		t.Fatalf("backend path=%q", gotPath)
	}
	if gotXFF != "203.0.113.42" || gotProto != "https" {
		t.Fatalf("forwarding headers: XFF=%q proto=%q", gotXFF, gotProto)
	}
}

func TestWhepGatewayForwardsValidatedViewerIP(t *testing.T) {
	var gotXFF string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotXFF = r.Header.Get("X-Forwarded-For")
		w.Header().Set("Content-Type", "application/sdp")
		w.Header().Set("ID", "media-session-123")
		w.Header().Set("Location", "/live/whep/test-session")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("v=0\r\n"))
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	g := newWhepGateway(target)
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/rtc/live/whep", strings.NewReader("v=0\r\n"))
	req.RemoteAddr = "127.0.0.1:45678"
	req.Header.Set("X-Forwarded-For", "203.0.113.42")
	req.Header.Set("Content-Type", "application/sdp")
	rr := httptest.NewRecorder()
	g.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%q", rr.Code, rr.Body.String())
	}
	if gotXFF != "203.0.113.42" {
		t.Fatalf("forwarded XFF=%q", gotXFF)
	}
	snaps := g.guard.snapshots(time.Now())
	if len(snaps) != 1 || snaps[0].ID != "media-session-123" || snaps[0].IP != "203.0.113.42" {
		t.Fatalf("session map=%+v", snaps)
	}
}

func TestBackendWhepSessionIDFallback(t *testing.T) {
	h := make(http.Header)
	if got := backendWhepSessionID(h, "/live/whep/abc-123"); got != "abc-123" {
		t.Fatalf("fallback id=%q", got)
	}
	h.Set("ID", "header-session")
	if got := backendWhepSessionID(h, "/live/whep/abc-123"); got != "header-session" {
		t.Fatalf("header id=%q", got)
	}
}

func TestFilterWhepSDPIPv4Candidates(t *testing.T) {
	in := "v=0\r\n" +
		"a=candidate:1 1 udp 2130706431 192.0.2.10 8189 typ host\r\n" +
		"a=candidate:2 1 udp 2130706430 2001:db8::10 8189 typ host\r\n" +
		"a=candidate:3 1 tcp 1671430143 198.51.100.20 8189 typ host tcptype passive\r\n" +
		"a=end-of-candidates\r\n"
	got, dropped, hasIPv4 := filterWhepSDPIPv4Candidates([]byte(in))
	if !hasIPv4 {
		t.Fatal("expected an IPv4 candidate")
	}
	if dropped != 1 {
		t.Fatalf("dropped=%d, want 1", dropped)
	}
	out := string(got)
	if strings.Contains(out, "2001:db8::10") {
		t.Fatalf("IPv6 candidate leaked: %q", out)
	}
	if !strings.Contains(out, "192.0.2.10") || !strings.Contains(out, "198.51.100.20") {
		t.Fatalf("IPv4 candidate missing: %q", out)
	}
	if !strings.Contains(out, "\r\na=end-of-candidates\r\n") {
		t.Fatalf("SDP line endings/other lines were not preserved: %q", out)
	}
}

func TestWhepGatewayStripsIPv6Candidates(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/sdp")
		w.Header().Set("Location", "/live/whep/backend-location")
		w.Header().Set("Id", "metrics-session-id")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, "v=0\r\n"+
			"a=candidate:1 1 udp 2130706431 203.0.113.9 8189 typ host\r\n"+
			"a=candidate:2 1 udp 2130706430 2001:db8::9 8189 typ host\r\n"+
			"a=end-of-candidates\r\n")
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	gateway := newWhepGateway(target)
	req := httptest.NewRequest(http.MethodPost, "http://viewer/rtc/live/whep", strings.NewReader("v=0\r\n"))
	req.Header.Set("Content-Type", "application/sdp")
	rr := httptest.NewRecorder()
	gateway.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%q", rr.Code, rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "2001:db8::9") {
		t.Fatalf("IPv6 candidate leaked through Gateway: %q", rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "203.0.113.9") {
		t.Fatalf("IPv4 candidate missing: %q", rr.Body.String())
	}
	if rr.Header().Get("Location") != "/rtc/live/whep/backend-location" {
		t.Fatalf("Location=%q", rr.Header().Get("Location"))
	}
	snaps := gateway.guard.snapshots(time.Now())
	if len(snaps) != 1 || snaps[0].ID != "metrics-session-id" {
		t.Fatalf("viewer map=%+v", snaps)
	}
}
