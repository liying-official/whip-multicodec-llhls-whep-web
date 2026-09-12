"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class MockEventTarget {
  constructor() {
    this.listeners = new Map();
    this.added = [];
  }

  addEventListener(type, listener, options = false) {
    const capture = typeof options === "boolean" ? options : Boolean(options && options.capture);
    const once = Boolean(options && typeof options === "object" && options.once);
    const records = this.listeners.get(type) || [];
    if (!records.some(record => record.listener === listener && record.capture === capture)) {
      const record = { listener, capture, once };
      records.push(record);
      this.listeners.set(type, records);
      this.added.push({ type, listener });
    }
  }

  removeEventListener(type, listener, options = false) {
    const capture = typeof options === "boolean" ? options : Boolean(options && options.capture);
    const records = this.listeners.get(type) || [];
    this.listeners.set(type, records.filter(record => (
      record.listener !== listener || record.capture !== capture
    )));
  }

  dispatchEvent(event) {
    const value = typeof event === "string" ? { type: event } : event;
    for (const record of [...(this.listeners.get(value.type) || [])]) {
      record.listener.call(this, value);
      if (record.once) this.removeEventListener(value.type, record.listener, record.capture);
    }
  }

  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
  }
}

function makeClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    toggle: (name, force) => {
      if (force === undefined ? !values.has(name) : force) values.add(name);
      else values.delete(name);
    },
    contains: name => values.has(name)
  };
}

function makeElement(id) {
  const element = new MockEventTarget();
  element.id = id;
  element.classList = makeClassList();
  element.dataset = {};
  element.style = {};
  element.textContent = "";
  element.innerHTML = "";
  element.disabled = false;
  element.setAttribute = () => {};
  element.removeAttribute = () => {};
  return element;
}

function makeHarness() {
  let nextTimer = 1;
  let now = 100000;
  class MockDate extends Date {
    static now() { return now; }
  }
  const timeouts = new Map();
  const scheduledTimeouts = [];
  const intervals = new Map();
  const fetchRequests = [];
  const video = makeElement("video");
  video.muted = true;
  video.autoplay = true;
  video.paused = true;
  video.currentTime = 0;
  video.duration = Infinity;
  video.readyState = 0;
  video.videoWidth = 0;
  video.srcObject = null;
  video.buffered = { length: 0, start: () => 0, end: () => 0 };
  video.canPlayType = () => "";
  video.play = () => {
    video.paused = false;
    return Promise.resolve();
  };
  video.pause = () => { video.paused = true; };
  video.load = () => {};

  const elements = new Map([
    ["video", video],
    ["status", makeElement("status")],
    ["codecSupport", makeElement("codecSupport")],
    ["soundToggle", makeElement("soundToggle")],
    ["autoMode", makeElement("autoMode")],
    ["hlsMode", makeElement("hlsMode")],
    ["whepMode", makeElement("whepMode")]
  ]);

  class MockHls {
    static Events = {
      MANIFEST_PARSED: "manifestParsed",
      FRAG_LOADED: "fragLoaded",
      LEVEL_SWITCHED: "levelSwitched",
      ERROR: "error"
    };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
    static ErrorDetails = {};
    static instances = [];
    static isMSESupported() { return true; }
    static isSupported() { return true; }

    constructor(config) {
      this.config = config;
      this.handlers = new Map();
      this.levels = [];
      this.bandwidthEstimate = 10_000_000;
      this.latency = 5;
      this.destroyed = false;
      MockHls.instances.push(this);
    }

    attachMedia(media) { this.media = media; }
    loadSource(source) { this.source = source; }
    on(type, listener) {
      const listeners = this.handlers.get(type) || [];
      listeners.push(listener);
      this.handlers.set(type, listeners);
    }
    emit(type, data) {
      for (const listener of [...(this.handlers.get(type) || [])]) {
        listener(type, data);
      }
    }
    startLoad() {}
    recoverMediaError() {}
    destroy() {
      this.destroyed = true;
      this.handlers.clear();
      this.media = null;
    }
  }

  const windowTarget = new MockEventTarget();
  const context = {
    AbortController,
    Array,
    Boolean,
    console: { debug() {}, info() {}, warn() {}, error() {} },
    Date: MockDate,
    Error,
    fetch: () => new Promise((resolve, reject) => fetchRequests.push({ resolve, reject })),
    Hls: MockHls,
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    Infinity,
    JSON,
    Map,
    Math,
    MediaSource: { isTypeSupported: () => true },
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    clearInterval: id => intervals.delete(id),
    clearTimeout: id => timeouts.delete(id),
    document: { getElementById: id => elements.get(id) },
    navigator: { onLine: true },
    performance: { now: () => 0 },
    setInterval: callback => {
      const id = nextTimer++;
      intervals.set(id, callback);
      return id;
    },
    setTimeout: (callback, delay = 0) => {
      const id = nextTimer++;
      timeouts.set(id, callback);
      scheduledTimeouts.push({ id, callback, delay });
      return id;
    },
    window: windowTarget
  };
  Object.assign(windowTarget, {
    Hls: MockHls,
    MediaSource: context.MediaSource,
    console: context.console,
    location: { href: "https://live.example.test/", origin: "https://live.example.test" },
    navigator: context.navigator
  });
  windowTarget.window = windowTarget;
  windowTarget.self = windowTarget;

  const root = path.resolve(__dirname, "..");
  vm.runInNewContext(
    fs.readFileSync(path.join(root, "web", "hls-weak-network-policy.js"), "utf8"),
    context,
    { filename: "hls-weak-network-policy.js" }
  );
  windowTarget.HlsWeakNetworkPolicy = context.HlsWeakNetworkPolicy;
  vm.runInNewContext(
    fs.readFileSync(path.join(root, "web", "app.js"), "utf8"),
    context,
    { filename: "app.js" }
  );

  return {
    advanceTime: milliseconds => { now += milliseconds; },
    context,
    elements,
    fetchRequests,
    intervals,
    MockHls,
    scheduledTimeouts,
    timeouts,
    video,
    windowTarget
  };
}

function manifestResponse(codecs) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(
      `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="${codecs}"\n/live/index.m3u8\n`
    )
  };
}

async function flushAsyncWork() {
  for (let attempt = 0; attempt < 8; attempt += 1) await Promise.resolve();
}

test("stale startAuto manifest result cannot overwrite the replacement generation", async () => {
  const harness = makeHarness();
  assert.equal(harness.fetchRequests.length, 1, "initial auto manifest request missing");

  const replacement = harness.windowTarget.__livePlayer.auto();
  assert.equal(harness.fetchRequests.length, 2, "replacement auto manifest request missing");
  harness.fetchRequests[0].resolve(manifestResponse("av01.0.08M.08,mp4a.40.2"));
  await flushAsyncWork();

  assert.equal(harness.windowTarget.__livePlayer.codec.video.value, "");
  assert.equal(harness.windowTarget.__livePlayer.codec.audio.value, "");
  assert.deepEqual(
    { ...harness.windowTarget.__livePlayer.mode },
    { requested: "auto", active: "" },
    "stale auto result changed replacement mode/fallback state"
  );

  harness.fetchRequests[1].resolve(manifestResponse("avc1.42E01E,mp4a.40.2"));
  await replacement;
  await flushAsyncWork();
  assert.equal(harness.windowTarget.__livePlayer.codec.video.value, "avc1.42E01E");
  assert.equal(harness.windowTarget.__livePlayer.codec.audio.value, "mp4a.40.2");
});

test("stale WHEP metadata refresh cannot overwrite a newer HLS generation", async () => {
  const harness = makeWhepHarness();
  const staleWhep = harness.windowTarget.__livePlayer.whep();
  const metadata = harness.fetchRequests.at(-1);
  await flushAsyncWork();
  assert.equal(metadata.url, "/live/index.m3u8", "WHEP metadata request missing");
  harness.elements.get("hlsMode").dispatchEvent("click");

  metadata.resolve(manifestResponse("vp09.00.10.08,opus"));
  await staleWhep;
  await flushAsyncWork();

  assert.deepEqual(
    { ...harness.windowTarget.__livePlayer.mode },
    { requested: "hls", active: "hls" }
  );
  assert.equal(harness.windowTarget.__livePlayer.codec.video.value, "");
  assert.equal(harness.windowTarget.__livePlayer.codec.audio.value, "");
});

