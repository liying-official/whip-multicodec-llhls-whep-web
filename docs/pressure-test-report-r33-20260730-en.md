# R33 Live Streaming and v25 Monitor Dual-Round Load Test Report

Test date: 2026-07-30 (UTC+8)  
Systems under test: R33 live-streaming service and v25 sidecar monitor  
Test server: Debian 13, 16 vCPU, 7,943.41 MiB RAM, 1 GiB swap  
Result: Both valid formal rounds passed. No new live-streaming or monitoring defect was found.

## 1. Test objectives

| Round | Generators | Users | Video bitrate | Duration | Theoretical output |
|---|---:|---:|---:|---:|---:|
| Round 1 | 2 × 100 | 200 | 50 Mbps/user | 600 s | 10 Gbps |
| Round 2 | 2 × 5,000 | 10,000 | 1 Mbps/user | 600 s | 10 Gbps |

Both load generators ran on the test server and accessed the R33 HLS entry point over loopback. Every virtual user established an independent authenticated session and fetched the playlist and latest media segment at a fixed two-second cadence. Server resource figures therefore include R33, the monitor, the FFmpeg test publisher, and both load generators.

Both sources used H.264/AVC video and AAC audio. The measured Round 1 input bitrate was approximately 50.008 Mbps. Round 2 used explicit 1 Mbps CBR video parameters; the monitor-recorded average stream bitrate was approximately 1.007 Mbps.

## 2. Executive summary

- Both formal rounds ran for more than 600 seconds.
- Playlist and media-segment errors were zero in both rounds; all success rates were 100%.
- Average delivered output was 9.997 Gbps in Round 1 and 10.048 Gbps in Round 2.
- R33 and the v25 monitor remained `active`; neither service's restart counter increased during either test.
- Every formal monitor API sample returned HTTP 200, and SQLite health remained good.
- No systemd warning, OOM, TCP memory exhaustion, segmentation fault, or hung-task event occurred in either formal window.
- Swap usage remained zero.
- After publishing stopped, HLS and WebRTC sessions immediately returned to zero. The broadcast correctly became offline after the 60-second resume grace period, and SQLite recorded the end state.

Overall test-server peaks across the two formal rounds:

| Metric | Overall peak |
|---|---:|
| System CPU | **74.76%** |
| Used system RAM | **4,707.07 MiB (4.60 GiB)** |
| Used swap | **0 MiB** |

The CPU maximum occurred in Round 2. The RAM maximum occurred in the high-bitrate segment workload of Round 1.

## 3. Round 1: 2 × 100 users, 50 Mbps, 600 seconds

Formal window: 2026-07-30 04:28:45–04:38:46 (UTC+8)  
Generator hold times: 600.121 seconds each

### 3.1 Requests and bandwidth

| Metric | Result |
|---|---:|
| Formal users / unique sessions | 200 / 200 |
| Master-playlist initialization | 200 succeeded, 0 failed |
| Playlist requests | 59,984 succeeded, 0 failed |
| Media-segment requests | 59,982 succeeded, 0 failed |
| Media payload | 749,893,900,106 bytes |
| Actual average output | 9.996569 Gbps |
| Theoretical output | 10.000000 Gbps |
| Playlist success rate | 100% |
| Segment success rate | 100% |

### 3.2 Latency

| Generator | p50 | p95 | p99 | Maximum |
|---|---:|---:|---:|---:|
| A | 5.299 ms | 11.518 ms | 15.666 ms | 230.495 ms |
| B | 5.287 ms | 11.429 ms | 15.874 ms | 26.760 ms |

Generator A recorded one 230.495 ms tail-latency outlier. Its p99 remained below 16 ms, with no failed request or lost session, so this was not a functional failure.

### 3.3 Test-server resources

| Metric | Maximum | Steady-state average / note |
|---|---:|---:|
| System CPU | 18.41% | Average 16.56%; p95 17.54% |
| Used system RAM | 4,707.07 MiB | Average 4,184.56 MiB |
| Minimum available RAM | 3,236.34 MiB | — |
| Used swap | 0 MiB | — |
| 1-minute load average | 4.81 | — |
| MediaMTX RSS | 2,412.04 MiB | High-bitrate segment buffers were the main RAM consumer |
| R33 helper RSS | 622.67 MiB | — |
| Caddy RSS | 64.97 MiB | — |
| Monitor RSS | 108.78 MiB | — |
| Combined generator RSS | 300.59 MiB | — |
| FFmpeg RSS | 160.61 MiB | — |
| HLS sessions | 201–202 | Includes one or two probe sessions |
| TCP ESTABLISHED | 211 | Peak |

### 3.4 Monitoring behavior

- The monitor reported 200–201 online users; the extra connection was a status probe.
- Non-200 monitor API samples: 0.
- Maximum API response time: 158.979 ms; p95: 6.359 ms.
- HLS, WebRTC, viewer-map, and SQLite health remained good.
- R33 and monitor restart deltas were both zero.

## 4. Round 2: 2 × 5,000 users, 1 Mbps, 600 seconds

Formal window: 2026-07-30 05:09:17–05:19:18 (UTC+8)  
Generator hold times: 600.636 and 600.659 seconds

