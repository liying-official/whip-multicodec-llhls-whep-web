package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	maxDownloadSize       int64 = 256 << 20
	maxRateLimiterEntries       = 20000
	maxWhepRequestBody    int64 = 256 << 10
	maxWhepResponseBody   int64 = 1 << 20
	maxWhepErrorBody      int64 = 64 << 10
	whepShortWindow             = 10 * time.Second
	whepMinuteWindow            = time.Minute
	whepShortLimit              = 10
	whepMinuteLimit             = 30
	whepMaxActivePerIP          = 5
	whepSessionTTL              = 5 * time.Minute
)

var whepUnsupportedCodecRE = regexp.MustCompile(`(?i)codecs?\s+not\s+supported\s+by\s+client`)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "fetch-mediamtx":
		err = runFetchMediaMTX(os.Args[2:])
	case "fetch-hlsjs":
		err = runFetchHLSJS(os.Args[2:])
	case "check-cert":
		err = runCheckCert(os.Args[2:])
	case "genkey":
		err = runGenKey()
	case "private-cidrs":
		err = runPrivateCIDRs(os.Args[2:])
	case "tcp":
		err = runTCP(os.Args[2:])
	case "serve":
		err = runServe(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		log.Fatal(err)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: helper fetch-mediamtx|fetch-hlsjs|check-cert|genkey|private-cidrs|tcp|serve [options]")
}

func httpClient() *http.Client {
	return &http.Client{
		Timeout: 10 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("too many redirects")
			}
			return nil
		},
	}
}

func newGET(rawURL string) (*http.Request, error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "obs-whip-multicodec-debian13/1.0")
	req.Header.Set("Accept", "*/*")
	return req, nil
}

func getBytes(rawURL string, limit int64) ([]byte, error) {
	req, err := newGET(rawURL)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %s", rawURL, resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errors.New("response too large")
	}
	return b, nil
}

func expectedChecksum(checksums []byte, filename string) (string, error) {
	for _, line := range strings.Split(string(checksums), "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 {
			continue
		}
		name := strings.TrimPrefix(fields[len(fields)-1], "*")
		name = strings.TrimPrefix(name, "./")
		if filepath.Base(name) != filename {
			continue
		}
		sum := strings.ToLower(fields[0])
		if len(sum) != 64 {
			continue
		}
		if _, err := hex.DecodeString(sum); err == nil {
			return sum, nil
		}
	}
	return "", fmt.Errorf("checksum for %s not found", filename)
}

func runFetchMediaMTX(args []string) error {
	fs := flag.NewFlagSet("fetch-mediamtx", flag.ContinueOnError)
	version := fs.String("version", "v1.19.3", "MediaMTX version")
	arch := fs.String("arch", "amd64", "amd64 or arm64")
	out := fs.String("out", "./bin/mediamtx", "output binary")
	licenseOut := fs.String("license", "", "optional LICENSE output")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *arch != "amd64" && *arch != "arm64" {
		return fmt.Errorf("unsupported MediaMTX architecture: %s", *arch)
	}
	if st, err := os.Stat(*out); err == nil && st.Mode().IsRegular() && st.Size() > 0 {
		return os.Chmod(*out, 0755)
	}

	filename := fmt.Sprintf("mediamtx_%s_linux_%s.tar.gz", *version, *arch)
	base := fmt.Sprintf("https://github.com/bluenviron/mediamtx/releases/download/%s", *version)
	fmt.Printf("首次启动：下载 MediaMTX %s (%s)...\n", *version, *arch)

	checksums, err := getBytes(base+"/checksums.sha256", 2<<20)
	if err != nil {
		return fmt.Errorf("download checksums: %w", err)
	}
	want, err := expectedChecksum(checksums, filename)
	if err != nil {
		return err
	}

	req, err := newGET(base + "/" + filename)
	if err != nil {
		return err
	}
	resp, err := httpClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %s", filename, resp.Status)
	}
	if resp.ContentLength > maxDownloadSize {
		return errors.New("MediaMTX release asset too large")
	}

	if err := os.MkdirAll(filepath.Dir(*out), 0755); err != nil {
		return err
	}
	tmp := *out + ".download"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, cpErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxDownloadSize+1))
	clErr := f.Close()
	if cpErr != nil {
		os.Remove(tmp)
		return cpErr
	}
	if clErr != nil {
		os.Remove(tmp)
		return clErr
	}
	if n > maxDownloadSize {
		os.Remove(tmp)
		return errors.New("MediaMTX release asset too large")
	}
	got := hex.EncodeToString(h.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		os.Remove(tmp)
		return fmt.Errorf("MediaMTX SHA256 mismatch: got %s want %s", got, want)
	}

	if err := extractMediaMTX(tmp, *out, *licenseOut); err != nil {
		os.Remove(tmp)
		return err
	}
	os.Remove(tmp)
	fmt.Printf("MediaMTX 校验完成：SHA256 %s\n", got)
	return nil
}