test("current-generation manifest success still applies video and audio metadata", async () => {
  const harness = makeHarness();
  harness.fetchRequests[0].resolve(manifestResponse("hvc1.1.6.L120.B0,mp4a.40.2"));
  await flushAsyncWork();
  assert.equal(harness.windowTarget.__livePlayer.codec.video.value, "hvc1.1.6.L120.B0");
  assert.equal(harness.windowTarget.__livePlayer.codec.audio.value, "mp4a.40.2");
});

test("100 HLS starts retain only the current generation's video listeners", () => {
  const harness = makeHarness();
  const eventTypes = ["waiting", "stalled", "playing", "loadeddata", "error"];
  let maximumTimeouts = 0;

  harness.windowTarget.__livePlayer.hls();
  const firstErrorListener = harness.video.added.find(entry => entry.type === "error").listener;
  for (let generation = 2; generation <= 100; generation += 1) {
    harness.MockHls.instances.at(-1).emit(harness.MockHls.Events.ERROR, {
      fatal: true,
      type: harness.MockHls.ErrorTypes.NETWORK_ERROR,
      details: "manifestLoadError",
      response: { code: 503 }
    });
    maximumTimeouts = Math.max(maximumTimeouts, harness.timeouts.size);
    harness.windowTarget.__livePlayer.hls();
  }
  harness.MockHls.instances.at(-1).emit(harness.MockHls.Events.ERROR, {
    fatal: true,
    type: harness.MockHls.ErrorTypes.NETWORK_ERROR,
    details: "manifestLoadError",
    response: { code: 503 }
  });
  maximumTimeouts = Math.max(maximumTimeouts, harness.timeouts.size);

  for (const type of eventTypes) {
    assert.equal(
      harness.video.listenerCount(type),
      1,
      `${type} listener count must remain constant across generations`
    );
  }
  assert.equal(harness.MockHls.instances.length, 100);
  assert.equal(harness.MockHls.instances.filter(instance => instance.destroyed).length, 99);
  assert.equal(harness.windowTarget.__liveHls, harness.MockHls.instances[99]);
  assert.ok(maximumTimeouts <= 3, `per-generation timeout count grew: ${maximumTimeouts}`);
  assert.ok(harness.timeouts.size <= 3, `unexpected live timeouts: ${harness.timeouts.size}`);
  assert.ok(harness.intervals.size <= 1, `unexpected live intervals: ${harness.intervals.size}`);

  const status = harness.elements.get("status");
  status.textContent = "current-generation-sentinel";
  firstErrorListener();
  assert.equal(status.textContent, "current-generation-sentinel", "stale generation mutated UI state");

  harness.windowTarget.dispatchEvent({ type: "beforeunload" });
  for (const type of eventTypes) {
    assert.equal(harness.video.listenerCount(type), 0, `${type} listener survived teardown`);
  }
  assert.equal(harness.MockHls.instances.filter(instance => instance.destroyed).length, 100);
  assert.equal(harness.windowTarget.__liveHls, null, "destroyed HLS object remained globally reachable");
  assert.equal(harness.timeouts.size, 0, "timeout survived teardown");
  assert.equal(harness.intervals.size, 0, "interval survived teardown");
});

test("paused or seeking media cannot be moved by the weak-network safe point", () => {
  for (const mediaState of [
    { paused: true, seeking: false },
    { paused: false, seeking: true }
  ]) {
    const harness = makeHarness();
    harness.windowTarget.__livePlayer.hls();
    const instance = harness.MockHls.instances.at(-1);
    harness.video.paused = mediaState.paused;
    harness.video.seeking = mediaState.seeking;
    harness.video.ended = false;
    harness.video.readyState = 4;
    harness.video.currentTime = 105;
    harness.video.buffered = { length: 1, start: () => 90, end: () => 112 };
    instance.liveSyncPosition = 100;

    instance.emit(harness.MockHls.Events.ERROR, {
      fatal: true,
      type: harness.MockHls.ErrorTypes.NETWORK_ERROR,
      details: "fragLoadError",
      response: { code: 0 }
    });
    const safePoint = [...harness.scheduledTimeouts]
      .reverse()
      .find(record => record.delay === 0 && harness.timeouts.has(record.id));
    assert.ok(safePoint, "weak safe-point attempt was not scheduled");
    harness.timeouts.delete(safePoint.id);
    safePoint.callback();
    assert.equal(harness.video.currentTime, 105);
  }
});

test("FRAG_LOADED preserves recent-error time and a new HLS session resets weak state", () => {
  const harness = makeHarness();
  harness.windowTarget.__livePlayer.hls();
  const first = harness.MockHls.instances.at(-1);
  harness.video.currentTime = 10;
  first.emit(harness.MockHls.Events.ERROR, {
    fatal: false,
    type: harness.MockHls.ErrorTypes.NETWORK_ERROR,
    details: "fragLoadError",
    response: { code: 0 }
  });
  harness.video.dispatchEvent("waiting");
  const afterError = harness.windowTarget.__livePlayer.network;
  assert.ok(afterError.hlsLastNetworkErrorAt > 0);
  assert.equal(afterError.hlsStallEpisodeActive, true);

  first.emit(harness.MockHls.Events.FRAG_LOADED, {});
  const afterFragment = harness.windowTarget.__livePlayer.network;
  assert.equal(afterFragment.hlsConsecutiveNetworkErrors, 0);
  assert.equal(afterFragment.hlsLastNetworkErrorAt, afterError.hlsLastNetworkErrorAt);

  harness.windowTarget.__livePlayer.hls();
  const nextSession = harness.windowTarget.__livePlayer.network;
  assert.equal(nextSession.hlsLastNetworkErrorAt, 0);
  assert.equal(nextSession.hlsStallEpisodeActive, false);
  assert.equal(nextSession.hlsRecentStallIncidents, 0);
  assert.equal(nextSession.hlsFastRecoverySamples, 0);
  assert.equal(nextSession.hlsStableRecoverySamples, 0);
});

test("offline to online re-arms an exhausted weak safe-point retry window", () => {
  const harness = makeHarness();
  harness.windowTarget.__livePlayer.hls();
  const instance = harness.MockHls.instances.at(-1);

  instance.emit(harness.MockHls.Events.ERROR, {
    fatal: true,
    type: harness.MockHls.ErrorTypes.NETWORK_ERROR,
    details: "fragLoadError",
    response: { code: 0 }
  });
  assert.equal(harness.windowTarget.__livePlayer.network.hlsWeakNetworkMode, true);

  let attempts = 0;
  while (attempts < 12) {
    const pending = [...harness.scheduledTimeouts]
      .reverse()
      .find(record => (
        harness.timeouts.has(record.id) &&
        (record.delay === 0 || record.delay === 500)
      ));
    assert.ok(pending, `missing weak safe-point attempt ${attempts + 1}`);
    harness.timeouts.delete(pending.id);
    pending.callback();
    attempts += 1;
  }
  assert.equal(
    [...harness.scheduledTimeouts].some(record => (
      harness.timeouts.has(record.id) &&
      (record.delay === 0 || record.delay === 500)
    )),
    false
  );

  const scheduledBeforeOnline = harness.scheduledTimeouts.length;
  harness.windowTarget.dispatchEvent("offline");
  harness.windowTarget.dispatchEvent("online");
  const rearmed = harness.scheduledTimeouts
    .slice(scheduledBeforeOnline)
    .find(record => record.delay === 0 && harness.timeouts.has(record.id));
  assert.ok(rearmed, "online recovery did not re-arm the weak safe point");
});

test("already-weak fatal errors preserve protection without duplicating safe-point loops", () => {
  const harness = makeHarness();
  harness.windowTarget.__livePlayer.hls();
  const instance = harness.MockHls.instances.at(-1);
  const fatal = {
    fatal: true,
    type: harness.MockHls.ErrorTypes.NETWORK_ERROR,
    details: "fragLoadError",
    response: { code: 0 }
  };
  instance.emit(harness.MockHls.Events.ERROR, fatal);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const pending = [...harness.scheduledTimeouts]
      .reverse()
      .find(record => (
        harness.timeouts.has(record.id) &&
        (record.delay === 0 || record.delay === 500)
      ));
    assert.ok(pending, `missing safe-point attempt ${attempt + 1}`);
    harness.timeouts.delete(pending.id);
    pending.callback();
  }
  const scheduledBeforeFatal = harness.scheduledTimeouts.length;
  instance.emit(harness.MockHls.Events.ERROR, fatal);

  assert.equal(harness.windowTarget.__livePlayer.network.hlsWeakNetworkMode, true);
  assert.equal(instance.config.lowLatencyMode, true);
  assert.equal(instance.config.liveSyncDuration, 12);
  assert.equal(
    harness.scheduledTimeouts.slice(scheduledBeforeFatal).some(record => (
      harness.timeouts.has(record.id) &&
      (record.delay === 0 || record.delay === 500)
    )),
    false
  );
});

