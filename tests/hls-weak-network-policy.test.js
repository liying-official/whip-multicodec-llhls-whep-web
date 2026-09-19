"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const policy = require("../web/hls-weak-network-policy.js");
const appSource = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const mediaMtxTemplate = fs.readFileSync(
  path.join(__dirname, "..", "mediamtx.template.yml"),
  "utf8"
);
const hlsAsset = fs.readFileSync(path.join(__dirname, "..", "web", "hls.min.js"));
const hlsVersionRecord = fs.readFileSync(
  path.join(__dirname, "..", "third_party", "HLSJS-VERSION.txt"),
  "utf8"
);
const startScript = fs.readFileSync(path.join(__dirname, "..", "start.sh"), "utf8");
const installScript = fs.readFileSync(path.join(__dirname, "..", "install-systemd.sh"), "utf8");
const helperSource = fs.readFileSync(path.join(__dirname, "..", "src", "helper.go"), "utf8");
const caddyTemplate = fs.readFileSync(path.join(__dirname, "..", "Caddyfile.template"), "utf8");

test("V8: a timed-out live playlist protects a draining playable buffer", () => {
  const state = { details: "levelLoadTimeOut", fatal: false, bufferAhead: 3,
    playbackAgeMs: 10000, paused: false, seeking: false };
  assert.equal(policy.shouldProtectPlaylistBuffer(state), true);
  assert.equal(policy.shouldProtectPlaylistBuffer({ ...state, details: "audioTrackLoadTimeOut" }), true);
  for (const change of [
    { bufferAhead: 6 }, { bufferAhead: NaN }, { bufferAhead: -1 },
    { playbackAgeMs: 1000 }, { paused: true }, { seeking: true },
    { details: "fragLoadTimeOut" }, { details: "levelLoadError" }, { fatal: true }
  ]) assert.equal(policy.shouldProtectPlaylistBuffer({ ...state, ...change }), false, JSON.stringify(change));
});

test("V8: real vendored buffer controller retires append deadlines when queue heads change", () => {
  const Hls = require("../web/hls.min.js");
  const Base = Hls.DefaultConfig.bufferController;
  const saved = { self: global.self, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  let next = 0; const timers = new Map();
  global.self = global;
  global.setTimeout = (fn) => { timers.set(++next, fn); return next; };
  global.clearTimeout = id => timers.delete(id);
  function fixture(Controller) {
    const hls = new Hls({ bufferController: Controller, appendTimeout: 15000 });
    const b = hls.bufferController;
    const sb = new EventTarget();
    sb.updating = false; sb.aborts = 0;
    sb.buffered = { length: 1, start: () => 90, end: () => 106 };
    sb.appendBuffer = () => { sb.updating = true; };
    sb.abort = () => { sb.aborts++; sb.updating = false; };
    let errors = 0;
    const op = { onComplete() {}, onError() { errors++; }, label: "append-video" };
    let head = op;
    b.media = { currentTime: 100 };
    b.mediaSource = { readyState: "open" };
    b.tracks.video = { buffer: sb, listeners: [] };
    b.sourceBuffers = [["video", sb], [null, null]];
    b.operationQueue = { current: () => head, shiftAndExecuteNext() { head = null; }, destroy() {} };
    return { b, sb, op, track: b.tracks.video, head: value => { head = value; },
      errors: () => errors, start() { b.appendExecutor(new Uint8Array([1]), "video"); return timers.get(b.tracks.video.bufferAppendTimeoutId); },
      cleanup() { b.clearBufferAppendTimeoutId(b.tracks.video); b.mediaSource = null; b.media = null; b.tracks = {}; b.sourceBuffers = [[null, null], [null, null]]; hls.destroy(); }
    };
  }
  try {
    const legacy = fixture(Base); const oldDeadline = legacy.start();
    legacy.sb.updating = false; legacy.head({ label: "async-blocker", onComplete() {} });
    legacy.b.onSBUpdateEnd("video"); oldDeadline();
    assert.equal(legacy.sb.aborts, 1, "control must reproduce stale deadline aborting an idle SourceBuffer");
    legacy.cleanup(); timers.clear();
    const Fixed = policy.withAppendOwnership ? policy.withAppendOwnership(Base) : Base;
    const fixed = fixture(Fixed); const retired = fixed.start();
    fixed.sb.updating = false; fixed.head({ label: "async-blocker", onComplete() {} });
    fixed.sb.dispatchEvent(new Event("updateend")); fixed.b.onSBUpdateEnd("video"); retired();
    assert.equal(fixed.sb.aborts, 0, "a completed append deadline must not abort an idle buffer");
    fixed.head(fixed.op); const stale = fixed.start();
    fixed.b.clearBufferAppendTimeoutId(fixed.track);
    const current = fixed.start(); stale();
    assert.equal(fixed.sb.aborts, 0, "retired deadline must not abort a newer append");
    current();
    assert.equal(fixed.sb.aborts, 1, "an actually pending append must retain timeout recovery");
    assert.equal(fixed.errors(), 1);
    const replaced = fixed.start(); fixed.track.buffer = new EventTarget(); replaced();
    assert.equal(fixed.sb.aborts, 1, "a replaced SourceBuffer is never aborted by its predecessor");
    fixed.track.buffer = fixed.sb;
    const failed = fixed.start(); fixed.sb.dispatchEvent(new Event("error")); failed();
    assert.equal(fixed.sb.aborts, 1, "an errored append retires its deadline");
    const append = fixed.sb.appendBuffer;
    fixed.sb.appendBuffer = () => { throw new Error("append fixture failure"); };
    assert.throws(() => fixed.start(), /append fixture failure/);
    assert.equal(timers.size, 0, "synchronous append failure must not leak a deadline");
    fixed.sb.appendBuffer = append;
    const idle = fixed.start(); fixed.sb.updating = false; idle();
    assert.equal(fixed.sb.aborts, 1, "lost completion notification must not abort an idle buffer");
    const detached = fixed.start(); fixed.cleanup(); detached();
    assert.equal(fixed.sb.aborts, 1, "destruction retires pending callbacks");
    assert.equal(timers.size, 0);
  } finally {
    global.self = saved.self; global.setTimeout = saved.setTimeout; global.clearTimeout = saved.clearTimeout;
  }
});

function lowBandwidthSample(state, ratio, bufferAhead = 2) {
  const risk = policy.isBandwidthRisk({ paused: false, bandwidthRatio: ratio, bufferAhead });
  return policy.sampleLowBandwidth(state, risk);
}

function recoverySample(state, ratio, bufferAhead, now, noRecentNetworkErrors = true) {
  // These existing threshold tests model healthy current transfers/motion;
  // stale, frozen and interrupted evidence is tested separately below.
  if (!state.recoveryMotion) state.recoveryMotion = { time: now / 1000 - 1, end: now / 1000 - 1 + bufferAhead };
  policy.noteMediaTransfer(state, { now, duration: 2 });
  return policy.sampleRecovery(state, {
    bandwidthRatio: ratio,
    bufferAhead,
    noRecentNetworkErrors,
    now, currentTime: now / 1000, bufferEnd: now / 1000 + bufferAhead
  });
}

function stall(state, now, ratio, bufferAhead, pastStartupWarmup = true, healthyDownloads = true) {
  return policy.recordStall(state, {
    now,
    bandwidthRatio: ratio,
    bufferAhead,
    noRecentNetworkErrors: healthyDownloads,
    pastStartupWarmup
  });
}

test("asset: hls.js 1.7.3 published asset, runtime version and startup pin agree", () => {
  const expected = "a12e7ee1cd64a69dcdb314157e45dafcba705bfb0b1440b7935cb265d374423e";
  assert.equal(crypto.createHash("sha256").update(hlsAsset).digest("hex"), expected);
  assert.match(hlsVersionRecord, /^  hls\.js v1\.7\.3$/m);
  assert.equal(require("../web/hls.min.js").version, "1.7.3");
  assert.match(helperSource, /fs\.String\("version", "1\.7\.3"/);
  assert.match(startScript, /hls\.js v1\.7\.3/);
  assert.match(hlsVersionRecord, new RegExp(`^  ${expected}$`, "m"));
  assert.match(startScript, new RegExp(`HLSJS_EXPECTED_SHA256=${expected}`));
});

test("integration: app.js uses the behavior-tested policy before app startup", () => {
  const policyScript = indexSource.search(/src="\/hls-weak-network-policy\.js(?:\?[^"<>]*)?"/);
  const appScript = indexSource.search(/src="\/app\.js(?:\?[^"<>]*)?"/);
  assert.ok(policyScript >= 0 && appScript > policyScript);
  for (const call of [
    "sampleLowBandwidth",
    "sampleRecovery",
    "recordStall",
    "markNetworkError",
    "endStallEpisode",
    "profileFor",
    "isSafeBacktrack",
    "consumeOnlineAfterOffline",
    "isFatalNetworkError"
  ]) {
    assert.match(appSource, new RegExp(`HLS_WEAK_POLICY\\.${call}`));
  }
  for (const deploymentSource of [startScript, installScript, helperSource, caddyTemplate]) {
    assert.match(deploymentSource, /hls-weak-network-policy\.js/);
  }
});

