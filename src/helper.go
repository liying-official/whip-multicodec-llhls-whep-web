package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
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
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxDownloadSize          int64 = 256 << 20
	maxRateLimiterEntries          = 20000
	maxWhepRequestBody       int64 = 256 << 10
	maxWhepResponseBody      int64 = 1 << 20
	maxWhepErrorBody         int64 = 64 << 10
	whepShortWindow                = 10 * time.Second
	whepMinuteWindow               = time.Minute
	whepShortLimit                 = 10
	whepMinuteLimit                = 30
	whepMaxActivePerIP             = 5
	whepSessionTTL                 = 5 * time.Minute
	whepOperationBurstLimit        = 30
	whepOperationMinuteLimit       = 120
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
	case "public-ips":
		err = runPublicIPs(os.Args[2:])
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
	fmt.Fprintln(os.Stderr, "usage: helper fetch-mediamtx|fetch-hlsjs|check-cert|genkey|private-cidrs|public-ips|tcp|serve [options]")
}

func httpClient() *http.Client {
	return &http.Client{
		Timeout: 10 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("too many redirects")
			}
			if err := validateHTTPSURL(req.URL); err != nil {
				return fmt.Errorf("unsafe download redirect: %w", err)
			}
			return nil
		},
	}
}

func validateHTTPSURL(u *url.URL) error {
	if u == nil || !strings.EqualFold(u.Scheme, "https") || u.Host == "" {
		return errors.New("download URL must use HTTPS and include a host")
	}
	if u.User != nil {
		return errors.New("download URL must not contain user information")
	}
	return nil
}

func newGET(rawURL string) (*http.Request, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	if err := validateHTTPSURL(u); err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "obs-whip-multicodec-debian13/V1.35")
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

func createSiblingTemp(target string, mode os.FileMode) (*os.File, string, error) {
	if strings.TrimSpace(target) == "" {
		return nil, "", errors.New("output path is empty")
	}
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0750); err != nil {
		return nil, "", err
	}
	f, err := os.CreateTemp(dir, ".obs-whip-download-*")
	if err != nil {
		return nil, "", err
	}
	if err := f.Chmod(mode); err != nil {
		name := f.Name()
		_ = f.Close()
		_ = os.Remove(name)
		return nil, "", err
	}
	return f, f.Name(), nil
}