test("resume after paused safe-point exhaustion remains stable without a forced seek", () => {
  const harness = makeHarness();
  harness.windowTarget.__livePlayer.hls();
  const instance = harness.MockHls.instances.at(-1);
  harness.video.paused = true;
  harness.video.seeking = false;
  harness.video.ended = false;
  harness.video.readyState = 4;
  harness.video.currentTime = 105;
  harness.video.buffered = { length: 1, start: () => 90, end: () => 112 };
  instance.liveSyncPosition = 100;
  instance.emit(harness.MockHls.Events.ERROR, {
    fatal: true,
    type: harness.MockHls.ErrorTypes.NETWORK_ERROR,
    details: "fragLoadError",
    response: { code: 0 }
  });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const pending = [...harness.scheduledTimeouts]
      .reverse()
      .find(record => (
        harness.timeouts.has(record.id) &&
        (record.delay === 0 || record.delay === 500)
      ));
    assert.ok(pending);
    harness.timeouts.delete(pending.id);
    pending.callback();
  }
  harness.video.paused = false;
  harness.video.dispatchEvent("playing");
  assert.equal(harness.video.currentTime, 105);
  assert.equal(harness.windowTarget.__livePlayer.network.hlsWeakNetworkMode, true);
  assert.equal(instance.config.liveSyncDuration, 12);
});

test("a stale safe-point retry cannot seek or re-arm a replacement session", () => {
  const harness = makeHarness();
  harness.windowTarget.__livePlayer.hls();
  const first = harness.MockHls.instances.at(-1);
  harness.video.paused = true;
  first.emit(harness.MockHls.Events.ERROR, {
    fatal: true,
    type: harness.MockHls.ErrorTypes.NETWORK_ERROR,
    details: "fragLoadError",
    response: { code: 0 }
  });
  const stale = [...harness.scheduledTimeouts]
    .reverse()
    .find(record => record.delay === 0 && harness.timeouts.has(record.id));
  assert.ok(stale);

  harness.windowTarget.__livePlayer.hls();
  const current = harness.MockHls.instances.at(-1);
  harness.video.paused = false;
  harness.video.seeking = false;
  harness.video.ended = false;
  harness.video.readyState = 4;
  harness.video.currentTime = 105;
  harness.video.buffered = { length: 1, start: () => 90, end: () => 112 };
  current.liveSyncPosition = 100;
  const scheduledBeforeStale = harness.scheduledTimeouts.length;
  stale.callback();

  assert.equal(harness.video.currentTime, 105);
  assert.equal(harness.windowTarget.__liveHls, current);
  assert.equal(
    harness.scheduledTimeouts.slice(scheduledBeforeStale).some(record => (
      harness.timeouts.has(record.id) && record.delay === 500
    )),
    false
  );
});

test("an intentional weak safe-point seek cannot become a second hard resync", () => {
  const harness = makeHarness();
  harness.windowTarget.__livePlayer.hls();
  const instance = harness.MockHls.instances.at(-1);
  harness.video.paused = false;
  harness.video.seeking = false;
  harness.video.ended = false;
  harness.video.readyState = 4;
  harness.video.currentTime = 105;
  harness.video.buffered = { length: 1, start: () => 90, end: () => 112 };
  instance.liveSyncPosition = 100;

  instance.emit(harness.MockHls.Events.ERROR, {
    fatal: true,
    type: harness.MockHls.ErrorTypes.NETWORK_ERROR,
    details: "fragLoadError",
    response: { code: 0 }
  });
  const safePoint = [...harness.scheduledTimeouts]
    .reverse()
    .find(record => record.delay === 0 && harness.timeouts.has(record.id));
  assert.ok(safePoint);
  harness.timeouts.delete(safePoint.id);
  safePoint.callback();
  assert.equal(harness.video.currentTime, 100);

  harness.video.dispatchEvent("waiting");
  harness.video.dispatchEvent("stalled");
  harness.video.dispatchEvent("playing");
  assert.equal(
    [...harness.scheduledTimeouts].some(record => (
      harness.timeouts.has(record.id) && record.delay === 1000
    )),
    false
  );
  assert.equal(harness.video.currentTime, 100);
  assert.equal(harness.windowTarget.__livePlayer.network.hlsRecentStallIncidents, 0);
});

test("WN-NEW-03: 200ms playing does not split one physical stall episode", () => {
  const harness = makeHarness();
  harness.windowTarget.__livePlayer.hls();
  const instance = harness.MockHls.instances.at(-1);
  instance.emit(harness.MockHls.Events.MANIFEST_PARSED, {
    levels: [{ videoCodec: "avc1.42E01E", bitrate: 5_000_000 }],
    audioTracks: []
  });
  instance.bandwidthEstimate = 5_500_000;
  harness.video.currentTime = 10;
  harness.video.buffered = { length: 0, start: () => 0, end: () => 0 };
  [...harness.intervals.values()][0]();
  harness.advanceTime(8000);

  harness.video.dispatchEvent("waiting");
  assert.equal(harness.windowTarget.__livePlayer.network.hlsRecentStallIncidents, 1);
  harness.advanceTime(2000);
  harness.video.dispatchEvent("playing");
  harness.advanceTime(200);
  harness.video.dispatchEvent("waiting");

  const network = harness.windowTarget.__livePlayer.network;
  assert.equal(network.hlsRecentStallIncidents, 1);
  assert.equal(network.hlsStallEpisodeActive, true);
  assert.equal(network.hlsWeakNetworkMode, false);
});

test("WN-NEW-05: sustained playing ends the episode before an independent stall", () => {
  const harness = makeHarness();
  harness.windowTarget.__livePlayer.hls();
  const instance = harness.MockHls.instances.at(-1);
  instance.emit(harness.MockHls.Events.MANIFEST_PARSED, {
    levels: [{ videoCodec: "avc1.42E01E", bitrate: 5_000_000 }],
    audioTracks: []
  });
  instance.bandwidthEstimate = 5_500_000;
  harness.video.currentTime = 10;
  harness.video.buffered = { length: 0, start: () => 0, end: () => 0 };
  [...harness.intervals.values()][0]();
  harness.advanceTime(8000);

  harness.video.dispatchEvent("waiting");
  harness.advanceTime(2000);
  harness.video.dispatchEvent("playing");
  const confirmation = [...harness.scheduledTimeouts]
    .reverse()
    .find(record => record.delay === 1000 && harness.timeouts.has(record.id));
  assert.ok(confirmation, "sustained-playing confirmation was not scheduled");
  harness.advanceTime(1000);
  harness.timeouts.delete(confirmation.id);
  confirmation.callback();
  assert.equal(harness.windowTarget.__livePlayer.network.hlsStallEpisodeActive, false);

  harness.advanceTime(2000);
  harness.video.dispatchEvent("waiting");
  const network = harness.windowTarget.__livePlayer.network;
  assert.equal(network.hlsRecentStallIncidents, 2);
  assert.equal(network.hlsWeakNetworkMode, true);
});

test("100ms and 500ms playing pulses remain inside the same stall episode", () => {
  for (const pulseMs of [100, 500]) {
    const harness = makeHarness();
    harness.windowTarget.__livePlayer.hls();
    const instance = harness.MockHls.instances.at(-1);
    instance.emit(harness.MockHls.Events.MANIFEST_PARSED, {
      levels: [{ videoCodec: "avc1.42E01E", bitrate: 5_000_000 }],
      audioTracks: []
    });
    instance.bandwidthEstimate = 5_500_000;
    harness.video.currentTime = 10;
    harness.video.buffered = { length: 0, start: () => 0, end: () => 0 };
    [...harness.intervals.values()][0]();
    harness.advanceTime(8000);

    harness.video.dispatchEvent("waiting");
    harness.advanceTime(2000);
    harness.video.dispatchEvent("playing");
    harness.advanceTime(pulseMs);
    harness.video.dispatchEvent("stalled");
    const network = harness.windowTarget.__livePlayer.network;
    assert.equal(network.hlsRecentStallIncidents, 1, `${pulseMs}ms pulse split the episode`);
    assert.equal(network.hlsWeakNetworkMode, false, `${pulseMs}ms pulse entered weak mode`);
  }
});

