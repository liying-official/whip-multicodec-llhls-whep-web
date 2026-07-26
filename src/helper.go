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
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	maxDownloadSize       int64 = 256 << 20
	maxRateLimiterEntries       = 20000
)

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
	case "fetch-caddy":
		err = runFetchCaddy(os.Args[2:])
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
	fmt.Fprintln(os.Stderr, "usage: helper fetch-mediamtx|fetch-hlsjs|fetch-caddy|check-cert|genkey|private-cidrs|tcp|serve [options]")
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

type githubRelease struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Digest             string `json:"digest"`
	} `json:"assets"`
}

func runFetchCaddy(args []string) error {
	fs := flag.NewFlagSet("fetch-caddy", flag.ContinueOnError)
	arch := fs.String("arch", "amd64", "amd64 or arm64")
	out := fs.String("out", "./bin/caddy", "output binary")
	licenseOut := fs.String("license", "", "optional LICENSE output")
	versionFile := fs.String("version-file", "", "optional version marker")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *arch != "amd64" && *arch != "arm64" {
		return fmt.Errorf("unsupported Caddy architecture: %s", *arch)
	}
	if st, err := os.Stat(*out); err == nil && st.Mode().IsRegular() && st.Size() > 0 {
		return os.Chmod(*out, 0755)
	}

	api := "https://api.github.com/repos/caddyserver/caddy/releases/latest"
	b, err := getBytes(api, 8<<20)
	if err != nil {
		return fmt.Errorf("download Caddy release metadata: %w", err)
	}
	var rel githubRelease
	if err := json.Unmarshal(b, &rel); err != nil {
		return err
	}
	if !strings.HasPrefix(rel.TagName, "v") {
		return fmt.Errorf("invalid Caddy release tag: %q", rel.TagName)
	}
	ver := strings.TrimPrefix(rel.TagName, "v")
	filename := fmt.Sprintf("caddy_%s_linux_%s.tar.gz", ver, *arch)

	var assetURL, digest string
	for _, a := range rel.Assets {
		if a.Name == filename {
			assetURL, digest = a.BrowserDownloadURL, strings.ToLower(a.Digest)
			break
		}
	}
	if assetURL == "" {
		return fmt.Errorf("Caddy release asset not found: %s", filename)
	}
	if !strings.HasPrefix(digest, "sha256:") || len(strings.TrimPrefix(digest, "sha256:")) != 64 {
		return fmt.Errorf("Caddy release asset has no usable GitHub SHA-256 digest")
	}
	want := strings.TrimPrefix(digest, "sha256:")

	fmt.Printf("首次启动：下载 Caddy %s (%s)...\n", rel.TagName, *arch)
	req, err := newGET(assetURL)
	if err != nil {
		return err
	}
	resp, err := httpClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download Caddy: HTTP %s", resp.Status)
	}

	tmp := *out + ".tar.gz"
	if err := os.MkdirAll(filepath.Dir(*out), 0755); err != nil {
		return err
	}
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
		return errors.New("Caddy release asset too large")
	}
	got := hex.EncodeToString(h.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		os.Remove(tmp)
		return fmt.Errorf("Caddy SHA256 mismatch: got %s want %s", got, want)
	}

	if err := extractCaddy(tmp, *out, *licenseOut); err != nil {
		os.Remove(tmp)
		return err
	}
	os.Remove(tmp)
	if *versionFile != "" {
		if err := os.MkdirAll(filepath.Dir(*versionFile), 0755); err != nil {
			return err
		}
		if err := os.WriteFile(*versionFile, []byte("Caddy "+rel.TagName+"\nSHA256 "+got+"\n"), 0644); err != nil {
			return err
		}
	}
	fmt.Printf("Caddy 校验完成：SHA256 %s\n", got)
	return nil
}

func extractCaddy(archivePath, out, licenseOut string) error {
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
	gotBin := false
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
		case "caddy":
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
		return errors.New("caddy binary not found in release archive")
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

	fmt.Printf("首次启动：下载 hls.js v%s...\n", *version)
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

func newProxy(target *url.URL, stripPrefix string) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		if stripPrefix != "" {
			req.URL.Path = strings.TrimPrefix(req.URL.Path, stripPrefix)
			if req.URL.RawPath != "" {
				req.URL.RawPath = strings.TrimPrefix(req.URL.RawPath, stripPrefix)
			}
		}
		if req.URL.Path == "" {
			req.URL.Path = "/"
		}
		req.Host = target.Host
	}
	proxy.FlushInterval = -1
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("HLS proxy error for %s: %v", r.URL.Path, err)
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

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	dir := fs.String("dir", "./web", "web root")
	addr := fs.String("addr", "127.0.0.1:8080", "listen address")
	backend := fs.String("hls-backend", "http://127.0.0.1:8888", "MediaMTX HLS backend")
	if err := fs.Parse(args); err != nil {
		return err
	}

	target, err := url.Parse(*backend)
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
	mux.HandleFunc("/hls.min.js", serveFile(hlsJSPath, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable"))
	mux.HandleFunc("/app.js", serveFile(appJSPath, "text/javascript; charset=utf-8", "no-cache"))
	mux.HandleFunc("/app.css", serveFile(appCSSPath, "text/css; charset=utf-8", "no-cache"))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, "ok\n")
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