func replaceTempFile(tmp, target string, mode os.FileMode) error {
	if st, err := os.Lstat(target); err == nil {
		if st.Mode()&os.ModeSymlink != 0 || !st.Mode().IsRegular() {
			return fmt.Errorf("refusing to replace non-regular output: %s", target)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	return os.Rename(tmp, target)
}

func writeFileAtomic(target string, data []byte, mode os.FileMode) error {
	f, tmp, err := createSiblingTemp(target, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return replaceTempFile(tmp, target, mode)
}

func copyTarEntry(dst io.Writer, src io.Reader, size int64) error {
	n, err := io.CopyN(dst, src, size)
	if err != nil {
		return err
	}
	if n != size {
		return io.ErrUnexpectedEOF
	}
	return nil
}

func runFetchMediaMTX(args []string) error {
	fs := flag.NewFlagSet("fetch-mediamtx", flag.ContinueOnError)
	version := fs.String("version", "v1.21.0", "MediaMTX version")
	arch := fs.String("arch", "amd64", "amd64 or arm64")
	out := fs.String("out", "./bin/mediamtx", "output binary")
	licenseOut := fs.String("license", "", "optional LICENSE output")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *arch != "amd64" && *arch != "arm64" {
		return fmt.Errorf("unsupported MediaMTX architecture: %s", *arch)
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

	f, tmp, err := createSiblingTemp(*out, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	h := sha256.New()
	n, cpErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxDownloadSize+1))
	clErr := f.Close()
	if cpErr != nil {
		return cpErr
	}
	if clErr != nil {
		return clErr
	}
	if n > maxDownloadSize {
		return errors.New("MediaMTX release asset too large")
	}
	got := hex.EncodeToString(h.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		return fmt.Errorf("MediaMTX SHA256 mismatch: got %s want %s", got, want)
	}

	if err := extractMediaMTX(tmp, *out, *licenseOut); err != nil {
		return err
	}
	fmt.Printf("MediaMTX 校验完成：SHA256 %s\n", got)
	return nil
}

func extractMediaMTX(archivePath, out, licenseOut string) error {
	// #nosec G304 -- archivePath is an unpredictable sibling temporary file
	// created by this process after HTTPS and release-checksum verification.
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
			if hdr.Size < 1 || hdr.Size > maxDownloadSize {
				return errors.New("invalid MediaMTX binary size in release archive")
			}
			of, tmpOut, err := createSiblingTemp(out, 0600)
			if err != nil {
				return err
			}
			cpErr := copyTarEntry(of, tr, hdr.Size)
			clErr := of.Close()
			if cpErr != nil {
				_ = os.Remove(tmpOut)
				return cpErr
			}
			if clErr != nil {
				_ = os.Remove(tmpOut)
				return clErr
			}
			if err := replaceTempFile(tmpOut, out, 0755); err != nil {
				_ = os.Remove(tmpOut)
				return err
			}
			gotBin = true
		case "LICENSE":
			if licenseOut != "" {
				if hdr.Size < 1 || hdr.Size > 2<<20 {
					return errors.New("invalid MediaMTX LICENSE size in release archive")
				}
				lf, tmpLicense, err := createSiblingTemp(licenseOut, 0600)
				if err != nil {
					return err
				}
				cpErr := copyTarEntry(lf, tr, hdr.Size)
				clErr := lf.Close()
				if cpErr != nil {
					_ = os.Remove(tmpLicense)
					return cpErr
				}
				if clErr != nil {
					_ = os.Remove(tmpLicense)
					return clErr
				}
				if err := replaceTempFile(tmpLicense, licenseOut, 0644); err != nil {
					_ = os.Remove(tmpLicense)
					return err
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
	leaf, err := validateCertificateBundle(certPEM, keyPEM, *domain, time.Now(), nil)
	if err != nil {
		return err
	}
	fmt.Printf("TLS certificate OK: %s, expires %s\n", *domain, leaf.NotAfter.Format(time.RFC3339))
	return nil
}

func validateCertificateBundle(certPEM, keyPEM []byte, domain string, now time.Time, roots *x509.CertPool) (*x509.Certificate, error) {
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("certificate/private-key mismatch or parse error: %w", err)
	}
	if len(pair.Certificate) == 0 {
		return nil, errors.New("certificate contains no leaf certificate")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse leaf certificate: %w", err)
	}
	if now.Before(leaf.NotBefore) {
		return nil, fmt.Errorf("certificate is not valid before %s", leaf.NotBefore.Format(time.RFC3339))
	}
	if !now.Before(leaf.NotAfter) {
		return nil, fmt.Errorf("certificate expired at %s", leaf.NotAfter.Format(time.RFC3339))
	}

	if roots == nil {
		roots, err = x509.SystemCertPool()
		if err != nil {
			return nil, fmt.Errorf("load system trust store: %w", err)
		}
	}
	intermediates := x509.NewCertPool()
	for i, raw := range pair.Certificate[1:] {
		cert, parseErr := x509.ParseCertificate(raw)
		if parseErr != nil {
			return nil, fmt.Errorf("parse intermediate certificate %d: %w", i+1, parseErr)
		}
		intermediates.AddCert(cert)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{
		DNSName:       domain,
		Roots:         roots,
		Intermediates: intermediates,
		CurrentTime:   now,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}); err != nil {
		return nil, fmt.Errorf("certificate is not trusted for %s: %w", domain, err)
	}

	// Use the caller-provided time for deterministic tests and for hosts whose
	// wall clock changes between parsing and verification.
	if leaf.NotAfter.Sub(now) < 24*time.Hour {
		return nil, fmt.Errorf("certificate expires in less than 24 hours: %s", leaf.NotAfter.Format(time.RFC3339))
	}
	return leaf, nil
}

type npmMeta struct {
	Dist struct {
		Tarball   string `json:"tarball"`
		Integrity string `json:"integrity"`
	} `json:"dist"`
}

func runFetchHLSJS(args []string) error {
	fs := flag.NewFlagSet("fetch-hlsjs", flag.ContinueOnError)
	version := fs.String("version", "1.7.3", "hls.js version")
	out := fs.String("out", "./web/hls.min.js", "output file")
	licenseOut := fs.String("license", "", "optional LICENSE output")
	versionFile := fs.String("version-file", "", "optional version marker")
	if err := fs.Parse(args); err != nil {
		return err
	}

	expectedMarker := "hls.js v" + *version

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
	if resp.ContentLength > maxDownloadSize {
		return errors.New("hls.js package too large")
	}

	f, tmp, err := createSiblingTemp(*out, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	h := sha512.New()
	n, cpErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxDownloadSize+1))
	clErr := f.Close()
	if cpErr != nil {
		return cpErr
	}
	if clErr != nil {
		return clErr
	}
	if n > maxDownloadSize {
		return errors.New("hls.js package too large")
	}
	got := h.Sum(nil)
	if len(got) != len(want) || subtle.ConstantTimeCompare(got, want) != 1 {
		return errors.New("hls.js SHA-512 integrity verification failed")
	}

	if err := extractHLSJS(tmp, *out, *licenseOut); err != nil {
		return err
	}
	if *versionFile != "" {
		text := expectedMarker + "\nVerified with npm dist.integrity (SHA-512)\n"
		if err := writeFileAtomic(*versionFile, []byte(text), 0644); err != nil {
			return err
		}
	}
	fmt.Println("hls.js 下载并校验完成。")
	return nil
}

func extractHLSJS(archivePath, out, licenseOut string) error {
	// #nosec G304 -- archivePath is an unpredictable sibling temporary file
	// created by this process after npm HTTPS integrity metadata validation.
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
			if hdr.Size < 1 || hdr.Size > 16<<20 {
				return errors.New("invalid hls.min.js size in npm archive")
			}
			of, tmpOut, err := createSiblingTemp(out, 0600)
			if err != nil {
				return err
			}
			cpErr := copyTarEntry(of, tr, hdr.Size)
			clErr := of.Close()
			if cpErr != nil {
				_ = os.Remove(tmpOut)
				return cpErr
			}
			if clErr != nil {
				_ = os.Remove(tmpOut)
				return clErr
			}
			if err := replaceTempFile(tmpOut, out, 0644); err != nil {
				_ = os.Remove(tmpOut)
				return err
			}
			gotJS = true
		case "package/LICENSE":
			if licenseOut != "" {
				if hdr.Size < 1 || hdr.Size > 2<<20 {
					return errors.New("invalid hls.js LICENSE size in npm archive")
				}
				lf, tmpLicense, err := createSiblingTemp(licenseOut, 0600)
				if err != nil {
					return err
				}
				cpErr := copyTarEntry(lf, tr, hdr.Size)
				clErr := lf.Close()
				if cpErr != nil {
					_ = os.Remove(tmpLicense)
					return cpErr
				}
				if clErr != nil {
					_ = os.Remove(tmpLicense)
					return clErr
				}
				if err := replaceTempFile(tmpLicense, licenseOut, 0644); err != nil {
					_ = os.Remove(tmpLicense)
					return err
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

var nonPublicIPv4Prefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
}

func isPublicRoutableIPv4(addr netip.Addr) bool {
	if !addr.IsValid() || !addr.Is4() || !addr.IsGlobalUnicast() {
		return false
	}
	for _, prefix := range nonPublicIPv4Prefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func normalizePublicIPv4s(value string) ([]string, error) {
	if strings.TrimSpace(value) == "" {
		return nil, errors.New("at least one public IPv4 address is required")
	}

	out := make([]string, 0, 4)
	seen := make(map[netip.Addr]struct{})
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			return nil, errors.New("public IPv4 list contains an empty item")
		}
		addr, err := netip.ParseAddr(item)
		if err != nil || !isPublicRoutableIPv4(addr) {
			return nil, fmt.Errorf("PUBLIC_HOST resolved to non-public IPv4 address %q", item)
		}
		if _, ok := seen[addr]; ok {
			continue
		}
		seen[addr] = struct{}{}
		out = append(out, addr.String())
		if len(out) > 16 {
			return nil, errors.New("PUBLIC_HOST may resolve to at most 16 public IPv4 addresses")
		}
	}
	if len(out) == 0 {
		return nil, errors.New("at least one public IPv4 address is required")
	}
	return out, nil
}

func approvedIPv4Set(values []string) map[netip.Addr]struct{} {
	out := make(map[netip.Addr]struct{}, len(values))
	for _, value := range values {
		addr, err := netip.ParseAddr(value)
		if err == nil && addr.Is4() {
			out[addr] = struct{}{}
		}
	}
	return out
}

func runPublicIPs(args []string) error {
	fs := flag.NewFlagSet("public-ips", flag.ContinueOnError)
	value := fs.String("value", "", "comma-separated PUBLIC_HOST IPv4 A records")
	if err := fs.Parse(args); err != nil {
		return err
	}
	ips, err := normalizePublicIPv4s(*value)
	if err != nil {
		return err
	}
	fmt.Println(strings.Join(ips, ","))
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
		hardenHLSResponseCookies(resp)
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

func allowedHLSCookie(name string) bool {
	return name == "cookieCheck" || name == "hlsSession"
}

func hardenHLSResponseCookies(resp *http.Response) {
	if len(resp.Header.Values("Set-Cookie")) == 0 {
		return
	}
	cookies := resp.Cookies()
	resp.Header.Del("Set-Cookie")
	for _, cookie := range cookies {
		if !allowedHLSCookie(cookie.Name) {
			continue
		}
		cookie.Secure = true
		cookie.HttpOnly = true
		if cookie.SameSite == 0 || cookie.SameSite == http.SameSiteDefaultMode {
			cookie.SameSite = http.SameSiteLaxMode
		}
		resp.Header.Add("Set-Cookie", cookie.String())
	}
}

func copyAllowedHLSRequestCookies(dst, src *http.Request) {
	dst.Header.Del("Cookie")
	for _, cookie := range src.Cookies() {
		if !allowedHLSCookie(cookie.Name) {
			continue
		}
		dst.AddCookie(&http.Cookie{
			Name:     cookie.Name,
			Value:    cookie.Value,
			Secure:   true,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
		})
	}
}

func isAssignedLocalIP(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, addr := range addrs {
		var assigned net.IP
		switch value := addr.(type) {
		case *net.IPNet:
			assigned = value.IP
		case *net.IPAddr:
			assigned = value.IP
		default:
			continue
		}
		if assigned.Equal(ip) {
			return true
		}
	}
	return false
}

func validateLocalBackendURL(u *url.URL) error {
	if u == nil || !strings.EqualFold(u.Scheme, "http") || u.Opaque != "" {
		return errors.New("backend URL must use plain HTTP to a literal local address")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("backend URL must not contain credentials, query parameters, or fragments")
	}
	if u.Path != "" && u.Path != "/" {
		return errors.New("backend URL must not contain a path")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !isAssignedLocalIP(ip) {
		return errors.New("backend URL host must be a literal IP assigned to this server")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return errors.New("backend URL must include a valid TCP port")
	}
	return nil
}

func newPinnedBackendTransport(target *url.URL) *http.Transport {
	pinnedIP := net.ParseIP(target.Hostname())
	pinnedPort := target.Port()
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" && network != "tcp4" && network != "tcp6" {
				return nil, errors.New("refusing non-TCP backend connection")
			}
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, fmt.Errorf("invalid backend address: %w", err)
			}
			ip := net.ParseIP(host)
			if pinnedIP == nil || ip == nil || !ip.Equal(pinnedIP) || port != pinnedPort {
				return nil, errors.New("refusing unpinned backend connection")
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(pinnedIP.String(), pinnedPort))
		},
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 100,
		IdleConnTimeout:     90 * time.Second,
	}
}

func safeLogField(value string) string {
	const maxBytes = 256
	var out strings.Builder
	for _, r := range value {
		if out.Len() >= maxBytes {
			break
		}
		if r < 0x20 || r > 0x7e {
			out.WriteByte('?')
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}

func newProxy(target *url.URL, stripPrefix string) *httputil.ReverseProxy {
	proxy := &httputil.ReverseProxy{}
	proxy.Transport = newPinnedBackendTransport(target)
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
		// The HLS backend is anonymous and only needs its own two session
		// cookies. Never forward browser/site credentials or unrelated cookies
		// into MediaMTX, where future logging or authentication changes could
		// turn them into a disclosure channel.
		proxyReq.Out.Header.Del("Authorization")
		proxyReq.Out.Header.Del("Proxy-Authorization")
		proxyReq.Out.Header.Del("X-Real-IP")
		copyAllowedHLSRequestCookies(proxyReq.Out, proxyReq.In)
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
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, _ error) {
		// Avoid putting a user-controlled path or transport details into logs.
		log.Printf("HLS backend unavailable: path=%q", safeLogField(r.URL.Path))
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "HLS backend unavailable", http.StatusBadGateway)
	}
	return proxy
}

// newLiveEntryGuard wraps the /live reverse proxy and denies the MediaMTX
// built-in HLS player page and its embedded hls.js copy. The project Web
// Player serves its own /hls.min.js, so only these exact names are removed
// while manifests, segments, and LL-HLS parts keep flowing to the backend.
// The decision uses r.URL.Path, never the reassembled URL, so a query string
// cannot bypass the block, and exact /live answers 404 instead of the old
// redirect to the player page.
func newLiveEntryGuard(proxy http.Handler) http.Handler {
	blockedLiveEntries := map[string]bool{
		"/live":                true,
		"/live/":               true,
		"/live/hls.min.js":     true,
		"/live/hls.min.js.map": true,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if blockedLiveEntries[r.URL.Path] {
			w.Header().Set("Cache-Control", "no-store")
			http.NotFound(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	})
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

// rateLimitKey keeps IPv4 clients isolated while grouping IPv6 clients by /64.
// A single IPv6 subscriber prefix can contain effectively unlimited temporary
// addresses, so using the full address would let one client exhaust bounded
// limiter tables by rotating source addresses.
func rateLimitKey(value string) string {
	addr, err := netip.ParseAddr(strings.TrimSpace(value))
	if err != nil {
		return value
	}
	addr = addr.Unmap()
	if addr.Is4() {
		return addr.String()
	}
	addr = addr.WithZone("")
	return netip.PrefixFrom(addr, 64).Masked().String()
}

func (l *fixedLimiter) allow(ip string) bool {
	allowed, _ := l.hitAt(ip, time.Now())
	return allowed
}

// hitAt records one request and returns the exact number of whole seconds until
// the fixed window resets when the request is rejected. Accepting now as an
// argument keeps boundary behavior deterministic in tests and lets callers with
// multiple windows evaluate every limit against the same clock sample.
func (l *fixedLimiter) hitAt(ip string, now time.Time) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := rateLimitKey(ip)

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

	e, exists := l.entries[key]
	if !exists && len(l.entries) >= maxRateLimiterEntries {
		return false, retryAfterSeconds(l.lastCleanup.Add(l.window), now)
	}
	if e.window.IsZero() || now.Sub(e.window) >= l.window {
		e = rateEntry{window: now, count: 0}
	}
	e.count++
	l.entries[key] = e
	if e.count <= l.limit {
		return true, 0
	}
	return false, retryAfterSeconds(e.window.Add(l.window), now)
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
		parts := strings.Split(xff, ",")
		last := strings.TrimSpace(parts[len(parts)-1])
		if parsed := net.ParseIP(last); parsed != nil {
			return parsed.String()
		}
	}
	return host
}

// isPrivateRequesterIPv4 reports whether value is an IPv4 address inside a
// private, loopback or link-local range.
//
// Only such a client may additionally receive LAN ICE candidates: it can
// already reach the server over the local network, so those addresses are not
// a new disclosure to it. A public requester keeps the PUBLIC_HOST snapshot
// only.
func isPrivateRequesterIPv4(value string) bool {
	addr, err := netip.ParseAddr(value)
	if err != nil || !addr.Is4() {
		return false
	}
	return addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast()
}

// normalizeLocalIPv4s validates the LAN ICE candidates that may be released to
// private requesters. An empty value keeps the feature disabled, so the public
// endpoint stays limited to the PUBLIC_HOST snapshot.
func normalizeLocalIPv4s(value string) ([]string, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}

	out := make([]string, 0, 4)
	seen := make(map[netip.Addr]struct{})
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			return nil, errors.New("local WHEP candidate list contains an empty item")
		}
		addr, err := netip.ParseAddr(item)
		if err != nil || !addr.Is4() {
			return nil, fmt.Errorf("local WHEP candidate is not an IPv4 address: %q", item)
		}
		if !addr.IsPrivate() && !addr.IsLoopback() && !addr.IsLinkLocalUnicast() {
			return nil, fmt.Errorf("local WHEP candidate is not a private IPv4 address: %q", item)
		}
		if _, ok := seen[addr]; ok {
			continue
		}
		seen[addr] = struct{}{}
		out = append(out, addr.String())
		if len(out) > 16 {
			return nil, errors.New("local WHEP candidate list may contain at most 16 addresses")
		}
	}
	return out, nil
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
		if state := g.clients[rateLimitKey(session.ip)]; state != nil && state.active > 0 {
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
	clientKey := rateLimitKey(ip)

	state := g.clients[clientKey]
	if state == nil {
		if len(g.clients) >= maxRateLimiterEntries {
			return false, 60, "client-table-full"
		}
		state = &whepClientState{}
		g.clients[clientKey] = state
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
	burstExceeded := len(shortPosts) >= whepShortLimit
	minuteExceeded := len(state.posts) >= whepMinuteLimit
	if burstExceeded || minuteExceeded {
		// Both windows may be exhausted at once. Report the longest
		// applicable reset so a client honours every limit, mirroring
		// allowOperationAt, while keeping the historical burst-first
		// reason precedence for client-visible error categories.
		retry := 0
		reason := "minute-rate-limit"
		if burstExceeded {
			retry = retryAfterSeconds(shortPosts[0].Add(whepShortWindow), now)
			reason = "burst-rate-limit"
		}
		if minuteExceeded {
			if minuteRetry := retryAfterSeconds(state.posts[0].Add(whepMinuteWindow), now); minuteRetry > retry {
				retry = minuteRetry
			}
		}
		return false, retry, reason
	}

	state.posts = append(state.posts, now)
	state.active++
	return true, 0, ""
}

func (g *whepGuard) cancelReservation(ip string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if state := g.clients[rateLimitKey(ip)]; state != nil && state.active > 0 {
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
	if state := g.clients[rateLimitKey(ip)]; state != nil && state.active > 0 {
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

// filterWhepSDPApprovedCandidates is the fail-closed trust boundary between
// the LAN-facing MediaMTX WebRTC listener and the public WHEP endpoint. The
// approved set is the validated PUBLIC_HOST A-record snapshot taken at service
// startup. WHIP_IP, private/special-use addresses, IPv6, mDNS and unrelated
// public IPv4 candidates are removed. Non-candidate SDP lines and their
// original line endings are preserved.
//
// local carries the LAN candidates that a request from a private address may
// additionally receive. It is always empty for a public requester, which keeps
// exactly the PUBLIC_HOST-only behaviour described above.
func filterWhepSDPApprovedCandidates(body []byte, approved, local map[netip.Addr]struct{}) ([]byte, int, int) {
	allowed := approved
	if len(local) != 0 {
		allowed = make(map[netip.Addr]struct{}, len(approved)+len(local))
		for addr := range approved {
			allowed[addr] = struct{}{}
		}
		for addr := range local {
			allowed[addr] = struct{}{}
		}
	}

	text := string(body)
	var out strings.Builder
	out.Grow(len(text))
	dropped := 0
	kept := 0

	for len(text) > 0 {
		segment := text
		text = ""
		if i := strings.IndexByte(segment, '\n'); i >= 0 {
			segment, text = segment[:i+1], segment[i+1:]
		}

		line := strings.TrimSuffix(segment, "\n")
		line = strings.TrimSuffix(line, "\r")
		candidateLine := strings.TrimSpace(line)
		const candidatePrefix = "a=candidate:"
		if len(candidateLine) >= len(candidatePrefix) &&
			strings.EqualFold(candidateLine[:len(candidatePrefix)], candidatePrefix) {
			fields := strings.Fields(candidateLine)
			if len(fields) < 8 || len(fields[0]) == len(candidatePrefix) ||
				!strings.EqualFold(fields[6], "typ") || !strings.EqualFold(fields[7], "host") {
				dropped++
				continue
			}
			component, componentErr := strconv.Atoi(fields[1])
			_, priorityErr := strconv.ParseUint(fields[3], 10, 32)
			port, portErr := strconv.Atoi(fields[5])
			transport := strings.ToLower(fields[2])
			if componentErr != nil || (component != 1 && component != 2) ||
				priorityErr != nil || portErr != nil || port < 1 || port > 65535 ||
				(transport != "udp" && transport != "tcp") {
				dropped++
				continue
			}
			addr, err := netip.ParseAddr(fields[4])
			if err != nil || !addr.Is4() {
				dropped++
				continue
			}
			if _, ok := allowed[addr]; !ok {
				dropped++
				continue
			}
			safeExtensions := true
			for _, field := range fields[8:] {
				lower := strings.ToLower(field)
				if lower == "raddr" || lower == "rport" || strings.HasSuffix(lower, ".local") {
					safeExtensions = false
					break
				}
				if extensionAddr, parseErr := netip.ParseAddr(field); parseErr == nil {
					if _, ok := allowed[extensionAddr]; !ok {
						safeExtensions = false
						break
					}
				}
			}
			if !safeExtensions {
				dropped++
				continue
			}
			kept++
		}
		out.WriteString(segment)
	}

	return []byte(out.String()), dropped, kept
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
	target          *url.URL
	guard           *whepGuard
	client          *http.Client
	approvedIPv4    map[netip.Addr]struct{}
	localIPv4       map[netip.Addr]struct{}
	operationBurst  *fixedLimiter
	operationMinute *fixedLimiter
}

func newWhepGateway(target *url.URL, approved, local map[netip.Addr]struct{}) *whepGateway {
	approvedCopy := make(map[netip.Addr]struct{}, len(approved))
	for addr := range approved {
		approvedCopy[addr] = struct{}{}
	}
	localCopy := make(map[netip.Addr]struct{}, len(local))
	for addr := range local {
		localCopy[addr] = struct{}{}
	}
	return &whepGateway{
		target:       target,
		guard:        newWhepGuard(),
		approvedIPv4: approvedCopy,
		localIPv4:    localCopy,
		client: &http.Client{
			Transport: newPinnedBackendTransport(target),
			Timeout:   20 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		operationBurst:  newFixedLimiter(whepOperationBurstLimit, whepShortWindow),
		operationMinute: newFixedLimiter(whepOperationMinuteLimit, whepMinuteWindow),
	}
}

func (g *whepGateway) allowOperation(w http.ResponseWriter, ip string) bool {
	return g.allowOperationAt(w, ip, time.Now())
}

func (g *whepGateway) allowOperationAt(w http.ResponseWriter, ip string, now time.Time) bool {
	burstAllowed, burstRetry := g.operationBurst.hitAt(ip, now)
	minuteAllowed, minuteRetry := g.operationMinute.hitAt(ip, now)
	if burstAllowed && minuteAllowed {
		return true
	}
	retry := burstRetry
	if minuteRetry > retry {
		retry = minuteRetry
	}
	if retry < 1 {
		retry = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(retry))
	w.Header().Set("X-WHEP-Error", "rate-limit")
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, strings.TrimSpace(genericWhepError(http.StatusTooManyRequests, "rate-limit")), http.StatusTooManyRequests)
	return false
}

func isSDPContentType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	return err == nil && strings.EqualFold(mediaType, "application/sdp")
}

func (g *whepGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	now := time.Now()
	path := r.URL.Path
	isOptions := path == "/rtc/live/whep" && r.Method == http.MethodOptions
	isCreate := path == "/rtc/live/whep" && r.Method == http.MethodPost
	isSession := strings.HasPrefix(path, "/rtc/live/whep/")

	if !isOptions && !isCreate && !isSession {
		http.NotFound(w, r)
		return
	}
	if r.URL.RawQuery != "" {
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "query parameters are not allowed", http.StatusBadRequest)
		return
	}
	if isOptions {
		if requestHasBody(r) {
			http.Error(w, "request body not allowed", http.StatusBadRequest)
			return
		}
		w.Header().Set("Accept-Post", "application/sdp")
		w.Header().Set("Allow", "OPTIONS, POST")
		w.Header().Set("Access-Control-Allow-Methods", "OPTIONS, POST")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if isSession && r.Method == http.MethodPost && r.Header.Get("X-WHEP-Keepalive") == "1" {
		if requestHasBody(r) {
			http.Error(w, "request body not allowed", http.StatusBadRequest)
			return
		}
		if !g.allowOperation(w, ip) {
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
		if !g.allowOperation(w, ip) {
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
		if !g.allowOperation(w, ip) {
			return
		}
		if !g.guard.ownsSession(ip, path, now) {
			http.Error(w, strings.TrimSpace(genericWhepError(http.StatusNotFound, "")), http.StatusNotFound)
			return
		}
	}

	reserved := isCreate
	if r.ContentLength > maxWhepRequestBody {
		if r.Body != nil {
			_ = r.Body.Close()
		}
		if reserved {
			g.guard.cancelReservation(ip)
		}
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
		return
	}

	var requestBody []byte
	if r.Body != nil {
		limited := &io.LimitedReader{R: r.Body, N: maxWhepRequestBody + 1}
		var readErr error
		requestBody, readErr = io.ReadAll(limited)
		closeErr := r.Body.Close()
		if readErr == nil {
			readErr = closeErr
		}
		if readErr != nil || int64(len(requestBody)) > maxWhepRequestBody {
			if reserved {
				g.guard.cancelReservation(ip)
			}
			w.Header().Set("Cache-Control", "no-store")
			if int64(len(requestBody)) > maxWhepRequestBody {
				http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
			} else {
				http.Error(w, "invalid request body", http.StatusBadRequest)
			}
			return
		}
	}

	backend := *g.target
	backend.Path = strings.TrimPrefix(path, "/rtc")
	backend.RawPath = ""
	backend.RawQuery = r.URL.RawQuery
	var backendBody io.Reader
	if r.Body != nil {
		backendBody = bytes.NewReader(requestBody)
	}
	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, backend.String(), backendBody)
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
	// MediaMTX trusts this same-host Gateway, allowing its loopback-only metrics
	// endpoint to expose the real WHEP viewer IP instead of the Gateway address.
	if ip != "" {
		outReq.Header.Set("X-Forwarded-For", ip)
	}
	outReq.Header.Set("User-Agent", "obs-whip-public-whep-gateway/V1.35")

	// #nosec G704 -- runServe validates a literal IP assigned to this server, the
	// transport pins that exact IP and port, and redirects are disabled.
	resp, err := g.client.Do(outReq)
	if err != nil {
		if reserved {
			g.guard.cancelReservation(ip)
		}
		log.Printf("WHEP backend unavailable: status=transport-error path=%q", safeLogField(path))
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
		// #nosec G706 -- safeLogField strips all control/non-ASCII bytes and
		// bounds the value before %q emits it to the local journal.
		log.Printf("WHEP backend rejected request: status=%d path=%q", resp.StatusCode, safeLogField(path))
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
		// LAN candidates are released only to a requester that already sits on
		// a private address; every other client keeps the PUBLIC_HOST snapshot.
		local := map[netip.Addr]struct{}(nil)
		if len(g.localIPv4) != 0 && isPrivateRequesterIPv4(ip) {
			local = g.localIPv4
		}
		filtered, dropped, kept := filterWhepSDPApprovedCandidates(body, g.approvedIPv4, local)
		if kept == 0 {
			if reserved {
				g.guard.cancelReservation(ip)
			}
			log.Printf("WHEP backend answer has no approved PUBLIC_HOST IPv4 ICE candidate: dropped=%d", dropped)
			w.Header().Set("Cache-Control", "no-store")
			http.Error(w, strings.TrimSpace(genericWhepError(http.StatusBadGateway, "")), http.StatusBadGateway)
			return
		}
		if dropped != 0 {
			log.Printf("WHEP stripped %d unauthorized ICE candidate(s) from public SDP answer", dropped)
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

// newProtectedHandler wraps the static mux and the WHEP gateway behind the
// shared method/body policy and the per-IP generic GET limiter. A rejected
// request advertises the limiter's exact remaining window instead of a fixed
// hint, so clients never wait longer than the window reset requires.
func newProtectedHandler(mux *http.ServeMux, whepProxy http.Handler, limiter *fixedLimiter) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		if allowed, retry := limiter.hitAt(clientIP(r), time.Now()); !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(retry))
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	dir := fs.String("dir", "./web", "web root")
	addr := fs.String("addr", "127.0.0.1:8080", "listen address")
	backend := fs.String("hls-backend", "http://127.0.0.1:8888", "MediaMTX HLS backend")
	whepBackend := fs.String("whep-backend", "http://127.0.0.1:8889", "MediaMTX WHEP backend")
	whepApprovedIPs := fs.String("whep-approved-ips", "", "comma-separated startup-approved PUBLIC_HOST IPv4 A records")
	whepLocalIPs := fs.String("whep-local-ips", "", "comma-separated private IPv4 ICE candidates releasable to private requesters")
	if err := fs.Parse(args); err != nil {
		return err
	}

	target, err := url.Parse(*backend)
	if err != nil {
		return err
	}
	if err := validateLocalBackendURL(target); err != nil {
		return fmt.Errorf("invalid HLS backend: %w", err)
	}
	whepTarget, err := url.Parse(*whepBackend)
	if err != nil {
		return err
	}
	if err := validateLocalBackendURL(whepTarget); err != nil {
		return fmt.Errorf("invalid WHEP backend: %w", err)
	}
	approvedValues, err := normalizePublicIPv4s(*whepApprovedIPs)
	if err != nil {
		return fmt.Errorf("invalid public WHEP approved IPv4 list: %w", err)
	}
	approvedCandidates := approvedIPv4Set(approvedValues)
	localValues, err := normalizeLocalIPv4s(*whepLocalIPs)
	if err != nil {
		return fmt.Errorf("invalid local WHEP candidate list: %w", err)
	}
	localCandidates := approvedIPv4Set(localValues)
	abs, err := filepath.Abs(*dir)
	if err != nil {
		return err
	}
	indexPath := filepath.Join(abs, "index.html")
	hlsJSPath := filepath.Join(abs, "hls.min.js")
	weakPolicyJSPath := filepath.Join(abs, "hls-weak-network-policy.js")
	appJSPath := filepath.Join(abs, "app.js")
	appCSSPath := filepath.Join(abs, "app.css")
	for _, f := range []string{indexPath, hlsJSPath, weakPolicyJSPath, appJSPath, appCSSPath} {
		if _, err := os.Stat(f); err != nil {
			return fmt.Errorf("web asset unavailable: %s: %w", f, err)
		}
	}

	liveProxy := newProxy(target, "")
	whepProxy := newWhepGateway(whepTarget, approvedCandidates, localCandidates)
	limiter := newFixedLimiter(6000, time.Minute)

	mux := http.NewServeMux()
	liveGuard := newLiveEntryGuard(liveProxy)
	mux.Handle("/live", liveGuard)
	mux.Handle("/live/", liveGuard)

	serveFile := func(path, ctype, cache string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", ctype)
			w.Header().Set("Cache-Control", cache)
			w.Header().Set("X-Content-Type-Options", "nosniff")
			http.ServeFile(w, r, path)
		}
	}
	mux.HandleFunc("/hls.min.js", serveFile(hlsJSPath, "text/javascript; charset=utf-8", "public, max-age=0, must-revalidate"))
	mux.HandleFunc("/hls-weak-network-policy.js", serveFile(weakPolicyJSPath, "text/javascript; charset=utf-8", "no-cache"))
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

	protected := newProtectedHandler(mux, whepProxy, limiter)

	srv := &http.Server{
		Addr:              *addr,
		Handler:           protected,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	log.Printf("internal Web/HLS gateway listening on %s", *addr)
	log.Printf("public WHEP ICE approved IPv4 candidates: %s", strings.Join(approvedValues, ","))
	return srv.ListenAndServe()
}
