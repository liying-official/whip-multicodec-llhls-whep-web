# v1.35 · fix12 update summary

English | [简体中文](CHANGELOG.md)

- Fix LL-HLS request-statistics ownership and repeated playlist-error recovery timing so stale requests do not interfere with current recovery.
- Improve RTT recovery evidence; exit weak mode on the existing playback pipeline and catch up smoothly, retaining buffer protection and the 1.05x speed limit.
- Remove a real public address from test fixtures, preserve security boundaries, dependency versions and all six binaries, and strengthen private-file exclusions.
- Maintainer feedback: a 48-hour soak test did not reproduce AUTO reconnections, so this is no longer tracked as an outstanding repair item for this release.

Validation: player regressions, Go tests, release-file checks and reproducible packaging passed. Detailed changelogs, repair plans, reports, logs and evidence remain local. See [security notes](SECURITY.txt) for dependency advisories.