test("TEST 01: sustained 3x bandwidth for 60 samples never confirms weak mode", () => {
  const state = policy.createState();
  for (let second = 0; second < 60; second += 1) {
    assert.equal(lowBandwidthSample(state, 3).confirmed, false);
  }
  assert.equal(state.lowBandwidthSamples, 0);
});

test("TEST 02: high bandwidth plus buffer below 0.75s is not a bandwidth trigger", () => {
  const state = policy.createState();
  for (let second = 0; second < 60; second += 1) lowBandwidthSample(state, 3, 0.5);
  assert.equal(state.lowBandwidthSamples, 0);
});

test("TEST 03: five consecutive low-bandwidth samples do not enter weak", () => {
  const state = policy.createState();
  let result;
  for (let sample = 0; sample < 5; sample += 1) result = lowBandwidthSample(state, 1.1);
  assert.equal(result.confirmed, false);
  assert.equal(state.lowBandwidthSamples, 5);
});

test("TEST 04: six consecutive low-bandwidth samples enter weak", () => {
  const state = policy.createState();
  let result;
  for (let sample = 0; sample < 6; sample += 1) result = lowBandwidthSample(state, 1.1);
  assert.equal(result.confirmed, true);
  assert.equal(state.lowBandwidthSamples, 6);
});

test("TEST 05: 5 low, 1 healthy, 2 low resets the counter and does not enter", () => {
  const state = policy.createState();
  for (let sample = 0; sample < 5; sample += 1) lowBandwidthSample(state, 1.1);
  lowBandwidthSample(state, 2);
  assert.equal(state.lowBandwidthSamples, 0);
  lowBandwidthSample(state, 1.1);
  const result = lowBandwidthSample(state, 1.1);
  assert.equal(result.confirmed, false);
  assert.equal(state.lowBandwidthSamples, 2);
});

test("TEST 06: 3 low, healthy, 5 low does not enter", () => {
  const state = policy.createState();
  for (let sample = 0; sample < 3; sample += 1) lowBandwidthSample(state, 1.1);
  lowBandwidthSample(state, 2);
  let result;
  for (let sample = 0; sample < 5; sample += 1) result = lowBandwidthSample(state, 1.1);
  assert.equal(result.confirmed, false);
  assert.equal(state.lowBandwidthSamples, 5);
});

