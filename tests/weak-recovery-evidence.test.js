"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
// Replay the real application through the existing deterministic media harness.
// An external baseline root is used only by the red-to-green audit runner.
const root = process.env.WEAK_REPAIR_BASELINE || path.resolve(__dirname, "..");
const filename = path.join(root, "tests/player-lifecycle.test.js");
const mod = new Module(filename, module);
mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
const requireOriginal = mod.require.bind(mod);
mod.require = id => id === "node:test" ? () => {} : requireOriginal(id);
mod._compile(fs.readFileSync(filename, "utf8").replace("performance: { now: () => 0 }", "performance: { now: () => now }") +
  "\nmodule.exports = { runningHls, makeHarness };", filename);
const { runningHls } = mod.exports;
const policy = require(path.join(root, "web/hls-weak-network-policy.js"));
const net = h => h.windowTarget.__livePlayer.network;
let sn = 0;
function media(h, overhead = 50, extra = {}) {
  const stats = { loaded: 1000000, retry: 0, aborted: false,
    loading: { start: 100, first: 100 + overhead, end: 300 + overhead } };
  h.instance.emit(h.MockHls.Events.FRAG_LOADED, { part: null,
    frag: { type: "main", level: 0, cc: 0, sn: ++sn, duration: 2, stats, ...extra } });
}
function step(h, overhead = 50) {
  h.video.currentTime += 1;
  media(h, overhead); h.tick();
}
function rtt() {
  const h = runningHls(); h.ahead(5.5);
  for (let i = 0; i < 4; i++) { h.tick(); media(h, 50); }
  h.ahead(4.5);
  for (let i = 0; i < 4; i++) { h.tick(); media(h, 350); }
  assert.equal(net(h).hlsWeakNetworkClass, "rtt");
  return h;
}
function nearExit() {
  const h = runningHls(); h.ahead(8.5);
  h.instance.emit(h.MockHls.Events.ERROR, { type: "networkError", details: "fragLoadError", fatal: true });
  for (let i = 0; i < 70 && net(h).hlsFastRecoverySamples < 19; i++) step(h);
  assert.equal(net(h).hlsWeakNetworkMode, true);
  assert.equal(net(h).hlsFastRecoverySamples, 19);
  return h;
}
function eventually(h, overhead = 50) {
  for (let i = 0; i < 100 && net(h).hlsWeakNetworkMode; i++) step(h, overhead);
  assert.equal(net(h).hlsWeakNetworkMode, false, "fresh comparable media must eventually recover");
}
test("A1: sustained 900ms whole requests cannot exit RTT or contaminate 50ms reference", () => {
  const h = rtt(); h.ahead(8.5);
  for (let i = 0; i < 60; i++) step(h, 900);
  assert.equal(net(h).hlsWeakNetworkMode, true);
  assert.equal(net(h).hlsRequestOverheadBaselineMs, 50);
});
for (const [ratio, expected] of [[2, "fast"], [1.55, "stable"]]) {
  test(`A2: comparable fresh improvement permits bounded ${expected} exit and preserves baseline`, () => {
    const h = rtt(); h.ahead(8.5); h.instance.bandwidthEstimate = ratio * 4000000;
    for (let i = 0; i < 40; i++) step(h, 900);
    assert.equal(net(h).hlsWeakNetworkMode, true);
    eventually(h);
    assert.equal(net(h).hlsWeakRecoveryPath, expected);
    assert.equal(net(h).hlsRequestOverheadBaselineMs, 50);
    for (let i = 0; i < 12; i++) step(h, 900);
    assert.equal(net(h).hlsRequestOverheadBaselineMs, 50);
  });
}
test("B1: 19 healthy samples and a 301s observation gap cannot be continuous recovery", () => {
  const h = nearExit(); h.advanceTime(300000); h.tick();
  assert.equal(net(h).hlsWeakNetworkMode, true);
  assert.equal(net(h).hlsFastRecoverySamples, 0);
  eventually(h);
});
test("B3/B4: offline without HLS ERROR vetoes exit; online needs new media and motion", () => {
  const h = nearExit(); h.context.navigator.onLine = false; h.windowTarget.dispatchEvent("offline");
  assert.equal(net(h).hlsFastRecoverySamples, 0);
  h.tick(); assert.equal(net(h).hlsWeakNetworkMode, true);
  h.context.navigator.onLine = true; h.windowTarget.dispatchEvent("online");
  for (let i = 0; i < 40; i++) h.tick();
  assert.equal(net(h).hlsWeakNetworkMode, true);
  assert.equal(net(h).hlsFastRecoverySamples, 0);
  eventually(h);
});
for (const event of ["pause", "seeking"]) {
  test(`B5: ${event} invalidates near-exit credit without spending another backtrack`, () => {
    const h = nearExit(); const spent = net(h).hlsLastWeakSafePointAt;
    h.video[event === "pause" ? "paused" : "seeking"] = true;
    h.video.dispatchEvent(event);
    assert.equal(net(h).hlsFastRecoverySamples, 0);
    h.advanceTime(300000); h.tick();
    h.video.paused = false; h.video.seeking = false;
    h.video.dispatchEvent(event === "pause" ? "play" : "seeked");
    for (let i = 0; i < 30; i++) h.tick();
    assert.equal(net(h).hlsWeakNetworkMode, true);
    assert.equal(net(h).hlsLastWeakSafePointAt, spent);
    eventually(h);
  });
}
test("A3: part/whole, init, retries and a destroyed owner cannot prove RTT recovery", () => {
  const h = rtt(); h.ahead(8.5);
  for (let i = 0; i < 50; i++) {
    h.instance.emit(h.MockHls.Events.FRAG_LOADED, { frag: { type: "main", sn: ++sn, level: 0, cc: 0 },
      part: { duration: 1, stats: { loaded: 500000, loading: { start: 100, first: 1150, end: 1400 } } } });
    media(h, 50, { sn: "initSegment" }); h.tick();
  }
  assert.equal(net(h).hlsWeakNetworkMode, true);
  const old = h.instance.handlers.get(h.MockHls.Events.FRAG_LOADED)[0];
  h.windowTarget.__livePlayer.hls();
  old("fragLoaded", { frag: { type: "main", sn: ++sn, duration: 2, stats: { loaded: 1, loading: { start: 1, first: 50, end: 100 } } } });
  assert.equal(net(h).hlsRequestOverheadBaselineMs, null);
});
test("N1: healthy 120 ticks retain normal profile and add no media recovery operations", () => {
  const h = runningHls(); let starts = 0, loads = 0;
  h.instance.startLoad = () => starts++; h.instance.loadSource = () => loads++;
  for (let i = 0; i < 120; i++) step(h);
  assert.equal(net(h).hlsWeakNetworkMode, false);
  assert.equal(h.instance.config.liveSyncDuration, 6);
  assert.equal(h.video.currentTime, 225);
  assert.equal(starts, 0); assert.equal(loads, 0);
  assert.equal(h.instance.destroyed, false);
});