func extractMediaMTX(archivePath, out, licenseOut string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)

	var gotBin bool
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		base := filepath.Base(hdr.Name)
		switch base {
		case "mediamtx":
			tmpOut := out + ".tmp"
			of, err := os.OpenFile(tmpOut, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
			if err != nil {
				return err
			}
			_, cpErr := io.Copy(of, io.LimitReader(tr, maxDownloadSize))
			clErr := of.Close()
			if cpErr != nil {
				os.Remove(tmpOut)
				return cpErr
			}
			if clErr != nil {
				os.Remove(tmpOut)
				return clErr
			}
			if err := os.Chmod(tmpOut, 0755); err != nil {
				os.Remove(tmpOut)
				return err
			}
			if err := os.Rename(tmpOut, out); err != nil {
				os.Remove(tmpOut)
				return err
			}
			gotBin = true
		case "LICENSE":
			if licenseOut != "" {
				if err := os.MkdirAll(filepath.Dir(licenseOut), 0755); err != nil {
					return err
				}
				lf, err := os.OpenFile(licenseOut, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
				if err != nil {
					return err
				}
				_, cpErr := io.Copy(lf, io.LimitReader(tr, 2<<20))
				clErr := lf.Close()
				if cpErr != nil {
					return cpErr
				}
				if clErr != nil {
					return clErr
				}
			}
		}
	}
	if !gotBin {
		return errors.New("mediamtx binary not found in release archive")
	}
	return nil
}

func runCheckCert(args []string) error {
	fs := flag.NewFlagSet("check-cert", flag.ContinueOnError)
	certPath := fs.String("cert", "", "certificate PEM")
	keyPath := fs.String("key", "", "private key PEM")
	domain := fs.String("domain", "", "expected DNS hostname")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *certPath == "" || *keyPath == "" || *domain == "" {
		return errors.New("cert, key and domain are required")
	}
	certPEM, err := os.ReadFile(*certPath)
	if err != nil {
		return fmt.Errorf("read certificate: %w", err)
	}
	keyPEM, err := os.ReadFile(*keyPath)
	if err != nil {
		return fmt.Errorf("read private key: %w", err)
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return fmt.Errorf("certificate/private-key mismatch or parse error: %w", err)
	}
	if len(pair.Certificate) == 0 {
		return errors.New("certificate contains no leaf certificate")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return fmt.Errorf("parse leaf certificate: %w", err)
	}
	now := time.Now()
	if now.Before(leaf.NotBefore) {
		return fmt.Errorf("certificate is not valid before %s", leaf.NotBefore.Format(time.RFC3339))
	}
	if !now.Before(leaf.NotAfter) {
		return fmt.Errorf("certificate expired at %s", leaf.NotAfter.Format(time.RFC3339))
	}
	if err := leaf.VerifyHostname(*domain); err != nil {
		return fmt.Errorf("certificate does not match %s: %w", *domain, err)
	}
	if time.Until(leaf.NotAfter) < 24*time.Hour {
		return fmt.Errorf("certificate expires in less than 24 hours: %s", leaf.NotAfter.Format(time.RFC3339))
	}
	fmt.Printf("TLS certificate OK: %s, expires %s\n", *domain, leaf.NotAfter.Format(time.RFC3339))
	return nil
}

type npmMeta struct {
	Dist struct {
		Tarball   string `json:"tarball"`
		Integrity string `json:"integrity"`
	} `json:"dist"`
}

