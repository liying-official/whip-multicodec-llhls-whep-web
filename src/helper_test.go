package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const testApprovedCandidateIPv4 = "203.0.113.9"

func testApprovedCandidates(t *testing.T, values ...string) map[netip.Addr]struct{} {
	t.Helper()
	if len(values) == 0 {
		values = []string{testApprovedCandidateIPv4}
	}
	out := make(map[netip.Addr]struct{}, len(values))
	for _, value := range values {
		addr, err := netip.ParseAddr(value)
		if err != nil || !addr.Is4() {
			t.Fatalf("invalid test candidate %q", value)
		}
		out[addr] = struct{}{}
	}
	return out
}

func testCandidateSDP(ip string) string {
	return "v=0\r\n" +
		"a=candidate:1 1 udp 2130706431 " + ip + " 8189 typ host\r\n" +
		"a=end-of-candidates\r\n"
}

func TestWriteFileAtomicRefusesSymlinkTarget(t *testing.T) {
	dir := t.TempDir()
	realTarget := filepath.Join(dir, "real-target")
	if err := os.WriteFile(realTarget, []byte("keep-me"), 0600); err != nil {
		t.Fatal(err)
	}
	linkTarget := filepath.Join(dir, "output-link")
	if err := os.Symlink(realTarget, linkTarget); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}

	if err := writeFileAtomic(linkTarget, []byte("replacement"), 0644); err == nil {
		t.Fatal("atomic writer accepted a symlink output")
	}
	got, err := os.ReadFile(realTarget)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "keep-me" {
		t.Fatalf("symlink destination was modified: %q", got)
	}
}

func TestWriteFileAtomicReplacesRegularFileAndMode(t *testing.T) {
	target := filepath.Join(t.TempDir(), "output")
	if err := os.WriteFile(target, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(target, []byte("new"), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new" {
		t.Fatalf("content=%q", got)
	}
	st, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0644 {
		t.Fatalf("mode=%#o want 0644", st.Mode().Perm())
	}
}

func TestLocalBackendValidationAndDialPin(t *testing.T) {
	if !isAssignedLocalIP(net.ParseIP("127.0.0.1")) {
		t.Fatal("loopback address was not recognized as local")
	}
	for _, raw := range []string{"0.0.0.0", "224.0.0.1"} {
		if isAssignedLocalIP(net.ParseIP(raw)) {
			t.Fatalf("non-dialable address was recognized as local: %s", raw)
		}
	}

	valid, err := url.Parse("http://127.0.0.1:8889")
	if err != nil {
		t.Fatal(err)
	}
	if err := validateLocalBackendURL(valid); err != nil {
		t.Fatalf("valid local backend rejected: %v", err)
	}
	for _, raw := range []string{
		"https://127.0.0.1:8889",
		"http://localhost:8889",
		"http://192.0.2.10:8889",
		"http://user:secret@127.0.0.1:8889",
		"http://127.0.0.1:8889/path",
		"http://127.0.0.1",
	} {
		u, parseErr := url.Parse(raw)
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		if err := validateLocalBackendURL(u); err == nil {
			t.Fatalf("unsafe backend URL accepted: %s", raw)
		}
	}

	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatal(err)
	}
	for _, addr := range addrs {
		ip, _, parseErr := net.ParseCIDR(addr.String())
		if parseErr != nil || ip == nil || ip.IsLoopback() || ip.IsUnspecified() {
			continue
		}
		u, parseErr := url.Parse("http://" + net.JoinHostPort(ip.String(), "8889"))
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		if err := validateLocalBackendURL(u); err != nil {
			t.Fatalf("assigned local backend rejected: %s: %v", ip, err)
		}
		break
	}

	transport := newPinnedBackendTransport(valid)
	if _, err := transport.DialContext(context.Background(), "tcp", "192.0.2.10:80"); err == nil {
		t.Fatal("transport accepted a different backend IP and port")
	}
	if _, err := transport.DialContext(context.Background(), "tcp", "127.0.0.1:8890"); err == nil {
		t.Fatal("transport accepted a different backend port")
	}
}

func TestWhepBackendRedirectsAreNotFollowed(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", "http://192.0.2.10/private")
		w.WriteHeader(http.StatusFound)
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	client := newWhepGateway(target, testApprovedCandidates(t), nil).client
	resp, err := client.Get(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status=%d, redirect was unexpectedly followed", resp.StatusCode)
	}
}

func TestWhepOptionsDiscoveryIsLocalAndDoesNotConsumeQuota(t *testing.T) {
	backendCalls := 0
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		backendCalls++
		http.Error(w, "backend rejection", http.StatusBadRequest)
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	gateway := newWhepGateway(target, testApprovedCandidates(t), nil)

	for range whepOperationBurstLimit + 5 {
		req := httptest.NewRequest(http.MethodOptions, "http://gateway/rtc/live/whep", nil)
		req.RemoteAddr = "127.0.0.1:12345"
		rr := httptest.NewRecorder()
		gateway.ServeHTTP(rr, req)
		if rr.Code != http.StatusNoContent {
			t.Fatalf("OPTIONS status=%d", rr.Code)
		}
		if rr.Header().Get("Accept-Post") != "application/sdp" || rr.Header().Get("Allow") != "OPTIONS, POST" {
			t.Fatalf("OPTIONS discovery headers=%v", rr.Header())
		}
	}
	if backendCalls != 0 {
		t.Fatalf("OPTIONS reached backend %d times", backendCalls)
	}

	req := httptest.NewRequest(http.MethodPost, "http://gateway/rtc/live/whep", strings.NewReader("v=0\r\n"))
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("Content-Type", "application/sdp")
	rr := httptest.NewRecorder()
	gateway.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest || backendCalls != 1 {
		t.Fatalf("POST after OPTIONS status=%d backendCalls=%d", rr.Code, backendCalls)
	}
}