### 4.1 Requests and bandwidth

| Metric | Result |
|---|---:|
| Formal users / unique sessions | 10,000 / 10,000 |
| Master-playlist initialization | 10,000 succeeded, 0 failed |
| Playlist requests | 3,002,688 succeeded, 0 failed |
| Media-segment requests | 3,002,661 succeeded, 0 failed |
| Media payload | 754,398,073,374 bytes |
| Actual average output | 10.047798 Gbps |
| Video-target theoretical output | 10.000000 Gbps |
| Estimate from monitored average stream bitrate | 10.065203 Gbps |
| Playlist success rate | 100% |
| Segment success rate | 100% |

The small difference from the 10 Gbps target is explained by AAC audio, container overhead, and short-term encoder bitrate variation.

### 4.2 Latency

| Generator | p50 | p95 | p99 | Maximum |
|---|---:|---:|---:|---:|
| A | 2.960 ms | 12.559 ms | 20.247 ms | 98.764 ms |
| B | 2.950 ms | 12.683 ms | 20.849 ms | 140.403 ms |

The two generators had 29 and 19 requests in flight at the stage boundary. Both drained normally to zero before writing their final `complete` events, with no residual request or error.

### 4.3 Test-server resources

| Metric | Maximum | Steady-state average / note |
|---|---:|---:|
| System CPU | 74.76% | Average 70.07%; p95 71.89% |
| Used system RAM | 3,437.41 MiB | Average 3,277.29 MiB |
| Minimum available RAM | 4,506.00 MiB | — |
| Used swap | 0 MiB | — |
| 1-minute load average | 19.74 | 16-vCPU host |
| MediaMTX RSS | 699.89 MiB | — |
| R33 helper RSS | 843.41 MiB | — |
| Caddy RSS | 67.04 MiB | — |
| Monitor RSS | 103.19 MiB | — |
| Combined generator RSS | 332.09 MiB | — |
| FFmpeg RSS | 63.16 MiB | — |
| HLS sessions | 10,001–10,002 | Includes status probes |
| TCP ESTABLISHED | 1,506 | Peak with connection pooling |

The sampler recorded 3,518.61 MiB used RAM during the post-formal drain window. The reported 3,437.41 MiB figure is strictly limited to the 600-second formal window.

### 4.4 Monitoring behavior

- Steady-state online users remained at 10,000–10,001 and correctly represented the 10,000 formal users.
- Non-200 monitor API samples: 0.
- Maximum API response time: 603.919 ms; p95: 340.540 ms.
- API latency increased at 10,000 users, but every request succeeded and monitoring did not block streaming output.
- HLS, WebRTC, viewer-map, and SQLite health remained good.
- R33 and monitor restart deltas were both zero.

## 5. Parameter-validation note

A preparation run for Round 2 was found to have used a mistaken 10 Mbps publisher setting. That workload represented approximately 100 Gbps of theoretical output and did not match the requested 1 Mbps scenario. All requests, resource figures, and errors from that invalid run were excluded.

The stream was then restarted with explicit `-b:v 1M -minrate 1M -maxrate 1M` settings, and the complete 600-second formal Round 2 was rerun. This report, the final JSON summary, and the final raw archive contain only the correct Round 1 and the corrected 1 Mbps Round 2 data. Files from the invalid run were deleted from the test server.

## 6. Recovery, logs, and data cleanup

- After Round 2 stopped, online, HLS, and WebRTC sessions returned to zero.
- After the 60-second resume grace period, `media_live=false`, `session_live=false`, and `resume_grace_active=false`.
- Systemd warning count was zero in both formal windows.
- OOM, TCP memory-exhaustion, segmentation-fault, and hung-task event counts were zero in both formal windows.
- The raw result archive was downloaded. Local SHA-256:
  `aefbc22fd1ffee47045be1794dd49aff1554252b9d6c8bbde51d61211088599b`
- All test-server publisher, generator, sampler, log, PID, temporary media, archive, and test-script files were deleted.
- Before clearing SQLite: 9 broadcasts, 242,323 viewer sessions, and `quick_check=ok`.
- The monitor was stopped; the primary database, WAL, and SHM were deleted; the monitor then recreated an empty database.
- Primary databases, WAL files, and SHM files in three inactive monitor backup directories under `/root` were also deleted. NSS test fixtures under the Go module cache were retained because they are not live-streaming or monitoring business data.
- After clearing SQLite: 0 broadcasts, 0 viewer sessions, `quick_check=ok`, and a 4,096-byte database.
- R33 and the monitor were both `active` and `enabled` after cleanup, with the stream offline.

## 7. Final assessment

Across two approximately 10 Gbps workloads with very different session counts and per-user bitrates:

1. R33 delivered the streams without request errors, crashes, or service restarts.
2. The v25 monitor continuously reported user, session, and bandwidth data correctly at both 200 and 10,000 users.
3. Monitor API p95 latency rose to approximately 341 ms at 10,000 users, but HTTP success remained 100%; this is not a functional failure.
4. The high-bitrate Round 1 was primarily memory-intensive, while the high-session-count Round 2 was primarily CPU-intensive.
5. No new bug requiring an immediate change to the live-streaming or monitoring package was found.