func runFetchHLSJS(args []string) error {
	fs := flag.NewFlagSet("fetch-hlsjs", flag.ContinueOnError)
	version := fs.String("version", "1.6.16", "hls.js version")
	out := fs.String("out", "./web/hls.min.js", "output file")
	licenseOut := fs.String("license", "", "optional LICENSE output")
	versionFile := fs.String("version-file", "", "optional version marker")
	if err := fs.Parse(args); err != nil {
		return err
	}

	expectedMarker := "hls.js v" + *version
	if st, err := os.Stat(*out); err == nil && st.Mode().IsRegular() && st.Size() > 1000 {
		if *versionFile == "" {
			return nil
		}
		if b, err := os.ReadFile(*versionFile); err == nil && strings.Contains(string(b), expectedMarker) {
			return nil
		}
	}

	metaURL := "https://registry.npmjs.org/hls.js/" + url.PathEscape(*version)
	b, err := getBytes(metaURL, 4<<20)
	if err != nil {
		return fmt.Errorf("download hls.js metadata: %w", err)
	}
	var meta npmMeta
	if err := json.Unmarshal(b, &meta); err != nil {
		return err
	}
	if meta.Dist.Tarball == "" || meta.Dist.Integrity == "" {
		return errors.New("npm metadata is missing tarball or integrity")
	}
	if !strings.HasPrefix(meta.Dist.Integrity, "sha512-") {
		return fmt.Errorf("unsupported npm integrity: %s", meta.Dist.Integrity)
	}
	want, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(meta.Dist.Integrity, "sha512-"))
	if err != nil {
		return fmt.Errorf("invalid npm integrity: %w", err)
	}

	fmt.Printf("下载 hls.js v%s...\n", *version)
	req, err := newGET(meta.Dist.Tarball)
	if err != nil {
		return err
	}
	resp, err := httpClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download hls.js: HTTP %s", resp.Status)
	}

	tmp := *out + ".tgz"
	if err := os.MkdirAll(filepath.Dir(*out), 0755); err != nil {
		return err
	}
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	h := sha512.New()
	n, cpErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxDownloadSize+1))
	clErr := f.Close()
	if cpErr != nil {
		os.Remove(tmp)
		return cpErr
	}
	if clErr != nil {
		os.Remove(tmp)
		return clErr
	}
	if n > maxDownloadSize {
		os.Remove(tmp)
		return errors.New("hls.js package too large")
	}
	got := h.Sum(nil)
	if len(got) != len(want) || subtle.ConstantTimeCompare(got, want) != 1 {
		os.Remove(tmp)
		return errors.New("hls.js SHA-512 integrity verification failed")
	}

	if err := extractHLSJS(tmp, *out, *licenseOut); err != nil {
		os.Remove(tmp)
		return err
	}
	os.Remove(tmp)
	if *versionFile != "" {
		if err := os.MkdirAll(filepath.Dir(*versionFile), 0755); err != nil {
			return err
		}
		text := expectedMarker + "\nVerified with npm dist.integrity (SHA-512)\n"
		if err := os.WriteFile(*versionFile, []byte(text), 0644); err != nil {
			return err
		}
	}
	fmt.Println("hls.js 下载并校验完成。")
	return nil
}

func extractHLSJS(archivePath, out, licenseOut string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	gotJS := false
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		clean := filepath.ToSlash(hdr.Name)
		switch clean {
		case "package/dist/hls.min.js":
			tmpOut := out + ".tmp"
			of, err := os.OpenFile(tmpOut, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
			if err != nil {
				return err
			}
			_, cpErr := io.Copy(of, io.LimitReader(tr, 16<<20))
			clErr := of.Close()
			if cpErr != nil {
				os.Remove(tmpOut)
				return cpErr
			}
			if clErr != nil {
				os.Remove(tmpOut)
				return clErr
			}
			if err := os.Rename(tmpOut, out); err != nil {
				os.Remove(tmpOut)
				return err
			}
			gotJS = true
		case "package/LICENSE":
			if licenseOut != "" {
				if err := os.MkdirAll(filepath.Dir(licenseOut), 0755); err != nil {
					return err
				}
				lf, err := os.OpenFile(licenseOut, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
				if err != nil {
					return err
				}
				_, cpErr := io.Copy(lf, io.LimitReader(tr, 2<<20))
				clErr := lf.Close()
				if cpErr != nil {
					return cpErr
				}
				if clErr != nil {
					return clErr
				}
			}
		}
	}
	if !gotJS {
		return errors.New("package/dist/hls.min.js not found in npm archive")
	}
	return nil
}

func runGenKey() error {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	key := hex.EncodeToString(b)
	sum := sha256.Sum256([]byte(key))
	hash := "sha256:" + base64.StdEncoding.EncodeToString(sum[:])
	fmt.Printf("key=%s\nhash=%s\n", key, hash)
	return nil
}

func normalizePrivateCIDRs(value string) ([]string, error) {
	privateRanges := []struct {
		network *net.IPNet
		ones    int
	}{}
	for _, raw := range []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"} {
		_, network, err := net.ParseCIDR(raw)
		if err != nil {
			return nil, err
		}
		ones, _ := network.Mask.Size()
		privateRanges = append(privateRanges, struct {
			network *net.IPNet
			ones    int
		}{network: network, ones: ones})
	}

	var out []string
	seen := make(map[string]struct{})
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			return nil, errors.New("private CIDR list contains an empty item")
		}
		_, network, err := net.ParseCIDR(item)
		if err != nil {
			return nil, fmt.Errorf("invalid ingest CIDR %q: %w", item, err)
		}
		ip4 := network.IP.To4()
		ones, bits := network.Mask.Size()
		if ip4 == nil || bits != 32 {
			return nil, fmt.Errorf("ingest CIDR %q is not IPv4", item)
		}

		isPrivate := false
		for _, privateRange := range privateRanges {
			if privateRange.network.Contains(ip4) && ones >= privateRange.ones {
				isPrivate = true
				break
			}
		}
		if !isPrivate {
			return nil, fmt.Errorf(
				"ingest CIDR %q is not fully contained in RFC1918 private IPv4 space",
				item,
			)
		}

		normalized := (&net.IPNet{IP: ip4, Mask: network.Mask}).String()
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
		if len(out) > 16 {
			return nil, errors.New("at most 16 ingest CIDRs are allowed")
		}
	}
	if len(out) == 0 {
		return nil, errors.New("at least one private ingest CIDR is required")
	}
	return out, nil
}

