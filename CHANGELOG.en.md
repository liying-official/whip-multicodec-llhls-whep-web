# v1.35 update summary

English | [简体中文](CHANGELOG.md)

- Upgrade MediaMTX to v1.21.0 and HLS.js to v1.7.3; build all six Linux binaries with Go 1.27.1 while retaining AV1 compatibility patches.
- Improve LL-HLS append/recovery handling, distinguish bandwidth/loss from RTT pressure, and use measured 8/6-second buffer readiness thresholds.
- Strengthen public routing, source/session checks, TLS/security headers, and systemd install/stop boundaries; retain persistent publishing credentials.
- Remove test-environment settings from release configuration and documentation. Packaging always emits an unconfigured template and excludes certificates, private keys, runtime data and detailed local records.
- Synchronize Chinese/English deployment, ports, defaults and build guidance under v1.35; provide the fix9 runtime archive and SHA256.

Validation: security, weak-network recovery and installation regressions passed; both architecture builds, file checksums and reproducible packaging were verified.

Known limits: some Chromium environments can still stop decoding AV1/WHEP. MediaMTX/Caddy binaries retain the GO-2026-5932 OpenPGP advisory; see [security notes](SECURITY.txt) for scope.
