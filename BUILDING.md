# Building R33 from source

The Git repository contains source, patches, reproducibility records, and
vendored browser assets. The GitHub Release archive additionally contains
prebuilt Linux binaries for amd64 and arm64.

## Requirements

- Go 1.26.5
- Git
- Node.js/npm for MediaMTX generated web assets
- Linux, or a Linux cross-compilation environment
- Standard SHA-256 and tar tools for release packaging

Run build commands from clean, trusted directories. Do not build or launch the
runtime from a path writable by unprivileged users.

## 1. Patch gortmplib v0.4.1

```sh
git clone --branch v0.4.1 --depth 1 \
  https://github.com/bluenviron/gortmplib.git gortmplib
git -C gortmplib apply \
  ../patches/gortmplib-v0.4.1-av1-empty-sequence-start.patch
```

## 2. Patch MediaMTX v1.19.3

```sh
git clone --branch v1.19.3 --depth 1 \
  https://github.com/bluenviron/mediamtx.git mediamtx
git -C mediamtx apply \
  ../patches/mediamtx-v1.19.3-av1-whip-hls.patch
cd mediamtx
go mod edit \
  -replace github.com/bluenviron/gortmplib=../gortmplib
go mod tidy
go generate ./...
printf '%s\n' 'v1.19.3-r8' > internal/core/VERSION
```

Build Linux binaries:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -buildvcs=false -o ../bin/mediamtx_linux_amd64 .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -buildvcs=false -o ../bin/mediamtx_linux_arm64 .
```

Run focused upstream regression tests:

```sh
go test ./internal/stream
go -C ../gortmplib test ./...
```

The expected R33 binary hashes and patch scope are recorded in
`third_party/MediaMTX-AOM-AV1-PATCH.txt`.

## 3. Build the R33 helper

From the repository root:

```sh
go test ./...

GOTOOLCHAIN=go1.26.5 CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -buildvcs=false \
  -ldflags='-s -w -buildid=' \
  -o bin/helper_linux_amd64 ./src

GOTOOLCHAIN=go1.26.5 CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -buildvcs=false \
  -ldflags='-s -w -buildid=' \
  -o bin/helper_linux_arm64 ./src
```

The expected R33 helper hashes are:

```text
amd64  36945f9baf92bb3e26b3f81baa30bef43d44085655c3e25884f9da7c92e7a990
arm64  9cfa8dde93f2a9b17fba1942c4c3e5d6fca0b329a9a93458ee86cc2b22b367cf
```

## 4. Build the pinned Caddy runtime

R33 uses upstream Caddy v2.11.4 at commit
`e2eee6a7fce366321294c9c2a79f3146891dcbdf`, with a pinned dependency graph and
Go 1.26.5.

Clone that exact commit, then replace its root `go.mod` and `go.sum` with
`third_party/Caddy-go.mod` and `third_party/Caddy-go.sum`. Use the command and
linker version string in `third_party/Caddy-BUILD.txt`.

Expected R33 hashes:

```text
amd64  2d9683d8520210cc5b85a4af1f7b23295c812a7868c98a942601dbe1e7e48760
arm64  3b6c50d7bb13a46a2973e0eca5f029bd01d18670dc522edc68e59bb5f45c3159
```

## 5. Browser asset

`web/hls.min.js` is the pinned hls.js v1.6.16 browser distribution. Its license
and npm integrity verification record are stored in
`third_party/HLSJS-LICENSE.txt` and `third_party/HLSJS-VERSION.txt`.

Expected SHA-256:

```text
442f599c34f103c3355b375a23bdff560592d7117d09a8c847242ea3de2d40e0
```

Do not replace it with a runtime CDN download. Offline bundling is part of the
R33 startup and supply-chain behavior.

## 6. Release validation

Before publishing:

1. Regenerate `SHA256SUMS` for every managed file in the runtime archive.
2. Run `go test ./...` for the helper and the focused patched upstream tests.
3. Run `node tests/whep-opus-stereo.test.js` to verify offer/answer Opus stereo
   normalization, unknown fmtp preservation, and idempotence.
4. Validate the generated MediaMTX and Caddy configurations.
5. Test manual startup and the installed systemd service on Debian 13.
6. Exercise WHIP and RTMP publishers plus LL-HLS and WHEP viewers.
7. Verify HTTP/2, HTTP/3, TLS 1.3-only behavior, strict Host handling, request
   limits, security headers, and absence of `Server`/`Via`.
8. Confirm all runtime scripts retain executable mode.
9. Confirm the release archive contains no changelog or historical debug report.

Release changes belong in the GitHub Release description, not in the runtime
archive.