func runPrivateCIDRs(args []string) error {
	fs := flag.NewFlagSet("private-cidrs", flag.ContinueOnError)
	value := fs.String("value", "", "comma-separated RFC1918 IPv4 CIDRs")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cidrs, err := normalizePrivateCIDRs(*value)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(cidrs)
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}

func runTCP(args []string) error {
	fs := flag.NewFlagSet("tcp", flag.ContinueOnError)
	addr := fs.String("addr", "127.0.0.1:8080", "host:port")
	timeout := fs.Duration("timeout", 800*time.Millisecond, "timeout")
	if err := fs.Parse(args); err != nil {
		return err
	}
	c, err := net.DialTimeout("tcp", *addr, *timeout)
	if err != nil {
		return err
	}
	return c.Close()
}

func genericHLSError(status int) string {
	switch {
	case status == http.StatusNotFound:
		return "HLS stream unavailable\n"
	case status >= 500:
		return "HLS service unavailable\n"
	default:
		return "HLS request rejected\n"
	}
}

func sanitizeHLSResponse(resp *http.Response) error {
	// Strip backend implementation-identifying headers on every HLS response.
	// Preserve successful bodies and redirects (MediaMTX uses redirects and
	// cookies while establishing LL-HLS sessions), but replace backend 4xx/5xx
	// bodies so implementation details never reach the viewer.
	resp.Header.Del("Server")
	resp.Header.Del("Via")
	resp.Header.Del("X-Powered-By")
	if resp.StatusCode < 400 {
		return nil
	}
	if resp.Body != nil {
		_ = resp.Body.Close()
	}
	body := genericHLSError(resp.StatusCode)
	resp.Body = io.NopCloser(strings.NewReader(body))
	resp.ContentLength = int64(len(body))
	// Replace the entire backend error header set with a tiny allowlist. This
	// prevents a future MediaMTX diagnostic/debug header from becoming a new
	// viewer-facing disclosure channel.
	resp.Header = make(http.Header)
	resp.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	resp.Header.Set("Content-Type", "text/plain; charset=utf-8")
	resp.Header.Set("Cache-Control", "no-store")
	resp.Header.Set("X-Content-Type-Options", "nosniff")
	return nil
}

func newProxy(target *url.URL, stripPrefix string) *httputil.ReverseProxy {
	proxy := &httputil.ReverseProxy{}
	proxy.Rewrite = func(proxyReq *httputil.ProxyRequest) {
		// Rewrite removes untrusted forwarding headers before this callback.
		// The helper listens on loopback only, so preserve the values Caddy
		// generated for the public request after SetXForwarded initializes a
		// clean header set.
		forwardedFor := proxyReq.In.Header.Get("X-Forwarded-For")
		forwardedHost := proxyReq.In.Header.Get("X-Forwarded-Host")
		forwardedProto := proxyReq.In.Header.Get("X-Forwarded-Proto")
		proxyReq.SetURL(target)
		proxyReq.SetXForwarded()
		if forwardedFor != "" {
			proxyReq.Out.Header.Set("X-Forwarded-For", forwardedFor)
		}
		if forwardedHost != "" {
			proxyReq.Out.Header.Set("X-Forwarded-Host", forwardedHost)
		}
		if forwardedProto == "http" || forwardedProto == "https" {
			proxyReq.Out.Header.Set("X-Forwarded-Proto", forwardedProto)
		}
		if stripPrefix != "" {
			proxyReq.Out.URL.Path = strings.TrimPrefix(proxyReq.Out.URL.Path, stripPrefix)
			if proxyReq.Out.URL.RawPath != "" {
				proxyReq.Out.URL.RawPath = strings.TrimPrefix(proxyReq.Out.URL.RawPath, stripPrefix)
			}
		}
		if proxyReq.Out.URL.Path == "" {
			proxyReq.Out.URL.Path = "/"
		}
		proxyReq.Out.Host = target.Host
	}
	proxy.FlushInterval = -1
	proxy.ModifyResponse = sanitizeHLSResponse
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("HLS proxy error for %s: %v", r.URL.Path, err)
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "HLS backend unavailable", http.StatusBadGateway)
	}
	return proxy
}

type rateEntry struct {
	window time.Time
	count  int
}

type fixedLimiter struct {
	mu          sync.Mutex
	entries     map[string]rateEntry
	limit       int
	window      time.Duration
	lastCleanup time.Time
}

func newFixedLimiter(limit int, window time.Duration) *fixedLimiter {
	return &fixedLimiter{
		entries:     make(map[string]rateEntry),
		limit:       limit,
		window:      window,
		lastCleanup: time.Now(),
	}
}