test("a stale recovery confirmation cannot end the current generation's episode", () => {
  const harness = makeHarness();
  harness.windowTarget.__livePlayer.hls();
  const first = harness.MockHls.instances.at(-1);
  first.emit(harness.MockHls.Events.MANIFEST_PARSED, {
    levels: [{ videoCodec: "avc1.42E01E", bitrate: 5_000_000 }],
    audioTracks: []
  });
  first.bandwidthEstimate = 5_500_000;
  harness.video.currentTime = 10;
  harness.video.buffered = { length: 0, start: () => 0, end: () => 0 };
  [...harness.intervals.values()][0]();
  harness.advanceTime(8000);
  harness.video.dispatchEvent("waiting");
  harness.video.dispatchEvent("playing");
  const staleConfirmation = [...harness.scheduledTimeouts]
    .reverse()
    .find(record => record.delay === 1000 && harness.timeouts.has(record.id));
  assert.ok(staleConfirmation);

  harness.windowTarget.__livePlayer.hls();
  const current = harness.MockHls.instances.at(-1);
  current.emit(harness.MockHls.Events.MANIFEST_PARSED, {
    levels: [{ videoCodec: "avc1.42E01E", bitrate: 5_000_000 }],
    audioTracks: []
  });
  current.bandwidthEstimate = 5_500_000;
  [...harness.intervals.values()][0]();
  harness.advanceTime(8000);
  harness.video.dispatchEvent("waiting");
  const before = harness.windowTarget.__livePlayer.network;
  assert.equal(before.hlsStallEpisodeActive, true);
  assert.equal(before.hlsRecentStallIncidents, 1);

  staleConfirmation.callback();
  const after = harness.windowTarget.__livePlayer.network;
  assert.equal(after.hlsStallEpisodeActive, true);
  assert.equal(after.hlsRecentStallIncidents, 1);
  assert.equal(harness.windowTarget.__liveHls, current);
});

test("paused or seeking media cannot confirm stall recovery", () => {
  for (const mediaState of [
    { paused: true, seeking: false },
    { paused: false, seeking: true }
  ]) {
    const harness = makeHarness();
    harness.windowTarget.__livePlayer.hls();
    const instance = harness.MockHls.instances.at(-1);
    instance.emit(harness.MockHls.Events.MANIFEST_PARSED, {
      levels: [{ videoCodec: "avc1.42E01E", bitrate: 5_000_000 }],
      audioTracks: []
    });
    instance.bandwidthEstimate = 5_500_000;
    harness.video.currentTime = 10;
    harness.video.buffered = { length: 0, start: () => 0, end: () => 0 };
    [...harness.intervals.values()][0]();
    harness.advanceTime(8000);
    harness.video.dispatchEvent("waiting");
    harness.video.dispatchEvent("playing");
    const confirmation = [...harness.scheduledTimeouts]
      .reverse()
      .find(record => record.delay === 1000 && harness.timeouts.has(record.id));
    assert.ok(confirmation);
    harness.video.paused = mediaState.paused;
    harness.video.seeking = mediaState.seeking;
    harness.timeouts.delete(confirmation.id);
    confirmation.callback();
    assert.equal(harness.windowTarget.__livePlayer.network.hlsStallEpisodeActive, true);
  }
});

// Real app.js runs in the same browser harness; only transport/stats are controlled.
function makeWhepHarness() {
  const h = makeHarness();
  class Peer extends MockEventTarget {
    constructor() { super(); this.connectionState = "new"; this.iceConnectionState = "new"; this.iceGatheringState = "complete"; }
    addTransceiver() {}
    createOffer() { return Promise.resolve({ type: "offer", sdp: "v=0\r\na=rtpmap:96 H264/90000\r\n" }); }
    setLocalDescription(value) { this.localDescription = value; return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    close() { this.connectionState = "closed"; }
    getStats() { return Promise.resolve(new Map()); }
  }
  class Stream {
    constructor() { this.tracks = []; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
    addTrack(track) { this.tracks.push(track); }
  }
  h.context.RTCPeerConnection = class extends Peer { constructor() { super(); h.peer = this; } };
  h.context.MediaStream = Stream;
  h.windowTarget.RTCPeerConnection = h.context.RTCPeerConnection;
  h.context.fetch = (url, options) => new Promise((resolve, reject) => h.fetchRequests.push({ url, options, resolve, reject }));
  return h;
}

function whepResponse(status, body = "v=0\r\na=rtpmap:96 H264/90000\r\n", headers = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => body, headers: { get: k => headers[k] || null } };
}

async function beginWhep(h) {
  const firstRequest = h.fetchRequests.length;
  const promise = h.windowTarget.__livePlayer.whep();
  // Metadata and POST are now independent; select by request identity, not
  // whichever request happens to be last after a particular microtask count.
  const metadata = h.fetchRequests.slice(firstRequest).find(r => r.url === "/live/index.m3u8");
  assert.ok(metadata, "current WHEP metadata request missing");
  metadata.resolve(manifestResponse("avc1.42E01E,opus"));
  await flushAsyncWork();
  await flushAsyncWork();
  await new Promise(resolve => setImmediate(resolve));
  const request = h.fetchRequests.slice(firstRequest).find(r => r.url === "/rtc/live/whep" && r.options?.method === "POST");
  assert.equal(request?.options?.headers?.["Content-Type"], "application/sdp", JSON.stringify({ status: h.elements.get("status").textContent, requests: h.fetchRequests.map(r => ({url:r.url,options:r.options})), peer: Boolean(h.peer) }));
  return { promise, request, metadata, peer: h.peer };
}

test("V5: AUTO chooses WHEP even when HLS works; unsupported falls back", async () => {
  const h = makeWhepHarness();
  const pending = h.windowTarget.__livePlayer.auto();
  h.fetchRequests.at(-1).resolve(manifestResponse("avc1.42E01E,opus"));
  await flushAsyncWork(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.MockHls.instances.length, 0);
  assert.equal(h.fetchRequests.at(-1).options?.method, "POST");
  h.fetchRequests.at(-1).resolve(whepResponse(400, "unsupported", { "X-WHEP-Error": "unsupported-codec" }));
  await pending;
  assert.equal(h.windowTarget.__livePlayer.mode.active, "hls");
});

test("V5: manual HLS and manual WHEP retain their routes", async () => {
  const h = makeWhepHarness();
  h.elements.get("hlsMode").dispatchEvent("click");
  assert.equal(h.windowTarget.__livePlayer.mode.active, "hls");
  const p = await beginWhep(h);
  assert.equal(h.windowTarget.__livePlayer.mode.active, "whep");
  p.request.resolve(whepResponse(201)); await p.promise;
});

function runningHls() {
  const h = makeHarness(); h.windowTarget.__livePlayer.hls();
  const instance = h.MockHls.instances.at(-1);
  instance.emit(h.MockHls.Events.MANIFEST_PARSED, { levels: [{ bitrate: 4000000, videoCodec: "avc1.42E01E" }] });
  h.video.currentTime = 105; h.video.readyState = 4; h.video.paused = false;
  h.video.seeking = false; h.video.ended = false;
  let ahead = 5.5;
  h.video.buffered = { length: 1, start: () => 90, end: () => h.video.currentTime + ahead };
  h.ahead = value => { ahead = value; };
  h.tick = () => { h.advanceTime(1000); for (const callback of [...h.intervals.values()]) callback(); };
  h.instance = instance;
  return h;
}

test("V8: playlist timeout enters protection before buffer starvation without source reload", () => {
  const h = runningHls();
  h.instance.bandwidthEstimate = 100000000;
  for (let i = 0; i < 10; i++) h.tick();
  h.ahead(3); h.video.playbackRate = 1.05;
  let reloads = 0; h.instance.loadSource = () => { reloads++; };
  h.instance.emit(h.MockHls.Events.ERROR, { type: "networkError", details: "levelLoadTimeOut", fatal: false });
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakNetworkMode, true);
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakNetworkClass, "bandwidth-loss");
  assert.equal(h.video.playbackRate, 1);
  assert.equal(h.instance.config.liveSyncDuration, 12);
  assert.equal(h.instance.config.lowLatencyMode, true);
  assert.equal(h.instance.destroyed, false);
  assert.equal(reloads, 0);
  const entered = h.windowTarget.__livePlayer.network.hlsWeakEnterTimestamp;
  h.instance.emit(h.MockHls.Events.ERROR, { type: "networkError", details: "audioTrackLoadTimeOut", fatal: false });
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakEnterTimestamp, entered);
  h.windowTarget.__livePlayer.hls();
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakNetworkMode, false);
  assert.equal(h.MockHls.instances.at(-1).config.liveSyncDuration, 6);
});

