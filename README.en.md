# OBS WHIP Multi-Codec LL-HLS/WHEP Edge

English | [简体中文](README.md)

A low-latency, zero-video-transcoding streaming service. OBS
publishes over WHIP or RTMP from a trusted LAN, while browsers play over public
TLS 1.3 using LL-HLS or WHEP/WebRTC.

Current release: **v1.35**

## Highlights

- Zero-video-transcoding routing for H.264, H.265/HEVC, AV1, and VP9
- WHIP/WHEP with Opus; RTMP with AAC retained through LL-HLS
- Explicit WHEP Opus `stereo=1;sprop-stereo=1` negotiation preserves left/right playback in Chromium
- Automatic LL-HLS/WHEP capability selection, fallback, and live codec changes
- LL-HLS distinguishes bandwidth/loss from RTT pressure: 12s weak target latency and measured 8s/6s buffer READY hysteresis; only the RTT class switches to complete segments
- hls.js 1.7.3 SourceBuffer append timeouts, stalled-playlist detection, and automatic MediaSource reset support recovery from weak-link failures; catch-up never exceeds `1.05x`
- HTTP/1.1, HTTP/2, and HTTP/3 with TLS 1.3 only and QUIC 0-RTT disabled
- `PUBLIC_HTTPS_PORT` support for matching public TCP/UDP port mappings to local 443
- WHIP/8889 and RTMP/1935 bind only to a detected RFC1918 interface
- Publishing requires both a random credential and the interface LAN subnet or local `/32`
- WHEP MIME, body-size, rate, active-session, source-IP, and heartbeat controls
- Public WHEP SDP exposes validated `PUBLIC_HOST` IPv4 ICE candidates; trusted local IPv4 requesters may also receive the exact `WHIP_IP` candidate, and an empty allowed set fails closed
- Anonymous Web/HLS routes strip browser credentials and unrelated cookies; upstream error bodies never enter the page or browser logs
- Strict Host authority (including the public port) and SNI enforcement, uniform security headers, and no `Server`/`Via` disclosure
- Optional systemd service with a read-only program tree, stronger sandboxing, restart recovery, and root-only persistent credentials
- Complete Linux runtime packages for amd64 and arm64

v1.35 pins:

- MediaMTX `v1.21.0-r11`, replaying and regressing the AOM AV1 RTMP/WHIP/HLS compatibility fixes on the v1.21.0 security baseline
- Caddy `v2.11.4-V1.35-go1.27.1-fix8v9`, built from a pinned commit and module graph
- helper, MediaMTX, and Caddy are all built with Go `1.27.1`
- hls.js `v1.7.3`, bundled locally after npm signature/provenance verification instead of downloaded during startup

## Data path

```text
OBS
 ├─ WHIP / WebRTC ─┐
 └─ RTMP ──────────┤
                    ▼
          patched MediaMTX
            ├─ LL-HLS ── secure gateway ── Caddy ── Browser
            └─ WHEP signaling ─ secure gateway ── Caddy ── Browser
                 WebRTC media (DTLS-SRTP) ─────────────── Browser
```

The server does not transcode video. The viewer must support the codec produced
by OBS; H.264 normally provides the widest compatibility. AOM AV1 requires a
real keyframe interval of 1–2 seconds and must not use `0/automatic`.

## Quick deployment

The code has been tested successfully on Debian 13 / Ubuntu 26.04. Other compatible
Linux distributions can be tested and deployed at your discretion.
The runtime package contains Linux amd64 / arm64 binaries, selected by CPU architecture.
It requires root privileges, the system CA trust store, iproute2 (`ip` / `ss`), `getent`,
GNU coreutils (including `timeout` and `sha256sum`), standard shell utilities, and
`tar` / `gzip`. Service installation also requires a running systemd environment,
`systemd-analyze`, `systemd-notify`, `systemctl`, and `flock`. Go is not required to
run the prebuilt package.