func (l *fixedLimiter) allow(ip string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	// Keep cleanup work bounded: scan at most once per window and never let
	// attacker-controlled client addresses grow the map without a limit.
	if now.Sub(l.lastCleanup) >= l.window {
		for key, value := range l.entries {
			if now.Sub(value.window) >= l.window {
				delete(l.entries, key)
			}
		}
		l.lastCleanup = now
	}

	e, exists := l.entries[ip]
	if !exists && len(l.entries) >= maxRateLimiterEntries {
		return false
	}
	if e.window.IsZero() || now.Sub(e.window) >= l.window {
		e = rateEntry{window: now, count: 0}
	}
	e.count++
	l.entries[ip] = e
	return e.count <= l.limit
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	remoteIP := net.ParseIP(host)

	// This gateway only listens on loopback and is reached through the bundled
	// Caddy instance. Never trust a caller-supplied forwarding header from a
	// non-loopback peer if the listen address is changed by an administrator.
	if remoteIP != nil && remoteIP.IsLoopback() {
		xff := r.Header.Get("X-Forwarded-For")
		first := strings.TrimSpace(strings.Split(xff, ",")[0])
		if net.ParseIP(first) != nil {
			return first
		}
	}
	return host
}

func requestHasBody(r *http.Request) bool {
	// A chunked request has ContentLength == -1. Checking only for values
	// greater than zero would allow a body through despite the gateway's
	// documented GET/HEAD-only, no-request-body policy.
	return r.ContentLength != 0 || len(r.TransferEncoding) != 0
}

type whepClientState struct {
	posts  []time.Time
	active int
}

type whepSessionState struct {
	ip       string
	mediaID  string
	lastSeen time.Time
}

type whepSessionSnapshot struct {
	ID       string `json:"id"`
	IP       string `json:"ip"`
	LastSeen int64  `json:"last_seen_unix"`
}

type whepGuard struct {
	mu          sync.Mutex
	clients     map[string]*whepClientState
	sessions    map[string]whepSessionState
	lastCleanup time.Time
}

func newWhepGuard() *whepGuard {
	return &whepGuard{
		clients:     make(map[string]*whepClientState),
		sessions:    make(map[string]whepSessionState),
		lastCleanup: time.Now(),
	}
}

func pruneTimes(values []time.Time, cutoff time.Time) []time.Time {
	i := 0
	for i < len(values) && values[i].Before(cutoff) {
		i++
	}
	if i == 0 {
		return values
	}
	return append(values[:0], values[i:]...)
}

func retryAfterSeconds(deadline, now time.Time) int {
	d := deadline.Sub(now)
	if d <= 0 {
		return 1
	}
	n := int((d + time.Second - 1) / time.Second)
	if n < 1 {
		n = 1
	}
	return n
}

func (g *whepGuard) cleanupLocked(now time.Time) {
	if now.Sub(g.lastCleanup) < time.Minute {
		return
	}
	for key, session := range g.sessions {
		if now.Sub(session.lastSeen) <= whepSessionTTL {
			continue
		}
		delete(g.sessions, key)
		if state := g.clients[session.ip]; state != nil && state.active > 0 {
			state.active--
		}
	}
	cutoff := now.Add(-whepMinuteWindow)
	for ip, state := range g.clients {
		state.posts = pruneTimes(state.posts, cutoff)
		if state.active == 0 && len(state.posts) == 0 {
			delete(g.clients, ip)
		}
	}
	g.lastCleanup = now
}

// reserveCreate applies exact rolling limits for WHEP session creation and
// reserves one active slot before a request is sent to MediaMTX. The reserved
// slot prevents concurrent POSTs from racing past the per-IP active limit.
func (g *whepGuard) reserveCreate(ip string, now time.Time) (bool, int, string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.cleanupLocked(now)

	state := g.clients[ip]
	if state == nil {
		if len(g.clients) >= maxRateLimiterEntries {
			return false, 60, "client-table-full"
		}
		state = &whepClientState{}
		g.clients[ip] = state
	}
	state.posts = pruneTimes(state.posts, now.Add(-whepMinuteWindow))

	if state.active >= whepMaxActivePerIP {
		return false, 30, "active-session-limit"
	}

	shortCutoff := now.Add(-whepShortWindow)
	shortStart := len(state.posts)
	for i, ts := range state.posts {
		if !ts.Before(shortCutoff) {
			shortStart = i
			break
		}
	}
	shortPosts := state.posts[shortStart:]
	if len(shortPosts) >= whepShortLimit {
		return false, retryAfterSeconds(shortPosts[0].Add(whepShortWindow), now), "burst-rate-limit"
	}
	if len(state.posts) >= whepMinuteLimit {
		return false, retryAfterSeconds(state.posts[0].Add(whepMinuteWindow), now), "minute-rate-limit"
	}

	state.posts = append(state.posts, now)
	state.active++
	return true, 0, ""
}

func (g *whepGuard) cancelReservation(ip string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if state := g.clients[ip]; state != nil && state.active > 0 {
		state.active--
	}
}