function profileSnapshot(h) {
  const c = h.instance.config;
  return { lowLatencyMode: c.lowLatencyMode, liveSyncDuration: c.liveSyncDuration,
    targetLatency: h.instance.targetLatency ?? c.liveSyncDuration,
    liveMaxLatencyDuration: c.liveMaxLatencyDuration, maxBufferLength: c.maxBufferLength,
    maxMaxBufferLength: c.maxMaxBufferLength, maxLiveSyncPlaybackRate: c.maxLiveSyncPlaybackRate,
    playbackRate: h.video.playbackRate };
}

function partSample(h, overheadMs) {
  h.instance.emit(h.MockHls.Events.FRAG_LOADED, {
    frag: { type: "main", sn: 1 },
    part: { duration: 1, stats: { loaded: 500000, retry: 0, aborted: false,
      loading: { start: 100, first: 1100 + overheadMs, end: 1400 + overheadMs } } }
  });
}

test("V5: normal whole-segment cadence builds baseline; natural part generation wait is excluded", () => {
  const h = runningHls(); h.ahead(6);
  for (let i = 0; i < 4; i += 1) {
    h.tick();
    h.instance.emit(h.MockHls.Events.FRAG_LOADED, { part: null, frag: {
      type: "main", sn: i, duration: 2, stats: { loaded: 500000, retry: 0,
        loading: { start: 100, first: 150, end: 400 } }
    } });
  }
  assert.equal(h.windowTarget.__livePlayer.network.hlsRequestOverheadBaselineMs, 50);
  h.ahead(4);
  for (let i = 0; i < 4; i += 1) { h.tick(); partSample(h, 0); }
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakNetworkMode, false);
  for (let i = 0; i < 4; i += 1) { h.tick(); partSample(h, 350); }
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakNetworkClass, "rtt");
});

test("V5: normal playback remains isolated for 120 ticks", () => {
  const h = runningHls(); const fresh = profileSnapshot(h);
  h.video.playbackRate = 1.03;
  for (let i = 0; i < 120; i += 1) { h.tick(); partSample(h, 50); }
  assert.equal(h.video.currentTime, 105);
  assert.equal(h.video.playbackRate, 1.03);
  assert.equal(h.instance.config.lowLatencyMode, true);
  assert.equal(h.instance.config.liveSyncDuration, 6);
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakNetworkClass, "");
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakBufferReady, false);
  assert.doesNotMatch(h.elements.get("status").textContent, /稳定缓冲已建立/);
  assert.equal(fresh.maxBufferLength, 10);
});

for (const kind of ["bandwidth-loss", "rtt"]) {
  test(`V5: ${kind} BUILDING -> actual READY -> drop -> exact recovered NORMAL`, () => {
    const h = runningHls(); const fresh = profileSnapshot(h);
    if (kind === "rtt") {
      h.ahead(6);
      for (let i = 0; i < 4; i += 1) { h.tick(); partSample(h, 50); }
      h.ahead(5);
      for (let i = 0; i < 4; i += 1) { h.tick(); partSample(h, 350); }
    } else {
      h.instance.bandwidthEstimate = 4400000;
      for (const b of [5.5, 4.9, 4.3, 3.7]) { h.ahead(b); h.tick(); }
    }
    let n = h.windowTarget.__livePlayer.network;
    assert.equal(n.hlsWeakNetworkClass, kind);
    assert.equal(n.hlsWeakBufferReady, false);
    assert.equal(h.instance.config.lowLatencyMode, kind !== "rtt");
    assert.equal(h.instance.targetLatency, 12);
    assert.match(h.elements.get("status").textContent, /建立.*安全缓冲|建立安全缓冲/);
    h.ahead(7.9); h.tick(); assert.equal(h.windowTarget.__livePlayer.network.hlsWeakBufferReady, false);
    h.ahead(8); h.tick(); assert.equal(h.windowTarget.__livePlayer.network.hlsWeakBufferReady, true);
    assert.match(h.elements.get("status").textContent, /实际前向缓冲约 8.0 秒/);
    h.ahead(6); h.tick(); assert.equal(h.windowTarget.__livePlayer.network.hlsWeakBufferReady, true);
    h.ahead(5.9); h.tick(); assert.equal(h.windowTarget.__livePlayer.network.hlsWeakBufferReady, false);
    assert.equal(h.windowTarget.__livePlayer.network.hlsWeakNetworkMode, true);
    h.ahead(8.5); h.instance.bandwidthEstimate = 8000000;
    for (let i = 0; i < 21; i += 1) h.tick();
    assert.deepEqual(profileSnapshot(h), fresh);
    n = h.windowTarget.__livePlayer.network;
    assert.equal(n.hlsWeakNetworkClass, ""); assert.equal(n.hlsWeakBufferReady, false);
    assert.equal(n.hlsRequestOverheadBaselineMs, null); assert.equal(n.hlsLastWeakSafePointAt, 0);
  });
}

test("V5: seek assignment succeeds but only 5.5s actually remains: never claim READY", () => {
  const h = runningHls(); h.ahead(5.5); h.instance.liveSyncPosition = 100;
  h.instance.emit(h.MockHls.Events.ERROR, { fatal: true, type: "networkError", details: "fragLoadError" });
  const pending = [...h.scheduledTimeouts].reverse().find(t => t.delay === 0 && h.timeouts.has(t.id));
  h.timeouts.delete(pending.id); pending.callback();
  assert.equal(h.video.currentTime, 100, "safe seek must really be issued");
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakBufferReady, false);
  h.video.dispatchEvent("seeked"); h.tick();
  assert.equal(h.windowTarget.__livePlayer.network.hlsBufferAheadSeconds, 5.5);
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakBufferReady, false);
  assert.doesNotMatch(h.elements.get("status").textContent, /稳定缓冲已建立/);
});

test("V5: building cannot recover using a latency target and shallow actual buffer", () => {
  const h = runningHls();
  h.instance.emit(h.MockHls.Events.ERROR, { fatal: true, type: "networkError", details: "fragLoadError" });
  partSample(h, 50); h.ahead(6.5);
  for (let i = 0; i < 60; i += 1) h.tick();
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakNetworkMode, true);
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakBufferReady, false);
});

test("V5: exhausted safe point retries continue on monitor, seek once, then reset all weak state", () => {
  const h = runningHls(); h.video.paused = true;
  h.instance.emit(h.MockHls.Events.ERROR, { fatal: true, type: "networkError", details: "fragLoadError" });
  let stale;
  for (let i = 0; i < 12; i += 1) {
    const p = [...h.scheduledTimeouts].reverse().find(t => h.timeouts.has(t.id) && [0, 500].includes(t.delay));
    stale = p; h.timeouts.delete(p.id); p.callback();
  }
  h.video.paused = false; h.instance.liveSyncPosition = 100; h.tick();
  assert.equal(h.video.currentTime, 100);
  h.instance.liveSyncPosition = 95;
  for (let i = 0; i < 40; i += 1) h.tick();
  assert.equal(h.video.currentTime, 100, "one successful backtrack per weak episode");
  h.windowTarget.__livePlayer.hls(); stale.callback();
  const n = h.windowTarget.__livePlayer.network;
  assert.equal(n.hlsWeakNetworkClass, ""); assert.equal(n.hlsWeakBufferReady, false);
  assert.equal(n.hlsBufferSlope, null); assert.equal(n.hlsRequestOverheadMs, null);
  assert.equal(n.hlsRequestOverheadBaselineMs, null); assert.equal(n.hlsLastWeakSafePointAt, 0);
  assert.equal(n.hlsRecentStallIncidents, 0);
});