test("TEST 07: two independent stalls at 1.5x with healthy buffer/downloads stay normal", () => {
  const state = policy.createState();
  assert.equal(stall(state, 10000, 1.5, 8).ignoredAsNetworkHealthy, true);
  policy.endStallEpisode(state);
  const second = stall(state, 12000, 1.5, 8);
  assert.equal(second.ignoredAsNetworkHealthy, true);
  assert.equal(second.enterWeak, false);
  assert.equal(state.stallIncidents.length, 0);
});

test("TEST 08: repeated stalls at 1.1x with low buffer may enter weak", () => {
  const state = policy.createState();
  assert.equal(stall(state, 10000, 1.1, 0.5).enterWeak, false);
  policy.endStallEpisode(state);
  assert.equal(stall(state, 12000, 1.1, 0.5).enterWeak, true);
});

test("TEST 09: bandwidth weak retains V1.35 buffer caps while separating latency and readiness", () => {
  assert.deepEqual(policy.profileFor(true), {
    lowLatencyMode: true,
    targetLatency: 12,
    liveMaxLatencyDuration: 24,
    maxBufferLength: 16,
    maxMaxBufferLength: 24,
    maxLiveSyncPlaybackRate: 1,
    minActualForwardBuffer: 8,
    bufferReadyLowWatermark: 6
  });
});

test("TEST 10: safe point can move backward inside one downloaded continuous range", () => {
  assert.equal(policy.isSafeBacktrack([{ start: 90, end: 112 }], 105, 100, 1.5, 6), true);
});

test("TEST 11: safe point cannot seek across a hole or to an undownloaded target", () => {
  const ranges = [{ start: 90, end: 98 }, { start: 102, end: 112 }];
  assert.equal(policy.isSafeBacktrack(ranges, 105, 97, 1.5, 10), false);
  assert.equal(policy.isSafeBacktrack([{ start: 102, end: 112 }], 105, 100, 1.5, 6), false);
});

test("safe-point boundary matrix rejects forward, too-short and too-long moves", () => {
  const ranges = [{ start: 90, end: 112 }];
  assert.equal(policy.isSafeBacktrack(ranges, 105, 106, 1.5, 6), false);
  assert.equal(policy.isSafeBacktrack(ranges, 105, 103.501, 1.5, 6), false);
  assert.equal(policy.isSafeBacktrack(ranges, 105, 103.5, 1.5, 6), true);
  assert.equal(policy.isSafeBacktrack(ranges, 105, 99, 1.5, 6), true);
  assert.equal(policy.isSafeBacktrack(ranges, 105, 98.999, 1.5, 6), false);
});

test("TEST 12: 1.7x, 6s buffer and 20 healthy samples use fast recovery", () => {
  const state = policy.createState();
  state.lastStallAt = 1000;
  let result;
  for (let sample = 1; sample <= 20; sample += 1) {
    result = recoverySample(state, 1.7, 6, 1000 + sample * 1000);
  }
  assert.equal(result.path, "fast");
});

test("TEST 13: 1.5x, 7s buffer and 30 stable samples use stable recovery", () => {
  const state = policy.createState();
  state.lastStallAt = 1000;
  let result;
  for (let sample = 1; sample <= 30; sample += 1) {
    result = recoverySample(state, 1.5, 7, 1000 + sample * 1000);
  }
  assert.equal(result.path, "stable");
});

test("TEST 14: 1.3x does not recover even with a temporarily deep buffer", () => {
  const state = policy.createState();
  for (let sample = 1; sample <= 60; sample += 1) {
    assert.equal(recoverySample(state, 1.3, 12, sample * 1000).path, "");
  }
});

test("TEST 15: a stall during recovery resets both recovery counters", () => {
  const state = policy.createState();
  for (let sample = 1; sample <= 10; sample += 1) {
    recoverySample(state, 1.7, 10, sample * 1000);
  }
  assert.equal(state.fastRecoverySamples, 10);
  stall(state, 12000, 1.1, 1);
  assert.equal(state.fastRecoverySamples, 0);
  assert.equal(state.stableRecoverySamples, 0);
});

test("healthy stalls in normal mode add no weak-network stall evidence", () => {
  const state = policy.createState();
  for (const now of [10000, 20000, 30000]) {
    const result = stall(state, now, 2, 9);
    assert.equal(result.ignoredAsNetworkHealthy, true);
    assert.equal(result.enterWeak, false);
    policy.endStallEpisode(state);
  }
  assert.equal(state.lastStallAt, null);
  assert.deepEqual(state.stallIncidents, []);
});

test("WN-NEW-01: healthy stall preserves an earlier real incident", () => {
  const state = policy.createState();
  assert.equal(stall(state, 10000, 1.1, 0.5).enterWeak, false);
  assert.deepEqual(state.stallIncidents, [10000]);
  policy.endStallEpisode(state);

  const ignored = stall(state, 12000, 2, 9);
  assert.equal(ignored.ignoredAsNetworkHealthy, true);
  assert.deepEqual(state.stallIncidents, [10000]);
  policy.endStallEpisode(state);

  const second = stall(state, 14000, 1.1, 0.5);
  assert.equal(second.enterWeak, true);
  assert.deepEqual(state.stallIncidents, [10000, 14000]);
});

test("WN-NEW-01 control: an expired first incident cannot combine with a later stall", () => {
  const state = policy.createState();
  assert.equal(stall(state, 10000, 1.1, 0.5).enterWeak, false);
  policy.endStallEpisode(state);

  const afterWindow = stall(state, 25001, 1.1, 0.5);
  assert.equal(afterWindow.enterWeak, false);
  assert.deepEqual(state.stallIncidents, [25001]);
});

