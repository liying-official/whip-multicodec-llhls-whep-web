"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const policy = require("../web/hls-weak-network-policy.js");

function fixture(options = {}) {
  let now = 1000, next = 0, owner = true, xhr;
  const timers = new Map(), calls = [], transfers = [];
  let idle = 0;
  class XHR {
    constructor() { xhr = this; this.readyState = 0; this.status = 200; this.headers = {}; this.responseURL = "http://localhost/segment.mp4"; this.aborts = 0; }
    open(method, url, async) { this.opened = [method, url, async]; this.readyState = 1; }
    send() { if (options.synchronous) h.complete(); if (options.throwLoad) throw Error("fixture-send"); }
    abort() { this.aborts++; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    getAllResponseHeaders() { return "Age: 12\r\nContent-Length: 4096\r\n"; }
    getResponseHeader(k) { return k.toLowerCase() === "age" ? "12" : "4096"; }
  }
  const self = { XMLHttpRequest: XHR, performance: { now: () => now },
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 0; }, clearInterval() {} };
  if (options.browser) {
    self.location={href:"http://localhost/player"};
    self.MediaSource={isTypeSupported:()=>true};
  }
  const sandbox = { self, performance: self.performance, module: { exports: {} }, exports: {}, status: 0,
    console: { warn() {}, log() {}, error() {}, debug() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/hls.min.js"), "utf8"), sandbox);
  const Hls = sandbox.module.exports, Base = Hls.DefaultConfig.loader;
  const facts = { duration: 2, bufferAhead: 1, playing: true, published: true, needed: true };
  const observer = policy.createRequestObserver({ now: () => now, isCurrent: () => owner,
    isRelevant: context => context.frag.type === "main", mediaState: () => facts,
    activeRecovery: options.active === true, onTransfer: (context, at) => transfers.push(at), onIdle: () => idle++ });
  const Wrapped = observer.wrap(Base), loader = new Wrapped(Hls.DefaultConfig);
  const frag = { type: "main", sn: 1, level: 0, cc: 0, duration: 2, start: 5, stats: loader.stats };
  const context = { frag, part: null, responseType: "arraybuffer", url: "http://localhost/segment.mp4",
    headers: { "X-Fixture": "same" }, rangeStart: 0, rangeEnd: 4096, ...options.context };
  const config = { loadPolicy: { maxTimeToFirstByteMs: 12000, maxLoadTimeMs: 120000,
    timeoutRetry: null, errorRetry: options.retry ? { maxNumRetry: 1, retryDelayMs: 100, maxRetryDelayMs: 100 } : null }, timeout: 12000 };
  const callbacks = {};
  for (const kind of ["Success", "Error", "Timeout", "Abort"]) callbacks["on" + kind] = (...args) => {
    calls.push({ kind, args }); if (options.replaceOnAbort && kind === "Abort") owner = false;
  };
  if (options.progress) callbacks.onProgress = (...args) => calls.push({ kind: "Progress", args });
  const h = { Hls, Base, Wrapped, observer, loader, frag, context, config, calls, facts, transfers, timers, self,
    now: () => now, xhr: () => xhr, idle: () => idle, stale: () => { owner = false; },
    load: () => loader.load(context, config, callbacks),
    headers() { now += 100; xhr.readyState = 2; xhr.onreadystatechange(); },
    progress(bytes) { now += 100; xhr.onprogress({ loaded: bytes, lengthComputable: true, total: 4096 }); observer.poll(); },
    advance(ms, runTimers = false) {
      now += ms;
      if (runTimers) for (const [id, t] of [...timers]) if (t.due <= now) { timers.delete(id); t.fn(); }
      return observer.poll();
    },
    complete(status = 200) { now += 100; xhr.status = status; xhr.readyState = 4; xhr.response = new ArrayBuffer(4096); xhr.onreadystatechange(); }
  };
  return h;
}

test("C1: actual vendored XHR exposes body idle but default observer preserves native deadline", () => {
  const h = fixture(); h.load(); h.headers(); h.progress(1024);
  const row = h.advance(20000)[0];
  assert.equal(h.Hls.version, "1.7.3");
  assert.equal(row.bodyIdleCandidate, true); assert.equal(row.bytes, 1024);
  assert.equal(row.progressCertainty, "event-limited");
  assert.equal(h.calls.length, 0); assert.equal(h.xhr().aborts, 0);
  assert.equal(h.observer.snapshot().activeRecoveryEnabled, false);
  assert.equal(h.config.loadPolicy.maxLoadTimeMs, 120000);
  h.loader.destroy(); assert.equal(h.timers.size, 0); assert.equal(h.observer.snapshot().active, 0);
});
test("C2: continuously visible slow bytes never become body idle", () => {
  const h = fixture({ active: true }); h.load(); h.headers();
  for (let i = 1; i <= 25; i++) { h.advance(1000); h.progress(i * 100); }
  assert.equal(h.idle(), 0); assert.equal(h.xhr().aborts, 0);
  h.complete(); assert.equal(h.calls.filter(c => c.kind === "Success").length, 1);
});
for (const kind of ["playlist", "part", "unpublished", "init", "audio", "append", "paused", "not-needed", "invalid-duration"]) {
  test(`C3/C7/C10: ${kind} cannot receive media body-idle cancellation`, () => {
    const h = fixture({ active: true });
    if (kind === "playlist") delete h.context.frag;
    if (kind === "part") h.context.part = { duration: 1 };
    if (kind === "init") h.frag.sn = "initSegment";
    if (kind === "audio") h.frag.type = "audio";
    if (kind === "unpublished") h.facts.published = false;
    if (kind === "paused") h.facts.playing = false;
    if (kind === "not-needed") h.facts.needed = false;
    if (kind === "invalid-duration") h.facts.duration = NaN;
    h.load(); h.headers(); h.progress(1024);
    if (kind === "append") h.complete();
    h.advance(20000); assert.equal(h.idle(), 0); assert.equal(h.xhr().aborts, 0);
    h.loader.destroy(); assert.equal(h.timers.size, 0);
  });
}
test("C4: no progress events and cache/synchronous completion remain unknown, no callback added", () => {
  const h = fixture(); h.load(); h.headers();
  assert.equal(h.loader.callbacks.onProgress, undefined);
  const row = h.advance(20000)[0];
  assert.equal(row.bytes, 0); assert.equal(row.bodyIdleCandidate, false);
  assert.equal(h.loader.getCacheAge(), 12);
  h.complete(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].kind, "Success");
  const sync = fixture({ synchronous: true }); sync.load();
  assert.equal(sync.calls.length, 1); assert.equal(sync.observer.snapshot().active, 0);
});
test("C4 release gate: event coalescing can mimic body idle even when the wire is progressing", () => {
  const h = fixture(); h.load(); h.headers(); h.progress(1024);
  // Real bytes may be withheld from XHR ProgressEvents by the browser. The
  // adapter cannot distinguish that trace from stopped TCP delivery.
  const row = h.advance(9000)[0];
  assert.equal(row.bodyIdleCandidate, true);
  assert.equal(row.progressCertainty, "event-limited");
  assert.equal(h.idle(), 0); assert.equal(h.xhr().aborts, 0);
  h.progress(4096); h.complete(); assert.equal(h.calls[0].kind, "Success");
});
test("C6/C8: opt-in owned abort has one terminal callback; native timeout cannot double-complete", () => {
  const h = fixture({ active: true }); h.load(); h.headers(); h.progress(1024);
  const timeout = [...h.timers.values()][0].fn;
  h.advance(9000); assert.equal(h.idle(), 1); assert.equal(h.xhr().aborts, 1);
  timeout(); h.loader.abort(); h.loader.destroy();
  assert.deepEqual(h.calls.map(c => c.kind), ["Abort"]);
  assert.equal(h.timers.size, 0); assert.equal(h.observer.snapshot().active, 0);
});
test("C8: synchronous abort reentrancy replaces owner before recovery hook", () => {
  const h = fixture({ active: true, replaceOnAbort: true }); h.load(); h.headers(); h.progress(1024); h.advance(9000);
  assert.equal(h.calls[0].kind, "Abort"); assert.equal(h.idle(), 0);
});
test("C8: late callbacks and destroy/throw/reuse do not leak observations", () => {
  const h = fixture(); h.load(); const late = h.loader.callbacks.onSuccess;
  h.loader.destroy(); late({}, {}, h.context, h.xhr());
  assert.equal(h.calls.length, 0); assert.equal(h.observer.snapshot().active, 0);
  const throwing = fixture({ throwLoad: true }); assert.throws(() => throwing.load(), /fixture-send/);
  throwing.loader.destroy(); assert.equal(throwing.timers.size, 0);
  const reuse = fixture(); reuse.load(); assert.throws(() => reuse.load(), /only be used once/);
  reuse.loader.destroy(); assert.equal(reuse.observer.snapshot().active, 0);
});
test("C8: retry resets attempt/bytes/idle ownership and preserves native retry", () => {
  const h = fixture({ retry: true, active: true }); h.load(); h.headers(); h.progress(1024); h.complete(503);
  h.advance(100, true); const row = h.observer.poll()[0];
  assert.equal(row.attempt, 2); assert.equal(row.bytes, 0); assert.equal(row.idleMs, null);
  h.headers(); h.progress(2048); h.complete();
  assert.deepEqual(h.calls.map(c => c.kind), ["Success"]); assert.equal(h.idle(), 0);
});
test("C9: replacement epoch discards old callbacks and cannot refresh new media evidence", () => {
  const h = fixture({ active: true }); h.load(); h.headers(); h.progress(1024);
  const count = h.transfers.length; h.observer.invalidate(); h.stale(); h.advance(20000); h.complete();
  assert.equal(h.transfers.length, count); assert.equal(h.calls.length, 0); assert.equal(h.idle(), 0);
  h.loader.destroy(); assert.equal(h.timers.size, 0);
});

test("R1: a statistics reset cannot swallow a still-owned transport completion", () => {
  const h=fixture();h.load();h.headers();h.progress(1024);
  const count=h.transfers.length;h.observer.invalidate();h.complete();
  assert.deepEqual(h.calls.map(c=>c.kind),["Success"]);
  assert.equal(h.transfers.length,count,"old observation must not renew the new epoch");
  assert.equal(h.observer.accepts(h.loader.stats,h.frag,null),false);
  h.loader.destroy();assert.equal(h.timers.size,0);
});

// Real Hls constructor/controllers/event ordering with simulated XHR/media.
// MSE attachment is intentionally absent; actual decoding is a browser gate.
function realAppHarness(sourceRoot=path.resolve(__dirname,"..")) {
  const Module=require("node:module"),real=fixture({browser:true});
  const filename=path.join(sourceRoot,"tests/player-lifecycle.test.js"),m=new Module(filename,module);
  m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  const req=m.require.bind(m);m.require=id=>id==="node:test"?()=>{}:id==="real-Hls"?real.Hls:req(id);
  let source=fs.readFileSync(filename,"utf8");
  const a=source.indexOf("  class MockHls {"),b=source.indexOf("  const windowTarget",a);
  assert.ok(a>=0&&b>a);
  source=source.slice(0,a)+`  class MockHls extends require('real-Hls') {
    static instances=[];
    static isMSESupported(){return true;}
    static isSupported(){return true;}
    constructor(config){super({...config,enableWorker:false,autoStartLoad:false});MockHls.instances.push(this);}
    attachMedia(){}
  }
`+source.slice(b);
  m._compile(source+"\nmodule.exports={makeHarness};",filename);
  const h=m.exports.makeHarness();h.windowTarget.__livePlayer.hls();
  const instance=h.MockHls.instances.at(-1),events=[];
  for(const event of [real.Hls.Events.MANIFEST_LOADING,real.Hls.Events.MANIFEST_LOADED,real.Hls.Events.MANIFEST_PARSED,real.Hls.Events.ERROR]){
    instance.on(event,(_event,data)=>events.push({event,details:data?.details}));
  }
  const complete=(code=200)=>{
    real.xhr().responseText='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.42E01E"\nvideo.m3u8\n';
    real.headers();real.complete(code);
  };
  const reload=(fatal=true)=>{
    h.video.readyState=2;h.video.paused=false;h.video.currentTime=105;
    h.video.buffered={length:0,start:()=>0,end:()=>0};
    const previous=real.xhr();
    instance.trigger(real.Hls.Events.ERROR,{type:"networkError",details:fatal?"manifestLoadTimeOut":"playlistUnchangedError",fatal});
    const queued=h.scheduledTimeouts.findLast(t=>h.timeouts.has(t.id)&&(t.delay===250||t.delay>=750&&t.delay<8250));
    assert.ok(queued,"actual application recovery backoff missing");h.timeouts.delete(queued.id);queued.callback();
    const rebootstrap=h.scheduledTimeouts.findLast(t=>h.timeouts.has(t.id)&&t.delay===2500);
    assert.ok(rebootstrap,"actual starved-buffer source reload missing");h.timeouts.delete(rebootstrap.id);rebootstrap.callback();
    assert.notEqual(real.xhr(),previous,"actual native manifest XHR missing");
    return real.xhr();
  };
  return {h,instance,real,events,complete,reload,
    loaded:()=>events.filter(e=>e.event===real.Hls.Events.MANIFEST_LOADED).length,
    close:()=>h.windowTarget.dispatchEvent("beforeunload")};
}

test("R1: real Hls receives initial and two same-instance recovery-queue manifest completions", () => {
  const f=realAppHarness();f.complete();assert.equal(f.loaded(),1);
  for(let i=0;i<2;i++){f.reload();f.complete();assert.equal(f.loaded(),i+2);assert.equal(f.h.MockHls.instances.length,1);}
  f.close();assert.equal(f.real.timers.size,0);
});

test("R1/SE14: repeated real playlist errors cannot postpone the owned starvation deadline",()=>{
  const f=realAppHarness();f.complete();const h=f.h;
  h.video.readyState=2;h.video.paused=false;h.video.currentTime=105;
  h.video.buffered={length:0,start:()=>0,end:()=>0};
  let deadline;
  for(let i=0;i<3;i++){
    f.instance.trigger(f.real.Hls.Events.ERROR,{type:'networkError',details:'playlistUnchangedError',fatal:false});
    const queued=h.scheduledTimeouts.findLast(t=>h.timeouts.has(t.id)&&t.delay===250);
    assert.ok(queued);h.timeouts.delete(queued.id);queued.callback();
    deadline ||= h.scheduledTimeouts.findLast(t=>h.timeouts.has(t.id)&&t.delay===2500);
    h.advanceTime(i<2?1000:500);
  }
  assert.ok(deadline);h.timeouts.delete(deadline.id);deadline.callback();
  assert.equal(f.events.filter(e=>e.event===f.real.Hls.Events.MANIFEST_LOADING).length,1,
    'the first 2.5s starvation confirmation must remain effective during repeated errors');
  f.complete();assert.equal(f.loaded(),2);
  deadline.callback();assert.equal(f.loaded(),2);
  assert.equal(f.events.filter(e=>e.event===f.real.Hls.Events.MANIFEST_LOADING).length,1);
  assert.equal(h.scheduledTimeouts.filter(t=>t.delay===2500&&h.timeouts.has(t.id)).length,0);
  f.close();assert.equal(f.real.timers.size,0);
});

for(const kind of ["error","timeout"])test(`R1: current reload ${kind} reaches real Hls after native retry exhaustion`,()=>{
  const f=realAppHarness();f.complete();f.reload();
  const before=f.events.length;
  const policy=f.instance.config.manifestLoadPolicy.default;
  const retries=(kind==="error"?policy.errorRetry:policy.timeoutRetry).maxNumRetry;
  for(let i=0;i<2*(retries+1)+1&&!f.events.slice(before).some(e=>e.event===f.real.Hls.Events.ERROR);i++){
    if(kind==="error")f.complete(503);
    if(!f.events.slice(before).some(e=>e.event===f.real.Hls.Events.ERROR)){
      const due=Math.min(...[...f.real.timers.values()].map(t=>t.due));
      assert.ok(Number.isFinite(due),"native retry/deadline timer missing");
      f.real.advance(Math.max(0,due-f.real.now())+1,true);
    }
  }
  const errors=f.events.slice(before).filter(e=>e.event===f.real.Hls.Events.ERROR);
  assert.ok(errors.some(e=>/manifestLoad/.test(e.details)),JSON.stringify(errors));
  assert.equal(errors.filter(e=>/manifestLoad/.test(e.details)).length,1);
  f.close();assert.equal(f.real.timers.size,0);
});

test("R1: canceled old manifest response cannot contaminate a current same-instance reload",()=>{
  const f=realAppHarness(),old=f.real.xhr(),late=old.onreadystatechange;
  f.reload();const current=f.real.xhr();
  old.responseText='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="hvc1.1.6.L120.90"\nold.m3u8\n';
  old.readyState=4;old.response=new ArrayBuffer(4096);late();
  assert.equal(f.loaded(),0);assert.equal(f.real.xhr(),current);
  f.complete();assert.equal(f.loaded(),1);
  assert.equal(f.h.windowTarget.__livePlayer.codec.video.value,"avc1.42E01E");
  f.close();
});

test("X1/SE13: real RTT episode survives the actual nonfatal reload queue, requalifies, and retains its spent backtrack",()=>{
  const f=realAppHarness(),h=f.h,v=h.video,instance=f.instance,real=f.real;
  f.complete();v.readyState=4;v.paused=false;v.seeking=false;v.currentTime=105;v.ended=false;
  let buffer=5.5,sn=0;
  const ranges=()=>{v.buffered={length:1,start:()=>v.currentTime-20,end:()=>v.currentTime+buffer};};ranges();
  Object.defineProperty(instance,"bandwidthEstimate",{get:()=>8000000});
  Object.defineProperty(instance,"latency",{get:()=>12});
  Object.defineProperty(instance,"liveSyncPosition",{get:()=>v.currentTime-5.5});
  const network=()=>h.windowTarget.__livePlayer.network;
  function sample(overhead=50){
    const loader=new instance.config.loader(instance.config);
    const frag={type:"main",sn:++sn,level:0,cc:0,duration:2,start:v.currentTime,stats:loader.stats,elementaryStreams:{}};
    loader.load({...real.context,frag},real.config,{onSuccess(){instance.trigger(real.Hls.Events.FRAG_LOADED,{frag,part:null});},
      onError(){assert.fail("unexpected media error");},onTimeout(){assert.fail("unexpected media timeout");}});
    real.advance(Math.max(0,overhead-100));real.headers();real.complete();loader.destroy();
  }
  const tick=()=>{v.currentTime+=1;h.advanceTime(1000);for(const cb of [...h.intervals.values()])cb();};
  for(let i=0;i<4;i++){sample();tick();}buffer=4.5;
  for(let i=0;i<4;i++){sample(350);tick();}
  assert.equal(network().hlsWeakNetworkClass,"rtt");buffer=6.5;
  const safe=h.scheduledTimeouts.findLast(t=>t.delay===0&&h.timeouts.has(t.id));safe.callback();
  const spent=network().hlsLastWeakSafePointAt;assert.ok(spent>0,"positive spent backtrack control");
  f.reload(false);assert.equal(network().hlsWeakNetworkClass,"rtt");f.complete();assert.equal(f.loaded(),2);
  assert.equal(network().hlsRequestOverheadBaselineMs,null);assert.equal(network().hlsLastWeakSafePointAt,spent);
  v.readyState=4;buffer=6;ranges();
  let i=0;for(;i<180&&network().hlsWeakNetworkMode;i++){sample();tick();}
  assert.ok(i<180);assert.equal(network().hlsWeakNetworkMode,false);assert.equal(network().hlsWeakRecoveryPath,"fast");
  assert.equal(network().hlsSmoothCatchup,true);assert.equal(network().hlsLastWeakSafePointAt,spent);
  assert.equal(h.MockHls.instances.length,1);f.close();
});

test("R1: the observation cap and a stats reset cannot drop current transport callbacks",()=>{
  const f=fixture(),loaders=[],xhrs=[];let completions=0;
  for(let i=0;i<40;i++){
    const loader=new f.Wrapped(f.Hls.DefaultConfig);loaders.push(loader);
    loader.load({...f.context,frag:{...f.frag,sn:i+1}},f.config,{onSuccess(){completions++;},onError(){},onTimeout(){}});xhrs.push(f.xhr());
  }
  assert.equal(f.observer.snapshot().active,32);f.observer.invalidate();
  for(const xhr of xhrs){xhr.readyState=4;xhr.response=new ArrayBuffer(4096);xhr.onreadystatechange();}
  assert.equal(completions,40);assert.equal(f.observer.snapshot().success,0);
  for(const loader of loaders)loader.destroy();assert.equal(f.timers.size,0);
});

test("R1: synchronous cached manifest success crosses the real event bus during two queue reloads",()=>{
  const f=realAppHarness();f.complete();
  f.real.self.XMLHttpRequest.prototype.send=function(){
    if(!this.opened[1].includes('index.m3u8'))return;
    this.responseText='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.42E01E"\nvideo.m3u8\n';
    f.real.advance(1);this.readyState=2;this.onreadystatechange();
    f.real.advance(1);this.readyState=4;this.response=new ArrayBuffer(4096);this.onreadystatechange();
  };
  for(let i=0;i<2;i++){f.reload();assert.equal(f.loaded(),i+2);}
  f.close();assert.equal(f.real.timers.size,0);
});
test("C transport contract: stats/context/body/header/range/getter and progress identity are preserved", () => {
  const h = fixture({ progress: true }); h.load(); h.headers(); h.progress(1024); h.complete();
  assert.deepEqual(h.calls.map(c => c.kind), ["Progress", "Success"]);
  assert.equal(h.xhr().headers.Range, "bytes=0-4095"); assert.equal(h.xhr().headers["X-Fixture"], "same");
  assert.equal(h.loader.getNetworkDetails(), h.xhr()); assert.equal(h.loader.getResponseHeader("Age"), "12");
  const success = h.calls[1].args;
  assert.equal(success[0].data, h.xhr().response); assert.equal(success[1], h.loader.stats);
  assert.equal(success[2], h.context); assert.equal(success[3], h.xhr());
  assert.equal(h.observer.accepts(h.loader.stats, h.frag, null), true);
  assert.equal(h.observer.accepts(h.loader.stats, {}, null), false);
});
test("C native error/TTFB/total timeout remains terminal exactly once", () => {
  for (const mode of ["error", "ttfb", "total"]) {
    const h = fixture(); h.load();
    if (mode === "error") h.complete(500);
    else { if (mode === "total") h.headers(); h.advance(mode === "total" ? 120000 : 12000, true); }
    assert.deepEqual(h.calls.map(c => c.kind), [mode === "error" ? "Error" : "Timeout"]);
    h.loader.destroy(); assert.equal(h.timers.size, 0);
  }
});
test("production app installs the actual Loader adapter and accepts its current fragment completion", () => {
  const Module = require("node:module"), real = fixture();
  const filename = path.join(__dirname, "player-lifecycle.test.js"), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(__dirname);
  const originalRequire = mod.require.bind(mod);
  mod.require = id => id === "node:test" ? () => {} : id === "real-loader" ? real.Base : originalRequire(id);
  const source = fs.readFileSync(filename, "utf8").replace("  Object.assign(windowTarget, {",
    "  MockHls.DefaultConfig = { loader: require('real-loader') };\n  Object.assign(windowTarget, {");
  mod._compile(source + "\nmodule.exports={runningHls};", filename);
  const h = mod.exports.runningHls();
  assert.notEqual(h.instance.config.loader, real.Base);
  const loader = new h.instance.config.loader(h.instance.config);
  const frag = { type: "main", sn: 1, duration: 2, level: 0, cc: 0, stats: loader.stats };
  const context = { ...real.context, frag };
  loader.load(context, real.config, { onSuccess() { h.instance.emit(h.MockHls.Events.FRAG_LOADED, { frag, part: null }); },
    onError() { assert.fail("unexpected error"); }, onTimeout() { assert.fail("unexpected timeout"); } });
  real.headers(); real.progress(1024); real.complete();
  assert.equal(h.windowTarget.__livePlayer.network.hlsMediaEvidenceFresh, true);
  assert.equal(h.windowTarget.__livePlayer.network.hlsRequestObservation.success, 1);
  assert.equal(h.windowTarget.__livePlayer.network.hlsRequestObservation.activeRecoveryEnabled, false);
  h.windowTarget.__livePlayer.hls(); loader.destroy();
  assert.equal(h.windowTarget.__livePlayer.network.hlsMediaEvidenceFresh, false);
});
test("C8/C9: app monitor stops after an opt-in native abort synchronously starts a new generation", () => {
  const Module=require("node:module"),real=fixture();
  const filename=path.join(__dirname,"player-lifecycle.test.js"),mod=new Module(filename,module);
  mod.filename=filename;mod.paths=Module._nodeModulePaths(__dirname);
  const originalRequire=mod.require.bind(mod);
  mod.require=id=>id==="node:test"?()=>{}:id==="real-loader"?real.Base:id==="node:fs"?{
    ...fs,readFileSync(file,...args){const s=fs.readFileSync(file,...args);return String(file).endsWith("app.js")?
      s.replace("const HLS_BODY_IDLE_RECOVERY_ENABLED = false","const HLS_BODY_IDLE_RECOVERY_ENABLED = true"):s;}
  }:originalRequire(id);
  const s=fs.readFileSync(filename,"utf8").replace("  Object.assign(windowTarget, {",
    "  MockHls.DefaultConfig = { loader: require('real-loader') };\n  Object.assign(windowTarget, {");
  mod._compile(s+"\nmodule.exports={runningHls};",filename);
  const h=mod.exports.runningHls();h.ahead(1);
  const loader=new h.instance.config.loader(h.instance.config);
  const frag={type:"main",sn:1,level:0,cc:0,start:105,duration:2,stats:loader.stats};
  h.instance.levels=[{details:{fragments:[frag]}}];h.instance.currentLevel=0;
  loader.load({...real.context,frag},real.config,{onSuccess(){},onTimeout(){},onError(){},onAbort(){h.windowTarget.__livePlayer.hls();}});
  real.headers();real.progress(1024);h.tick();h.advanceTime(9000);h.tick();
  assert.equal(h.MockHls.instances.length,2);
  assert.equal(h.windowTarget.__livePlayer.network.hlsRequestProgress.length,0);
  assert.equal(h.windowTarget.__livePlayer.network.hlsRequestObservation.idleActions,0);
  assert.equal(h.windowTarget.__livePlayer.network.hlsNetworkPlaybackStartedAt,0);
  loader.destroy();
});