func validWhepSessionID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, ch := range value {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
			(ch >= '0' && ch <= '9') || ch == '-' || ch == '_' {
			continue
		}
		return false
	}
	return true
}

func backendWhepSessionID(headers http.Header, location string) string {
	if id := strings.TrimSpace(headers.Get("ID")); validWhepSessionID(id) {
		return id
	}
	u, err := url.Parse(location)
	if err != nil {
		return ""
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) == 0 {
		return ""
	}
	id := strings.TrimSpace(parts[len(parts)-1])
	if id == "whep" || !validWhepSessionID(id) {
		return ""
	}
	return id
}

func (g *whepGuard) commitSession(ip, key, mediaID string, now time.Time) bool {
	if key == "" || !validWhepSessionID(mediaID) {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if _, exists := g.sessions[key]; exists {
		return false
	}
	g.sessions[key] = whepSessionState{ip: ip, mediaID: mediaID, lastSeen: now}
	return true
}

func (g *whepGuard) snapshots(now time.Time) []whepSessionSnapshot {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.cleanupLocked(now)
	out := make([]whepSessionSnapshot, 0, len(g.sessions))
	for _, session := range g.sessions {
		if !validWhepSessionID(session.mediaID) || net.ParseIP(session.ip) == nil {
			continue
		}
		out = append(out, whepSessionSnapshot{
			ID: session.mediaID, IP: session.ip, LastSeen: session.lastSeen.Unix(),
		})
	}
	return out
}

func (g *whepGuard) ownsSession(ip, key string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.cleanupLocked(now)
	session, ok := g.sessions[key]
	return ok && session.ip == ip
}

func (g *whepGuard) touchSession(ip, key string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.cleanupLocked(now)
	session, ok := g.sessions[key]
	if !ok || session.ip != ip {
		return false
	}
	session.lastSeen = now
	g.sessions[key] = session
	return true
}

func (g *whepGuard) releaseSession(ip, key string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[key]
	if !ok || session.ip != ip {
		return
	}
	delete(g.sessions, key)
	if state := g.clients[ip]; state != nil && state.active > 0 {
		state.active--
	}
}

func publicWhepSessionPath(location string) (string, bool) {
	u, err := url.Parse(location)
	if err != nil {
		return "", false
	}
	path := u.Path
	if strings.HasPrefix(path, "/rtc/live/whep/") {
		return path, true
	}
	if strings.HasPrefix(path, "/live/whep/") {
		return "/rtc" + path, true
	}
	return "", false
}

func copyWhepResponseHeaders(dst, src http.Header) {
	for _, name := range []string{"Content-Type", "ETag", "Accept-Patch", "Link", "Cache-Control"} {
		for _, value := range src.Values(name) {
			dst.Add(name, value)
		}
	}
}

// filterWhepSDPIPv4Candidates is a defense-in-depth boundary for the public
// WHEP endpoint. MediaMTX resolves webrtcAdditionalHosts server-side; when a
// DDNS hostname unexpectedly gains an AAAA record, the answer can therefore
// contain IPv6 host candidates even though this package intentionally uses an
// IPv4/LAN ICE topology. Keep only syntactically valid IPv4 candidate lines.
// Non-candidate SDP lines and their original line endings are preserved.
func filterWhepSDPIPv4Candidates(body []byte) ([]byte, int, bool) {
	text := string(body)
	var out strings.Builder
	out.Grow(len(text))
	dropped := 0
	hasIPv4 := false

	for len(text) > 0 {
		segment := text
		text = ""
		if i := strings.IndexByte(segment, '\n'); i >= 0 {
			segment, text = segment[:i+1], segment[i+1:]
		}

		line := strings.TrimSuffix(segment, "\n")
		line = strings.TrimSuffix(line, "\r")
		if strings.HasPrefix(line, "a=candidate:") {
			fields := strings.Fields(line)
			if len(fields) < 6 {
				dropped++
				continue
			}
			ip := net.ParseIP(fields[4])
			if ip == nil || ip.To4() == nil {
				dropped++
				continue
			}
			hasIPv4 = true
		}
		out.WriteString(segment)
	}

	return []byte(out.String()), dropped, hasIPv4
}

func genericWhepError(status int, class string) string {
	switch class {
	case "unsupported-codec":
		return "WHEP codec unsupported\n"
	case "rate-limit":
		return "WHEP request limit exceeded\n"
	case "session-limit":
		return "WHEP active session limit exceeded\n"
	}
	switch {
	case status == http.StatusNotFound:
		return "WHEP session unavailable\n"
	case status >= 500:
		return "WHEP service unavailable\n"
	default:
		return "WHEP request rejected\n"
	}
}

type whepGateway struct {
	target *url.URL
	guard  *whepGuard
	client *http.Client
}

func newWhepGateway(target *url.URL) *whepGateway {
	return &whepGateway{
		target: target,
		guard:  newWhepGuard(),
		client: &http.Client{Timeout: 20 * time.Second},
	}
}

func isSDPContentType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	return err == nil && strings.EqualFold(mediaType, "application/sdp")
}