test("WN-NEW-02: a healthy-looking episode can escalate exactly once", () => {
  const state = policy.createState();
  assert.equal(stall(state, 10000, 2, 8).ignoredAsNetworkHealthy, true);
  policy.markNetworkError(state, 11000);

  const escalated = stall(state, 12000, 1.1, 0.2, true, false);
  assert.equal(escalated.ignoredAsNetworkHealthy, false);
  assert.deepEqual(state.stallIncidents, [12000]);
  stall(state, 13000, 1.1, 0.2, true, false);
  assert.deepEqual(state.stallIncidents, [12000]);

  policy.endStallEpisode(state);
  const independent = stall(state, 16000, 1.1, 0.2, true, false);
  assert.equal(independent.enterWeak, true);
  assert.deepEqual(state.stallIncidents, [12000, 16000]);
});

test("WN-NEW-02 controls: healthy episodes stay ignored and network episodes count once", () => {
  const healthy = policy.createState();
  for (const now of [10000, 12000, 14000]) {
    assert.equal(stall(healthy, now, 2, 8).ignoredAsNetworkHealthy, true);
  }
  assert.deepEqual(healthy.stallIncidents, []);
  assert.equal(healthy.stallEpisodeClassification, "healthy");

  const network = policy.createState();
  for (const now of [10000, 12000, 14000, 17000]) {
    stall(network, now, 1.1, 0.2, true, false);
  }
  assert.deepEqual(network.stallIncidents, [10000]);
  assert.equal(network.stallEpisodeClassification, "network");
});

test("WN-NEW-04: independent-episode time dedup boundary is exact", () => {
  for (const [delta, expectedCount, expectedDedup] of [
    [1499, 1, true],
    [1500, 2, false],
    [1501, 2, false]
  ]) {
    const state = policy.createState();
    stall(state, 10000, 1.1, 0.5);
    policy.endStallEpisode(state);
    const result = stall(state, 10000 + delta, 1.1, 0.5);
    assert.equal(result.deduplicated, expectedDedup, `${delta}ms dedup decision`);
    assert.equal(state.stallIncidents.length, expectedCount, `${delta}ms incident count`);
  }
});

test("boundary matrix: entry, health, recovery ratios and buffers remain exact", () => {
  for (const [ratio, expected] of [[1.199999, true], [1.2, false], [1.200001, false]]) {
    assert.equal(policy.isBandwidthRisk({ paused: false, bandwidthRatio: ratio, bufferAhead: 3 }), expected);
  }
  for (const [bufferAhead, expected] of [[3.999, true], [4, false], [4.001, false]]) {
    assert.equal(policy.isBandwidthRisk({ paused: false, bandwidthRatio: 1.1, bufferAhead }), expected);
  }

  for (const [ratio, healthy] of [[1.449999, false], [1.45, true], [1.450001, true]]) {
    const result = stall(policy.createState(), 20000, ratio, 2);
    assert.equal(result.ignoredAsNetworkHealthy, healthy, `health ratio ${ratio}`);
  }
  for (const [bufferAhead, healthy] of [[1.999, false], [2, true], [2.001, true]]) {
    const result = stall(policy.createState(), 20000, 1.45, bufferAhead);
    assert.equal(result.ignoredAsNetworkHealthy, healthy, `health buffer ${bufferAhead}`);
  }

  for (const [ratio, expected] of [[1.499999, 0], [1.5, 1], [1.500001, 1]]) {
    const state = policy.createState();
    recoverySample(state, ratio, 7, 40000);
    assert.equal(state.stableRecoverySamples, expected, `stable ratio ${ratio}`);
  }
  for (const [bufferAhead, expected] of [[5.999, 0], [6, 1], [6.001, 1]]) {
    const state = policy.createState();
    recoverySample(state, 1.5, bufferAhead, 40000);
    assert.equal(state.stableRecoverySamples, expected, `stable buffer ${bufferAhead}`);
  }

  for (const [ratio, expected] of [[1.699999, 0], [1.7, 1], [1.700001, 1]]) {
    const state = policy.createState();
    recoverySample(state, ratio, 6, 20000);
    assert.equal(state.fastRecoverySamples, expected, `fast ratio ${ratio}`);
  }
  for (const [bufferAhead, expected] of [[5.999, 0], [6, 1], [6.001, 1]]) {
    const state = policy.createState();
    recoverySample(state, 1.7, bufferAhead, 20000);
    assert.equal(state.fastRecoverySamples, expected, `fast buffer ${bufferAhead}`);
  }
});

test("boundary matrix: fast and stable quiet windows remain inclusive", () => {
  for (const [quietMs, expectedPath] of [[14999, ""], [15000, "fast"], [15001, "fast"]]) {
    const state = policy.createState();
    state.fastRecoverySamples = policy.constants.FAST_RECOVERY_SAMPLES - 1;
    state.lastStallAt = 1000;
    state.lastNetworkErrorAt = 1000;
    assert.equal(recoverySample(state, 1.7, 6, 1000 + quietMs).path, expectedPath);
  }
  for (const [quietMs, expectedPath] of [[29999, ""], [30000, "stable"], [30001, "stable"]]) {
    const state = policy.createState();
    state.stableRecoverySamples = policy.constants.STABLE_RECOVERY_SAMPLES - 1;
    state.stableRecoveryLastEvidenceAt = quietMs;
    state.lastStallAt = 1000;
    state.lastNetworkErrorAt = 1000;
    assert.equal(recoverySample(state, 1.5, 7, 1000 + quietMs).path, expectedPath);
  }
});

test("wall-clock jumps cannot bypass sample counts or recent-error quiet time", () => {
  const forward = policy.createState();
  forward.lastStallAt = 1000;
  assert.equal(recoverySample(forward, 1.7, 8, 1_000_000_000).path, "");
  assert.equal(forward.fastRecoverySamples, 1);

  const backward = policy.createState();
  backward.fastRecoverySamples = policy.constants.FAST_RECOVERY_SAMPLES - 1;
  backward.lastStallAt = 1000;
  policy.markNetworkError(backward, 10000);
  assert.equal(recoverySample(backward, 1.7, 8, 9000).path, "");
});