test("V5: RTT upgrades once on fatal loss and cannot oscillate back", () => {
  const h = runningHls(); h.ahead(6);
  for (let i = 0; i < 4; i += 1) { h.tick(); partSample(h, 50); }
  h.ahead(5);
  for (let i = 0; i < 4; i += 1) { h.tick(); partSample(h, 350); }
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakNetworkClass, "rtt");
  h.instance.emit(h.MockHls.Events.ERROR, { fatal: true, type: "networkError", details: "fragLoadError" });
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakNetworkClass, "bandwidth-loss");
  assert.equal(h.instance.config.lowLatencyMode, true);
  for (let i = 0; i < 20; i += 1) { h.tick(); partSample(h, 400); }
  assert.equal(h.windowTarget.__livePlayer.network.hlsWeakNetworkClass, "bandwidth-loss");
});

test("V5: auto without RTCPeerConnection uses HLS; stale auto WHEP cannot override manual HLS", async () => {
  const noRtc = makeHarness();
  noRtc.fetchRequests[0].resolve(manifestResponse("avc1.42E01E,opus"));
  await flushAsyncWork(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(noRtc.windowTarget.__livePlayer.mode.active, "hls");
  const h = makeWhepHarness();
  const old = h.windowTarget.__livePlayer.auto(); const request = h.fetchRequests.at(-1);
  h.elements.get("hlsMode").dispatchEvent("click");
  request.resolve(manifestResponse("avc1.42E01E,opus")); await old;
  assert.equal(h.windowTarget.__livePlayer.mode.requested, "hls");
  assert.equal(h.windowTarget.__livePlayer.mode.active, "hls");
  assert.equal(h.peer.connectionState, "closed");
});

test("V5: automatic WHEP establishment errors reuse bounded recovery then HLS fallback", async () => {
  const h = makeWhepHarness();
  const first = h.windowTarget.__livePlayer.auto();
  h.fetchRequests.at(-1).resolve(manifestResponse("avc1.42E01E,opus"));
  await flushAsyncWork(); await new Promise(resolve => setImmediate(resolve));
  h.fetchRequests.at(-1).resolve(whepResponse(503)); await first;
  assert.equal(h.windowTarget.__livePlayer.network.whepReconnectAttempts, 1);
  const retry = [...h.scheduledTimeouts].reverse().find(t => h.timeouts.has(t.id) && t.delay === 3000);
  assert.ok(retry); h.timeouts.delete(retry.id); retry.callback();
  h.fetchRequests.at(-1).resolve(manifestResponse("avc1.42E01E,opus"));
  await flushAsyncWork(); await new Promise(resolve => setImmediate(resolve));
  h.fetchRequests.at(-1).resolve(whepResponse(503));
  await flushAsyncWork(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.windowTarget.__livePlayer.network.whepReconnectAttempts, 2);
  const fallback = [...h.scheduledTimeouts].reverse().find(t => h.timeouts.has(t.id) && t.delay === 5000);
  assert.ok(fallback); h.timeouts.delete(fallback.id); fallback.callback();
  assert.equal(h.windowTarget.__livePlayer.mode.active, "hls");
  assert.equal(h.MockHls.instances.length, 1);
});

test("V5: auto attempts WHEP even with a hung HLS metadata request", async () => {
  const h = makeWhepHarness();
  const pending = h.windowTarget.__livePlayer.auto();
  await flushAsyncWork(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.fetchRequests.at(-1).options?.method, "POST");
  h.fetchRequests.at(-1).resolve(whepResponse(201)); await pending;
  assert.equal(h.windowTarget.__livePlayer.mode.active, "whep");
});

test("V5: auto hung WHEP POST is bounded and late 201 deletes only its stale session", async () => {
  const h = makeWhepHarness();
  const pending = h.windowTarget.__livePlayer.auto();
  h.fetchRequests.at(-1).resolve(manifestResponse("avc1.42E01E,opus"));
  await flushAsyncWork(); await new Promise(resolve => setImmediate(resolve));
  const post = h.fetchRequests.at(-1);
  const deadline = [...h.scheduledTimeouts].find(t => h.timeouts.has(t.id) && t.delay === 15000);
  assert.ok(deadline, "auto needs a pre-answer deadline");
  h.timeouts.delete(deadline.id); deadline.callback();
  const retry = [...h.scheduledTimeouts].reverse().find(t => h.timeouts.has(t.id) && t.delay === 3000);
  assert.ok(retry); h.timeouts.delete(retry.id); retry.callback();
  await flushAsyncWork(); await new Promise(resolve => setImmediate(resolve));
  const secondDeadline = [...h.scheduledTimeouts].find(t => h.timeouts.has(t.id) && t.delay === 15000);
  assert.ok(secondDeadline); h.timeouts.delete(secondDeadline.id); secondDeadline.callback();
  const fallback = [...h.scheduledTimeouts].reverse().find(t => h.timeouts.has(t.id) && t.delay === 5000);
  assert.ok(fallback); h.timeouts.delete(fallback.id); fallback.callback();
  const current = h.windowTarget.__liveHls;
  post.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/late" })); await pending;
  assert.equal(h.windowTarget.__liveHls, current);
  assert.equal(h.fetchRequests.at(-1).options.method, "DELETE");
  assert.equal(h.fetchRequests.at(-1).url, "https://live.example.test/rtc/live/whep/late");
});

for (const phase of ["fetch", "body"]) {
  test(`F-01: stale WHEP ${phase} error cannot destroy replacement HLS`, async () => {
    const h = makeWhepHarness();
    const pending = await beginWhep(h);
    const response = whepResponse(400, "codec unsupported", { "X-WHEP-Error": "unsupported-codec" });
    let finishBody;
    if (phase === "body") {
      response.text = () => new Promise(resolve => { finishBody = resolve; });
      pending.request.resolve(response);
      await flushAsyncWork();
    }
    h.elements.get("hlsMode").dispatchEvent("click");
    const current = h.MockHls.instances.at(-1);
    if (phase === "body") finishBody("codec unsupported"); else pending.request.resolve(response);
    await pending.promise;
    assert.equal(current.destroyed, false);
    assert.equal(h.MockHls.instances.length, 1);
    h.windowTarget.dispatchEvent("beforeunload");
  });
}

test("F-01: current codec error falls back and stale 201 releases only its own session", async () => {
  const current = makeWhepHarness();
  const first = await beginWhep(current);
  first.request.resolve(whepResponse(400, "codec unsupported", { "X-WHEP-Error": "unsupported-codec" }));
  await first.promise;
  assert.equal(current.MockHls.instances.length, 1);
  current.windowTarget.dispatchEvent("beforeunload");
  const h = makeWhepHarness(), p = await beginWhep(h);
  h.elements.get("hlsMode").dispatchEvent("click");
  const replacement = h.MockHls.instances.at(-1);
  p.request.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/old" }));
  await p.promise;
  assert.equal(replacement.destroyed, false);
  assert.ok(h.fetchRequests.some(r => r.options?.method === "DELETE" && r.url.endsWith("/old")));
  h.windowTarget.dispatchEvent("beforeunload");
});

test("F-01: pending ICE summary cannot replace a new auto-mode HLS player", async () => {
  const h = makeWhepHarness(), p = await beginWhep(h);
  p.request.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/old" })); await p.promise;
  const timer = h.scheduledTimeouts.findLast(t => t.delay === 15000 && h.timeouts.has(t.id));
  assert.ok(timer);
  let finish; p.peer.getStats = () => new Promise(resolve => { finish = resolve; });
  const work = timer.callback(); await flushAsyncWork();
  h.windowTarget.__livePlayer.hls();
  const replacement = h.MockHls.instances.at(-1);
  finish(new Map()); await work;
  assert.equal(replacement.destroyed, false);
  assert.equal(h.MockHls.instances.length, 1);
  h.windowTarget.dispatchEvent("beforeunload");
});

test("F-01: stale keepalive 404 cannot cancel a replacement session heartbeat", async () => {
  const h = makeWhepHarness(), old = await beginWhep(h);
  old.request.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/old" })); await old.promise;
  const callback = [...h.intervals.values()][0];
  const work = callback(); const request = h.fetchRequests.at(-1);
  const next = await beginWhep(h);
  next.request.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/new" })); await next.promise;
  const timers = [...h.intervals.keys()];
  request.resolve(whepResponse(404)); await work;
  assert.deepEqual([...h.intervals.keys()], timers);
  h.windowTarget.dispatchEvent("beforeunload");
});

async function connectedSyncHarness() {
  const h = makeWhepHarness(), p = await beginWhep(h);
  p.request.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/sync" })); await p.promise;
  p.peer.connectionState = "connected"; p.peer.dispatchEvent("connectionstatechange");
  h.video.paused = false;
  h.monitor = () => [...h.intervals.values()].at(-1)();
  let samples = 0;
  p.peer.getStats = async () => new Map([
    ["a", { type: "inbound-rtp", kind: "audio", estimatedPlayoutTimestamp: 200000 + (samples++ >= 3 ? 1000 : 0) }],
    ["v", { type: "inbound-rtp", kind: "video", estimatedPlayoutTimestamp: 200000 }]
  ]);
  h.sample = async () => { h.advanceTime(2000); await h.monitor(); };
  h.resync = () => h.scheduledTimeouts.findLast(t => t.delay === 150 && h.timeouts.has(t.id));
  return h;
}

test("WHIP stall: converging startup playout must settle before calibrating sync", async () => {
  const h = await connectedSyncHarness();
  const offsets = [-520, -460, -400, -300, -220, -130, -80, -40, -20, -10, -8, -5];
  let i = 0;
  h.peer.getStats = async () => new Map([
    ["a", { type: "inbound-rtp", kind: "audio", estimatedPlayoutTimestamp: 200000 + offsets[Math.min(i++, offsets.length - 1)] }],
    ["v", { type: "inbound-rtp", kind: "video", estimatedPlayoutTimestamp: 200000 }]
  ]);
  for (let j = 0; j < offsets.length; j++) {
    await h.sample();
    assert.equal(h.resync(), undefined, "improving browser A/V alignment must not restart healthy playback");
  }
  const baseline = h.windowTarget.__livePlayer.sync.whepPlayoutBaselineMs;
  assert.ok(baseline >= -40 && baseline <= 0, `baseline must reflect settled samples, got ${baseline}`);
  h.windowTarget.dispatchEvent("beforeunload");
});

for (const state of ["paused", "seeking"]) {
  test(`F-02: ${state} WHEP never schedules drift recovery`, async () => {
    const h = await connectedSyncHarness(); h.video[state] = true;
    for (let i = 0; i < 8; i++) await h.sample();
    assert.equal(h.resync(), undefined);
    assert.equal(h.windowTarget.__livePlayer.sync.whepPlayoutBaselineMs, null);
    h.windowTarget.dispatchEvent("beforeunload");
  });
}

test("F-02: pause during getStats discards that sample", async () => {
  const h = await connectedSyncHarness();
  let finish; h.peer.getStats = () => new Promise(resolve => { finish = resolve; });
  const work = h.sample(); await flushAsyncWork(); h.video.paused = true;
  finish(new Map()); await work;
  assert.equal(h.windowTarget.__livePlayer.sync.whepLastSyncMetric, "");
  assert.equal(h.resync(), undefined);
  h.windowTarget.dispatchEvent("beforeunload");
});

test("F-02: pause cancels pending recovery, resume calibrates fresh stats", async () => {
  const h = await connectedSyncHarness();
  for (let i = 0; i < 8; i++) await h.sample();
  const timer = h.resync(); assert.ok(timer, "playing drift must still recover");
  h.video.paused = true; h.video.dispatchEvent("pause");
  assert.equal(h.resync(), undefined);
  h.video.paused = false; h.video.dispatchEvent("play");
  for (let i = 0; i < 8; i++) await h.sample();
  assert.equal(h.resync(), undefined, "the resumed fixed offset must become a new baseline");
  assert.equal(h.windowTarget.__livePlayer.sync.whepPlayoutBaselineMs, 1000);
  h.windowTarget.dispatchEvent("beforeunload");
});

test("F-02: late tracks and automatic WHEP restart preserve user pause", async () => {
  const h = await connectedSyncHarness();
  h.peer.dispatchEvent({ type: "track", track: { id: "v", kind: "video" } });
  h.video.paused = true; h.video.dispatchEvent("pause");
  h.peer.dispatchEvent({ type: "track", track: { id: "a", kind: "audio" } });
  assert.equal(h.video.paused, true);
  const next = await beginWhep(h);
  next.request.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/new" })); await next.promise;
  next.peer.dispatchEvent({ type: "track", track: { id: "v2", kind: "video" } });
  assert.equal(h.video.paused, true);
  h.windowTarget.dispatchEvent("beforeunload");
});

test("DBG-V5-01 RED-01 / G-01: manual WHEP starts POST with held metadata", async () => {
  const h = makeWhepHarness();
  h.elements.get("whepMode").dispatchEvent("click");
  const metadata = h.fetchRequests.at(-1);
  await flushAsyncWork();
  await new Promise(resolve => setImmediate(resolve));
  const post = h.fetchRequests.find(r => r.url === "/rtc/live/whep" && r.options?.method === "POST");
  assert.ok(post, "held HLS metadata blocked manual WHEP POST");
  assert.equal(metadata.url, "/live/index.m3u8");
  assert.equal(h.windowTarget.__livePlayer.mode.requested, "whep");
  assert.equal(h.MockHls.instances.length, 0);
  h.windowTarget.dispatchEvent("beforeunload");
  post.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/red-control" }));
  await flushAsyncWork();
});

async function drainWhepWork() {
  await flushAsyncWork();
  await new Promise(resolve => setImmediate(resolve));
}

function fireSetupDeadline(h) {
  const timer = h.scheduledTimeouts.find(t => t.delay === 15000 && h.timeouts.has(t.id));
  assert.ok(timer, "missing unchanged 15s setup deadline");
  h.advanceTime(15000);
  h.timeouts.delete(timer.id);
  timer.callback();
}

async function heldManualWhep(h) {
  const firstRequest = h.fetchRequests.length;
  h.elements.get("whepMode").dispatchEvent("click");
  const metadata = h.fetchRequests.at(-1);
  await drainWhepWork();
  const post = h.fetchRequests.slice(firstRequest).find(r => r.url === "/rtc/live/whep" && r.options?.method === "POST");
  assert.ok(post, "manual POST depends on unresolved metadata");
  return { metadata, post, peer: h.peer };
}

for (const replacementMode of ["hls", "whep"]) {
  test(`DBG-V5-01 G-02/G-05: late metadata and 201 preserve new ${replacementMode}`, async () => {
    const h = makeWhepHarness(), old = await heldManualWhep(h);
    let replacement;
    if (replacementMode === "hls") {
      h.elements.get("hlsMode").dispatchEvent("click");
      replacement = h.windowTarget.__liveHls;
      replacement.emit(h.MockHls.Events.MANIFEST_PARSED, { levels: [{ videoCodec: "avc1.42E01E", audioCodec: "opus" }] });
    } else {
      const current = await beginWhep(h);
      current.request.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/new" }));
      await current.promise;
      replacement = current.peer;
    }
    await drainWhepWork();
    assert.equal(old.metadata.options.signal.aborted, true);
    const codec = h.windowTarget.__livePlayer.codec.video.value;
    const status = h.elements.get("status").textContent;
    old.metadata.resolve(manifestResponse("vp09.00.10.08,mp4a.40.2"));
    old.post.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/old" }));
    await drainWhepWork();
    assert.equal(h.windowTarget.__livePlayer.codec.video.value, codec);
    assert.equal(h.elements.get("status").textContent, status);
    assert.equal(old.peer.connectionState, "closed");
    assert.equal(replacementMode === "hls" ? replacement.destroyed : replacement.connectionState === "closed", false);
    const deleted = h.fetchRequests.filter(r => r.options?.method === "DELETE").map(r => r.url);
    assert.deepEqual(deleted, ["https://live.example.test/rtc/live/whep/old"]);
    if (replacementMode === "whep") {
      const keepalive = [...h.intervals.values()][0]();
      assert.equal(h.fetchRequests.at(-1).url, "https://live.example.test/rtc/live/whep/new");
      h.fetchRequests.at(-1).resolve(whepResponse(204));
      await keepalive;
    }
    h.windowTarget.dispatchEvent("beforeunload");
  });
}

test("DBG-V5-01 G-03: keepalive expiry rebuild starts POST with held metadata", async () => {
  const h = makeWhepHarness(), old = await beginWhep(h);
  old.request.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/expired" }));
  await old.promise;
  const firstRequest = h.fetchRequests.length;
  const keepalive = [...h.intervals.values()][0]();
  h.fetchRequests.at(-1).resolve(whepResponse(404));
  await keepalive;
  await drainWhepWork();
  const fresh = h.fetchRequests.slice(firstRequest);
  assert.ok(fresh.find(r => r.url === "/live/index.m3u8"));
  const post = fresh.find(r => r.url === "/rtc/live/whep" && r.options?.method === "POST");
  assert.ok(post, "internal default startWhep entry still waits for metadata");
  assert.equal(old.peer.connectionState, "closed");
  h.windowTarget.dispatchEvent("beforeunload");
  post.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/rebuilt" }));
  await drainWhepWork();
});

for (const phase of ["post", "body", "remote-description"]) {
  test(`DBG-V5-01 G-04/G-05: manual held ${phase} retires in 15s with owned cleanup`, async () => {
    const h = makeWhepHarness(), old = await heldManualWhep(h);
    let finish;
    if (phase === "body") {
      const response = whepResponse(201, undefined, { Location: "/rtc/live/whep/timed-out" });
      response.text = () => new Promise(resolve => { finish = resolve; });
      old.post.resolve(response);
    } else if (phase === "remote-description") {
      old.peer.setRemoteDescription = () => new Promise(resolve => { finish = resolve; });
      old.post.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/timed-out" }));
    }
    await drainWhepWork();
    fireSetupDeadline(h);
    await drainWhepWork();
    assert.equal(old.peer.connectionState, "closed");
    assert.equal(old.metadata.options.signal.aborted, true);
    assert.equal(h.windowTarget.__livePlayer.network.whepConnectionState, null);
    assert.equal(h.windowTarget.__livePlayer.mode.requested, "whep");
    assert.equal(h.MockHls.instances.length, 0);
    assert.match(h.elements.get("status").textContent, /15 秒.*重试/);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.timeouts.size, 0);
    if (phase !== "post") {
      assert.equal(h.fetchRequests.filter(r => r.options?.method === "DELETE").length, 1, "known Location must be released without waiting for body/SDP completion");
    }
    const current = await beginWhep(h);
    current.request.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/current" }));
    await current.promise;
    if (phase === "post") old.post.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/timed-out" }));
    else finish("v=0\r\n");
    await drainWhepWork();
    assert.equal(h.peer, current.peer);
    assert.notEqual(current.peer.connectionState, "closed");
    assert.deepEqual(h.fetchRequests.filter(r => r.options?.method === "DELETE").map(r => r.url), ["https://live.example.test/rtc/live/whep/timed-out"]);
    h.windowTarget.dispatchEvent("beforeunload");
  });
}