func (g *whepGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	now := time.Now()
	path := r.URL.Path
	isCreate := path == "/rtc/live/whep" && r.Method == http.MethodPost
	isSession := strings.HasPrefix(path, "/rtc/live/whep/")

	if !isCreate && !isSession {
		http.NotFound(w, r)
		return
	}

	if isSession && r.Method == http.MethodPost && r.Header.Get("X-WHEP-Keepalive") == "1" {
		if requestHasBody(r) {
			http.Error(w, "request body not allowed", http.StatusBadRequest)
			return
		}
		if !g.guard.touchSession(ip, path, now) {
			http.Error(w, genericWhepError(http.StatusNotFound, ""), http.StatusNotFound)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if isCreate {
		// Validate the non-simple WHEP media type before touching rate-limit or
		// active-session state. This prevents a cross-site HTML form using a
		// simple content type (for example text/plain) from exhausting a viewer's
		// per-IP WHEP quota. Optional MIME parameters are accepted.
		if !isSDPContentType(r.Header.Get("Content-Type")) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Accept-Post", "application/sdp")
			http.Error(w, "unsupported media type", http.StatusUnsupportedMediaType)
			return
		}

		ok, retry, reason := g.guard.reserveCreate(ip, now)
		if !ok {
			class := "rate-limit"
			if reason == "active-session-limit" {
				class = "session-limit"
			}
			w.Header().Set("Retry-After", fmt.Sprintf("%d", retry))
			w.Header().Set("X-WHEP-Error", class)
			w.Header().Set("Cache-Control", "no-store")
			http.Error(w, strings.TrimSpace(genericWhepError(http.StatusTooManyRequests, class)), http.StatusTooManyRequests)
			return
		}
	} else {
		if r.Method != http.MethodPatch && r.Method != http.MethodDelete {
			w.Header().Set("Allow", "PATCH, DELETE")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !g.guard.ownsSession(ip, path, now) {
			http.Error(w, strings.TrimSpace(genericWhepError(http.StatusNotFound, "")), http.StatusNotFound)
			return
		}
	}

	reserved := isCreate
	if r.ContentLength > maxWhepRequestBody {
		if reserved {
			g.guard.cancelReservation(ip)
		}
		http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
		return
	}
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, maxWhepRequestBody)
	}

	backend := *g.target
	backend.Path = strings.TrimPrefix(path, "/rtc")
	backend.RawPath = ""
	backend.RawQuery = r.URL.RawQuery
	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, backend.String(), r.Body)
	if err == nil {
		outReq.ContentLength = r.ContentLength
	}
	if err != nil {
		if reserved {
			g.guard.cancelReservation(ip)
		}
		http.Error(w, strings.TrimSpace(genericWhepError(http.StatusBadGateway, "")), http.StatusBadGateway)
		return
	}
	for _, name := range []string{"Content-Type", "Accept", "If-Match"} {
		if value := r.Header.Get(name); value != "" {
			outReq.Header.Set(name, value)
		}
	}
	// clientIP() trusts X-Forwarded-For only from a loopback peer (bundled Caddy).
	// MediaMTX trusts this loopback Gateway, allowing its loopback-only metrics
	// endpoint to expose the real WHEP viewer IP instead of 127.0.0.1.
	if ip != "" {
		outReq.Header.Set("X-Forwarded-For", ip)
	}
	outReq.Header.Set("User-Agent", "obs-whip-public-whep-gateway/r33")

	resp, err := g.client.Do(outReq)
	if err != nil {
		if reserved {
			g.guard.cancelReservation(ip)
		}
		log.Printf("WHEP backend unavailable: status=transport-error path=%s", path)
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, strings.TrimSpace(genericWhepError(http.StatusBadGateway, "")), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxWhepErrorBody+1))
		class := ""
		if resp.StatusCode == http.StatusBadRequest && whepUnsupportedCodecRE.Match(body) {
			class = "unsupported-codec"
			w.Header().Set("X-WHEP-Error", class)
		}
		log.Printf("WHEP backend rejected request: status=%d class=%s path=%s", resp.StatusCode, class, path)
		if reserved {
			g.guard.cancelReservation(ip)
		}
		if r.Method == http.MethodDelete {
			g.guard.releaseSession(ip, path)
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(resp.StatusCode)
		_, _ = io.WriteString(w, genericWhepError(resp.StatusCode, class))
		return
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxWhepResponseBody+1))
	if err != nil || int64(len(body)) > maxWhepResponseBody {
		if reserved {
			g.guard.cancelReservation(ip)
		}
		http.Error(w, strings.TrimSpace(genericWhepError(http.StatusBadGateway, "")), http.StatusBadGateway)
		return
	}

	if isCreate {
		filtered, dropped, hasIPv4 := filterWhepSDPIPv4Candidates(body)
		if dropped != 0 && !hasIPv4 {
			if reserved {
				g.guard.cancelReservation(ip)
			}
			log.Printf("WHEP backend answer has no usable IPv4 ICE candidate: dropped=%d", dropped)
			w.Header().Set("Cache-Control", "no-store")
			http.Error(w, strings.TrimSpace(genericWhepError(http.StatusBadGateway, "")), http.StatusBadGateway)
			return
		}
		if dropped != 0 {
			log.Printf("WHEP stripped %d non-IPv4 ICE candidate(s) from public SDP answer", dropped)
		}
		body = filtered
	}

	copyWhepResponseHeaders(w.Header(), resp.Header)
	w.Header().Set("Cache-Control", "no-store")

	if isCreate {
		location := resp.Header.Get("Location")
		publicPath, ok := publicWhepSessionPath(location)
		mediaID := backendWhepSessionID(resp.Header, location)
		if !ok || !g.guard.commitSession(ip, publicPath, mediaID, now) {
			g.guard.cancelReservation(ip)
			log.Printf("WHEP backend returned an invalid/duplicate Location or session ID")
			http.Error(w, strings.TrimSpace(genericWhepError(http.StatusBadGateway, "")), http.StatusBadGateway)
			return
		}
		reserved = false
		w.Header().Set("Location", publicPath)
	}

	w.WriteHeader(resp.StatusCode)
	if r.Method != http.MethodHead && len(body) != 0 {
		_, _ = w.Write(body)
	}
	if r.Method == http.MethodDelete {
		g.guard.releaseSession(ip, path)
	}
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	dir := fs.String("dir", "./web", "web root")
	addr := fs.String("addr", "127.0.0.1:8080", "listen address")
	backend := fs.String("hls-backend", "http://127.0.0.1:8888", "MediaMTX HLS backend")
	whepBackend := fs.String("whep-backend", "http://127.0.0.1:8889", "MediaMTX WHEP backend")
	if err := fs.Parse(args); err != nil {
		return err
	}

	target, err := url.Parse(*backend)
	if err != nil {
		return err
	}
	whepTarget, err := url.Parse(*whepBackend)
	if err != nil {
		return err
	}
	abs, err := filepath.Abs(*dir)
	if err != nil {
		return err
	}
	indexPath := filepath.Join(abs, "index.html")
	hlsJSPath := filepath.Join(abs, "hls.min.js")
	appJSPath := filepath.Join(abs, "app.js")
	appCSSPath := filepath.Join(abs, "app.css")
	for _, f := range []string{indexPath, hlsJSPath, appJSPath, appCSSPath} {
		if _, err := os.Stat(f); err != nil {
			return fmt.Errorf("web asset unavailable: %s: %w", f, err)
		}
	}

	liveProxy := newProxy(target, "")
	whepProxy := newWhepGateway(whepTarget)
	limiter := newFixedLimiter(6000, time.Minute)

	mux := http.NewServeMux()
	mux.Handle("/live/", liveProxy)
	mux.HandleFunc("/live", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/live/", http.StatusTemporaryRedirect)
	})

	serveFile := func(path, ctype, cache string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", ctype)
			w.Header().Set("Cache-Control", cache)
			w.Header().Set("X-Content-Type-Options", "nosniff")
			http.ServeFile(w, r, path)
		}
	}
	mux.HandleFunc("/hls.min.js", serveFile(hlsJSPath, "text/javascript; charset=utf-8", "public, max-age=0, must-revalidate"))
	mux.HandleFunc("/app.js", serveFile(appJSPath, "text/javascript; charset=utf-8", "no-cache"))
	mux.HandleFunc("/app.css", serveFile(appCSSPath, "text/css; charset=utf-8", "no-cache"))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("/__internal/whep-sessions", func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		peer := net.ParseIP(host)
		if peer == nil || !peer.IsLoopback() {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if requestHasBody(r) {
			http.Error(w, "request body not allowed", http.StatusBadRequest)
			return
		}
		payload := struct {
			Sessions []whepSessionSnapshot `json:"sessions"`
		}{Sessions: whepProxy.guard.snapshots(time.Now())}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		_ = json.NewEncoder(w).Encode(payload)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" && r.URL.Path != "/index.html" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		http.ServeFile(w, r, indexPath)
	})

	protected := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rtc/live/whep" || strings.HasPrefix(r.URL.Path, "/rtc/live/whep/") {
			whepProxy.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if requestHasBody(r) {
			http.Error(w, "request body not allowed", http.StatusBadRequest)
			return
		}
		if !limiter.allow(clientIP(r)) {
			w.Header().Set("Retry-After", "10")
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}
		mux.ServeHTTP(w, r)
	})

	srv := &http.Server{
		Addr:              *addr,
		Handler:           protected,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	log.Printf("internal Web/HLS gateway listening on %s", *addr)
	return srv.ListenAndServe()
}
