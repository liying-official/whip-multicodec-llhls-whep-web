"use strict";
const assert=require("node:assert/strict"),test=require("node:test"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module");
const root=process.env.SEAMLESS_BASELINE||path.resolve(__dirname,"..");
function loadFixture(filename,exports){
  const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  const req=m.require.bind(m);m.require=id=>id==="node:test"?()=>{}:req(id);
  m._compile(fs.readFileSync(filename,"utf8")+"\nmodule.exports={"+exports+"};",filename);return m.exports;
}
const {runningHls}=loadFixture(path.join(root,"tests/player-lifecycle.test.js"),"runningHls");
let sn=0;
function player({buffer=6,latency=12,dynamic=false,history=0.5,ratio=2.5,cadence=2}={}){
  const h=runningHls(),v=h.video,instance=h.instance,ops=[];
  let position=v.currentTime,edge=position+latency,end=position+buffer,rate=1,clock=0,fixed=dynamic?null:buffer,depth=history;
  const record=(op,value)=>ops.push({op,value,at:clock,weak:h.windowTarget.__livePlayer.network.hlsWeakNetworkMode,stack:new Error().stack});
  Object.defineProperty(v,"currentTime",{configurable:true,get:()=>position,set:x=>{record("seek",x-position);position=x;}});
  Object.defineProperty(v,"playbackRate",{configurable:true,get:()=>rate,set:x=>{record("rate",x);rate=x;}});
  Object.defineProperty(v,"buffered",{configurable:true,get:()=>({length:1,start:()=>position-depth,end:()=>fixed===null?end:position+fixed})});
  Object.defineProperty(instance,"latency",{configurable:true,get:()=>edge-position});
  Object.defineProperty(instance,"liveSyncPosition",{configurable:true,get:()=>edge-(instance.targetLatency??instance.config.liveSyncDuration)});
  const details={live:true,targetduration:cadence,totalduration:48,advanced:true,fragments:[],age:0,
    get edge(){return edge;},get fragmentStart(){return edge-48;}};
  instance.levels=[{videoCodec:"avc1.42E01E",details}];instance.currentLevel=0;instance.latestLevelDetails=details;
  instance.bandwidthEstimate=ratio*4000000;
  for(const name of ["loadSource","startLoad","stopLoad","attachMedia","detachMedia","destroy","recoverMediaError"]){
    const fn=instance[name];instance[name]=function(...args){record(name,null);return fn?.apply(this,args);};
  }
  for(const name of ["load","play","pause","fastSeek"]){const fn=v[name];v[name]=function(...args){record(name,args[0]);return fn?.apply(this,args);};}
  function transfer(overhead=50){
    instance.emit(h.MockHls.Events.FRAG_LOADED,{part:null,frag:{type:"main",level:0,cc:0,sn:++sn,duration:2,
      stats:{loaded:1000000,retry:0,aborted:false,loading:{start:100,first:100+overhead,end:300+overhead}}}});
  }
  function step(seconds=1,{media=true,overhead=50}={}){
    const steps=Math.round(seconds*4);
    for(let i=0;i<steps;i++){
      const before=position;
      edge+=0.25;
      if(!v.paused&&!v.seeking){
        const available=fixed===null?Math.max(0,end-position):(Number.isFinite(fixed)?Math.max(0,fixed):0);
        position+=Math.min(available,rate*0.25);
      }
      clock+=250;h.advanceTime(250);
      if(media&&clock%(cadence*1000)===0){
        if(fixed===null)end=Math.max(end,Math.min(Math.floor(edge/cadence)*cadence,Math.floor((position+instance.config.maxBufferLength)/cadence)*cadence));
        transfer(overhead);
      }
      v.dispatchEvent("timeupdate");
      if(clock%1000===0)for(const cb of [...h.intervals.values()])cb();
      if(f.nativeStep)f.nativeStep();
      if(!v.paused&&!v.seeking)assert.ok(position-before<=0.262501||ops.at(-1)?.op==="seek","model advanced without integrating actual rate");
    }
  }
  const f={h,v,instance,details,ops,transfer,step,network:()=>h.windowTarget.__livePlayer.network,
    buffer:x=>{fixed=x;},history:x=>{depth=x;},dynamic:()=>{end=position+(fixed??Math.max(0,end-position));fixed=null;},
    latency:x=>{edge=position+x;},time:()=>clock,
    weak(kind="bandwidth-loss"){
      if(kind==="rtt"){
        fixed=5.5;for(let i=0;i<4;i++){step(1,{media:false});transfer(50);}
        fixed=4.5;for(let i=0;i<4;i++){step(1,{media:false});transfer(350);}
      }else instance.emit(h.MockHls.Events.ERROR,{type:"networkError",details:"fragLoadError",fatal:true});
      assert.equal(f.network().hlsWeakNetworkClass,kind);
      fixed=buffer;
    },
    exhaustSafeTimers(){for(let i=0;i<12;i++){const t=h.scheduledTimeouts.findLast(t=>h.timeouts.has(t.id)&&[0,500].includes(t.delay));if(!t)break;h.timeouts.delete(t.id);t.callback();}},
    close:()=>h.windowTarget.dispatchEvent("beforeunload")};
  return f;
}
const forbidden=ops=>ops.filter(o=>["seek","fastSeek","loadSource","startLoad","stopLoad","attachMedia","detachMedia","destroy","recoverMediaError","load","play","pause"].includes(o.op));
function exit(f,limit=180){let i=0;for(;i<limit&&f.network().hlsWeakNetworkMode;i++)f.step();assert.equal(f.network().hlsWeakNetworkMode,false,"fresh 6-second buffer must admit a qualified exit");return i;}

for(const kind of ["rtt","bandwidth-loss"])for(const [ratio,recovery] of [[2,"fast"],[1.55,"stable"]]){
  test(`SE1: ${kind}/${recovery} exits at 6s without ever reaching READY or replacing media`,()=>{
    const f=player({buffer:6});f.weak(kind);f.instance.bandwidthEstimate=ratio*4000000;
    const start=f.ops.length;let everReady=false;
    for(let i=0;i<180&&f.network().hlsWeakNetworkMode;i++){f.step();everReady ||= f.network().hlsWeakBufferReady;}
    assert.equal(f.network().hlsWeakNetworkMode,false);assert.equal(everReady,false);
    assert.equal(f.network().hlsWeakRecoveryPath,recovery);
    assert.equal(f.instance.config.liveSyncDuration,6);
    assert.equal(forbidden(f.ops.slice(start)).length,0);
    assert.equal(f.h.MockHls.instances.length,1);f.close();
  });
}
test("SE2: current exit buffer boundary is finite, continuous and exactly inclusive at 6",()=>{
  for(const [buffer,want] of [[5.999,true],[6,false],[6.001,false],[7,false],[7.999,false],[8,false],[NaN,true],[Infinity,true]]){
    const f=player({buffer});f.weak();for(let i=0;i<100;i++)f.step();
    assert.equal(f.network().hlsWeakNetworkMode,want,String(buffer));f.close();
  }
});
test("SE3: stable hold cannot commit while the current buffer is below 6",()=>{
  const f=player({buffer:6,ratio:1.55});f.weak();
  for(let i=0;i<100&&f.network().hlsStableRecoverySamples<29;i++)f.step();
  assert.equal(f.network().hlsStableRecoverySamples,29);
  f.buffer(5.999);f.step();assert.equal(f.network().hlsWeakNetworkMode,true);
  assert.equal(f.network().hlsStableRecoverySamples,29);
  f.buffer(6);f.step();assert.equal(f.network().hlsWeakNetworkMode,false);f.close();
});
test("SE4/SE6: the existing post-exit playing-confirmation path cannot jump to live",()=>{
  const f=player({buffer:8.5,latency:12});f.weak();exit(f);
  const before=f.v.currentTime,start=f.ops.length;
  f.v.dispatchEvent("waiting");f.v.dispatchEvent("playing");
  const timer=f.h.scheduledTimeouts.findLast(t=>t.delay===1000&&f.h.timeouts.has(t.id));
  if(timer){f.h.timeouts.delete(timer.id);f.h.advanceTime(1000);timer.callback();}
  assert.equal(f.v.currentTime,before);assert.equal(forbidden(f.ops.slice(start)).length,0);f.close();
});
test("SE4/SE12: healthy 12s latency converges through real rate integration, with zero exit seek/reload",()=>{
  const f=player({buffer:6,latency:12});f.weak();exit(f);
  assert.equal(f.instance.latency,12,"exit must not pretend physical latency instantly became 6");
  f.dynamic();const start=f.ops.length;
  let elapsed=0;
  for(;elapsed<900;elapsed++){f.step();if(f.instance.latency<=6.8&&f.instance.config.liveMaxLatencyDuration===18&&f.instance.config.maxLiveSyncPlaybackRate===1.05)break;}
  assert.ok(elapsed>=100,"cannot consume the excess delay faster than the 1.05x physical limit");
  assert.ok(elapsed<900,"healthy catchup must have a natural convergence exit");
  assert.equal(forbidden(f.ops.slice(start)).length,0);
  assert.ok(f.ops.filter(o=>o.op==="rate").every(o=>o.value>=1&&o.value<=1.05));
  assert.ok(f.ops.some(o=>o.op==="rate"&&o.value>1));f.close();
});
test("SE6: a qualified 6s exit is decided before an available BUILDING backtrack",()=>{
  const f=player({buffer:6,history:0.5});f.v.paused=true;f.weak();f.exhaustSafeTimers();f.v.paused=false;
  for(let i=0;i<100&&f.network().hlsFastRecoverySamples<19;i++)f.step();
  assert.equal(f.network().hlsFastRecoverySamples,19);
  f.history(20);const start=f.ops.length;f.step();
  assert.equal(f.network().hlsWeakNetworkMode,false);assert.equal(forbidden(f.ops.slice(start)).length,0);f.close();
});
test("SE7/SE8: buffer pressure and pause stop acceleration; fresh playback resumes without wall-clock jumps",()=>{
  const f=player({buffer:8.5,latency:20});f.weak();exit(f);for(let i=0;i<6;i++)f.step();
  assert.ok(f.v.playbackRate>1&&f.v.playbackRate<=1.05);
  f.buffer(2.9);f.step();assert.equal(f.v.playbackRate,1);
  f.v.paused=true;f.v.dispatchEvent("pause");const before=f.v.currentTime,start=f.ops.length;
  f.step(10,{media:false});assert.equal(f.v.currentTime,before);assert.equal(f.v.playbackRate,1);
  assert.equal(forbidden(f.ops.slice(start)).length,0);
  f.v.paused=false;f.v.dispatchEvent("play");f.buffer(8.5);f.step(12);
  assert.ok(f.v.playbackRate>1);assert.equal(f.ops.slice(start).filter(o=>o.op==="seek").length,0);f.close();
});

// Real vendored controller methods: test-only controlled media and level
// getters; no replacement of synchronizeToLiveEdge/onTimeupdate internals.
function nativeControllers(f){
  const {fixture}=loadFixture(path.join(root,"tests/request-observation.test.js"),"fixture");
  const real=fixture({browser:true}),native=new real.Hls({enableWorker:false,autoStartLoad:false,...f.instance.config});
  Object.defineProperty(native,"latestLevelDetails",{get:()=>f.details});
  native.latencyController.media=f.v;native.streamController.media=f.v;native.streamController.mediaBuffer=f.v;
  native.streamController._hasEnoughToStart=true;
  f.nativeStep=()=>{
    Object.assign(native.config,f.instance.config);
    native.targetLatency=f.instance.targetLatency ?? f.instance.config.liveSyncDuration;
    native.latencyController.onTimeupdate();
    native.latencyController.onLevelUpdated(real.Hls.Events.LEVEL_UPDATED,{details:f.details});
    native.streamController.synchronizeToLiveEdge(f.details);
  };
  return {native,close(){f.nativeStep=null;native.latencyController.media=null;native.streamController.media=null;native.streamController.mediaBuffer=null;native.destroy();}};
}
for(const latency of [17.999,18,18.001,20,23.9,47])test(`SE5/SE10/SE12: native controllers preserve continuity from ${latency}s latency and hand back rate ownership`,()=>{
  const f=player({buffer:8.5,latency});f.weak();exit(f);
  const start=f.ops.length,n=nativeControllers(f);f.dynamic();let elapsed=0;
  for(;elapsed<1500&&f.network().hlsSmoothCatchup;elapsed++)f.step();
  assert.ok(elapsed<1500,"finite healthy convergence");assert.equal(f.instance.config.liveMaxLatencyDuration,18);
  assert.equal(f.instance.config.maxLiveSyncPlaybackRate,1.05);assert.equal(f.network().hlsCatchupGuardSeconds,null);
  assert.equal(forbidden(f.ops.slice(start)).length,0);
  const rates=f.ops.slice(start).filter(o=>o.op==="rate");assert.ok(rates.length>1);
  assert.ok(rates.every(o=>o.value>=1&&o.value<=1.05));
  assert.equal(rates.filter(o=>/onTimeupdate|changeMediaPlaybackRate/.test(o.stack)&&o.at<f.time()-250).length,0,
    "native controller must not compete for rate before handoff");
  f.step(3);assert.equal(forbidden(f.ops.slice(start)).length,0);n.close();f.close();
});
test("SE5/SE14: native unguarded 20-to-6 transition really seeks; independent out-of-window fault still recovers",()=>{
  const f=player({buffer:16,latency:20}),n=nativeControllers(f);
  const before=f.ops.length;n.native.streamController.media=f.v;f.nativeStep();
  assert.ok(f.ops.slice(before).some(o=>o.op==="seek"),"control must exercise the actual dangerous native method");
  f.latency(60);f.v.readyState=2;Object.defineProperty(f.v,"buffered",{get:()=>({length:0})});
  f.nativeStep();assert.ok(f.ops.at(-1).op==="seek");n.close();f.close();
});
for(const cadence of [1,3,4])test(`SE12: natural ${cadence}s segment cadence converges without fake wall-clock position changes`,()=>{
  const f=player({buffer:8.5,latency:20,cadence});f.weak();exit(f);f.dynamic();const start=f.ops.length;
  let elapsed=0;for(;elapsed<1500&&f.network().hlsSmoothCatchup;elapsed++)f.step();
  assert.ok(elapsed<1500,`unconverged at latency=${f.instance.latency}, buffer=${f.network().hlsBufferAheadSeconds}`);
  assert.equal(forbidden(f.ops.slice(start)).length,0);f.close();
});
test("SE2/SE9: gaps, audio-only reserve, empty/negative and invalid ranges never count as playable video",()=>{
  const cases=[()=>({length:0}),v=>({length:2,start:i=>i?v.currentTime+0.01:v.currentTime-1,end:i=>i?v.currentTime+12:v.currentTime-0.01}),
    v=>({length:1,start:()=>v.currentTime+0.001,end:()=>v.currentTime+12}),
    v=>({length:1,start:()=>-1,end:()=>v.currentTime+12}),v=>({length:1,start:()=>NaN,end:()=>v.currentTime+12})];
  for(const ranges of cases){const f=player({buffer:8.5});f.weak();Object.defineProperty(f.v,"buffered",{get:()=>ranges(f.v)});
    for(let i=0;i<100;i++)f.step();assert.equal(f.network().hlsWeakNetworkMode,true);assert.equal(f.network().hlsWeakBufferReady,false);f.close();}
});
test("SE6: queued recovery/confirmation/safe callbacks cannot act after qualified exit, including consumed reload child",()=>{
  const f=player({buffer:8.5});f.weak();
  f.instance.emit(f.h.MockHls.Events.ERROR,{type:"networkError",details:"playlistUnchangedError",fatal:false});
  const parent=f.h.scheduledTimeouts.findLast(t=>t.delay===250);parent.callback();
  const child=f.h.scheduledTimeouts.findLast(t=>t.delay===2500);assert.ok(child);
  f.v.dispatchEvent("waiting");f.v.dispatchEvent("playing");
  const confirmation=f.h.scheduledTimeouts.findLast(t=>t.delay===1000);
  const safe=f.h.scheduledTimeouts.find(t=>t.delay===0);
  exit(f);const start=f.ops.length;
  f.buffer(0);f.v.readyState=2;for(const timer of [parent,child,confirmation,safe])timer?.callback();
  assert.equal(forbidden(f.ops.slice(start)).length,0);
  f.instance.emit(f.h.MockHls.Events.ERROR,{type:"networkError",details:"manifestLoadError",fatal:true});
  const fresh=f.h.scheduledTimeouts.findLast(t=>t.delay>=750&&t.delay<8250);fresh.callback();
  assert.ok(f.ops.slice(start).some(o=>o.op==="startLoad"),"current independent fatal must retain recovery");f.close();
});
test("SE7/SE8/SE9: stale transfers, media freeze, sampling gap and new error brake, then fresh playback can resume",()=>{
  for(const cause of ["stale","gap","error","freeze"]){
    const f=player({buffer:8.5,latency:20});f.weak();exit(f);f.step(4);assert.ok(f.v.playbackRate>1);
    if(cause==="gap"){f.h.advanceTime(30000);f.step(0.25,{media:false});}
    if(cause==="stale")f.step(12,{media:false});
    if(cause==="error")f.instance.emit(f.h.MockHls.Events.ERROR,{type:"mediaError",details:"bufferAppendError",fatal:false});
    if(cause==="freeze"){
      for(let i=0;i<14;i++){f.h.advanceTime(1000);f.transfer();f.v.dispatchEvent("timeupdate");}
    }
    assert.equal(f.v.playbackRate,1,cause);
    const start=f.ops.length;f.step(16);assert.ok(f.v.playbackRate>1,cause);assert.equal(forbidden(f.ops.slice(start)).length,0);f.close();
  }
});
test("SE8: manual seek and old timeupdate owner cannot control replacement HLS",()=>{
  const f=player({buffer:8.5,latency:20});f.weak();exit(f);f.step(4);
  const callbacks=f.v.added.filter(r=>r.type==="timeupdate").map(r=>r.listener);
  f.v.seeking=true;f.v.dispatchEvent("seeking");const before=f.v.currentTime;f.step(3);assert.equal(f.v.currentTime,before);
  f.v.seeking=false;f.v.dispatchEvent("seeked");f.step(12);assert.ok(f.v.playbackRate>1);
  f.h.windowTarget.__livePlayer.hls();f.v.playbackRate=1.025;const start=f.ops.length;
  for(const cb of callbacks)cb();f.h.advanceTime(5000);for(const cb of callbacks)cb();
  assert.equal(f.ops.length,start);assert.equal(f.v.playbackRate,1.025);f.close();
});

test("SE13: renewed credible weakness brakes and preserves the finite guard and spent backtrack across soft transitions",()=>{
  const f=player({buffer:6.5,latency:20,history:20});f.weak();
  const timer=f.h.scheduledTimeouts.findLast(t=>t.delay===0);timer.callback();
  const spent=f.network().hlsLastWeakSafePointAt;assert.ok(spent>0);
  f.buffer(8.5);exit(f);f.step(5);assert.ok(f.v.playbackRate>1);
  const guard=f.network().hlsCatchupGuardSeconds,start=f.ops.length;
  f.instance.emit(f.h.MockHls.Events.ERROR,{type:"networkError",details:"fragLoadError",fatal:true});
  assert.equal(f.v.playbackRate,1);assert.equal(f.network().hlsWeakNetworkMode,true);
  assert.equal(f.network().hlsCatchupGuardSeconds,guard);assert.equal(f.network().hlsLastWeakSafePointAt,spent);
  f.exhaustSafeTimers();exit(f);assert.equal(f.network().hlsLastWeakSafePointAt,spent);
  assert.equal(f.ops.slice(start).filter(o=>o.op==="seek").length,0);f.close();
});