test("DBG-V5-01 G-04: held offer is bounded and caller settles on cancellation", async () => {
  const h = makeWhepHarness();
  let finishOffer;
  h.context.RTCPeerConnection.prototype.createOffer = () => new Promise(resolve => { finishOffer = resolve; });
  const pending = h.windowTarget.__livePlayer.whep();
  await drainWhepWork();
  const peer = h.peer;
  h.elements.get("hlsMode").dispatchEvent("click");
  await pending;
  assert.equal(peer.connectionState, "closed");
  finishOffer({ type: "offer", sdp: "v=0\r\n" });
  await drainWhepWork();
  assert.equal(h.fetchRequests.some(r => r.url === "/rtc/live/whep"), false);
  h.windowTarget.dispatchEvent("beforeunload");
});

test("DBG-V5-01 G-07: 100 WHEP generations cancel metadata and retire every peer", async () => {
  const h = makeWhepHarness(), attempts = [];
  for (let i = 0; i < 100; i++) {
    attempts.push(await heldManualWhep(h));
    for (const type of ["pause", "play", "seeking", "seeked"]) assert.equal(h.video.listenerCount(type), 1);
    assert.ok(h.timeouts.size <= 2, `setup timers accumulated: ${h.timeouts.size}`);
    assert.equal(h.intervals.size, 0);
  }
  h.windowTarget.dispatchEvent("beforeunload");
  for (const [i, attempt] of attempts.entries()) {
    assert.equal(attempt.peer.connectionState, "closed");
    assert.equal(attempt.metadata.options.signal.aborted, true);
    attempt.metadata.resolve(manifestResponse("vp09.00.10.08,opus"));
    attempt.post.resolve(whepResponse(201, undefined, { Location: `/rtc/live/whep/stale-${i}` }));
  }
  await drainWhepWork();
  for (const type of ["pause", "play", "seeking", "seeked"]) assert.equal(h.video.listenerCount(type), 0);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.fetchRequests.filter(r => r.options?.method === "DELETE").length, 100);
  assert.equal(h.windowTarget.__livePlayer.codec.video.value, "");
});

