package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
	if !limiter.allow("192.0.2.1") || !limiter.allow("192.0.2.1") {
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
	got, err := normalizePrivateCIDRs("192.168.50.10/24, 10.20.30.40/32,192.168.50.0/24")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"192.168.50.0/24", "10.20.30.40/32"}
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
