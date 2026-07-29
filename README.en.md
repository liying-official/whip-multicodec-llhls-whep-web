# OBS WHIP Multi-Codec LL-HLS/WHEP Edge

English | [简体中文](README.md)

A low-latency, zero-video-transcoding streaming edge for Debian 13. OBS
publishes over WHIP or RTMP from a trusted LAN, while browsers play over public
TLS 1.3 using LL-HLS or WHEP/WebRTC.

Current release: **R33 Runtime Audit Fixes**

## Highlights

- Zero-video-transcoding routing for H.264, H.265/HEVC, AV1, and VP9
- WHIP/WHEP with Opus; RTMP with AAC retained through LL-HLS
- Automatic LL-HLS/WHEP capability selection, fallback, and live codec changes
- HTTP/1.1, HTTP/2, and HTTP/3 with TLS 1.3 only and QUIC 0-RTT disabled
- `PUBLIC_HTTPS_PORT` support for matching public TCP/UDP port mappings to local 443
- WHIP/8889 and RTMP/1935 bind only to a detected RFC1918 interface
- Publishing requires both a random credential and the interface LAN subnet or local `/32`
- WHEP MIME, body-size, rate, active-session, source-IP, and heartbeat controls
- Strict Host/SNI enforcement, uniform security headers, and no `Server`/`Via` disclosure
- Optional hardened systemd service with restart recovery and root-only persistent credentials
- Complete Debian 13 runtime packages for amd64 and arm64

R33 pins:

- MediaMTX `v1.19.3-r8`, including AOM AV1 RTMP/WHIP/HLS compatibility fixes
- Caddy `v2.11.4-r33-go1.26.5`, built from a pinned commit and module graph
- hls.js `v1.6.16`, bundled locally instead of downloaded during startup

## Data path

```text
OBS
 ├─ WHIP / WebRTC ─┐
 └─ RTMP ──────────┤
                    ▼
          patched MediaMTX
            ├─ LL-HLS ── secure gateway ── Caddy ── Browser
            └─ WHEP / WebRTC ────────────── Caddy ── Browser
```

The server does not transcode video. The viewer must support the codec produced
by OBS; H.264 normally provides the widest compatibility. AOM AV1 requires a
real keyframe interval of 1–2 seconds and must not use `0/automatic`.

## Quick deployment

1. Download the R33 Debian 13 runtime archive and its `.sha256` file from
   [GitHub Releases](https://github.com/liying-official/whip-multicodec-llhls-whep-web/releases).
2. Verify SHA-256, extract the archive, and install it in a root-managed
   directory below `/opt` or `/usr/local`.
3. Edit `config.env`:

   ```text
   PUBLIC_DOMAIN=live.example.com
   PUBLIC_HTTPS_PORT=443
   TLS_CERT=certs/fullchain.pem
   TLS_KEY=certs/privkey.pem
   WHIP_IP=
   INGEST_ALLOW_CIDRS=
   PUBLIC_HOST=rtc.example.com
   ```

   `PUBLIC_HOST` must be a DNS hostname with at least one IPv4 A record and no
   AAAA record. Leave `WHIP_IP` empty to prefer the RFC1918 address associated
   with the default route. `INGEST_ALLOW_CIDRS` is a legacy compatibility key;
   a manual value cannot broaden the publish ACL.

4. Install a publicly trusted PEM certificate and private key. Make sure the
   project directory and its critical files are not writable by unprivileged users.
5. Install and enable the systemd service:

   ```sh
   sudo ./install-systemd.sh
   sudo systemctl status obs-whip-live.service
   sudo ./show-credentials.sh
   ```

You can instead run `sudo ./start.sh` manually. Manual startup rotates the
publish credential each time.

## OBS settings

WHIP (recommended):

```text
Server:       http://<LAN_IP>:8889/live/whip
Bearer Token: obs:<random password shown by show-credentials.sh>
```

RTMP compatibility input:

```text
Server:     rtmp://<LAN_IP>:1935
Stream key: live?user=obs&pass=<random password>
```

Start validation with H.264, CBR, a 1–2 second keyframe interval, and no B
frames. For initial software-encoder troubleshooting, use 1920×1080 at 30 FPS.
The server cannot repair an overloaded OBS encoding queue.

## Network ports

| Port | Purpose | Exposure |
| --- | --- | --- |
| TCP/443 | HTTPS, HTTP/1.1, HTTP/2 | Public |
| UDP/443 | HTTP/3 / QUIC | Public |
| UDP/TCP 8189 | Encrypted WHEP WebRTC media | Public when WHEP is used |
| TCP/8889 | OBS WHIP signaling | Trusted LAN |
| TCP/1935 | OBS RTMP compatibility input | Trusted LAN |
| TCP/8080, 8888, 9998 | Internal gateway, HLS, metrics | Loopback only |

For a non-standard public HTTPS port, map the same public TCP and UDP port to
local TCP and UDP 443, then set that public port in `PUBLIC_HTTPS_PORT`.

## R33 default rate limits

R33 applies the following built-in limits per real source IP identified by the
secure gateway:

| Traffic | Default rule | Over-limit response |
| --- | --- | --- |
| Web and LL-HLS GET/HEAD | 6,000 requests per IP per minute (fixed window) | HTTP 429 with `Retry-After: 10` |
| WHEP session-create POST | 10 requests/10 seconds and 30 requests/60 seconds per IP (rolling windows) | HTTP 429 |
| Active WHEP sessions | 5 per IP | HTTP 429 |

The Web/LL-HLS and WHEP limiter tables can each track at most 20,000 source IPs.
A WHEP create request must pass `application/sdp` MIME validation before it
consumes quota, and its request body is limited to 256 KiB. Sessions use a
60-second heartbeat and are reclaimed after five minutes without a refresh.
These are R33's built-in request/session limits, not public bandwidth caps.

## Playback behavior

- H.264 and HEVC normally use LL-HLS.
- AV1 and VP9 use LL-HLS when the browser reports compatible MSE support,
  otherwise the player can fall back to WHEP.
- The player re-reads the current HLS codec before each new WHEP session, so an
  OBS codec change does not require a page reload.
- A normal connection targets about five seconds of latency. Sustained low
  throughput enables a larger stability buffer and conservative catch-up.
- WHEP audio requires Opus. RTMP commonly supplies AAC, which should be played
  through LL-HLS because this project does not transcode AAC to Opus.

## Documentation

- [Detailed deployment and operation guide (Chinese)](README.txt)
- [R33 dual-round load test report (English)](docs/pressure-test-report-r33-20260730-en.md)
- [OBS encoder compatibility](OBS-COMPATIBILITY.txt)
- [Codec and transport support](CODEC-SUPPORT.txt)
- [Security model](SECURITY.txt)
- [Firewall and port policy](FIREWALL.txt)
- [DNS setup](DNS-SETUP.txt)
- [Building from source](BUILDING.md)

Release changes are documented only on the corresponding GitHub Release page.
Runtime archives do not include changelogs or historical debug reports; their
bundled documentation describes only the current release.

## Source, binaries, and licensing

- `src/`: Go secure gateway and helper
- `web/`: HTML, CSS, native JavaScript player, and pinned hls.js asset
- `patches/`: reproducible MediaMTX and gortmplib compatibility patches
- `third_party/`: licenses, versions, module graph, and build records
- `tools/`: OBS/libdatachannel behavior simulators and regression tools

Prebuilt Linux binaries are intentionally excluded from Git history and are
published only through Releases. Project-owned code is licensed under the
[MIT License](LICENSE); third-party licenses are retained in `third_party/`.