1. Download the v1.35 runtime archive and its `.sha256` file from the same
   [GitHub Release](https://github.com/liying-official/obs-whip-multicodec-llhls-web/releases).
   The actual release filename is retained below for checksum verification and compatibility
   with the current packaging tool. Its platform and build labels do not define distro support.
2. Run the following from the download directory. This is a first-install procedure for an
   absent `/opt/obs-whip-live`; use “Uninstall and reinstall” for an existing deployment.
   If the directory exists, `mkdir` fails: do not continue by extracting over it.

   ```sh
   set -eu
   archive='obs-whip-multicodec-llhls-web-debian13-v1.35-weak-network-fix9.tar.gz'
   sha256sum -c "$archive.sha256"
   sudo mkdir -m 0755 /opt/obs-whip-live
   sudo tar -xzf "$archive" -C /opt/obs-whip-live --strip-components=1 --same-owner --same-permissions
   cd /opt/obs-whip-live
   sudo sha256sum -c SHA256SUMS
   ```

   Verify every entry in the bundled `SHA256SUMS` before editing configuration. Extraction
   preserves the archive's root ownership and file modes. The project and every parent must
   be root-owned and not group/other-writable, and the project path must not contain symlinks.
   Do not run root startup scripts from `/tmp` or a user-writable download directory.
3. Run `sudoedit config.env` in `/opt/obs-whip-live`, reviewing and replacing every setting
   for your environment:

   ```text
   PUBLIC_DOMAIN=live.example.com
   PUBLIC_HTTPS_PORT=443
   TLS_CERT=certs/fullchain.pem
   TLS_KEY=certs/privkey.pem
   WHIP_IP=
   INGEST_ALLOW_CIDRS=
   PUBLIC_HOST=rtc.example.com
   ```

   The bundled `config.env` is an unconfigured template: the site hostname, WebRTC
   hostname and interface address are empty, and the public HTTPS port defaults to 443.
   Set your own `PUBLIC_DOMAIN` and `PUBLIC_HOST` before installing; the installer and
   startup script reject missing values. The hostnames above are deployment examples.
   An empty `WHIP_IP` selects an enabled RFC1918 interface, preferring the default route;
   you may explicitly select a local private interface. Publishing is restricted to that
   interface's actual LAN subnet plus the local `WHIP_IP/32`. `INGEST_ALLOW_CIDRS` is a
   compatibility key whose manual value cannot broaden this scope.

   `PUBLIC_DOMAIN` is the playback hostname and may have A / AAAA records as appropriate.
   `PUBLIC_HOST` must be an A-only DNS hostname with 1–16 publicly routable IPv4 A records;
   raw IPs, schemes, ports, and native IPv6 / AAAA are rejected. All validated A records form
   the process's exact public WHEP ICE allowlist; restart to capture later DNS changes.
   Public requesters receive only these candidates. A requester whose real source is private,
   loopback, or link-local IPv4 may additionally receive the exact configured `WHIP_IP`
   candidate. Other addresses, IPv6, mDNS, and malformed candidates are filtered, and an
   empty allowed set fails closed.
4. Place your PEM full certificate chain and private key at the configured paths; real
   certificates and keys are not bundled. The resolved key must be root-owned with no
   group/other permissions; `root:root 0600` is recommended. Both the configured and resolved
   parent chains must be root-managed and not group/other-writable. Startup verifies the
   key pair, system trust chain, `PUBLIC_DOMAIN`, ServerAuth usage, and at least 24 hours of
   remaining validity. Caddy does not issue certificates automatically; restart after renewal.
5. After preparing configuration and certificates, install from the project directory:

   ```sh
   sudo ./install-systemd.sh --check-only
   sudo ./install-systemd.sh
   sudo systemctl status obs-whip-live.service
   sudo ./show-credentials.sh
   ```

   `--check-only` validates paths, ownership, modes, required files/manifest presence, and
   required configuration. It neither writes a unit nor requires systemd as PID 1, and does
   not perform full content hashing or runtime validation. Formal installation strictly
   verifies every managed file's SHA-256 (except mutable `config.env` content), validates
   the unit, and enables the service. Startup checks must pass before the readiness
   notification; the installer then observes stability for 152 seconds. Process liveness
   alone is insufficient. DNS lookups and retries share a 30-second total deadline;
   unresolved A-only safety checks or a timeout prevent startup.

The first service start saves credentials in root-only `runtime/publish.credentials`,
reuses them on restart, and keeps them out of the journal. For manual operation use
`sudo ./start.sh`: it reuses persisted credentials when present, otherwise generates
an in-memory temporary credential. An active unit prevents a concurrent manual start.
The service makes the project tree read-only except `logs/` and `runtime/`, enables
process/namespace/filesystem isolation, and restarts the service group if the gateway
or Caddy exits unexpectedly.

## Uninstall and reinstall

`sudo ./uninstall.sh` stops and removes the service while preserving the entire project
including configuration, certificates, and credentials. `sudo ./uninstall.sh --purge`
deletes the project and must not be used for a data-preserving reinstall.
Uninstall checks unit ownership, stop results, MainPID / ControlPID, and the cgroup.
Failure to confirm a complete stop, or a disable/reload failure, returns nonzero and
retains the directory. A failed reload after removal restores the unit file.

Reinstall into a new, complete directory; do not extract over the retained old tree.
The commands below verify the new archive, retain the old tree, then restore configuration,
certificates, and publishing credentials. Set `archive` to the actual new archive's
absolute path. `/opt/obs-whip-live-backup` must not exist; if occupied, choose another
unused backup directory and update every reference. External certificate paths remain
administrator-managed. After restoring `certs/`, the example re-extracts managed
`certs/README.txt` from the verified new archive, keeping the new manifest valid. If your
configuration uses custom certificate paths elsewhere inside the old project, restore
those certificate/key files separately and verify ownership/modes before installation.
Do not restore old code, templates, or other managed documents. Review restored domains,
ports, and interfaces before use.

```sh
set -eu
archive='/absolute/path/obs-whip-multicodec-llhls-web-debian13-v1.35-weak-network-fix9.tar.gz'
cd "$(dirname "$archive")"
sha256sum -c "$(basename "$archive").sha256"
sudo mkdir -m 0700 /opt/obs-whip-live-backup
cd /opt/obs-whip-live
sudo ./uninstall.sh
cd /opt
sudo mv /opt/obs-whip-live /opt/obs-whip-live-backup/project
sudo mkdir -m 0755 /opt/obs-whip-live
sudo tar -xzf "$archive" -C /opt/obs-whip-live --strip-components=1 --same-owner --same-permissions
cd /opt/obs-whip-live
sudo sha256sum -c SHA256SUMS
sudo cp -a /opt/obs-whip-live-backup/project/config.env ./config.env
sudo cp -a /opt/obs-whip-live-backup/project/certs/. ./certs/
release_root=$(basename "$archive" .tar.gz)
sudo tar -xzf "$archive" -C /opt/obs-whip-live --strip-components=1 --same-owner --same-permissions "$release_root/certs/README.txt"
if sudo test -f /opt/obs-whip-live-backup/project/runtime/publish.credentials; then
  sudo mkdir -m 0700 runtime
  sudo cp -p /opt/obs-whip-live-backup/project/runtime/publish.credentials runtime/publish.credentials
fi
sudoedit config.env
sudo ./install-systemd.sh --check-only
sudo ./install-systemd.sh
sudo ./show-credentials.sh
```

## Routine management

Run these commands from `/opt/obs-whip-live`:

```sh
sudo ./status.sh
sudo ./diagnose.sh
sudo journalctl -u obs-whip-live.service
sudo systemctl restart obs-whip-live.service
sudo ./stop.sh
```

`status.sh` / `diagnose.sh` return nonzero if required processes, listeners, TLS/Caddy,
or public ICE security checks fail. A service restart reloads certificates and DNS
candidates while preserving credentials. In manual mode run `sudo ./stop.sh` followed
by `sudo ./start.sh` after certificate renewal. `stop.sh` preserves credentials by default.
For rotation, `sudo ./stop.sh --clear-credentials` safely stops the current unit first,
then removes old credentials. Start service mode again with
`sudo systemctl start obs-whip-live.service` to generate new credentials.

## OBS settings

WHIP (recommended):

```text
Server:       http://<LAN_IP>:8889/live/whip
Bearer Token: obs:<random password shown by show-credentials.sh>
```

RTMP compatibility input (same password as WHIP; omit `obs:` from the stream key):

```text
Server:     rtmp://<LAN_IP>:1935
Stream key: live?user=obs&pass=<random password>
```

Start validation with H.264, CBR, a 1–2 second keyframe interval, and no B
frames. For initial software-encoder troubleshooting, use 1920×1080 at 30 FPS.
The server cannot repair an overloaded OBS encoding queue.

## Playback URLs

The standard-port player URL is `https://live.example.com/`; a non-standard port
uses `https://live.example.com:<PUBLIC_HTTPS_PORT>/`. The HLS master playlist path
is `/live/index.m3u8`, and same-origin WHEP creation uses `/rtc/live/whep`. Prefix
both paths with the same HTTPS hostname and public port. WHEP media travels
separately over 8189, outside the HTTPS reverse proxy. The player starts muted;
click the audio button to enable sound. WHIP/WHEP audio uses Opus; RTMP typically
supplies AAC, which requires manual LL-HLS selection to retain audio.

## Network ports

| Server-local listener | Purpose | Exposure |
| --- | --- | --- |
| TCP/443 | HTTPS, HTTP/1.1, HTTP/2 | Public |
| UDP/443 | HTTP/3 / QUIC | Public |
| UDP/TCP 8189 | Encrypted WHEP WebRTC media | Public when WHEP is used |
| TCP/8889 | OBS WHIP signaling | Trusted LAN |
| TCP/1935 | OBS RTMP compatibility input | Trusted LAN |
| TCP/8080, 8888, 9998 | Internal gateway, HLS, metrics | Loopback only |

For a non-standard public HTTPS port, map the same public TCP and UDP port to
local TCP and UDP 443, then set that public port in `PUBLIC_HTTPS_PORT`.
TCP alone supports HTTP/1.1/2 but not HTTP/3. Public WHEP also requires same-port
UDP/TCP 8189 forwarding; public 8189 can stay closed for LL-HLS-only viewing.
TCP/80, the management API, RTSP, SRT, MoQ, pprof, recording, and playback service
are disabled; metrics on 9998 remain loopback-only. WHIP/8889 and RTMP/1935 carry
plaintext publishing signaling inside the trusted LAN and should be blocked from public access.

## v1.35 default rate limits

v1.35 applies the following built-in limits to real sources identified by the
secure gateway. IPv4 remains isolated per `/32` address; IPv6 is aggregated by
the source `/64` prefix.

| Traffic | Default rule | Over-limit response |
| --- | --- | --- |
| Web and LL-HLS GET/HEAD | 6,000 requests/minute per IPv4 `/32` or IPv6 `/64` (fixed window) | HTTP 429; `Retry-After` reports the remaining seconds until the current fixed window resets (minimum 1 second) |
| WHEP session-create POST | 10 requests/10 seconds and 30 requests/60 seconds per IPv4 `/32` or IPv6 `/64` (rolling windows) | HTTP 429 |
| Valid WHEP operations (create/PATCH/DELETE/heartbeat) | 30 requests/10 seconds and 120 requests/60 seconds per IPv4 `/32` or IPv6 `/64` (fixed windows) | HTTP 429 |
| Active WHEP sessions | 5 per IPv4 `/32` or IPv6 `/64` | HTTP 429 |

The Web/LL-HLS and WHEP limiter tables can each track at most 20,000 source keys.
A WHEP create request must pass `application/sdp` MIME validation before it
consumes quota, and its request body is limited to 256 KiB. Sessions use a
60-second heartbeat and are reclaimed after five minutes without a refresh.
These are v1.35's built-in request/session limits, not public bandwidth caps.
When both WHEP operation windows reject a request, `Retry-After` reports the
longer remaining reset time.

Internal HLS/WHEP backend URLs must use a literal IP assigned to the server.
The gateway ignores environment HTTP proxies, pins connections to the validated
IP and port, and does not follow WHEP backend redirects.
Standard WHEP `OPTIONS` capability discovery is answered locally by the gateway;
it neither reaches the backend nor consumes create/operation quota.
Public Web/HLS accepts only bodyless GET/HEAD. WHEP creation uses POST; session
control uses PATCH/DELETE, and player heartbeats use a bodyless POST with
`X-WHEP-Keepalive: 1`. Session control is bound to the creator's exact source IP,
separately from IPv6 `/64` quota aggregation. Public routing exposes only player
assets, controlled HLS resources, and WHEP endpoints. `/live/whip`, `/live/whep`,
the MediaMTX built-in player, and other management paths are denied.
Each candidate in a WHEP create response is matched against the validated
`PUBLIC_HOST` A records captured at startup. Public sources never receive `WHIP_IP`.
Private, loopback, or link-local real IPv4 sources may additionally receive the exact
`WHIP_IP` candidate. Other public addresses, IPv6, mDNS, and malformed candidates are filtered.

## Playback behavior

- AUTO attempts WebRTC/WHEP first when `RTCPeerConnection` exists. Without WebRTC it uses the HLS inspection/playback path. HLS metadata is a parallel codec/capability hint, never a prerequisite for WHEP. Manual LL-HLS and WHEP remain independent diagnostic choices.
- Every WHEP establishment retains the 15-second deadline. AUTO retains bounded retries and HLS fallback after repeated failures. Manual WHEP timeout or unsupported-codec errors preserve the selected mode and offer an explicit retry. Replacement cancels old metadata; a late 201 releases only its own old session.
- LL-HLS Normal uses `lowLatencyMode=true`, target latency **6s**, `maxBufferLength=10s`, `maxMaxBufferLength=15s`, and at most 1.05x catch-up.
- Bandwidth-loss Weak keeps `lowLatencyMode=true` and available LL-HLS parts. RTT Weak uses `lowLatencyMode=false` and complete segments. Both Weak classes target **12s**, retain 16s/24s buffer caps, and use 1.00x playback.
- Weak READY requires a measured forward buffer of **8s** initially; it remains READY at **6s** or higher and loses READY below 6s. A successful seek, target latency, or configuration value is not buffer evidence.
- The bandwidth path requires six consecutive risk samples after playback warmup: bandwidth/stream-bitrate ratio<1.2 and buffer<4s; a healthy sample resets the count. Early protection can act before the 8-second stall warmup after three valid drain slopes or three severe-starvation network samples during actual playback. Pauses, seeking, and invalid sampling gaps discard trend evidence.
- RTT classification needs a healthy request-overhead baseline, four consecutive relatively degraded request samples, bandwidth headroom, no recent network errors, and buffer pressure. Physical stall episodes retain deduplication and healthy-to-network escalation; a healthy decoder stall does not erase an earlier real incident.
- The weak safe point can move backward only 1.5–6s within one downloaded continuous range. Paused, seeking, ended, or stale-generation media cannot be moved. Each Weak episode permits one successful backtrack; the monitor may retry after the initial bounded retry loop.
- Fast recovery needs ratio≥1.7, buffer≥6s, 20 healthy samples, and 15s without stall/network error. Stable recovery needs ratio≥1.5, 30 samples with buffer≥7s, and 30s quiet. Safe cadence valleys hold existing evidence for at most 3000ms without inventing healthy samples. The app also requires actual Weak READY; successful fragments clear retry counts, not the recent-error timestamp.
- Weak-to-Normal updates the profile without reload, flush, or a hard live-edge seek. Gradual catch-up does not immediately restore 6s latency. Server segmentation remains about 2s per segment, 1s per CMAF part, and 24 retained segments; these differ from player target latency and actual READY.
- WHEP audio requires Opus. RTMP commonly supplies AAC; select manual LL-HLS to retain AAC audio. The server does not transcode video or audio.

## Documentation

- [Detailed deployment and operation guide (Chinese)](README.txt)
- [OBS encoder compatibility](OBS-COMPATIBILITY.txt)
- [Codec and transport support](CODEC-SUPPORT.txt)
- [Security model](SECURITY.txt)
- [Firewall and port policy](FIREWALL.txt)
- [DNS setup](DNS-SETUP.txt)
- [Building from source](BUILDING.md)

Brief updates are available in the repository [English changelog](https://github.com/liying-official/obs-whip-multicodec-llhls-web/blob/main/CHANGELOG.en.md),
[Chinese changelog](https://github.com/liying-official/obs-whip-multicodec-llhls-web/blob/main/CHANGELOG.md), and the corresponding GitHub Release.
Detailed change and test records remain local. Runtime archives exclude changelogs
and detailed reports.

## Source, binaries, and licensing

- `src/`: Go secure gateway and helper
- `web/`: HTML, CSS, native JavaScript player, and pinned hls.js asset
- `patches/`: reproducible MediaMTX and gortmplib compatibility patches
- `third_party/`: licenses, versions, module graph, and build records
- `tools/`: OBS/libdatachannel behavior simulators and regression tools

Prebuilt Linux binaries are intentionally excluded from Git history and are
published only through Releases. Project-owned code is licensed under the
[MIT License](LICENSE); third-party licenses are retained in `third_party/`.

## Playback continuity and compatibility limits

The official hls.js 1.7.3 asset is unchanged. A bufferController extension assigns
each SourceBuffer append its own timeout ownership. Completion, error, replacement,
and destruction retire stale callbacks; only the current, updating append may invoke
timeout recovery. The 15-second append watchdog remains enabled.
After at least 8 seconds of live playback, a nonfatal audio/video playlist timeout
with less than 6 seconds of contiguous forward buffer immediately enters bandwidth-loss
protection, stops catch-up, and attempts one bounded safe backtrack.
Protection may produce a brief seek and replayed content. Sustained bandwidth below
the actual source bitrate or an outage exceeding the buffer still causes stalls.
The project does not provide ABR, transcoding, or additional bandwidth, and cannot
eliminate router/NAT TCP retransmissions.

Some Chromium environments can still stop decoding AV1/WHEP video while receiving
packets. Continued reception or a connected state does not prove continuous decoding.
Validate manual WHEP and manual LL-HLS separately, and change playback mode or codec
if needed. Weak-link recovery does not guarantee stall-free playback under every condition.