function healthy(state, now, ratio = 2, bufferAhead = 8.5, duration = 2, transfer = true) {
  if (!state.recoveryMotion) state.recoveryMotion = { time: now / 1000 - 1, end: now / 1000 + bufferAhead - 1 };
  if (transfer) policy.noteMediaTransfer(state, { now, duration });
  return policy.sampleRecovery(state, { now, bandwidthRatio: ratio, bufferAhead,
    noRecentNetworkErrors: true, currentTime: now / 1000, bufferEnd: now / 1000 + bufferAhead });
}
test("B6: zero is valid; duplicates/sub-tick calls cannot inflate samples; invalid/backward clocks reset", () => {
  const s = policy.createState();
  assert.equal(healthy(s, 0).fastSamples, 1);
  for (let i = 0; i < 30; i++) assert.equal(healthy(s, 0).fastSamples, 1);
  assert.equal(healthy(s, 499).fastSamples, 1);
  assert.equal(healthy(s, 1000).fastSamples, 2);
  assert.equal(healthy(s, 900).fastSamples, 0);
  for (const now of [NaN, Infinity, -Infinity, -1, null, undefined]) {
    const state = policy.createState(); for (let i = 0; i < 19; i++) healthy(state, i * 1000);
    assert.equal(healthy(state, now).path, ""); assert.equal(state.fastRecoverySamples, 0);
  }
  const zeroError = policy.createState(); policy.markNetworkError(zeroError, 0);
  assert.equal(healthy(zeroError, 14000).networkQuietFor, 14000);
});
test("B2/N3: stable continuity keeps the 3s sawtooth hold but rejects a 301s gap", () => {
  const s = policy.createState(); let result;
  for (let i = 1; i <= 29; i++) healthy(s, i * 1000, 1.55);
  assert.equal(s.stableRecoverySamples, 29);
  assert.equal(healthy(s, 330000, 1.55, 8.5, 2, false).path, "");
  assert.equal(s.stableRecoverySamples, 0);
  for (let i = 331; i < 400 && !result?.path; i++) result = healthy(s, i * 1000, 1.55);
  assert.equal(result.path, "stable");
  for (const gap of [2999, 3000, 3001]) {
    const h = policy.createState(); healthy(h, 1000, 1.55, 7.5);
    healthy(h, 1000 + gap, 1.55, 5.9);
    assert.equal(h.stableRecoverySamples, gap <= 3000 ? 1 : 0);
  }
});
for (const duration of [2, 6, 8]) {
  test(`N3: ${duration}s segment cadence supplies fresh media without a new request each monitor tick`, () => {
    const s = policy.createState(); let result;
    for (let i = 0; i < 60 && !result?.path; i++) result = healthy(s, i * 1000, 1.55, i % 2 ? 6.5 : 8.5,
      duration, i % duration === 0);
    assert.equal(result.path, "stable");
    assert.ok(s.mediaTransferSerial <= 30, "at most one transfer per two monitor ticks");
  });
}
test("C5/C10: stale high bandwidth plus one physical stall is unknown, and audio cannot wash video freshness", () => {
  const h = runningHls(); media(h); h.instance.bandwidthEstimate = 100000000;
  for (let i = 0; i < 12; i++) h.tick();
  h.ahead(0); h.video.readyState = 2; h.video.dispatchEvent("waiting");
  for (let i = 0; i < 25; i++) { media(h, 50, { type: "audio" }); h.tick(); }
  assert.equal(net(h).hlsMediaEvidenceFresh, false); assert.equal(net(h).hlsLastBandwidthRatio, null);
  assert.equal(net(h).hlsRecentStallIncidents, 1); assert.equal(net(h).hlsWeakNetworkMode, false);
});
test("A3: aborted/retried/duplicate and wrong-level events cannot refresh recovery facts", () => {
  const h = rtt(); h.ahead(8.5); h.instance.currentLevel = 0;
  for (let i = 0; i < 40; i++) {
    for (const flags of [{ aborted: true }, { retry: 1 }]) media(h, 50, { stats: { loaded: 1, ...flags, loading: { start: 1, first: 51, end: 100 } } });
    media(h, 50, { level: 1 }); h.tick();
  }
  assert.equal(net(h).hlsWeakNetworkMode, true); assert.equal(net(h).hlsRttRecoverySamples, 0);
  assert.equal(net(h).hlsMediaEvidenceFresh, false);
  eventually(h);
});
test("A4: stream/level/shape and expired references cannot cross contexts; new generation rebuilds", () => {
  const s = policy.createState();
  const fact = (now, ms, requestKind = "whole", requestScope = "0/0") => policy.sampleRequestOverhead(s,
    { now, requestOverheadMs: ms, requestKind, requestScope, bufferAhead: 5, bandwidthRatio: 2, duration: 2 });
  for (let i = 0; i < 4; i++) fact(i * 1000, 50);
  assert.equal(s.requestOverheadBaselineMs, 50);
  fact(4000, 900, "part"); assert.equal(s.requestOverheadBaselineMs, null);
  fact(5000, 50); assert.equal(s.requestOverheadBaselineMs, 50);
  fact(6000, 900, "whole", "1/0"); assert.equal(s.requestOverheadBaselineMs, null);
  for (let i = 7; i < 11; i++) fact(i * 1000, 50, "whole", "1/0");
  assert.notEqual(s.requestOverheadBaselineMs, null);
  fact(400000, 900, "whole", "1/0"); assert.equal(s.requestOverheadBaselineMs, null);
  const h = rtt(); h.windowTarget.__livePlayer.hls();
  assert.equal(net(h).hlsRequestOverheadBaselineMs, null); assert.equal(net(h).hlsWeakNetworkMode, false);
});
test("B5: invalidation preserves a spent safe-point budget across offline/pause/seek", () => {
  const h = runningHls(); h.ahead(5.5); h.instance.liveSyncPosition = 100;
  h.instance.emit(h.MockHls.Events.ERROR, { type: "networkError", details: "fragLoadError", fatal: true });
  const action = h.scheduledTimeouts.findLast(t => t.delay === 0 && h.timeouts.has(t.id));
  h.timeouts.delete(action.id); action.callback(); assert.equal(h.video.currentTime, 100);
  const spent = net(h).hlsLastWeakSafePointAt;
  h.instance.liveSyncPosition = 95;
  for (const e of ["offline", "online"]) h.windowTarget.dispatchEvent(e);
  for (const e of ["pause", "play", "seeking", "seeked"]) h.video.dispatchEvent(e);
  for (let i = 0; i < 30; i++) h.tick();
  assert.equal(net(h).hlsLastWeakSafePointAt, spent); assert.equal(h.video.currentTime, 100);
});
test("B6: wall-clock changes cannot alter HLS monotonic recovery evidence", () => {
  const h = rtt(); h.ahead(8.5);
  h.context.Date = class extends Date { static now() { return -1000000000; } };
  for (let i = 0; i < 40; i++) step(h, 900);
  assert.equal(net(h).hlsWeakNetworkMode, true);
  h.context.Date = class extends Date { static now() { return Infinity; } };
  eventually(h); assert.equal(net(h).hlsWeakRecoveryPath, "fast");
});
test("S2/B6: a young monotonic clock does not postpone the first safe point or reset its spent budget", () => {
  const h = runningHls(); h.advanceTime(-99999); h.ahead(5.5); h.instance.liveSyncPosition = 100;
  h.instance.emit(h.MockHls.Events.ERROR, { type: "networkError", details: "fragLoadError", fatal: true });
  const action=h.scheduledTimeouts.findLast(t=>t.delay===0&&h.timeouts.has(t.id));
  h.timeouts.delete(action.id); action.callback();
  assert.equal(h.video.currentTime,100); assert.ok(net(h).hlsLastWeakSafePointAt>0);
  h.instance.liveSyncPosition=95; for(let i=0;i<40;i++)h.tick();
  assert.equal(h.video.currentTime,100);
});
test("C10/A4: audio-only MAIN cannot refresh video health; codec changes invalidate comparison", () => {
  const h=runningHls();
  h.instance.emit(h.MockHls.Events.MANIFEST_PARSED,{levels:[{audioCodec:"mp4a.40.2",bitrate:128000}]});
  for(let i=0;i<10;i++){media(h);h.tick();}
  assert.equal(net(h).hlsMediaEvidenceFresh,false);
  assert.equal(net(h).hlsRequestOverheadBaselineMs,null);
  h.instance.emit(h.MockHls.Events.MANIFEST_PARSED,{levels:[{videoCodec:"avc1.42E01E",bitrate:4000000}]});
  for(let i=0;i<4;i++){media(h);h.tick();}
  assert.equal(net(h).hlsRequestOverheadBaselineMs,50);
  h.instance.emit(h.MockHls.Events.MANIFEST_PARSED,{levels:[{videoCodec:"hvc1.1.6.L120.90",bitrate:4000000}]});
  media(h);
  assert.equal(net(h).hlsRequestOverheadBaselineMs,null);
});

