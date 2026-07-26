# Building from source

The deployment release contains prebuilt Linux binaries. This document rebuilds
the patched components from their audited upstream versions.

Requirements:

- Go 1.26 or newer
- Git
- Node.js/npm for MediaMTX generated web assets
- Linux or a Linux cross-compilation environment

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
  go build -trimpath -o ../bin/mediamtx_linux_amd64 .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -o ../bin/mediamtx_linux_arm64 .
```

Run focused tests:

```sh
go test ./internal/stream
go -C ../gortmplib test ./...
```

## 3. Build the helper

From the repository root:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -o bin/helper_linux_amd64 ./src/helper.go
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -o bin/helper_linux_arm64 ./src/helper.go
```

Before publishing binaries, regenerate `SHA256SUMS`, run all Go tests, validate
the Caddy and MediaMTX generated configurations, and perform live WHIP, RTMP,
LL-HLS and WHEP regression tests.