func TestNewGETRequiresCredentialFreeHTTPS(t *testing.T) {
	for _, raw := range []string{
		"http://example.com/file",
		"https://user:secret@example.com/file",
		"file:///tmp/file",
		"//example.com/file",
	} {
		if _, err := newGET(raw); err == nil {
			t.Fatalf("newGET(%q) unexpectedly succeeded", raw)
		}
	}
	if _, err := newGET("https://example.com/file"); err != nil {
		t.Fatalf("valid HTTPS URL rejected: %v", err)
	}

	client := httpClient()
	req, _ := http.NewRequest(http.MethodGet, "http://example.com/file", nil)
	if err := client.CheckRedirect(req, nil); err == nil {
		t.Fatal("HTTP downgrade redirect was accepted")
	}
}

func makeTestCertificate(t *testing.T, now time.Time, domain string) ([]byte, []byte, *x509.CertPool) {
	t.Helper()
	caPublic, caPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "V1.35 test root"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(7 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, caPublic, caPrivate)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}

	leafPublic, leafPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: domain},
		DNSNames:     []string{domain},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(48 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, ca, leafPublic, caPrivate)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(leafPrivate)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := append(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})...,
	)
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	return certPEM, keyPEM, roots
}

func TestValidateCertificateBundleRequiresTrustAndHostname(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	certPEM, keyPEM, roots := makeTestCertificate(t, now, "live.example.com")
	if _, err := validateCertificateBundle(certPEM, keyPEM, "live.example.com", now, roots); err != nil {
		t.Fatalf("trusted certificate rejected: %v", err)
	}
	if _, err := validateCertificateBundle(certPEM, keyPEM, "other.example.com", now, roots); err == nil {
		t.Fatal("wrong-host certificate was accepted")
	}
	if _, err := validateCertificateBundle(certPEM, keyPEM, "live.example.com", now, x509.NewCertPool()); err == nil {
		t.Fatal("untrusted certificate chain was accepted")
	}
}

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

func TestRateLimitKeyAggregatesIPv6By64(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  string
	}{
		{name: "IPv4 remains per address", value: "192.0.2.8", want: "192.0.2.8"},
		{name: "IPv4-mapped IPv6 is IPv4", value: "::ffff:192.0.2.8", want: "192.0.2.8"},
		{name: "IPv6 global prefix", value: "2001:db8:1234:5678::abcd", want: "2001:db8:1234:5678::/64"},
		{name: "IPv6 zone is removed", value: "fe80::1%eth0", want: "fe80::/64"},
		{name: "non-IP test key is preserved", value: "synthetic-client", want: "synthetic-client"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := rateLimitKey(tc.value); got != tc.want {
				t.Fatalf("rateLimitKey(%q) = %q, want %q", tc.value, got, tc.want)
			}
		})
	}
}

func TestFixedLimiterSharesIPv6PrefixBucket(t *testing.T) {
	limiter := newFixedLimiter(1, time.Minute)
	base := time.Date(2026, time.August, 31, 12, 0, 0, 0, time.UTC)
	if ok, _ := limiter.hitAt("2001:db8:1234:5678::1", base); !ok {
		t.Fatal("first IPv6 address was rejected")
	}
	if ok, _ := limiter.hitAt("2001:db8:1234:5678::ffff", base); ok {
		t.Fatal("a rotated address in the same /64 received a new bucket")
	}
	if ok, _ := limiter.hitAt("2001:db8:1234:5679::1", base); !ok {
		t.Fatal("a different IPv6 /64 was not isolated")
	}
	if len(limiter.entries) != 2 {
		t.Fatalf("entry count = %d, want two /64 buckets", len(limiter.entries))
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

func TestFixedLimiterRetryBoundaryAndConcurrency(t *testing.T) {
	base := time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)
	limiter := newFixedLimiter(1, 10*time.Second)
	limiter.lastCleanup = base
	if ok, retry := limiter.hitAt("boundary", base); !ok || retry != 0 {
		t.Fatalf("first hit = ok:%v retry:%d", ok, retry)
	}
	if ok, retry := limiter.hitAt("boundary", base.Add(9*time.Second+time.Millisecond)); ok || retry != 1 {
		t.Fatalf("pre-boundary hit = ok:%v retry:%d, want false/1", ok, retry)
	}
	if ok, retry := limiter.hitAt("boundary", base.Add(10*time.Second)); !ok || retry != 0 {
		t.Fatalf("exact-boundary hit = ok:%v retry:%d, want true/0", ok, retry)
	}

	concurrent := newFixedLimiter(whepOperationBurstLimit, whepShortWindow)
	concurrent.lastCleanup = base
	var wg sync.WaitGroup
	var mu sync.Mutex
	allowed := 0
	retries := make([]int, 0, 170)
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, retry := concurrent.hitAt("same-client", base)
			mu.Lock()
			defer mu.Unlock()
			if ok {
				allowed++
			} else {
				retries = append(retries, retry)
			}
		}()
	}
	wg.Wait()
	if allowed != whepOperationBurstLimit || len(retries) != 200-whepOperationBurstLimit {
		t.Fatalf("concurrent results: allowed=%d rejected=%d", allowed, len(retries))
	}
	for _, retry := range retries {
		if retry != 10 {
			t.Fatalf("concurrent Retry-After=%d, want 10", retry)
		}
	}
}