test("diagnostic low-buffer boundary stays fixed at 0.75 seconds", () => {
  assert.match(appSource, /const HLS_WEAK_LOW_BUFFER_SECONDS = 0\.75;/);
  assert.match(appSource, /bufferAhead < HLS_WEAK_LOW_BUFFER_SECONDS/);
  assert.deepEqual(
    [0.749, 0.75, 0.751].map(bufferAhead => bufferAhead < 0.75),
    [true, false, false]
  );
});

test("healthy stall preserves fast recovery evidence while weak", () => {
  const state = policy.createState();
  state.lastStallAt = 1000;
  for (let sample = 1; sample <= 5; sample += 1) {
    recoverySample(state, 2, 9, 1000 + sample * 1000);
  }
  assert.equal(state.fastRecoverySamples, 5);
  const result = stall(state, 7000, 2, 9);
  assert.equal(result.ignoredAsNetworkHealthy, true);
  assert.equal(state.fastRecoverySamples, 5);
  assert.equal(state.lastStallAt, 1000);
});

test("healthy stall preserves stable recovery evidence while weak", () => {
  const state = policy.createState();
  state.lastStallAt = 1000;
  for (let sample = 1; sample <= 5; sample += 1) {
    recoverySample(state, 1.55, 7.5, 1000 + sample * 1000);
  }
  assert.equal(state.fastRecoverySamples, 0);
  assert.equal(state.stableRecoverySamples, 5);
  const result = stall(state, 7000, 1.55, 7.5);
  assert.equal(result.ignoredAsNetworkHealthy, true);
  assert.equal(state.stableRecoverySamples, 5);
  assert.equal(state.lastStallAt, 1000);
});

test("healthy stall preserves the network-stall quiet window", () => {
  const state = policy.createState();
  state.lastStallAt = 1000;
  for (let sample = 1; sample <= 19; sample += 1) {
    recoverySample(state, 2, 9, 1000 + sample * 1000);
  }
  const ignored = stall(state, 20500, 2, 9);
  assert.equal(ignored.ignoredAsNetworkHealthy, true);
  assert.equal(state.lastStallAt, 1000);
  assert.equal(recoverySample(state, 2, 9, 21000).path, "fast");
});

test("real network stall still resets recovery evidence and quiet time", () => {
  const state = policy.createState();
  state.lastStallAt = 1000;
  for (let sample = 1; sample <= 5; sample += 1) {
    recoverySample(state, 2, 9, 1000 + sample * 1000);
  }
  const result = stall(state, 7000, 1.1, 0.5);
  assert.equal(result.ignoredAsNetworkHealthy, false);
  assert.equal(state.fastRecoverySamples, 0);
  assert.equal(state.stableRecoverySamples, 0);
  assert.equal(state.lastStallAt, 7000);
});

test("periodic decoder stalls cannot keep a recovered link in weak mode", () => {
  const state = policy.createState();
  state.lastStallAt = 1000;
  let recoveryPath = "";
  for (let second = 1; second <= 60 && !recoveryPath; second += 1) {
    const now = 1000 + second * 1000;
    if (second % 10 === 0) {
      assert.equal(stall(state, now, 2, 9).ignoredAsNetworkHealthy, true);
      policy.endStallEpisode(state);
    }
    recoveryPath = recoverySample(state, 2, 9, now).path;
  }
  assert.equal(recoveryPath, "fast");
});

test("periodic real network stalls continue to block weak-mode exit", () => {
  const state = policy.createState();
  state.lastStallAt = 1000;
  for (let second = 1; second <= 60; second += 1) {
    const now = 1000 + second * 1000;
    if (second % 10 === 0) {
      assert.equal(stall(state, now, 1.1, 0.5).ignoredAsNetworkHealthy, false);
      policy.endStallEpisode(state);
    }
    assert.equal(recoverySample(state, 2, 9, now).path, "");
  }
  assert.equal(state.lastStallAt, 61000);
  assert.ok(state.fastRecoverySamples < policy.constants.FAST_RECOVERY_SAMPLES);
});

test("TEST 16: bandwidth falling back into the risk region resets recovery", () => {
  const state = policy.createState();
  for (let sample = 1; sample <= 10; sample += 1) {
    recoverySample(state, 1.5, 10, sample * 1000);
  }
  assert.equal(state.stableRecoverySamples, 10);
  recoverySample(state, 1.1, 10, 11000);
  assert.equal(state.fastRecoverySamples, 0);
  assert.equal(state.stableRecoverySamples, 0);
});