test("DBG-V5-01 G-01: unsupported manual WHEP reports failure without changing mode", async () => {
  const h = makeWhepHarness(), attempt = await heldManualWhep(h);
  attempt.post.resolve(whepResponse(400, "unsupported", { "X-WHEP-Error": "unsupported-codec" }));
  await drainWhepWork();
  assert.equal(h.windowTarget.__livePlayer.mode.requested, "whep");
  assert.equal(h.MockHls.instances.length, 0);
  assert.equal(attempt.peer.connectionState, "closed");
  assert.match(h.elements.get("status").textContent, /播放失败/);
  h.windowTarget.dispatchEvent("beforeunload");
});

test("DBG-V5-01 G-02: metadata deadline cannot clear a connected SDP codec", async () => {
  const h = makeWhepHarness(), attempt = await heldManualWhep(h);
  attempt.post.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/connected" }));
  await drainWhepWork();
  attempt.peer.connectionState = "connected";
  attempt.peer.dispatchEvent("connectionstatechange");
  const codec = h.windowTarget.__livePlayer.codec.video.value;
  assert.equal(codec, "avc1");
  const metadataDeadline = h.scheduledTimeouts.find(t => t.delay === 15000 && h.timeouts.has(t.id));
  assert.ok(metadataDeadline);
  h.timeouts.delete(metadataDeadline.id); metadataDeadline.callback();
  assert.equal(attempt.metadata.options.signal.aborted, true);
  attempt.metadata.resolve(manifestResponse("vp09.00.10.08,opus"));
  await drainWhepWork();
  assert.equal(h.windowTarget.__livePlayer.codec.video.value, codec);
  assert.equal(attempt.peer.connectionState, "connected");
  h.windowTarget.dispatchEvent("beforeunload");
});

test("DBG-V5-01 G-07: cancellation removes a pending ICE listener and timer", async () => {
  const h = makeWhepHarness();
  Object.defineProperty(h.context.RTCPeerConnection.prototype, "iceGatheringState", {
    get: () => "gathering", set() {}
  });
  h.elements.get("whepMode").dispatchEvent("click");
  await drainWhepWork();
  const peer = h.peer;
  assert.equal(peer.listenerCount("icegatheringstatechange"), 1);
  h.windowTarget.dispatchEvent("beforeunload");
  await drainWhepWork();
  assert.equal(peer.listenerCount("icegatheringstatechange"), 0);
  assert.equal(peer.connectionState, "closed");
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.fetchRequests.some(r => r.url === "/rtc/live/whep"), false);
});

test("DBG-V5-01 G-02: failed advisory metadata preserves negotiated SDP codec", async () => {
  const h = makeWhepHarness(), attempt = await heldManualWhep(h);
  attempt.post.resolve(whepResponse(201, undefined, { Location: "/rtc/live/whep/healthy" }));
  await drainWhepWork();
  attempt.peer.connectionState = "connected";
  attempt.peer.dispatchEvent("connectionstatechange");
  assert.equal(h.windowTarget.__livePlayer.codec.video.value, "avc1");
  attempt.metadata.reject(new Error("HLS metadata unavailable"));
  await drainWhepWork();
  assert.equal(h.windowTarget.__livePlayer.codec.video.value, "avc1");
  assert.equal(attempt.peer.connectionState, "connected");
  h.windowTarget.dispatchEvent("beforeunload");
});