func TestWhepOperationLimiterUsesLongestApplicableReset(t *testing.T) {
	target, _ := url.Parse("http://127.0.0.1:18889")
	base := time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name         string
		burstWindow  time.Time
		minuteWindow time.Time
		now          time.Time
		wantRetry    string
	}{
		{
			name:         "minute reset is longer",
			burstWindow:  base.Add(50 * time.Second),
			minuteWindow: base.Add(5 * time.Second),
			now:          base.Add(56 * time.Second),
			wantRetry:    "9",
		},
		{
			name:         "burst reset is longer",
			burstWindow:  base.Add(55 * time.Second),
			minuteWindow: base,
			now:          base.Add(56 * time.Second),
			wantRetry:    "9",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gateway := newWhepGateway(target, testApprovedCandidates(t), nil)
			ip := "198.51.100.80"
			gateway.operationBurst.entries[ip] = rateEntry{
				window: tc.burstWindow,
				count:  whepOperationBurstLimit,
			}
			gateway.operationMinute.entries[ip] = rateEntry{
				window: tc.minuteWindow,
				count:  whepOperationMinuteLimit,
			}
			gateway.operationBurst.lastCleanup = tc.burstWindow
			gateway.operationMinute.lastCleanup = tc.minuteWindow

			rr := httptest.NewRecorder()
			if gateway.allowOperationAt(rr, ip, tc.now) {
				t.Fatal("request above both limits was accepted")
			}
			if rr.Code != http.StatusTooManyRequests {
				t.Fatalf("status=%d, want 429", rr.Code)
			}
			if got := rr.Header().Get("Retry-After"); got != tc.wantRetry {
				t.Fatalf("Retry-After=%q, want %q", got, tc.wantRetry)
			}
		})
	}
}

func TestProtectedHandlerGenericGetLimiterRetryAfter(t *testing.T) {
	target, _ := url.Parse("http://127.0.0.1:18889")
	gateway := newWhepGateway(target, testApprovedCandidates(t), nil)
	limiter := newFixedLimiter(6000, time.Minute)
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	protected := newProtectedHandler(mux, gateway, limiter)

	get := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		request.RemoteAddr = "203.0.113.40:50000"
		recorder := httptest.NewRecorder()
		protected.ServeHTTP(recorder, request)
		return recorder
	}

	for i := 0; i < 6000; i++ {
		if recorder := get(); recorder.Code != http.StatusOK {
			t.Fatalf("request %d inside the quota was rejected: %d", i+1, recorder.Code)
		}
	}
	over := get()
	if over.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", over.Code)
	}
	retryHeader := over.Header().Get("Retry-After")
	retry, err := strconv.Atoi(retryHeader)
	if err != nil || retry < 1 || retry > 60 {
		t.Fatalf("Retry-After = %q, want an integer in [1,60]", retryHeader)
	}

	// The exact per-second countdown the handler emits comes from hitAt; it
	// must decrease monotonically inside one window and recover after reset.
	base := time.Date(2026, time.September, 3, 12, 0, 0, 0, time.UTC)
	windowLimiter := newFixedLimiter(1, time.Minute)
	windowLimiter.lastCleanup = base
	if ok, _ := windowLimiter.hitAt("countdown", base); !ok {
		t.Fatal("first hit inside quota was rejected")
	}
	seenRetry := 0
	for offset := 0; offset <= 45; offset += 15 {
		ok, windowRetry := windowLimiter.hitAt("countdown", base.Add(time.Duration(offset)*time.Second))
		if ok {
			t.Fatalf("hit at +%ds was allowed before the window reset", offset)
		}
		if offset == 0 {
			seenRetry = windowRetry
			continue
		}
		if windowRetry > seenRetry {
			t.Fatalf("Retry-After grew from %d to %d at +%ds", seenRetry, windowRetry, offset)
		}
		seenRetry = windowRetry
	}
	if ok, windowRetry := windowLimiter.hitAt("countdown", base.Add(61*time.Second)); !ok || windowRetry != 0 {
		t.Fatalf("post-reset hit = ok:%v retry:%d, want true/0", ok, windowRetry)
	}

	// Once the shared window has actually expired, the handler serves again.
	limiter.entries[rateLimitKey("203.0.113.40")] = rateEntry{window: time.Now().Add(-time.Minute), count: 6000}
	if recorder := get(); recorder.Code != http.StatusOK {
		t.Fatalf("status after window reset = %d, want 200", recorder.Code)
	}
}