test("TEST 17: weak to normal changes only the profile and has no destructive recovery call", () => {
  const normal = policy.profileFor(false);
  assert.equal(normal.lowLatencyMode, true);
  assert.equal(normal.maxLiveSyncPlaybackRate, 1.05);
  const begin = appSource.indexOf("function applyHlsNetworkProfile");
  const end = appSource.indexOf("function armHlsNetworkMonitor", begin);
  const transitionSource = appSource.slice(begin, end);
  assert.doesNotMatch(transitionSource, /\.destroy\(|\.loadSource\(|video\.currentTime\s*=/);
});

test("TEST 18: a standalone online event without prior offline is ignored", () => {
  const state = policy.createState();
  assert.equal(policy.consumeOnlineAfterOffline(state), false);
});

test("TEST 19: a real offline to online transition requests weak safety mode once", () => {
  const state = policy.createState();
  policy.markOffline(state);
  assert.equal(policy.consumeOnlineAfterOffline(state), true);
  assert.equal(policy.consumeOnlineAfterOffline(state), false);
});

test("TEST 20: only a fatal HLS network error requests immediate weak mode", () => {
  assert.equal(policy.isFatalNetworkError(true, "networkError", "networkError"), true);
  assert.equal(policy.isFatalNetworkError(false, "networkError", "networkError"), false);
  assert.equal(policy.isFatalNetworkError(true, "mediaError", "networkError"), false);
});

test("entry hysteresis: oscillating 1.15x/1.25x samples cannot accumulate", () => {
  const state = policy.createState();
  for (const ratio of [1.15, 1.25, 1.18, 1.3, 1.15, 1.25, 1.18, 1.3]) {
    assert.equal(lowBandwidthSample(state, ratio).confirmed, false);
  }
  assert.equal(state.lowBandwidthSamples, 0);
  let result;
  for (let sample = 0; sample < 6; sample += 1) result = lowBandwidthSample(state, 1.1);
  assert.equal(result.confirmed, true);
});

test("recovery hysteresis: 1.45x/1.55x oscillation cannot instantly recover", () => {
  const state = policy.createState();
  let now = 0;
  for (let sample = 0; sample < 60; sample += 1) {
    now += 1000;
    const ratio = sample % 2 === 0 ? 1.45 : 1.55;
    assert.equal(recoverySample(state, ratio, 10, now).path, "");
  }
  let result;
  for (let sample = 0; sample < 30; sample += 1) {
    now += 1000;
    result = recoverySample(state, 1.5, 10, now);
  }
  assert.equal(result.path, "stable");
});

test("one long stall episode remains one incident beyond the time dedup window", () => {
  const state = policy.createState();
  stall(state, 10000, 1.1, 0.5);
  assert.equal(stall(state, 12000, 1.1, 0.5).deduplicated, true);
  assert.equal(stall(state, 14000, 1.1, 0.5).deduplicated, true);
  assert.equal(state.stallIncidents.length, 1);
  assert.equal(state.stallEpisodeActive, true);
});

test("playing ends an episode so a later physical stall is a second incident", () => {
  const state = policy.createState();
  assert.equal(stall(state, 10000, 1.1, 0.5).enterWeak, false);
  policy.endStallEpisode(state);
  assert.equal(state.stallEpisodeActive, false);
  assert.equal(stall(state, 14000, 1.1, 0.5).enterWeak, true);
  assert.equal(state.stallIncidents.length, 2);
});

test("startup warmup discards startup stalls from the normal entry window", () => {
  const state = policy.createState();
  assert.equal(stall(state, 10000, 1.1, 0.5, false).ignoredDuringWarmup, true);
  policy.endStallEpisode(state);
  const startupStall = stall(state, 12000, 1.1, 0.5, false);
  assert.equal(startupStall.ignoredDuringWarmup, true);
  assert.equal(state.stallIncidents.length, 0);
  policy.endStallEpisode(state);
  assert.equal(stall(state, 14000, 1.1, 0.5, true).enterWeak, false);
  policy.endStallEpisode(state);
  assert.equal(stall(state, 16000, 1.1, 0.5, true).enterWeak, true);
  assert.match(appSource, /hlsNow\(\) - hlsNetworkPlaybackStartedAt < HLS_NETWORK_MONITOR_WARMUP_MS/);
});

test("recent download errors prevent stall suppression and recovery", () => {
  const state = policy.createState();
  policy.markNetworkError(state, 10000);
  assert.equal(stall(state, 11000, 1.5, 8, true, true).ignoredAsNetworkHealthy, false);
  assert.equal(recoverySample(state, 1.7, 10, 20000, true).path, "");
});

test("non-fatal HLS network errors count against recovery without forcing weak mode", () => {
  const errorHandler = appSource.slice(
    appSource.indexOf("instance.on(Hls.Events.ERROR"),
    appSource.indexOf("instance.on(Hls.Events.ERROR") + 5000
  );
  const counter = errorHandler.indexOf("hlsConsecutiveNetworkErrors += 1");
  const timestamp = errorHandler.indexOf("HLS_WEAK_POLICY.markNetworkError");
  const nonFatalBranch = errorHandler.indexOf("if (!data.fatal)");
  const fatalTransition = errorHandler.indexOf("if (fatalNetworkError)");
  assert.ok(counter >= 0 && counter < nonFatalBranch);
  assert.ok(timestamp >= 0 && timestamp < nonFatalBranch);
  assert.ok(fatalTransition > nonFatalBranch);
});

test("new HLS session state does not inherit weak counters, stalls, or offline state", () => {
  const oldState = policy.createState();
  lowBandwidthSample(oldState, 1.1);
  policy.markOffline(oldState);
  policy.markWeakEntry(oldState, 1234, "test");
  const nextState = policy.createState();
  assert.deepEqual(nextState, {
    lowBandwidthSamples: 0,
    fastRecoverySamples: 0,
    stableRecoverySamples: 0,
    stableRecoveryLastEvidenceAt: 0,
    lastStallAt: null,
    stallIncidents: [],
    stallEpisodeActive: false,
    stallEpisodeStartedAt: 0,
    stallEpisodeClassification: "",
    lastNetworkErrorAt: null,
    lastBandwidthRatio: null,
    wasOffline: false,
    weakEnterTimestamp: 0,
    weakTriggerReason: "",
    weakRecoveryPath: "",
    weakNetworkClass: "",
    weakBufferReady: false,
    previousBufferAhead: null,
    previousBufferSampleAt: 0,
    networkSamples: 0,
    bufferDrainSamples: 0,
    bufferSlope: null,
    requestOverheadMs: null,
    requestOverheadBaselineMs: null,
    requestOverheadBaseline: [],
    requestOverheadSamples: 0,
    lastRequestSampleAt: 0,
    requestScope: "", requestKind: "", requestContexts: {}, rttReference: null,
    rttRecoverySamples: 0, rttRecoveryAt: null, rttRequalification: null, rttEvidenceMaxAgeMs: 6000,
    mediaTransferAt: null, mediaTransferSerial: 0, mediaEvidenceMaxAgeMs: 6000,
    recoveryLastSampleAt: null, recoveryNeedsMedia: false, recoveryAfterSerial: 0,
    recoveryMotion: null, recoveryMotionAt: null
  });
});

test("timer lifecycle and normal server cadence remain unchanged", () => {
  assert.match(appSource, /clearInterval\(hlsNetworkMonitorTimer\)/);
  assert.match(appSource, /clearTimeout\(hlsWeakSafePointTimer\)/);
  assert.match(appSource, /resetHlsNetworkMonitor\(\);[\s\S]*hls\.destroy\(\)/);
  assert.match(mediaMtxTemplate, /^hlsSegmentCount: 24$/m);
  assert.match(mediaMtxTemplate, /^hlsSegmentDuration: 2s$/m);
  assert.match(mediaMtxTemplate, /^hlsPartDuration: 1s$/m);
});

test("stable recovery accepts the real 7.x/8.x full-segment cadence", () => {
  const state = policy.createState();
  state.lastStallAt = 1000;
  const cadence = [7.0, 7.8, 7.1, 8.0, 7.2, 7.9];
  let result;
  for (let sample = 1; sample <= 30; sample += 1) {
    result = recoverySample(state, 1.55, cadence[(sample - 1) % cadence.length], 1000 + sample * 1000);
  }
  assert.equal(result.path, "stable");
  assert.equal(policy.constants.STABLE_RECOVERY_BUFFER_SECONDS, 6);
});

test("stable recovery holds 6s evidence through safe full-segment cadence valleys", () => {
  const state = policy.createState();
  state.lastStallAt = 1000;
  const cadence = [5.9, 6.5];
  let result;
  for (let sample = 1; sample <= 60; sample += 1) {
    result = recoverySample(state, 1.55, cadence[(sample - 1) % cadence.length], 1000 + sample * 1000);
    if (sample < 60) assert.equal(result.path, "");
  }
  assert.equal(state.stableRecoverySamples, 30);
  assert.equal(result.path, "stable");
});

test("WN-NEW-04: sparse 7s samples separated by prolonged valleys do not recover", () => {
  const state = policy.createState();
  state.lastStallAt = 1000;
  const sparse = [4.1, 4.3, 4.6, 7.1];
  let result;
  for (let sample = 1; sample <= 120; sample += 1) {
    result = recoverySample(state, 1.55, sparse[(sample - 1) % sparse.length], 1000 + sample * 1000);
  }
  assert.equal(result.path, "");
  assert.ok(state.stableRecoverySamples < policy.constants.STABLE_RECOVERY_SAMPLES);
});

test("stable recovery evidence hold has exact 3000ms boundary", () => {
  for (const [gap, expectedSamples] of [[2999, 1], [3000, 1], [3001, 0]]) {
    const state = policy.createState();
    recoverySample(state, 1.55, 7.1, 1000);
    recoverySample(state, 1.55, 5.9, 1000 + gap);
    assert.equal(state.stableRecoverySamples, expectedSamples, `${gap}ms evidence hold`);
  }
});

test("stable recovery still rejects only 4.5s to 5.5s of buffer", () => {
  const state = policy.createState();
  for (let sample = 1; sample <= 60; sample += 1) {
    const bufferAhead = 4.5 + (sample % 11) / 10;
    assert.equal(recoverySample(state, 1.55, bufferAhead, sample * 1000).path, "");
  }
  assert.equal(state.stableRecoverySamples, 0);
});

test("intermittent network errors cannot be hidden by successful fragments", () => {
  const state = policy.createState();
  for (let second = 1; second <= 60; second += 1) {
    const now = second * 1000;
    if (second % 3 === 1) policy.markNetworkError(state, now);
    const result = recoverySample(state, 2, 8, now, true);
    assert.equal(result.path, "");
  }
  assert.equal(state.lastNetworkErrorAt, 58000);
});

test("a successful fragment does not bypass the fast network-error quiet window", () => {
  const state = policy.createState();
  policy.markNetworkError(state, 1000);
  for (let now = 2000; now < 16000; now += 1000) {
    assert.equal(recoverySample(state, 2, 8, now, true).path, "");
  }
  let result;
  for (let now = 16000; now <= 21000; now += 1000) {
    result = recoverySample(state, 2, 8, now, true);
  }
  assert.equal(result.path, "fast");
  assert.equal(state.lastNetworkErrorAt, 1000);
});

test("stable recovery requires its full 30-second network-error quiet window", () => {
  const state = policy.createState();
  policy.markNetworkError(state, 1000);
  for (let now = 2000; now < 31000; now += 1000) {
    assert.equal(recoverySample(state, 1.55, 7.5, now, true).path, "");
  }
  const result = recoverySample(state, 1.55, 7.5, 31000, true);
  assert.equal(result.path, "stable");
});

test("low-buffer samples remain diagnostics-only", () => {
  assert.match(appSource, /Diagnostic-only; does not directly trigger weak-network transitions\./);
  assert.doesNotMatch(appSource, /if\s*\([^)]*hlsLowBufferSamples/s);
});

test("V5: exact normal and classified weak profiles separate latency from buffer", () => {
  assert.deepEqual(policy.profileFor(false), {
    lowLatencyMode: true, targetLatency: 6, liveMaxLatencyDuration: 18,
    maxBufferLength: 10, maxMaxBufferLength: 15, maxLiveSyncPlaybackRate: 1.05
  });
  for (const kind of ["bandwidth-loss", "rtt"]) {
    assert.deepEqual(policy.profileFor(kind), {
      lowLatencyMode: kind !== "rtt", targetLatency: 12, liveMaxLatencyDuration: 24,
      maxBufferLength: 16, maxMaxBufferLength: 24, maxLiveSyncPlaybackRate: 1,
      minActualForwardBuffer: 8, bufferReadyLowWatermark: 6
    });
  }
});

test("V5: actual readiness uses exact 8/6 hysteresis, never latency or seek success", () => {
  const state = policy.createState();
  policy.markWeakEntry(state, 1000, "test", "bandwidth-loss");
  for (const [buffer, ready] of [[5.5, false], [7.9, false], [8, true], [7.9, true], [6, true], [5.999, false]]) {
    assert.equal(policy.sampleBufferReadiness(state, buffer), ready, `buffer=${buffer}`);
  }
  policy.markWeakRecovery(state, "fast");
  assert.equal(state.weakNetworkClass, "");
  assert.equal(state.weakBufferReady, false);
});

test("V5: safe point uses real buffer end and preserves every seek boundary", () => {
  const pick = (ranges, current, sync) => policy.weakSafePoint(ranges, current, sync, 1.5, 6);
  assert.equal(pick([{ start: 90, end: 109 }], 105, 103), 101);
  assert.equal(pick([{ start: 90, end: 112 }], 105, 100), 100);
  assert.equal(pick([{ start: 90, end: 106 }], 105, 103), null, "requires >6s backtrack");
  assert.equal(pick([{ start: 90, end: 98 }, { start: 102, end: 109 }], 105, 103), null);
  assert.equal(pick([{ start: 102, end: 109 }], 105, 101), null);
  assert.equal(pick([{ start: 90, end: 120 }], 105, 107), null, "already deep: no forward seek");
  assert.equal(pick([{ start: 90, end: 111.6 }], 105, 104), null, "below min backtrack");
});

function trend(state, now, bufferAhead, bandwidthRatio = 1.1, extra = {}) {
  return policy.sampleNetworkTrend(state, { now, bufferAhead, bandwidthRatio, ...extra });
}

test("V5: three valid drain slopes protect before the old six-second confirmation", () => {
  const state = policy.createState();
  const buffers = [5.5, 4.9, 4.3, 3.7];
  buffers.forEach((buffer, i) => {
    const result = trend(state, 1000 + i * 1000, buffer);
    assert.equal(result, i === 3 ? "bandwidth-loss" : "");
  });
  assert.ok(state.bufferSlope < -0.25);
});

test("V5: severe starvation has a short evidence window but startup/healthy stalls do not enter", () => {
  for (const ratio of [1.1, 3]) {
    const state = policy.createState();
    assert.equal(trend(state, 1000, 1, ratio), "");
    assert.equal(trend(state, 2000, 1, ratio), "");
    assert.equal(trend(state, 3000, 1, ratio), ratio === 1.1 ? "bandwidth-loss" : "");
  }
  const state = policy.createState();
  policy.markNetworkError(state, 1000);
  trend(state, 1000, 1, 3); trend(state, 2000, 1, 3);
  assert.equal(trend(state, 3000, 1, 3), "bandwidth-loss");
});

test("V5: timer jumps, pauses and seeks discard drain evidence", () => {
  for (const extra of [{ paused: true }, { seeking: true }, {}]) {
    const state = policy.createState();
    trend(state, 1000, 5.5); trend(state, 2000, 4.9); trend(state, 3000, 4.3);
    assert.equal(trend(state, Object.keys(extra).length ? 4000 : 30000, 3.7, 1.1, extra), "");
    assert.equal(state.bufferDrainSamples, 0);
    assert.equal(state.bufferSlope, null);
  }
});

function overhead(state, now, ms, bufferAhead = 5, bandwidthRatio = 2) {
  return policy.sampleRequestOverhead(state, { now, requestOverheadMs: ms, bufferAhead, bandwidthRatio });
}

function baseline(state) {
  for (let i = 1; i <= 4; i += 1) assert.equal(overhead(state, i * 1000, 50, 6), "");
}

test("V5: RTT needs a healthy baseline, four deteriorated requests and buffer pressure", () => {
  const state = policy.createState(); baseline(state);
  assert.equal(state.requestOverheadBaselineMs, 50);
  for (let i = 1; i <= 4; i += 1) {
    assert.equal(overhead(state, 4000 + i * 1000, 350), i === 4 ? "rtt" : "");
  }
  const noBaseline = policy.createState();
  for (let i = 1; i <= 20; i += 1) assert.equal(overhead(noBaseline, i * 1000, 1000, 2), "");
});

test("V5: healthy buffer, blocking-wait baseline, errors or insufficient headroom cannot become RTT", () => {
  for (const kind of ["buffer", "blocking", "loss", "bandwidth"]) {
    const state = policy.createState();
    if (kind === "blocking") {
      for (let i = 1; i <= 4; i += 1) overhead(state, i * 1000, 900, 6);
    } else baseline(state);
    if (kind === "loss") policy.markNetworkError(state, 4500);
    for (let i = 1; i <= 10; i += 1) {
      assert.equal(overhead(state, 4000 + i * 1000, kind === "blocking" ? 950 : 350,
        kind === "buffer" ? 8 : 3, kind === "bandwidth" ? 1.1 : 2), "");
    }
  }
});

test("V5: deterministic downloaded-minus-played dynamics never invent buffer capacity", () => {
  for (const sustained of [false, true]) {
    const state = policy.createState(); let buffer = 5.5; let enteredAt = 0; let readyAt = 0;
    trend(state, 1000, buffer);
    for (let second = 1; second <= 40; second += 1) {
      const downloaded = sustained || second < 5 ? 0.4 : 1.8;
      buffer = Math.max(0, buffer + downloaded - 1);
      const kind = trend(state, (second + 1) * 1000, buffer, downloaded);
      if (!enteredAt && kind) {
        enteredAt = second; policy.markWeakEntry(state, (second + 1) * 1000, "drain", kind);
      }
      if (enteredAt && policy.sampleBufferReadiness(state, buffer) && !readyAt) readyAt = second;
      if (buffer < 8 && !readyAt) assert.equal(state.weakBufferReady, false);
    }
    assert.equal(enteredAt, 3);
    if (sustained) { assert.equal(buffer, 0); assert.equal(readyAt, 0); }
    else { assert.ok(buffer >= 8); assert.ok(readyAt > enteredAt); }
  }
});