function partFact(h, overhead) {
  const first=1100+overhead;
  h.instance.emit(h.MockHls.Events.FRAG_LOADED,{frag:{type:"main",level:0,cc:0,sn:++sn,duration:2},
    part:{duration:1,stats:{loaded:500000,retry:0,aborted:false,loading:{start:100,first,end:first+200}}}});
}
function requalHarness(kind) {
  let h;
  if(kind==="part"){
    h=runningHls();h.ahead(5.5);
    for(let i=0;i<4;i++){h.tick();partFact(h,50);}
    h.ahead(4.5);for(let i=0;i<4;i++){h.tick();partFact(h,350);}
    assert.equal(net(h).hlsWeakNetworkClass,"rtt");
  }else h=rtt();
  h.ahead(8.5);
  let extra={};
  const advance=ms=>{h.video.currentTime+=1;h.tick();media(h,ms,extra);};
  if(kind==="expired")for(let i=0;i<310;i++)advance(900);
  if(kind==="cc")extra={cc:1};
  if(kind==="level"){
    h.instance.levels=[{videoCodec:"avc1.42E01E"},{videoCodec:"avc1.42E01E"}];
    h.instance.currentLevel=1;h.instance.emit(h.MockHls.Events.LEVEL_SWITCHED,{level:1});extra={level:1};
  }
  if(kind==="pause"){
    h.video.paused=true;h.video.dispatchEvent("pause");h.advanceTime(301000);h.tick();
    h.video.paused=false;h.video.dispatchEvent("play");
  }
  return {h,advance};
}
for(const kind of ["expired","cc","level","part","pause"]){
  for(const [ratio,path] of [[2,"fast"],[1.55,"stable"]])test(`R2 ${kind}: same episode requalifies and exits through ${path}`,()=>{
    const {h,advance}=requalHarness(kind);h.instance.bandwidthEstimate=ratio*4000000;
    const owner=h.instance,episode=net(h).hlsWeakEnterTimestamp,budget=net(h).hlsLastWeakSafePointAt;
    for(let i=0;i<180&&net(h).hlsWeakNetworkMode;i++)advance(50);
    assert.equal(net(h).hlsWeakNetworkMode,false);
    assert.equal(net(h).hlsWeakRecoveryPath,path);
    assert.equal(h.instance,owner);assert.equal(h.MockHls.instances.length,1);
    assert.equal(net(h).hlsWeakEnterTimestamp,episode);
    assert.equal(net(h).hlsLastWeakSafePointAt,budget);
  });
  test(`R2 ${kind}: 900ms across multiple reference windows never self-certifies`,()=>{
    const {h,advance}=requalHarness(kind);
    for(let i=0;i<650;i++)advance(900);
    assert.equal(net(h).hlsWeakNetworkClass,"rtt");
    assert.notEqual(net(h).hlsRequestOverheadBaselineMs,900);
    assert.equal(net(h).hlsRttRecoverySamples,0);
    for(let i=0;i<180&&net(h).hlsWeakNetworkMode;i++)advance(50);
    assert.equal(net(h).hlsWeakNetworkMode,false);
  });
}
test("R2: candidate observations are separate from validation; bad evidence resets and a later window retries",()=>{
  const {h,advance}=requalHarness("cc");
  for(let i=0;i<7;i++)advance(50);
  assert.equal(net(h).hlsRequestOverheadBaselineMs,null);
  assert.equal(net(h).hlsWeakNetworkMode,true);
  advance(900);assert.equal(net(h).hlsRttRequalification,null);
  for(let i=0;i<7;i++)advance(50);
  h.advanceTime(31000);h.tick();assert.equal(net(h).hlsRttRequalification,null);
  for(let i=0;i<180&&net(h).hlsWeakNetworkMode;i++)advance(50);
  assert.equal(net(h).hlsWeakNetworkMode,false);
  h.ahead(4.5);for(let i=0;i<5;i++)advance(350);
  assert.equal(net(h).hlsWeakNetworkClass,"rtt","normal RTT entry remains active after requalification");
});