func TestClientIP(t *testing.T) {
	t.Run("trusted loopback proxy", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("X-Forwarded-For", "203.0.113.99, 198.51.100.8")
		if got := clientIP(req); got != "198.51.100.8" {
			t.Fatalf("clientIP() = %q, want %q", got, "198.51.100.8")
		}
	})

	t.Run("invalid last forwarded value fails closed", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("X-Forwarded-For", "198.51.100.8, invalid")
		if got := clientIP(req); got != "127.0.0.1" {
			t.Fatalf("clientIP() = %q, want loopback fallback", got)
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

func TestWhepGuardAggregatesIPv6RateStateButKeepsExactOwnership(t *testing.T) {
	guard := newWhepGuard()
	now := time.Date(2026, time.August, 31, 12, 0, 0, 0, time.UTC)
	ips := []string{
		"2001:db8:abcd:1::1",
		"2001:db8:abcd:1::2",
		"2001:db8:abcd:1::3",
		"2001:db8:abcd:1::4",
		"2001:db8:abcd:1::5",
	}
	for _, ip := range ips {
		if ok, _, reason := guard.reserveCreate(ip, now); !ok {
			t.Fatalf("reserveCreate(%q) rejected: %s", ip, reason)
		}
	}
	if len(guard.clients) != 1 {
		t.Fatalf("same-/64 client table entries = %d, want 1", len(guard.clients))
	}
	if ok, _, reason := guard.reserveCreate("2001:db8:abcd:1::6", now); ok || reason != "active-session-limit" {
		t.Fatalf("sixth same-/64 session = ok:%v reason:%q", ok, reason)
	}
	if ok, _, reason := guard.reserveCreate("2001:db8:abcd:2::1", now); !ok {
		t.Fatalf("different /64 rejected: %s", reason)
	}
	guard.cancelReservation("2001:db8:abcd:2::1")
	for _, ip := range ips {
		guard.cancelReservation(ip)
	}

	creator := ips[0]
	peerInSamePrefix := ips[1]
	if ok, _, reason := guard.reserveCreate(creator, now); !ok {
		t.Fatalf("creator reservation rejected: %s", reason)
	}
	if !guard.commitSession(creator, "public-session", "media-session", now) {
		t.Fatal("session commit failed")
	}
	if !guard.ownsSession(creator, "public-session", now) {
		t.Fatal("creator does not own its session")
	}
	if guard.ownsSession(peerInSamePrefix, "public-session", now) {
		t.Fatal("another address in the same /64 inherited exact session ownership")
	}
	guard.releaseSession(creator, "public-session")
	if state := guard.clients[rateLimitKey(creator)]; state == nil || state.active != 0 {
		t.Fatalf("aggregated active count was not released: %+v", state)
	}
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
	gateway := newWhepGateway(target, testApprovedCandidates(t), nil)

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

func TestWhepGatewayEnforcesBoundedRequestBodiesBeforeBackend(t *testing.T) {
	var mu sync.Mutex
	backendCalls := 0
	backendLengths := make([]int, 0, 3)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("backend read: %v", err)
		}
		mu.Lock()
		backendCalls++
		backendLengths = append(backendLengths, len(body))
		mu.Unlock()
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	gateway := newWhepGateway(target, testApprovedCandidates(t), nil)

	tests := []struct {
		name       string
		size       int64
		framing    string
		wantStatus int
		wantCall   bool
	}{
		{name: "fixed exact max", size: maxWhepRequestBody, framing: "fixed", wantStatus: http.StatusBadRequest, wantCall: true},
		{name: "fixed max plus one", size: maxWhepRequestBody + 1, framing: "fixed", wantStatus: http.StatusRequestEntityTooLarge},
		{name: "chunked exact max", size: maxWhepRequestBody, framing: "chunked", wantStatus: http.StatusBadRequest, wantCall: true},
		{name: "chunked max plus one", size: maxWhepRequestBody + 1, framing: "chunked", wantStatus: http.StatusRequestEntityTooLarge},
		{name: "unknown exact max", size: maxWhepRequestBody, framing: "unknown", wantStatus: http.StatusBadRequest, wantCall: true},
		{name: "unknown max plus one", size: maxWhepRequestBody + 1, framing: "unknown", wantStatus: http.StatusRequestEntityTooLarge},
	}

	for index, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body := strings.NewReader(strings.Repeat("v", int(tc.size)))
			req := httptest.NewRequest(http.MethodPost, "http://viewer/rtc/live/whep", body)
			req.RemoteAddr = "127.0.0.1:12345"
			req.Header.Set("X-Forwarded-For", fmt.Sprintf("198.51.100.%d", 100+index))
			req.Header.Set("Content-Type", "application/sdp")
			switch tc.framing {
			case "chunked":
				req.ContentLength = -1
				req.TransferEncoding = []string{"chunked"}
			case "unknown":
				req.ContentLength = -1
				req.TransferEncoding = nil
			}

			mu.Lock()
			callsBefore := backendCalls
			mu.Unlock()
			rr := httptest.NewRecorder()
			gateway.ServeHTTP(rr, req)
			if rr.Code != tc.wantStatus {
				t.Fatalf("status=%d, want %d; body=%q", rr.Code, tc.wantStatus, rr.Body.String())
			}
			if rr.Code == http.StatusBadGateway {
				t.Fatal("client framing error was misreported as backend failure")
			}

			mu.Lock()
			callsAfter := backendCalls
			gotLength := 0
			if callsAfter > callsBefore {
				gotLength = backendLengths[len(backendLengths)-1]
			}
			mu.Unlock()
			called := callsAfter > callsBefore
			if called != tc.wantCall {
				t.Fatalf("backend called=%v, want %v", called, tc.wantCall)
			}
			if called && gotLength != int(maxWhepRequestBody) {
				t.Fatalf("backend body length=%d, want %d", gotLength, maxWhepRequestBody)
			}
		})
	}

	mu.Lock()
	defer mu.Unlock()
	if backendCalls != 3 {
		t.Fatalf("backend calls=%d, want 3 exact-boundary requests only", backendCalls)
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
			_, _ = io.WriteString(w, testCandidateSDP(testApprovedCandidateIPv4))
		case http.MethodDelete:
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	gateway := newWhepGateway(target, testApprovedCandidates(t), nil)
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
	gateway := newWhepGateway(target, testApprovedCandidates(t), nil)
	ip := "198.51.100.60"

	for i := 0; i < whepOperationBurstLimit+5; i++ {
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

func TestWhepGatewayRateLimitsSessionKeepalive(t *testing.T) {
	target, err := url.Parse("http://127.0.0.1:18889")
	if err != nil {
		t.Fatal(err)
	}
	g := newWhepGateway(target, testApprovedCandidates(t), nil)
	ip := "198.51.100.70"
	path := "/rtc/live/whep/session-keepalive"
	if !g.guard.commitSession(ip, path, "media-keepalive", time.Now()) {
		t.Fatal("failed to seed WHEP session")
	}

	for i := 0; i < whepOperationBurstLimit; i++ {
		req := httptest.NewRequest(http.MethodPost, "http://viewer"+path, nil)
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("X-Forwarded-For", ip)
		req.Header.Set("X-WHEP-Keepalive", "1")
		rr := httptest.NewRecorder()
		g.ServeHTTP(rr, req)
		if rr.Code != http.StatusNoContent {
			t.Fatalf("keepalive %d status=%d body=%q", i+1, rr.Code, rr.Body.String())
		}
	}

	req := httptest.NewRequest(http.MethodPost, "http://viewer"+path, nil)
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("X-Forwarded-For", ip)
	req.Header.Set("X-WHEP-Keepalive", "1")
	rr := httptest.NewRecorder()
	g.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests || rr.Header().Get("X-WHEP-Error") != "rate-limit" {
		t.Fatalf("overflow status=%d headers=%v body=%q", rr.Code, rr.Header(), rr.Body.String())
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

func TestSanitizeHLSResponseHardensAndFiltersCookies(t *testing.T) {
	resp := &http.Response{StatusCode: http.StatusOK, Header: make(http.Header)}
	resp.Header.Add("Set-Cookie", "hlsSession=session-value")
	resp.Header.Add("Set-Cookie", "cookieCheck=1; SameSite=None; Secure; Partitioned; HttpOnly")
	resp.Header.Add("Set-Cookie", "unrelated=private-value")
	if err := sanitizeHLSResponse(resp); err != nil {
		t.Fatal(err)
	}
	values := resp.Header.Values("Set-Cookie")
	joined := strings.Join(values, "\n")
	if strings.Contains(joined, "unrelated") || strings.Contains(joined, "private-value") {
		t.Fatalf("unrelated backend cookie survived: %v", values)
	}
	if !strings.Contains(joined, "hlsSession=session-value") ||
		!strings.Contains(joined, "Secure") ||
		!strings.Contains(joined, "HttpOnly") ||
		!strings.Contains(joined, "SameSite=Lax") {
		t.Fatalf("HLS session cookie was not hardened: %v", values)
	}
	if !strings.Contains(joined, "cookieCheck=1") || !strings.Contains(joined, "Partitioned") {
		t.Fatalf("partitioned compatibility cookie was not preserved: %v", values)
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
	var gotPath, gotXFF, gotProto, gotAuthorization, gotProxyAuthorization, gotCookies, gotRealIP string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotXFF = r.Header.Get("X-Forwarded-For")
		gotProto = r.Header.Get("X-Forwarded-Proto")
		gotAuthorization = r.Header.Get("Authorization")
		gotProxyAuthorization = r.Header.Get("Proxy-Authorization")
		gotCookies = r.Header.Get("Cookie")
		gotRealIP = r.Header.Get("X-Real-IP")
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
	req.Header.Set("X-Real-IP", "198.51.100.99")
	req.Header.Set("Authorization", "Bearer browser-private-token")
	req.Header.Set("Proxy-Authorization", "Basic proxy-private-token")
	req.Header.Set("Cookie", "siteSession=private; hlsSession=hls-value; cookieCheck=1")
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
	if gotAuthorization != "" || gotProxyAuthorization != "" || gotRealIP != "" {
		t.Fatalf("sensitive/spoofable headers reached backend: auth=%q proxy=%q realIP=%q", gotAuthorization, gotProxyAuthorization, gotRealIP)
	}
	if strings.Contains(gotCookies, "siteSession") || !strings.Contains(gotCookies, "hlsSession=hls-value") || !strings.Contains(gotCookies, "cookieCheck=1") {
		t.Fatalf("backend cookies=%q", gotCookies)
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
		_, _ = w.Write([]byte(testCandidateSDP(testApprovedCandidateIPv4)))
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	g := newWhepGateway(target, testApprovedCandidates(t), nil)
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

func TestNormalizePublicIPv4sRejectsSpecialUse(t *testing.T) {
	got, err := normalizePublicIPv4s("8.8.8.8,1.1.1.1,8.8.8.8")
	if err != nil {
		t.Fatalf("valid public addresses rejected: %v", err)
	}
	if strings.Join(got, ",") != "8.8.8.8,1.1.1.1" {
		t.Fatalf("normalized public addresses=%v", got)
	}

	for _, value := range []string{
		"0.1.2.3", "10.1.2.3", "100.64.0.1", "127.0.0.1",
		"169.254.1.1", "172.16.0.1", "192.0.0.8", "192.0.2.1", "192.88.99.1",
		"192.168.1.10", "198.18.0.1", "198.51.100.1", "203.0.113.1",
		"224.0.0.1", "240.0.0.1", "255.255.255.255", "2001:4860:4860::8888",
	} {
		if _, err := normalizePublicIPv4s(value); err == nil {
			t.Fatalf("special-use address accepted: %s", value)
		}
	}
}

func TestFilterWhepSDPUsesExactApprovedIPv4Set(t *testing.T) {
	in := "v=0\r\n" +
		"a=candidate:1 1 udp 2130706431 192.168.1.10 8189 typ host\r\n" +
		"a=candidate:2 1 udp 2130706430 203.0.113.9 8189 typ host\r\n" +
		"a=candidate:3 1 tcp 1671430143 203.0.113.10 8189 typ host tcptype passive\r\n" +
		"a=candidate:4 1 udp 2130706429 127.0.0.1 8189 typ host\r\n" +
		"a=candidate:5 1 udp 2130706428 169.254.1.2 8189 typ host\r\n" +
		"a=candidate:6 1 udp 2130706427 100.64.1.2 8189 typ host\r\n" +
		"a=candidate:7 1 udp 2130706426 2001:db8::10 8189 typ host\r\n" +
		"a=candidate:8 1 udp 2130706425 8.8.8.8 8189 typ host\r\n" +
		"a=candidate:9 1 udp 2130706424 host.local 8189 typ host\r\n" +
		"a=candidate:10 1 udp 2130706423 203.0.113.9 8189 typ host raddr 192.168.1.10 rport 8189\r\n" +
		" a=candidate:11 1 udp 2130706422 192.168.1.11 8189 typ host\r\n" +
		"a=candidate:12 1 udp 2130706421 203.0.113.10 8189 typ srflx raddr 192.168.1.10 rport 8189\r\n" +
		"a=candidate:13 1 udp 2130706420 203.0.113.9 0 typ host\r\n" +
		"a=candidate:14 1 quic 2130706419 203.0.113.9 8189 typ host\r\n" +
		"a=candidate:15 3 udp 2130706418 203.0.113.9 8189 typ host\r\n" +
		"a=candidate:16 1 udp 4294967296 203.0.113.9 8189 typ host\r\n" +
		"a=candidate: 1 udp 2130706417 203.0.113.9 8189 typ host\r\n" +
		"a=end-of-candidates\r\n"
	approved := testApprovedCandidates(t, "203.0.113.9", "203.0.113.10")
	got, dropped, kept := filterWhepSDPApprovedCandidates([]byte(in), approved, nil)
	if kept != 2 || dropped != 15 {
		t.Fatalf("kept=%d dropped=%d, want kept=2 dropped=15", kept, dropped)
	}
	out := string(got)
	for _, forbidden := range []string{
		"192.168.1.10", "127.0.0.1", "169.254.1.2", "100.64.1.2",
		"2001:db8::10", "8.8.8.8", "host.local", "192.168.1.11", "raddr",
	} {
		if strings.Contains(out, forbidden) {
			t.Fatalf("unauthorized candidate %s leaked: %q", forbidden, out)
		}
	}
	if !strings.Contains(out, "203.0.113.9") || !strings.Contains(out, "203.0.113.10") {
		t.Fatalf("approved multi-A candidates missing: %q", out)
	}
	if !strings.Contains(out, "\r\na=end-of-candidates\r\n") {
		t.Fatalf("SDP line endings/other lines were not preserved: %q", out)
	}
}

func TestWhepGatewayOnlyReturnsApprovedPublicCandidate(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/sdp")
		w.Header().Set("Location", "/live/whep/backend-location")
		w.Header().Set("Id", "metrics-session-id")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, "v=0\r\n"+
			"a=candidate:1 1 udp 2130706431 192.168.1.10 8189 typ host\r\n"+
			"a=candidate:2 1 udp 2130706430 203.0.113.9 8189 typ host\r\n"+
			"a=candidate:3 1 udp 2130706429 8.8.8.8 8189 typ host\r\n"+
			"a=candidate:4 1 udp 2130706428 2001:db8::9 8189 typ host\r\n"+
			"a=end-of-candidates\r\n")
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	gateway := newWhepGateway(target, testApprovedCandidates(t), nil)
	req := httptest.NewRequest(http.MethodPost, "http://viewer/rtc/live/whep", strings.NewReader("v=0\r\n"))
	req.Header.Set("Content-Type", "application/sdp")
	rr := httptest.NewRecorder()
	gateway.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%q", rr.Code, rr.Body.String())
	}
	for _, forbidden := range []string{"192.168.1.10", "8.8.8.8", "2001:db8::9"} {
		if strings.Contains(rr.Body.String(), forbidden) {
			t.Fatalf("unauthorized candidate %s leaked through Gateway: %q", forbidden, rr.Body.String())
		}
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

func TestWhepGatewayFailsClosedWithoutApprovedCandidate(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/sdp")
		w.Header().Set("Location", "/live/whep/no-approved-candidate")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, "v=0\r\n"+
			"a=candidate:1 1 udp 2130706431 192.168.1.10 8189 typ host\r\n"+
			"a=candidate:2 1 udp 2130706430 8.8.8.8 8189 typ host\r\n")
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	gateway := newWhepGateway(target, testApprovedCandidates(t), nil)
	req := httptest.NewRequest(http.MethodPost, "http://viewer/rtc/live/whep", strings.NewReader("v=0\r\n"))
	req.Header.Set("Content-Type", "application/sdp")
	rr := httptest.NewRecorder()
	gateway.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%q, want 502", rr.Code, rr.Body.String())
	}
	if len(gateway.guard.snapshots(time.Now())) != 0 {
		t.Fatal("failed-closed WHEP response committed a session")
	}
}

func TestWhepGatewayRejectsQueryParameters(t *testing.T) {
	target, _ := url.Parse("http://127.0.0.1:18889")
	gateway := newWhepGateway(target, testApprovedCandidates(t), nil)
	req := httptest.NewRequest(http.MethodPost, "http://viewer/rtc/live/whep?target=http://example.test", strings.NewReader("v=0\r\n"))
	req.Header.Set("Content-Type", "application/sdp")
	rr := httptest.NewRecorder()
	gateway.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400", rr.Code)
	}
}

func TestWhepGuardCreateLimiterUsesLongestApplicableReset(t *testing.T) {
	base := time.Date(2026, time.September, 3, 12, 0, 0, 0, time.UTC)
	times := func(start, step time.Duration, n int) []time.Time {
		out := make([]time.Time, 0, n)
		for i := 0; i < n; i++ {
			out = append(out, base.Add(start+time.Duration(i)*step))
		}
		return out
	}

	tests := []struct {
		name       string
		older      []time.Time
		short      []time.Time
		wantRetry  int
		wantReason string
	}{
		{
			name:       "burst only reports burst reset",
			short:      times(-2*time.Second, 100*time.Millisecond, whepShortLimit),
			wantRetry:  8,
			wantReason: "burst-rate-limit",
		},
		{
			name:       "minute only reports minute reset",
			older:      times(-50*time.Second, time.Second, whepMinuteLimit),
			wantRetry:  10,
			wantReason: "minute-rate-limit",
		},
		{
			// Burst reset is 8s and minute reset is 15s. The create limiter
			// must advertise 15s, not the short burst-only reset the early
			// burst return used to produce when both windows were exhausted.
			name:       "both exceeded takes longer minute reset",
			older:      times(-45*time.Second, time.Second, whepMinuteLimit-whepShortLimit),
			short:      times(-2*time.Second, 100*time.Millisecond, whepShortLimit),
			wantRetry:  15,
			wantReason: "burst-rate-limit",
		},
		{
			name:       "both exceeded keeps longer burst reset",
			older:      times(-58*time.Second, time.Second, whepMinuteLimit-whepShortLimit),
			short:      times(-500*time.Millisecond, 10*time.Millisecond, whepShortLimit),
			wantRetry:  10,
			wantReason: "burst-rate-limit",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			guard := newWhepGuard()
			ip := "198.51.100.77"
			posts := append(append([]time.Time{}, tc.older...), tc.short...)
			guard.clients[rateLimitKey(ip)] = &whepClientState{posts: posts}

			ok, retry, reason := guard.reserveCreate(ip, base)
			if ok || reason != tc.wantReason || retry != tc.wantRetry {
				t.Fatalf("reserveCreate = ok:%v retry:%d reason:%q, want ok:false retry:%d reason:%q", ok, retry, reason, tc.wantRetry, tc.wantReason)
			}
			if state := guard.clients[rateLimitKey(ip)]; state.active != 0 {
				t.Fatalf("rejected create leaked an active reservation: %d", state.active)
			}
		})
	}

	// The same exhausted guard must accept a create again once the windows
	// drain, proving rejected dual-window creates never leaked reservations
	// or permanently poisoned the per-IP state.
	guard := newWhepGuard()
	ip := "198.51.100.78"
	guard.clients[rateLimitKey(ip)] = &whepClientState{posts: append(
		times(-45*time.Second, time.Second, whepMinuteLimit-whepShortLimit),
		times(-2*time.Second, 100*time.Millisecond, whepShortLimit)...,
	)}
	if ok, retry, reason := guard.reserveCreate(ip, base); ok || reason != "burst-rate-limit" || retry != 15 {
		t.Fatalf("dual-window create = ok:%v retry:%d reason:%q, want ok:false retry:15 reason:burst-rate-limit", ok, retry, reason)
	}
	if ok, _, reason := guard.reserveCreate(ip, base.Add(16*time.Second)); !ok || reason != "" {
		t.Fatalf("create after windows drained = ok:%v reason:%q", ok, reason)
	}
	guard.cancelReservation(ip)
	if state := guard.clients[rateLimitKey(ip)]; state.active != 0 {
		t.Fatalf("active reservation leaked after cancel: %d", state.active)
	}
}

func TestLiveEntryGuardBlocksMediaMTXPlayerEntries(t *testing.T) {
	backendHits := 0
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backendHits++
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	guard := newLiveEntryGuard(newProxy(target, ""))

	for _, path := range []string{
		"/live",
		"/live/",
		"/live/hls.min.js",
		"/live/hls.min.js?v=1",
		"/live/hls.min.js?x=1",
		"/live/hls.min.js.map",
		"/live/hls.min.js.map?v=1",
	} {
		req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1"+path, nil)
		rr := httptest.NewRecorder()
		guard.ServeHTTP(rr, req)
		if rr.Code != http.StatusNotFound {
			t.Fatalf("%s: status=%d, want 404", path, rr.Code)
		}
		if cc := rr.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
			t.Fatalf("%s: Cache-Control=%q, want no-store", path, cc)
		}
	}
	if backendHits != 0 {
		t.Fatalf("blocked /live player entries reached the MediaMTX backend %d times", backendHits)
	}
}

func TestLiveEntryGuardProxiesHLSNamespace(t *testing.T) {
	backendHits := 0
	var gotPath, gotQuery string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backendHits++
		gotPath = r.URL.EscapedPath()
		gotQuery = r.URL.RawQuery
		_, _ = io.WriteString(w, "#EXTM3U\n")
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	guard := newLiveEntryGuard(newProxy(target, ""))

	tests := []struct {
		target    string
		wantPath  string
		wantQuery string
	}{
		{"/live/index.m3u8", "/live/index.m3u8", ""},
		{"/live/index.m3u8?_HLS_msn=10&_HLS_part=2", "/live/index.m3u8", "_HLS_msn=10&_HLS_part=2"},
		{"/live/index.m3u8?_HLS_msn=11&_HLS_skip=YES", "/live/index.m3u8", "_HLS_msn=11&_HLS_skip=YES"},
		{"/live/test-segment", "/live/test-segment", ""},
		{"/live/test-part", "/live/test-part", ""},
	}
	for _, tc := range tests {
		req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1"+tc.target, nil)
		rr := httptest.NewRecorder()
		guard.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("%s: status=%d body=%q, want 200", tc.target, rr.Code, rr.Body.String())
		}
		if gotPath != tc.wantPath || gotQuery != tc.wantQuery {
			t.Fatalf("%s: backend saw path=%q query=%q, want path=%q query=%q", tc.target, gotPath, gotQuery, tc.wantPath, tc.wantQuery)
		}
	}
	if backendHits != len(tests) {
		t.Fatalf("backend hits=%d, want %d", backendHits, len(tests))
	}
}
func TestNormalizeLocalIPv4s(t *testing.T) {
	got, err := normalizeLocalIPv4s("")
	if err != nil || got != nil {
		t.Fatalf("empty value must disable the feature: got=%v err=%v", got, err)
	}

	got, err = normalizeLocalIPv4s("10.23.45.10, 10.0.0.5,10.23.45.10")
	if err != nil {
		t.Fatalf("valid local candidates rejected: %v", err)
	}
	if strings.Join(got, ",") != "10.23.45.10,10.0.0.5" {
		t.Fatalf("normalized local candidates=%v", got)
	}

	for _, value := range []string{
		"8.8.8.8", "203.0.113.1", "2001:db8::1", "host.local", "192.168.1.1,",
	} {
		if _, err := normalizeLocalIPv4s(value); err == nil {
			t.Fatalf("non-private local candidate accepted: %s", value)
		}
	}
}

func TestIsPrivateRequesterIPv4(t *testing.T) {
	for _, value := range []string{
		"10.23.45.20", "10.1.2.3", "172.16.9.9", "127.0.0.1", "169.254.7.7",
	} {
		if !isPrivateRequesterIPv4(value) {
			t.Fatalf("private requester %s not detected", value)
		}
	}
	for _, value := range []string{"8.8.8.8", "203.0.113.9", "2001:db8::1", ""} {
		if isPrivateRequesterIPv4(value) {
			t.Fatalf("public or invalid requester %s treated as private", value)
		}
	}
}

func TestFilterWhepSDPKeepsLocalCandidateOnlyWhenAllowed(t *testing.T) {
	in := "v=0\r\n" +
		"a=candidate:1 1 udp 2130706431 10.23.45.10 8189 typ host\r\n" +
		"a=candidate:2 1 udp 2130706430 203.0.113.9 8189 typ host\r\n" +
		"a=end-of-candidates\r\n"
	approved := testApprovedCandidates(t, "203.0.113.9")
	local := testApprovedCandidates(t, "10.23.45.10")

	got, dropped, kept := filterWhepSDPApprovedCandidates([]byte(in), approved, nil)
	if kept != 1 || dropped != 1 || strings.Contains(string(got), "10.23.45.10") {
		t.Fatalf("public answer kept=%d dropped=%d body=%q", kept, dropped, got)
	}

	got, dropped, kept = filterWhepSDPApprovedCandidates([]byte(in), approved, local)
	if kept != 2 || dropped != 0 {
		t.Fatalf("local answer kept=%d dropped=%d", kept, dropped)
	}
	for _, want := range []string{"10.23.45.10", "203.0.113.9"} {
		if !strings.Contains(string(got), want) {
			t.Fatalf("candidate %s missing from %q", want, got)
		}
	}
}

func TestWhepGatewayReleasesLocalCandidateOnlyToPrivateRequester(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/sdp")
		w.Header().Set("Location", "/live/whep/backend-location")
		w.Header().Set("Id", "metrics-session-id")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, "v=0\r\n"+
			"a=candidate:1 1 udp 2130706431 10.23.45.10 8189 typ host\r\n"+
			"a=candidate:2 1 udp 2130706430 203.0.113.9 8189 typ host\r\n"+
			"a=end-of-candidates\r\n")
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)

	for _, tc := range []struct {
		name       string
		remoteAddr string
		xff        string
		wantLocal  bool
	}{
		{name: "lan through caddy", remoteAddr: "127.0.0.1:40000", xff: "10.23.45.20", wantLocal: true},
		{name: "lan direct peer", remoteAddr: "10.23.45.20:40000", wantLocal: true},
		{name: "public through caddy", remoteAddr: "127.0.0.1:40000", xff: "198.51.100.23", wantLocal: false},
		{name: "public direct peer", remoteAddr: "198.51.100.23:40000", wantLocal: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gateway := newWhepGateway(target,
				testApprovedCandidates(t, "203.0.113.9"),
				testApprovedCandidates(t, "10.23.45.10"))
			req := httptest.NewRequest(http.MethodPost, "http://viewer/rtc/live/whep", strings.NewReader("v=0\r\n"))
			req.Header.Set("Content-Type", "application/sdp")
			req.RemoteAddr = tc.remoteAddr
			if tc.xff != "" {
				req.Header.Set("X-Forwarded-For", tc.xff)
			}
			rr := httptest.NewRecorder()
			gateway.ServeHTTP(rr, req)
			if rr.Code != http.StatusCreated {
				t.Fatalf("status=%d body=%q", rr.Code, rr.Body.String())
			}
			body := rr.Body.String()
			if strings.Contains(body, "10.23.45.10") != tc.wantLocal {
				t.Fatalf("local candidate released=%v want=%v body=%q",
					strings.Contains(body, "10.23.45.10"), tc.wantLocal, body)
			}
			if !strings.Contains(body, "203.0.113.9") {
				t.Fatalf("public candidate missing: %q", body)
			}
		})
	}
}
