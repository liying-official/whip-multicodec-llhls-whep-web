(() => {
  "use strict";

  const video = document.getElementById("video");
  const status = document.getElementById("status");
  const codecSupport = document.getElementById("codecSupport");
  const soundButton = document.getElementById("soundToggle");
  const autoButton = document.getElementById("autoMode");
  const hlsButton = document.getElementById("hlsMode");
  const whepButton = document.getElementById("whepMode");

  const HLS_URL = "/live/index.m3u8";
  const WHEP_URL = "/rtc/live/whep";
  const TARGET_BUFFER_SECONDS = 5;
  const HLS_OFFLINE_RETRY_DELAYS_MS = [5000, 10000, 20000, 30000, 60000];
  const HLS_STARTUP_TIMEOUT_MS = 18000;
  const HLS_SERVER_FAILURE_FALLBACK_COUNT = 3;
  const HLS_MAX_SYNC_PLAYBACK_RATE = 1.06;
  const HLS_WEAK_TARGET_BUFFER_SECONDS = 8;
  const HLS_WEAK_MAX_SYNC_PLAYBACK_RATE = 1.03;
  const HLS_NORMAL_MAX_BUFFER_SECONDS = 10;
  const HLS_WEAK_MAX_BUFFER_SECONDS = 16;
  const HLS_WEAK_MAX_MAX_BUFFER_SECONDS = 24;
  const HLS_WEAK_LOW_BUFFER_SECONDS = 2.5;
  const HLS_WEAK_RECOVER_BUFFER_SECONDS = 4;
  const HLS_WEAK_BANDWIDTH_RATIO = 1.35;
  const HLS_WEAK_RECOVER_BANDWIDTH_RATIO = 1.7;
  const HLS_WEAK_CONFIRM_SAMPLES = 2;
  const HLS_WEAK_RECOVER_SAMPLES = 20;
  const HLS_NETWORK_MONITOR_INTERVAL_MS = 1000;
  const HLS_NETWORK_MONITOR_WARMUP_MS = 8000;
  const HLS_HARD_RESYNC_MARGIN_SECONDS = 6;
  const HLS_RECOVERY_MIN_BUFFER_SECONDS = 0.75;
  const WHEP_SYNC_CHECK_INTERVAL_MS = 2000;
  const WHEP_SYNC_WARMUP_SAMPLES = 2;
  const WHEP_PLAYOUT_DRIFT_THRESHOLD_SECONDS = 0.25;
  const WHEP_PLAYOUT_DRIFT_CLEAR_SECONDS = 0.12;
  const WHEP_JITTER_DRIFT_THRESHOLD_SECONDS = 0.35;
  const WHEP_JITTER_DRIFT_CLEAR_SECONDS = 0.18;
  const WHEP_SYNC_DRIFT_REQUIRED_SAMPLES = 3;
  const WHEP_RESYNC_COOLDOWN_MS = 20000;
  const WHEP_SESSION_KEEPALIVE_MS = 60000;
  const WHEP_CONNECT_TIMEOUT_MS = 15000;
  const WHEP_DISCONNECT_GRACE_MS = 7000;
  const WHEP_RECONNECT_BACKOFF_MS = [3000, 5000, 8000, 12000];
  const WHEP_RECONNECT_STABLE_RESET_MS = 15000;
  const WHEP_CODEC_FALLBACK_MESSAGE = "当前浏览器不支持此编码的 WebRTC，已切换兼容播放模式";

  let requestedMode = "auto";
  let activeMode = "";
  let detectedCodec = "";
  let detectedCodecName = "未知编码";
  let detectedAudioCodec = "";
  let detectedAudioCodecName = "未知音频";
  let hls = null;
  let peerConnection = null;
  let whepSessionUrl = "";
  let generation = 0;
  let watchdogTimer = 0;
  let audioWatchdogTimer = 0;
  let videoFrameCallbackId = 0;
  let whepAudioTrackSeen = false;
  let statusTimer = 0;
  let codecFallbackTried = false;
  let hlsServerFailureCount = 0;
  let hlsLastHttpStatus = 0;
  let lastStreamMetadata = null;
  let codecCapability = null;
  let capabilityGeneration = 0;
  let hlsRecoveryTimer = 0;
  let hlsStallStartedAt = 0;
  let whepSyncTimer = 0;
  let whepSyncDriftSamples = 0;
  let whepLastJitterStats = null;
  let whepLastResyncAt = 0;
  let whepLastSyncDiffSeconds = 0;
  let whepLastSyncMetric = "";
  let whepSyncSamplesSeen = 0;
  let whepPlayoutBaselineMs = null;
  let whepPlayoutBaselineSamples = [];
  let whepSessionKeepaliveTimer = 0;
  let hlsNetworkMonitorTimer = 0;
  let hlsWeakNetworkMode = false;
  let hlsLowBufferSamples = 0;
  let hlsHealthySamples = 0;
  let hlsNetworkMonitorStartedAt = 0;
  let hlsLastStallAt = 0;
  let hlsConsecutiveNetworkErrors = 0;
  let hlsPendingNetworkRecovery = "";
  let whepReconnectTimer = 0;
  let whepReconnectStableTimer = 0;
  let whepReconnectAttempts = 0;
  let whepConnectWatchdogTimer = 0;
  let whepLastIceSummary = "";
  let hlsOfflineRetryTimer = 0;
  let hlsOfflineRetryAttempts = 0;

  video.muted = true;
  video.autoplay = true;
  try {
    if ("preservesPitch" in video) video.preservesPitch = true;
    if ("webkitPreservesPitch" in video) video.webkitPreservesPitch = true;
  } catch (_) {}

  function showStatus(text, duration = 3500) {
    status.textContent = text;
    status.classList.add("show");
    clearTimeout(statusTimer);
    if (duration > 0) {
      statusTimer = setTimeout(() => status.classList.remove("show"), duration);
    }
  }

  function codecName(codec) {
    const value = String(codec || "").toLowerCase();
    if (value.startsWith("avc1") || value.startsWith("avc3")) {
      return "H.264 / AVC";
    }
    if (value.startsWith("hvc1") || value.startsWith("hev1")) {
      return "H.265 / HEVC";
    }
    if (value.startsWith("av01")) {
      return "AV1";
    }
    if (value.startsWith("vp09")) {
      return "VP9";
    }
    return codec || "未知编码";
  }

  function codecFamily(codec) {
    const value = String(codec || "").toLowerCase();
    if (value.startsWith("avc1") || value.startsWith("avc3")) return "h264";
    if (value.startsWith("hvc1") || value.startsWith("hev1")) return "hevc";
    if (value.startsWith("av01")) return "av1";
    if (value.startsWith("vp09")) return "vp9";
    return "";
  }

  function isAv1(codec) {
    return codecFamily(codec) === "av1";
  }

  function isVp9(codec) {
    return codecFamily(codec) === "vp9";
  }

  function isWhepPreferredCodec(codec) {
    const family = codecFamily(codec);
    return family === "av1" || family === "vp9";
  }

  function rtpMimeType(codec) {
    const family = codecFamily(codec);
    if (family === "h264") return "video/H264";
    if (family === "hevc") return "video/H265";
    if (family === "av1") return "video/AV1";
    if (family === "vp9") return "video/VP9";
    return "";
  }

  function mediaSourceContentType(codec) {
    return codec ? `video/mp4; codecs="${codec}"` : "";
  }

  function getWebRtcReceiveCodecSupport(codec) {
    const wanted = rtpMimeType(codec).toLowerCase();
    if (!wanted) return null;
    if (
      !window.RTCRtpReceiver ||
      typeof window.RTCRtpReceiver.getCapabilities !== "function"
    ) {
      return null;
    }
    try {
      const capabilities = window.RTCRtpReceiver.getCapabilities("video");
      if (!capabilities || !Array.isArray(capabilities.codecs)) return null;
      return capabilities.codecs.some(item =>
        String(item && item.mimeType || "").toLowerCase() === wanted
      );
    } catch (_) {
      return null;
    }
  }

  async function queryDecodingInfo(type, metadata) {
    if (
      !navigator.mediaCapabilities ||
      typeof navigator.mediaCapabilities.decodingInfo !== "function" ||
      !metadata ||
      !metadata.videoCodec
    ) {
      return null;
    }

    const contentType = type === "webrtc"
      ? rtpMimeType(metadata.videoCodec)
      : mediaSourceContentType(metadata.videoCodec);
    if (!contentType) return null;

    const configuration = {
      type,
      video: {
        contentType,
        width: Math.max(1, Number(metadata.width) || 1920),
        height: Math.max(1, Number(metadata.height) || 1080),
        bitrate: Math.max(1, Number(metadata.bandwidth) || 8000000),
        framerate: Math.max(1, Number(metadata.frameRate) || 30)
      }
    };

    try {
      const result = await navigator.mediaCapabilities.decodingInfo(configuration);
      return {
        supported: Boolean(result.supported),
        smooth: Boolean(result.smooth),
        powerEfficient: Boolean(result.powerEfficient)
      };
    } catch (_) {
      return null;
    }
  }

  function combineSupport(primary, mediaCapability) {
    if (primary === false) return false;
    if (mediaCapability && mediaCapability.supported === false) return false;
    if (primary === true) return true;
    if (mediaCapability && mediaCapability.supported === true) return true;
    return null;
  }

  function supportWord(value) {
    if (value === true) return "支持";
    if (value === false) return "不支持";
    return "未知";
  }

  function qualityWords(info) {
    if (!info || !info.supported) return "";
    const parts = [];
    parts.push(info.smooth ? "预计流畅" : "可能不流畅");
    parts.push(info.powerEfficient ? "硬件解码" : "软件解码");
    return `（${parts.join(" / ")}）`;
  }

  function renderCodecCapability(capability) {
    if (!codecSupport) return;
    if (!capability || !capability.codec) {
      codecSupport.textContent = "正在检测视频编码与设备解码能力…";
      codecSupport.dataset.state = "checking";
      return;
    }

    const hls = combineSupport(capability.mse, capability.mediaSource);
    const whep = combineSupport(capability.webrtcReceiver, capability.webrtc);
    const hlsQuality = qualityWords(capability.mediaSource);
    const whepQuality = qualityWords(capability.webrtc);
    codecSupport.textContent =
      `${capability.name} · LL-HLS：${supportWord(hls)}${hlsQuality} · ` +
      `WebRTC：${supportWord(whep)}${whepQuality}`;
    codecSupport.dataset.state = hls === false && whep === false
      ? "unsupported"
      : "ready";
    codecSupport.title =
      `实际流编码：${capability.codec}\n` +
      `LL-HLS/MSE：${supportWord(hls)}\n` +
      `WebRTC 接收：${supportWord(whep)}\n` +
      "“硬件解码 / 软件解码”为浏览器 MediaCapabilities powerEfficient 能力推断，不是驱动级解码器确认。";
  }

  async function detectCodecCapability(metadata) {
    const myCapabilityGeneration = ++capabilityGeneration;
    if (!metadata || !metadata.videoCodec) {
      codecCapability = null;
      renderCodecCapability(null);
      return null;
    }

    const base = {
      codec: metadata.videoCodec,
      name: codecName(metadata.videoCodec),
      family: codecFamily(metadata.videoCodec),
      mse: isExactMseCodecSupported(metadata.videoCodec),
      webrtcReceiver: getWebRtcReceiveCodecSupport(metadata.videoCodec),
      mediaSource: null,
      webrtc: null
    };
    codecCapability = base;
    renderCodecCapability(base);

    const [mediaSourceInfo, webrtcInfo] = await Promise.all([
      queryDecodingInfo("media-source", metadata),
      queryDecodingInfo("webrtc", metadata)
    ]);
    if (myCapabilityGeneration !== capabilityGeneration) return codecCapability;

    base.mediaSource = mediaSourceInfo;
    base.webrtc = webrtcInfo;
    codecCapability = base;
    renderCodecCapability(base);
    return base;
  }

  function effectiveHlsSupport(capability = codecCapability) {
    if (!capability) return null;
    return combineSupport(capability.mse, capability.mediaSource);
  }

  function effectiveWhepSupport(capability = codecCapability) {
    if (!capability) return null;
    return combineSupport(capability.webrtcReceiver, capability.webrtc);
  }

  function unsupportedCodecMessage(capability = codecCapability) {
    const name = capability && capability.name ? capability.name : detectedCodecName;
    return (
      `当前设备/浏览器未声明可解码 ${name}。\n` +
      "LL-HLS 与 WebRTC 两种播放路径均检测为不支持；服务器不会转码。"
    );
  }

  function sdpSupportsDetectedVideoCodec(sdp) {
    const codec = String(detectedCodec || "").toLowerCase();
    const value = String(sdp || "");
    if (!codec) return null;
    if (codec.startsWith("av01")) return /\bAV1\/90000\b/i.test(value);
    if (codec.startsWith("vp09")) return /\bVP9\/90000\b/i.test(value);
    if (codec.startsWith("avc1") || codec.startsWith("avc3")) {
      return /\bH264\/90000\b/i.test(value);
    }
    if (codec.startsWith("hvc1") || codec.startsWith("hev1")) {
      return /\bH265\/90000\b/i.test(value);
    }
    return null;
  }

  function isWhepUnsupportedCodecResponse(response, body) {
    if (!response || response.ok) return false;
    if (response.headers.get("X-WHEP-Error") === "unsupported-codec") return true;
    // Backward compatibility for deployments whose public WHEP path does not
    // yet return the sanitized error header. The raw body is never rendered
    // into the viewer UI.
    let detail = String(body || "").trim();
    try {
      const parsed = JSON.parse(detail);
      if (parsed && typeof parsed.error === "string") detail = parsed.error;
    } catch (_) {}
    return /codecs?\s+not\s+supported\s+by\s+client/i.test(detail);
  }

  function audioCodecName(codec) {
    const value = String(codec || "").toLowerCase();
    if (value.startsWith("mp4a")) return "AAC";
    if (value.startsWith("opus")) return "Opus";
    if (value.startsWith("ac-3")) return "AC-3";
    if (value.startsWith("ec-3")) return "E-AC-3";
    if (value.startsWith("flac")) return "FLAC";
    return codec || "未知音频";
  }

  function setDetectedCodec(codec) {
    detectedCodec = codec || "";
    detectedCodecName = codecName(detectedCodec);
    status.title =
      `当前编码：${detectedCodecName}` +
      (detectedCodec ? ` (${detectedCodec})` : "");
  }

  function setDetectedAudioCodec(codec) {
    detectedAudioCodec = codec || "";
    detectedAudioCodecName = audioCodecName(detectedAudioCodec);
  }

  function setModeButtons() {
    autoButton.classList.toggle("active", requestedMode === "auto");
    hlsButton.classList.toggle("active", requestedMode === "hls");
    whepButton.classList.toggle("active", requestedMode === "whep");
    autoButton.title = requestedMode === "auto" && activeMode
      ? `自动选择的当前传输：${activeMode === "whep" ? "WebRTC / WHEP" : "LL-HLS"}`
      : "自动检测编码和播放能力";
  }

  function setSoundButton() {
    soundButton.textContent = video.muted ? "开启声音" : "静音";
    soundButton.classList.toggle("audio-on", !video.muted);
    soundButton.setAttribute("aria-pressed", String(!video.muted));
    soundButton.title = video.muted
      ? "浏览器要求自动播放先静音；点击后恢复直播声音"
      : "点击将播放器静音";
  }

  function mutedHint() {
    return video.muted ? "\n页面当前静音，请点右上角“开启声音”。" : "";
  }

  function getMediaSourceConstructor() {
    if (window.Hls && typeof Hls.getMediaSource === "function") {
      try {
        return Hls.getMediaSource();
      } catch (_) {}
    }
    return window.MediaSource || window.ManagedMediaSource || null;
  }

  function isExactMseCodecSupported(codec) {
    if (!codec) return null;
    const MediaSourceConstructor = getMediaSourceConstructor();
    if (
      !MediaSourceConstructor ||
      typeof MediaSourceConstructor.isTypeSupported !== "function"
    ) {
      return null;
    }
    try {
      return MediaSourceConstructor.isTypeSupported(
        `video/mp4; codecs="${codec}"`
      );
    } catch (_) {
      return null;
    }
  }

  function bufferedAheadSeconds(media = video) {
    const now = Number(media.currentTime) || 0;
    try {
      const ranges = media.buffered;
      for (let i = 0; i < ranges.length; i += 1) {
        if (now >= ranges.start(i) - 0.05 && now <= ranges.end(i) + 0.05) {
          return Math.max(0, ranges.end(i) - now);
        }
      }
    } catch (_) {}
    return 0;
  }

  function isBufferedTime(media, time) {
    if (!Number.isFinite(time)) return false;
    try {
      const ranges = media.buffered;
      for (let i = 0; i < ranges.length; i += 1) {
        if (time >= ranges.start(i) - 0.12 && time <= ranges.end(i) + 0.12) {
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  function resetHlsNetworkMonitor() {
    clearInterval(hlsNetworkMonitorTimer);
    hlsNetworkMonitorTimer = 0;
    hlsWeakNetworkMode = false;
    hlsLowBufferSamples = 0;
    hlsHealthySamples = 0;
    hlsNetworkMonitorStartedAt = 0;
    hlsLastStallAt = 0;
    hlsConsecutiveNetworkErrors = 0;
    hlsPendingNetworkRecovery = "";
  }

  function queueHlsNetworkRecovery(mode) {
    if (mode === "reload" || !hlsPendingNetworkRecovery) {
      hlsPendingNetworkRecovery = mode;
    }
  }

  function runPendingHlsNetworkRecovery(myGeneration, instance) {
    if (
      !hlsPendingNetworkRecovery ||
      myGeneration !== generation ||
      activeMode !== "hls" ||
      hls !== instance ||
      navigator.onLine === false
    ) {
      return false;
    }

    const mode = hlsPendingNetworkRecovery;
    hlsPendingNetworkRecovery = "";
    const beforeBuffer = bufferedAheadSeconds(video);
    try { instance.startLoad(-1); } catch (_) {}

    // A manifest/level failure can require a full source reload after a long
    // outage, but doing it immediately throws away a still-usable MSE buffer.
    // Give the existing pipeline a chance to resume first; only re-bootstrap
    // if playback is still starved after the network has returned.
    if (mode === "reload") {
      setTimeout(() => {
        if (
          myGeneration !== generation ||
          activeMode !== "hls" ||
          hls !== instance ||
          navigator.onLine === false
        ) {
          return;
        }
        const afterBuffer = bufferedAheadSeconds(video);
        const recovered = video.readyState >= 3 || afterBuffer >= Math.max(0.75, beforeBuffer + 0.25);
        if (!recovered) {
          try { instance.loadSource(HLS_URL); } catch (_) {}
        }
      }, 2500);
    }
    return true;
  }

  function applyHlsNetworkProfile(instance, weak, reason = "") {
    if (!instance || instance !== hls) return;
    if (hlsWeakNetworkMode === weak) return;
    hlsWeakNetworkMode = weak;
    hlsLowBufferSamples = 0;
    hlsHealthySamples = 0;
    const config = instance.config || {};
    config.liveSyncDuration = weak ? HLS_WEAK_TARGET_BUFFER_SECONDS : TARGET_BUFFER_SECONDS;
    config.liveMaxLatencyDuration = weak ? 24 : 18;
    config.maxBufferLength = weak ? HLS_WEAK_MAX_BUFFER_SECONDS : HLS_NORMAL_MAX_BUFFER_SECONDS;
    config.maxMaxBufferLength = weak ? HLS_WEAK_MAX_MAX_BUFFER_SECONDS : 15;
    config.maxLiveSyncPlaybackRate = weak
      ? HLS_WEAK_MAX_SYNC_PLAYBACK_RATE
      : HLS_MAX_SYNC_PLAYBACK_RATE;
    if (weak) {
      showStatus(
        `检测到弱网${reason ? `（${reason}）` : ""}，已切换稳定缓冲模式 · 目标约 ${HLS_WEAK_TARGET_BUFFER_SECONDS} 秒。`,
        4200
      );
    } else {
      showStatus(`网络持续稳定，已恢复低延迟模式 · 目标约 ${TARGET_BUFFER_SECONDS} 秒。`, 3200);
    }
  }

  function armHlsNetworkMonitor(myGeneration, instance) {
    clearInterval(hlsNetworkMonitorTimer);
    hlsNetworkMonitorStartedAt = Date.now();
    hlsNetworkMonitorTimer = setInterval(() => {
      if (
        myGeneration !== generation ||
        activeMode !== "hls" ||
        hls !== instance
      ) {
        return;
      }
      if (Date.now() - hlsNetworkMonitorStartedAt < HLS_NETWORK_MONITOR_WARMUP_MS) return;

      const bufferAhead = bufferedAheadSeconds(video);
      const bandwidth = Number(instance.bandwidthEstimate);
      const streamBitrate = Number(lastStreamMetadata && lastStreamMetadata.bandwidth) || 0;
      const bandwidthWeak = Number.isFinite(bandwidth) && streamBitrate > 0 &&
        bandwidth < streamBitrate * HLS_WEAK_BANDWIDTH_RATIO;
      const bufferWeak = !video.paused && bufferAhead < HLS_WEAK_LOW_BUFFER_SECONDS;

      if (bandwidthWeak || bufferWeak) {
        hlsLowBufferSamples += 1;
        hlsHealthySamples = 0;
      } else {
        hlsLowBufferSamples = Math.max(0, hlsLowBufferSamples - 1);
      }

      if (!hlsWeakNetworkMode && hlsLowBufferSamples >= HLS_WEAK_CONFIRM_SAMPLES) {
        applyHlsNetworkProfile(
          instance,
          true,
          bandwidthWeak ? "可用带宽接近直播码率" : "前向缓冲持续偏低"
        );
        return;
      }

      if (!hlsWeakNetworkMode) return;
      const bandwidthHealthy = !Number.isFinite(bandwidth) || streamBitrate <= 0 ||
        bandwidth >= streamBitrate * HLS_WEAK_RECOVER_BANDWIDTH_RATIO;
      const bufferHealthy = bufferAhead >= HLS_WEAK_RECOVER_BUFFER_SECONDS;
      const stallQuiet = !hlsLastStallAt || Date.now() - hlsLastStallAt >= 15000;
      if (bandwidthHealthy && bufferHealthy && stallQuiet) {
        hlsHealthySamples += 1;
      } else {
        hlsHealthySamples = 0;
      }
      if (hlsHealthySamples >= HLS_WEAK_RECOVER_SAMPLES) {
        applyHlsNetworkProfile(instance, false);
      }
    }, HLS_NETWORK_MONITOR_INTERVAL_MS);
  }

  function resetHlsSyncRecovery() {
    clearTimeout(hlsRecoveryTimer);
    hlsRecoveryTimer = 0;
    hlsStallStartedAt = 0;
    try {
      video.playbackRate = 1;
    } catch (_) {}
  }

  function markHlsStall() {
    if (!hlsStallStartedAt) hlsStallStartedAt = Date.now();
    hlsLastStallAt = Date.now();
    const pastStartupWarmup = hlsNetworkMonitorStartedAt &&
      Date.now() - hlsNetworkMonitorStartedAt >= HLS_NETWORK_MONITOR_WARMUP_MS &&
      Number(video.currentTime || 0) > 0.5;
    if (hls && activeMode === "hls" && pastStartupWarmup) {
      applyHlsNetworkProfile(hls, true, "发生播放卡顿");
    }
  }

  function maybeResyncHlsAfterStall(myGeneration, instance) {
    clearTimeout(hlsRecoveryTimer);
    hlsRecoveryTimer = setTimeout(() => {
      hlsRecoveryTimer = 0;
      if (
        myGeneration !== generation ||
        activeMode !== "hls" ||
        hls !== instance ||
        video.paused ||
        video.seeking
      ) {
        hlsStallStartedAt = 0;
        return;
      }

      const latency = Number(instance.latency);
      const targetLatency = Number(instance.targetLatency);
      const liveSyncPosition = Number(instance.liveSyncPosition);
      const effectiveTarget = Number.isFinite(targetLatency) && targetLatency > 0
        ? targetLatency
        : TARGET_BUFFER_SECONDS;
      const excessLatency = Number.isFinite(latency)
        ? latency - effectiveTarget
        : 0;
      const bufferAhead = bufferedAheadSeconds(video);

      // hls.js normally catches up gently (maxLiveSyncPlaybackRate). Only make a
      // hard seek after a real stall when latency is far beyond target and the
      // target point is already buffered. Seeking only to buffered media avoids
      // trading A/V drift for another starvation event.
      if (
        excessLatency >= HLS_HARD_RESYNC_MARGIN_SECONDS &&
        bufferAhead >= HLS_RECOVERY_MIN_BUFFER_SECONDS &&
        Number.isFinite(liveSyncPosition) &&
        liveSyncPosition > Number(video.currentTime || 0) + 1 &&
        isBufferedTime(video, liveSyncPosition)
      ) {
        try {
          video.currentTime = liveSyncPosition;
          video.playbackRate = 1;
          showStatus("网络恢复，已重新同步音画并返回直播安全缓冲点。", 3200);
        } catch (_) {}
      }
      hlsStallStartedAt = 0;
    }, 450);
  }

  function clearWhepReconnectTimers() {
    clearTimeout(whepReconnectTimer);
    clearTimeout(whepReconnectStableTimer);
    whepReconnectTimer = 0;
    whepReconnectStableTimer = 0;
  }

  function markWhepStable() {
    clearTimeout(whepReconnectStableTimer);
    whepReconnectStableTimer = setTimeout(() => {
      if (activeMode === "whep" && peerConnection && peerConnection.connectionState === "connected") {
        whepReconnectAttempts = 0;
      }
    }, WHEP_RECONNECT_STABLE_RESET_MS);
  }

  function scheduleWhepRecovery(myGeneration, connection, reason, graceMs = 0) {
    if (whepReconnectTimer) return;
    const attemptIndex = Math.min(whepReconnectAttempts, WHEP_RECONNECT_BACKOFF_MS.length - 1);
    const backoff = WHEP_RECONNECT_BACKOFF_MS[attemptIndex];
    const delay = Math.max(graceMs, backoff);
    whepReconnectAttempts += 1;
    showStatus(
      `WebRTC 网络异常，${Math.ceil(delay / 1000)} 秒后自动恢复连接…${reason ? `\n${reason}` : ""}`,
      0
    );
    whepReconnectTimer = setTimeout(() => {
      whepReconnectTimer = 0;
      if (
        myGeneration !== generation ||
        activeMode !== "whep" ||
        peerConnection !== connection ||
        connection.connectionState === "connected"
      ) {
        return;
      }
      if (
        requestedMode === "auto" &&
        whepReconnectAttempts >= 2 &&
        effectiveHlsSupport() !== false
      ) {
        startHls("WebRTC 弱网恢复多次失败", "WebRTC 网络持续不稳定，已切换 LL-HLS 稳定播放模式");
        return;
      }
      startWhep(`弱网自动恢复，第 ${whepReconnectAttempts} 次`);
    }, delay);
  }

  function resetWhepSyncMonitor() {
    clearInterval(whepSyncTimer);
    whepSyncTimer = 0;
    whepSyncDriftSamples = 0;
    whepLastJitterStats = null;
    whepLastSyncDiffSeconds = 0;
    whepLastSyncMetric = "";
    whepSyncSamplesSeen = 0;
    whepPlayoutBaselineMs = null;
    whepPlayoutBaselineSamples = [];
  }

  function collectWhepJitterSnapshot(reports) {
    const result = {
      audio: { delay: 0, emitted: 0, received: 0, lost: 0, playout: null },
      video: { delay: 0, emitted: 0, received: 0, lost: 0, playout: null }
    };
    reports.forEach(report => {
      if (report.type !== "inbound-rtp") return;
      const kind = report.kind || report.mediaType;
      if (kind !== "audio" && kind !== "video") return;
      result[kind].delay += Number(report.jitterBufferDelay || 0);
      result[kind].emitted += Number(report.jitterBufferEmittedCount || 0);
      result[kind].received += Number(report.packetsReceived || 0);
      result[kind].lost += Number(report.packetsLost || 0);
      const playout = Number(report.estimatedPlayoutTimestamp);
      if (Number.isFinite(playout) && playout > 0) {
        result[kind].playout = playout;
      }
    });
    return result;
  }

  function intervalJitterDelay(current, previous, kind) {
    if (!current || !previous || !current[kind] || !previous[kind]) return null;
    const emitted = current[kind].emitted - previous[kind].emitted;
    const delay = current[kind].delay - previous[kind].delay;
    if (emitted <= 0 || delay < 0) return null;
    return delay / emitted;
  }

  function armWhepSyncMonitor(myGeneration, connection) {
    resetWhepSyncMonitor();
    whepSyncTimer = setInterval(async () => {
      if (
        myGeneration !== generation ||
        activeMode !== "whep" ||
        peerConnection !== connection ||
        connection.connectionState !== "connected"
      ) {
        return;
      }

      let reports;
      try {
        reports = await connection.getStats();
      } catch (_) {
        return;
      }
      if (myGeneration !== generation || peerConnection !== connection) return;

      const snapshot = collectWhepJitterSnapshot(reports);
      const previous = whepLastJitterStats;
      whepLastJitterStats = snapshot;

      let diff = null;
      let highThreshold = WHEP_JITTER_DRIFT_THRESHOLD_SECONDS;
      let clearThreshold = WHEP_JITTER_DRIFT_CLEAR_SECONDS;
      let metric = "jitter-buffer";

      // The WebRTC Stats specification explicitly defines the difference between
      // the audio and video estimatedPlayoutTimestamp values as an A/V sync
      // estimate. Prefer it whenever Chromium/Firefox exposes both values.
      if (
        Number.isFinite(snapshot.audio.playout) &&
        Number.isFinite(snapshot.video.playout)
      ) {
        const rawOffsetMs = snapshot.audio.playout - snapshot.video.playout;

        // Some relayed sources expose a large but stable sender-clock offset
        // between tracks. Calibrate that fixed baseline first, then detect a
        // *change* in the playout offset. This prevents false reconnect loops
        // while still catching network-induced A/V drift after startup.
        if (!Number.isFinite(whepPlayoutBaselineMs)) {
          whepPlayoutBaselineSamples.push(rawOffsetMs);
          if (whepPlayoutBaselineSamples.length < 3) {
            whepLastSyncMetric = "estimated-playout-calibrating";
            return;
          }
          const sorted = [...whepPlayoutBaselineSamples].sort((a, b) => a - b);
          whepPlayoutBaselineMs = sorted[Math.floor(sorted.length / 2)];
          whepPlayoutBaselineSamples = [];
          whepLastSyncMetric = "estimated-playout-baseline";
          whepLastSyncDiffSeconds = 0;
          return;
        }

        diff = Math.abs(rawOffsetMs - whepPlayoutBaselineMs) / 1000;
        highThreshold = WHEP_PLAYOUT_DRIFT_THRESHOLD_SECONDS;
        clearThreshold = WHEP_PLAYOUT_DRIFT_CLEAR_SECONDS;
        metric = "estimated-playout-delta";

        // Track tiny long-term sender clock movement without adapting away a
        // real lip-sync error. Only offsets inside 50 ms can move the baseline.
        if (diff < 0.05) {
          whepPlayoutBaselineMs = whepPlayoutBaselineMs * 0.995 + rawOffsetMs * 0.005;
        }
      } else if (previous) {
        // Fallback for browsers that omit estimatedPlayoutTimestamp: compare the
        // per-interval average time spent in each receiver jitter buffer.
        const audioDelay = intervalJitterDelay(snapshot, previous, "audio");
        const videoDelay = intervalJitterDelay(snapshot, previous, "video");
        if (Number.isFinite(audioDelay) && Number.isFinite(videoDelay)) {
          diff = Math.abs(videoDelay - audioDelay);
        }
      }

      if (!Number.isFinite(diff)) return;
      whepLastSyncDiffSeconds = diff;
      whepLastSyncMetric = metric;
      whepSyncSamplesSeen += 1;
      if (whepSyncSamplesSeen <= WHEP_SYNC_WARMUP_SAMPLES) return;

      if (diff >= highThreshold) {
        whepSyncDriftSamples += 1;
      } else if (diff <= clearThreshold) {
        whepSyncDriftSamples = 0;
      } else {
        whepSyncDriftSamples = Math.max(0, whepSyncDriftSamples - 1);
      }

      if (
        whepSyncDriftSamples >= WHEP_SYNC_DRIFT_REQUIRED_SAMPLES &&
        Date.now() - whepLastResyncAt >= WHEP_RESYNC_COOLDOWN_MS
      ) {
        whepLastResyncAt = Date.now();
        whepSyncDriftSamples = 0;
        clearInterval(whepSyncTimer);
        whepSyncTimer = 0;
        showStatus("检测到网络抖动造成持续音画缓冲偏移，正在重新同步 WebRTC…", 0);
        setTimeout(() => {
          if (
            myGeneration === generation &&
            activeMode === "whep" &&
            peerConnection === connection
          ) {
            startWhep("网络恢复后重新建立同步缓冲");
          }
        }, 150);
      }
    }, WHEP_SYNC_CHECK_INTERVAL_MS);
  }

  function clearVideo() {
    try {
      video.pause();
    } catch (_) {}
    delete video.dataset.whepAudioTracks;
    delete video.dataset.whepVideoTracks;
    video.srcObject = null;
    video.removeAttribute("src");
    try {
      video.load();
    } catch (_) {}
  }

  function resetWhepSessionKeepalive() {
    clearInterval(whepSessionKeepaliveTimer);
    whepSessionKeepaliveTimer = 0;
  }

  function armWhepSessionKeepalive(url, myGeneration) {
    resetWhepSessionKeepalive();
    if (!url) return;
    whepSessionKeepaliveTimer = setInterval(async () => {
      if (
        myGeneration !== generation ||
        activeMode !== "whep" ||
        whepSessionUrl !== url
      ) {
        return;
      }
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "X-WHEP-Keepalive": "1" },
          cache: "no-store",
          credentials: "same-origin"
        });
        if (response.status === 404 || response.status === 410) {
          resetWhepSessionKeepalive();
          if (
            myGeneration === generation &&
            activeMode === "whep" &&
            whepSessionUrl === url
          ) {
            startWhep("会话状态已过期，重新建立安全会话");
          }
        }
      } catch (_) {}
    }, WHEP_SESSION_KEEPALIVE_MS);
  }

  function deleteWhepSession(url) {
    if (!url) return;
    fetch(url, {
      method: "DELETE",
      headers: { "If-Match": "*" },
      credentials: "same-origin",
      keepalive: true
    }).catch(() => {});
  }

  function stopCurrentPlayer() {
    clearTimeout(hlsOfflineRetryTimer);
    hlsOfflineRetryTimer = 0;
    resetHlsSyncRecovery();
    resetHlsNetworkMonitor();
    resetWhepSyncMonitor();
    clearWhepReconnectTimers();
    resetWhepSessionKeepalive();
    resetWhepConnectWatchdog();
    clearTimeout(watchdogTimer);
    watchdogTimer = 0;
    clearTimeout(audioWatchdogTimer);
    audioWatchdogTimer = 0;
    whepAudioTrackSeen = false;
    if (
      videoFrameCallbackId &&
      typeof video.cancelVideoFrameCallback === "function"
    ) {
      try {
        video.cancelVideoFrameCallback(videoFrameCallbackId);
      } catch (_) {}
    }
    videoFrameCallbackId = 0;

    if (hls) {
      try {
        hls.destroy();
      } catch (_) {}
      hls = null;
    }

    if (peerConnection) {
      try {
        peerConnection.close();
      } catch (_) {}
      peerConnection = null;
    }

    const oldSessionUrl = whepSessionUrl;
    whepSessionUrl = "";
    deleteWhepSession(oldSessionUrl);
    clearVideo();
  }

  function describeHttpError(response, body) {
    const detail = String(body || "").trim();
    if (detail) {
      // Diagnostic detail stays in DevTools only. Never render MediaMTX or
      // upstream response bodies into the public viewer status overlay.
      console.debug("upstream HTTP error detail", {
        status: response.status,
        statusText: response.statusText,
        detail
      });
    }
    return `${response.status} ${response.statusText || "请求失败"}`;
  }

  function publicWhepHttpError(response) {
    const errorClass = response.headers.get("X-WHEP-Error") || "";
    if (response.status === 429 && errorClass === "session-limit") {
      return "当前 IP 的 WebRTC 同时活动会话已达到 5 个，请关闭其他播放页面后重试。";
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      return retryAfter
        ? `WebRTC 连接请求过于频繁，请约 ${retryAfter} 秒后重试。`
        : "WebRTC 连接请求过于频繁，请稍后重试。";
    }
    if (response.status >= 500) {
      return "WebRTC 播放服务暂时不可用，请稍后重试或切换 LL-HLS。";
    }
    return `WebRTC 会话建立失败（HTTP ${response.status}）。请稍后重试或切换 LL-HLS。`;
  }

  function parseManifest(text) {
    const codecMatch = String(text).match(/CODECS="([^"]+)"/i);
    const resolutionMatch = String(text).match(/RESOLUTION=(\d+)x(\d+)/i);
    const frameRateMatch = String(text).match(/FRAME-RATE=([\d.]+)/i);
    const bandwidthMatch = String(text).match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i);
    const codecs = codecMatch ? codecMatch[1].split(",").map(v => v.trim()) : [];
    const videoCodec = codecs.find(codec =>
      /^(av01|vp09|avc1|avc3|hvc1|hev1)/i.test(codec)
    ) || "";
    const audioCodec = codecs.find(codec =>
      /^(mp4a|opus|ac-3|ec-3|flac)/i.test(codec)
    ) || "";

    return {
      videoCodec,
      audioCodec,
      width: resolutionMatch ? Number(resolutionMatch[1]) : 1920,
      height: resolutionMatch ? Number(resolutionMatch[2]) : 1080,
      frameRate: frameRateMatch ? Number(frameRateMatch[1]) : 30,
      bandwidth: bandwidthMatch ? Number(bandwidthMatch[1]) : 8000000
    };
  }

  async function inspectManifest() {
    const response = await fetch(HLS_URL, {
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`HLS 清单暂不可用：${describeHttpError(response, body)}`);
      error.httpStatus = response.status;
      throw error;
    }
    const metadata = parseManifest(await response.text());
    lastStreamMetadata = metadata;
    setDetectedCodec(metadata.videoCodec);
    setDetectedAudioCodec(metadata.audioCodec);
    return metadata;
  }

  function clearDetectedStreamMetadata() {
    lastStreamMetadata = null;
    setDetectedCodec("");
    setDetectedAudioCodec("");
    capabilityGeneration += 1;
    codecCapability = null;
    renderCodecCapability(null);
  }

  async function refreshWhepStreamMetadata(myGeneration) {
    const previousCodecFamily = codecFamily(detectedCodec);
    try {
      const metadata = await inspectManifest();
      if (
        myGeneration !== generation ||
        activeMode !== "whep"
      ) {
        return false;
      }

      const currentCodecFamily = codecFamily(metadata.videoCodec);
      if (
        previousCodecFamily &&
        currentCodecFamily &&
        previousCodecFamily !== currentCodecFamily
      ) {
        // A publisher can reconnect with a different codec while the viewer
        // page remains open. Do not carry an old fallback decision or label
        // into the replacement WHEP session.
        codecFallbackTried = false;
      }
      await detectCodecCapability(metadata);
      return myGeneration === generation && activeMode === "whep";
    } catch (_) {
      if (myGeneration === generation && activeMode === "whep") {
        // The HLS muxer can briefly disappear between publishers. Clearing
        // stale metadata lets the negotiated WHEP answer identify the new
        // codec instead of continuing to display the previous publisher.
        clearDetectedStreamMetadata();
      }
      return false;
    }
  }

  async function waitForIceGathering(connection, timeoutMs) {
    if (connection.iceGatheringState === "complete") return;

    await new Promise(resolve => {
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        connection.removeEventListener("icegatheringstatechange", check);
        resolve();
      };
      const check = () => {
        if (connection.iceGatheringState === "complete") finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      connection.addEventListener("icegatheringstatechange", check);
    });
  }

  function whepCodecError() {
    return (
      `当前浏览器的 WebRTC 没有声明 ${detectedCodecName} 解码能力。\n` +
      "可尝试最新版 Chromium/Firefox，或点“LL-HLS”测试系统的 MSE 解码器。"
    );
  }

  function whepAudioWarning() {
    if (!detectedAudioCodec.toLowerCase().startsWith("mp4a")) return "";
    return (
      `\n当前流的音频是 ${detectedAudioCodecName}，WebRTC/WHEP 不支持 AAC，` +
      "此模式可能只有画面；LL-HLS 可保留声音。"
    );
  }

  function whepReadyMessage() {
    return (
      `WebRTC 已连接 · ${detectedCodecName}` +
      whepAudioWarning() +
      mutedHint()
    );
  }

  function whepMissingAudioMessage() {
    if (whepAudioWarning()) return whepReadyMessage();
    return (
      "WebRTC 已连接，但 WHEP 会话没有收到音频轨。\n" +
      "请确认 OBS 音轨未静音；WHIP 输入应发送 Opus。RTMP/AAC 请改用 LL-HLS。"
    );
  }

  function armWhepAudioWatchdog(myGeneration, connection) {
    clearTimeout(audioWatchdogTimer);
    audioWatchdogTimer = setTimeout(() => {
      if (
        myGeneration !== generation ||
        activeMode !== "whep" ||
        peerConnection !== connection ||
        connection.connectionState !== "connected" ||
        whepAudioTrackSeen
      ) {
        return;
      }
      showStatus(whepMissingAudioMessage() + mutedHint(), 0);
    }, 3000);
  }

  function publicWhepSessionUrl(locationHeader) {
    if (!locationHeader) return "";
    // MediaMTX sees the request after Caddy strips /rtc and therefore
    // returns a backend path such as /live/whep/<session>. Always route
    // session PATCH/DELETE through our same-origin public prefix.
    const backendLocation = new URL(locationHeader, window.location.href);
    const publicPath = backendLocation.pathname.startsWith("/rtc/")
      ? backendLocation.pathname
      : `/rtc${backendLocation.pathname}`;
    return `${window.location.origin}${publicPath}${backendLocation.search}`;
  }

  function resetWhepConnectWatchdog() {
    clearTimeout(whepConnectWatchdogTimer);
    whepConnectWatchdogTimer = 0;
  }

  async function whepIceSummary(connection) {
    let selected = null;
    let localCandidates = new Map();
    let remoteCandidates = new Map();
    try {
      const reports = await connection.getStats();
      reports.forEach(report => {
        if (report.type === "local-candidate") localCandidates.set(report.id, report);
        if (report.type === "remote-candidate") remoteCandidates.set(report.id, report);
        if (
          report.type === "candidate-pair" &&
          (report.selected || (report.nominated && report.state === "succeeded"))
        ) {
          selected = report;
        }
      });
    } catch (_) {}

    if (!selected) {
      return `ICE=${connection.iceConnectionState || "unknown"}, Peer=${connection.connectionState || "unknown"}, 未选中 candidate pair`;
    }
    const local = localCandidates.get(selected.localCandidateId) || {};
    const remote = remoteCandidates.get(selected.remoteCandidateId) || {};
    const localProto = String(local.protocol || "?").toUpperCase();
    const remoteProto = String(remote.protocol || "?").toUpperCase();
    return `ICE=${connection.iceConnectionState || "unknown"}, Peer=${connection.connectionState || "unknown"}, candidate=${localProto}/${local.candidateType || "?"} ↔ ${remoteProto}/${remote.candidateType || "?"}`;
  }

  function armWhepConnectWatchdog(myGeneration, connection) {
    resetWhepConnectWatchdog();
    whepConnectWatchdogTimer = setTimeout(async () => {
      whepConnectWatchdogTimer = 0;
      if (
        myGeneration !== generation ||
        activeMode !== "whep" ||
        peerConnection !== connection ||
        connection.connectionState === "connected"
      ) {
        return;
      }

      whepLastIceSummary = await whepIceSummary(connection);
      const message = `WHEP 已返回 201，但 WebRTC 媒体通道在 ${Math.round(WHEP_CONNECT_TIMEOUT_MS / 1000)} 秒内没有建立。\n${whepLastIceSummary}`;
      if (requestedMode === "auto" && effectiveHlsSupport() !== false) {
        startHls("WebRTC ICE/DTLS 建立超时", `${message}\n已切换 LL-HLS 兼容播放模式`);
        return;
      }
      showStatus(`${message}\n请检查公网 UDP/TCP 8189、NAT 映射和 Windows 网络/代理策略。`, 0);
      scheduleWhepRecovery(myGeneration, connection, "ICE/DTLS 建立超时，重新建立 WebRTC 会话。", 1000);
    }, WHEP_CONNECT_TIMEOUT_MS);
  }

  function armWhepVideoWatchdog(myGeneration, connection) {
    clearTimeout(watchdogTimer);

    const markFrameDecoded = () => {
      if (myGeneration !== generation) return;
      clearTimeout(watchdogTimer);
      watchdogTimer = 0;
      videoFrameCallbackId = 0;
    };

    if (typeof video.requestVideoFrameCallback === "function") {
      videoFrameCallbackId = video.requestVideoFrameCallback(markFrameDecoded);
    } else {
      video.addEventListener("loadeddata", markFrameDecoded, { once: true });
    }

    watchdogTimer = setTimeout(async () => {
      if (
        myGeneration !== generation ||
        activeMode !== "whep" ||
        peerConnection !== connection
      ) {
        return;
      }

      let packetsReceived = 0;
      let framesDecoded = 0;
      let framesReceived = 0;
      try {
        const reports = await connection.getStats();
        reports.forEach(report => {
          if (
            report.type === "inbound-rtp" &&
            (report.kind === "video" || report.mediaType === "video")
          ) {
            packetsReceived += Number(report.packetsReceived || 0);
            framesDecoded += Number(report.framesDecoded || 0);
            framesReceived += Number(report.framesReceived || 0);
          }
        });
      } catch (_) {}

      if (
        myGeneration !== generation ||
        video.videoWidth > 0 ||
        framesDecoded > 0
      ) {
        return;
      }

      const detail = packetsReceived > 0
        ? `已收到 ${packetsReceived} 个视频 RTP 包，但浏览器解码帧数仍为 0；` +
          (framesReceived > 0 ? `浏览器报告收到 ${framesReceived} 帧。` : "") +
          `通常是 ${detectedCodecName} profile/bit-depth 或浏览器解码器不兼容。`
        : "没有收到视频 RTP 包；请检查 PUBLIC_HOST、NAT 映射和 UDP/TCP 8189。";
      const noVideoMessage =
        `WebRTC 已连接但 ${Math.round(HLS_STARTUP_TIMEOUT_MS / 1000)} 秒内没有可显示画面。\n${detail}` +
        whepAudioWarning();
      if (requestedMode === "auto" && effectiveHlsSupport() !== false) {
        startHls("WebRTC 无可显示视频帧", `${noVideoMessage}\n已切换 LL-HLS 兼容播放模式`);
        return;
      }
      showStatus(noVideoMessage, 0);
    }, HLS_STARTUP_TIMEOUT_MS);
  }

  async function startWhep(reason = "") {
    const myGeneration = ++generation;
    stopCurrentPlayer();
    whepAudioTrackSeen = false;
    activeMode = "whep";
    setModeButtons();
    showStatus(
      `正在建立 WebRTC / WHEP 播放${reason ? `（${reason}）` : ""}…`,
      0
    );

    if (!window.RTCPeerConnection) {
      showStatus("当前浏览器不支持 WebRTC，无法使用 WHEP 播放。", 0);
      return;
    }

    await refreshWhepStreamMetadata(myGeneration);
    if (
      myGeneration !== generation ||
      activeMode !== "whep"
    ) {
      return;
    }

    if (detectedCodec && effectiveWhepSupport() === false) {
      if (requestedMode === "auto") {
        if (effectiveHlsSupport() === false) {
          showStatus(unsupportedCodecMessage(), 0);
          return;
        }
        startHls("设备未声明当前编码的 WebRTC 接收能力", WHEP_CODEC_FALLBACK_MESSAGE);
        return;
      }
      showStatus(
        `当前浏览器未声明 ${detectedCodecName} 的 WebRTC 接收能力。\n` +
        "仍可切换 LL-HLS 测试系统媒体解码器。",
        0
      );
      return;
    }

    const connection = new RTCPeerConnection();
    peerConnection = connection;
    const playbackStream = new MediaStream();
    connection.addTransceiver("video", { direction: "recvonly" });
    connection.addTransceiver("audio", { direction: "recvonly" });

    connection.addEventListener("track", event => {
      if (myGeneration !== generation) return;
      if (!playbackStream.getTracks().some(track => track.id === event.track.id)) {
        playbackStream.addTrack(event.track);
      }
      video.srcObject = playbackStream;
      video.dataset.whepAudioTracks = String(playbackStream.getAudioTracks().length);
      video.dataset.whepVideoTracks = String(playbackStream.getVideoTracks().length);
      if (event.track.kind === "video") {
        armWhepVideoWatchdog(myGeneration, connection);
      } else if (event.track.kind === "audio") {
        whepAudioTrackSeen = true;
        clearTimeout(audioWatchdogTimer);
        audioWatchdogTimer = 0;
      }
      video.play().catch(() => {
        showStatus(
          `${whepReadyMessage()}\n请点击播放器开始播放。`,
          0
        );
      });
      const audioWarning = whepAudioWarning();
      showStatus(whepReadyMessage(), audioWarning ? 0 : 3500);
    });

    connection.addEventListener("connectionstatechange", () => {
      if (myGeneration !== generation) return;
      const state = connection.connectionState;
      if (state === "failed") {
        scheduleWhepRecovery(
          myGeneration,
          connection,
          "连接已进入 failed；将重新建立 ICE/DTLS/jitter buffer。"
        );
      } else if (state === "disconnected") {
        scheduleWhepRecovery(
          myGeneration,
          connection,
          "短暂断线会先等待浏览器自行恢复。",
          WHEP_DISCONNECT_GRACE_MS
        );
      } else if (state === "connected") {
        resetWhepConnectWatchdog();
        clearTimeout(whepReconnectTimer);
        whepReconnectTimer = 0;
        const audioWarning = whepAudioWarning();
        showStatus(whepReadyMessage(), audioWarning ? 0 : 3500);
        armWhepAudioWatchdog(myGeneration, connection);
        armWhepSyncMonitor(myGeneration, connection);
        markWhepStable();
      }
    });

    connection.addEventListener("iceconnectionstatechange", () => {
      if (myGeneration !== generation) return;
      if (connection.iceConnectionState === "failed") {
        scheduleWhepRecovery(
          myGeneration,
          connection,
          "ICE 连接失败；将重新建立候选路径。"
        );
      }
    });

    let createdSessionUrl = "";
    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await waitForIceGathering(connection, 5000);
      if (myGeneration !== generation) return;

      const localSdp = connection.localDescription && connection.localDescription.sdp;
      if (!localSdp) throw new Error("浏览器没有生成 WebRTC SDP");
      const localCodecSupport = sdpSupportsDetectedVideoCodec(localSdp);
      if (localCodecSupport === false) {
        codecFallbackTried = true;
        if (requestedMode === "whep") requestedMode = "hls";
        startHls("WebRTC SDP 未声明当前直播编码", WHEP_CODEC_FALLBACK_MESSAGE);
        return;
      }

      const response = await fetch(WHEP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/sdp",
          "Accept": "application/sdp"
        },
        body: localSdp,
        cache: "no-store",
        credentials: "same-origin"
      });
      const answerSdp = await response.text();
      if (!response.ok) {
        if (isWhepUnsupportedCodecResponse(response, answerSdp)) {
          codecFallbackTried = true;
          if (requestedMode === "whep") requestedMode = "hls";
          startHls("WebRTC 编码协商失败", WHEP_CODEC_FALLBACK_MESSAGE);
          return;
        }
        describeHttpError(response, answerSdp);
        throw new Error(publicWhepHttpError(response));
      }
      if (!detectedCodec) {
        if (/\bAV1\/90000\b/i.test(answerSdp)) {
          setDetectedCodec("av01");
        } else if (/\bVP9\/90000\b/i.test(answerSdp)) {
          setDetectedCodec("vp09");
        } else if (/\bH264\/90000\b/i.test(answerSdp)) {
          setDetectedCodec("avc1");
        } else if (/\bH265\/90000\b/i.test(answerSdp)) {
          setDetectedCodec("hvc1");
        }
      }
      if (!detectedAudioCodec && /\bopus\/48000\b/i.test(answerSdp)) {
        setDetectedAudioCodec("opus");
      }

      const locationHeader = response.headers.get("Location");
      createdSessionUrl = publicWhepSessionUrl(locationHeader);
      if (myGeneration !== generation) {
        deleteWhepSession(createdSessionUrl);
        return;
      }
      whepSessionUrl = createdSessionUrl;
      armWhepSessionKeepalive(createdSessionUrl, myGeneration);
      await connection.setRemoteDescription({
        type: "answer",
        sdp: answerSdp
      });
      if (connection.connectionState !== "connected") {
        armWhepConnectWatchdog(myGeneration, connection);
      }
    } catch (error) {
      if (createdSessionUrl) {
        if (whepSessionUrl === createdSessionUrl) whepSessionUrl = "";
        deleteWhepSession(createdSessionUrl);
      }
      if (myGeneration !== generation) return;
      const message = error && error.message ? error.message : String(error);
      showStatus(
        `WebRTC / WHEP 播放失败：${message}\n可点击“LL-HLS”继续诊断。`,
        0
      );
      try {
        connection.close();
      } catch (_) {}
      if (peerConnection === connection) peerConnection = null;
    }
  }

  function hlsCodecError() {
    const codecDetail = detectedCodec
      ? `${detectedCodecName} (${detectedCodec})`
      : detectedCodecName;
    const whepHint = isWhepPreferredCodec(detectedCodec)
      ? `\n可点击“WebRTC / WHEP”；自动模式也会在 ${detectedCodecName} 的 HLS/MSE 不可用时尝试 WHEP。`
      : "\n服务器不会转码，请改用支持该编码的浏览器/系统或在 OBS 改用 H.264。";
    return `当前浏览器无法通过 HLS/MSE 解码：${codecDetail}${whepHint}`;
  }

  function armHlsWatchdog(myGeneration) {
    const startedAt = Date.now();
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      if (myGeneration !== generation || activeMode !== "hls") return;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;

      if (
        requestedMode === "auto" &&
        !codecFallbackTried &&
        (isWhepPreferredCodec(detectedCodec) || hlsServerFailureCount > 0)
      ) {
        codecFallbackTried = true;
        const reason = hlsLastHttpStatus >= 500
          ? `HLS 清单持续返回 HTTP ${hlsLastHttpStatus}`
          : `${detectedCodecName} 的 HLS 在浏览器中没有产生可播放画面`;
        startWhep(reason);
        return;
      }

      showStatus(
        `HLS 已等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒仍没有画面。\n` +
        `编码：${detectedCodecName}${detectedCodec ? ` (${detectedCodec})` : ""}\n` +
        "请检查浏览器解码支持；AV1 / VP9 可切换到 WebRTC / WHEP。",
        0
      );
    }, HLS_STARTUP_TIMEOUT_MS);
  }

  function startNativeHls(myGeneration, compatibilityNotice = "") {
    video.src = HLS_URL;
    video.play().catch(() => {
      showStatus(
        `${compatibilityNotice ? `${compatibilityNotice}\n` : ""}` +
        "原生 HLS 已就绪，请点击播放器开始播放。",
        0
      );
    });
    armHlsWatchdog(myGeneration);
    showStatus(
      `${compatibilityNotice ? `${compatibilityNotice}\n` : ""}` +
      "使用浏览器原生 HLS；编码支持由系统播放器决定。",
      compatibilityNotice ? 6000 : 3500
    );
  }

  function startHls(reason = "", compatibilityNotice = "") {
    const myGeneration = ++generation;
    stopCurrentPlayer();
    hlsServerFailureCount = 0;
    hlsLastHttpStatus = 0;
    activeMode = "hls";
    setModeButtons();
    showStatus(
      compatibilityNotice
        ? `${compatibilityNotice}\n正在连接 LL-HLS…`
        : `正在连接 LL-HLS${reason ? `（${reason}）` : ""}…`,
      compatibilityNotice ? 6000 : 0
    );

    if (!window.Hls) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        startNativeHls(myGeneration, compatibilityNotice);
      } else {
        showStatus("HLS.js 未加载，且浏览器没有原生 HLS 能力。", 0);
      }
      return;
    }

    const mseSupported = typeof Hls.isMSESupported === "function"
      ? Hls.isMSESupported()
      : Hls.isSupported();
    if (!mseSupported) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        startNativeHls(myGeneration, compatibilityNotice);
      } else {
        showStatus("当前浏览器没有可用的 HLS/MSE 播放能力。", 0);
      }
      return;
    }

    const instance = new Hls({
      lowLatencyMode: true,

      // Keep the normal target close to 5 seconds, but prefer already-buffered
      // positions when HLS.js has to resync after a stall.
      liveSyncDuration: TARGET_BUFFER_SECONDS,
      liveMaxLatencyDuration: 18,
      liveSyncMode: "buffered",
      startOnSegmentBoundary: true,

      // A little more forward buffer gives poor links room to recover without
      // letting audio repeatedly run into a different starvation pattern.
      maxBufferLength: HLS_NORMAL_MAX_BUFFER_SECONDS,
      maxMaxBufferLength: 15,
      backBufferLength: 10,

      // LL-HLS weak-network policy: tolerate short outages inside hls.js, then
      // let our outer recovery re-bootstrap near the live edge instead of
      // retrying stale parts for tens of seconds.
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 12000,
          maxLoadTimeMs: 120000,
          timeoutRetry: { maxNumRetry: 4, retryDelayMs: 400, maxRetryDelayMs: 4000, backoff: "exponential" },
          errorRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 5000, backoff: "exponential" }
        }
      },
      playlistLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 12000,
          maxLoadTimeMs: 30000,
          timeoutRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 4000, backoff: "exponential" },
          errorRetry: { maxNumRetry: 4, retryDelayMs: 700, maxRetryDelayMs: 6000, backoff: "exponential" }
        }
      },
      manifestLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 12000,
          maxLoadTimeMs: 30000,
          timeoutRetry: { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 4000, backoff: "exponential" },
          errorRetry: { maxNumRetry: 3, retryDelayMs: 700, maxRetryDelayMs: 6000, backoff: "exponential" }
        }
      },

      // MediaMTX LL-HLS uses one-second CMAF parts. Tolerate small timestamp
      // gaps introduced by encoder clocks and browser remuxing.
      maxBufferHole: 0.25,

      // Allow the target latency to increase slightly after a real stall
      // instead of repeatedly forcing it straight back to exactly 5 seconds.
      liveSyncOnStallIncrease: 1.5,

      // Keep audio timestamps tightly restamped and let the gap controller
      // nudge video rendering when audio is buffered across a small video hole.
      maxAudioFramesDrift: 1,
      stretchShortVideoTrack: true,
      nudgeOnVideoHole: true,
      detectStallWithCurrentTimeMs: 1000,
      highBufferWatchdogPeriod: 2,

      // Catch up very gently after a network stall. This rate applies to the
      // single HTMLMediaElement timeline, so audio and video remain locked.
      maxLiveSyncPlaybackRate: HLS_MAX_SYNC_PLAYBACK_RATE
    });
    hls = instance;
    window.__liveHls = instance;
    instance.attachMedia(video);
    instance.loadSource(HLS_URL);
    armHlsWatchdog(myGeneration);
    armHlsNetworkMonitor(myGeneration, instance);

    instance.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      if (myGeneration !== generation) return;
      hlsServerFailureCount = 0;
      hlsLastHttpStatus = 0;
      hlsConsecutiveNetworkErrors = 0;
      const codecs = Array.from(new Set(
        (data.levels || []).map(level => level.videoCodec).filter(Boolean)
      ));
      const audioCodecs = Array.from(new Set(
        [
          ...(data.levels || []).map(level => level.audioCodec),
          ...(data.audioTracks || []).map(track => track.audioCodec)
        ].filter(Boolean)
      ));
      setDetectedCodec(codecs[0] || "");
      setDetectedAudioCodec(audioCodecs[0] || "");
      if (detectedCodec) {
        const level = (data.levels || [])[0] || {};
        lastStreamMetadata = {
          videoCodec: detectedCodec,
          audioCodec: detectedAudioCodec,
          width: Number(level.width) || (lastStreamMetadata && lastStreamMetadata.width) || 1920,
          height: Number(level.height) || (lastStreamMetadata && lastStreamMetadata.height) || 1080,
          frameRate: Number(level.frameRate) || (lastStreamMetadata && lastStreamMetadata.frameRate) || 30,
          bandwidth: Number(level.bitrate) || (lastStreamMetadata && lastStreamMetadata.bandwidth) || 8000000
        };
        detectCodecCapability(lastStreamMetadata).catch(() => {});
      }

      const supported = isExactMseCodecSupported(detectedCodec);
      if (
        isWhepPreferredCodec(detectedCodec) &&
        supported !== true &&
        requestedMode === "auto" &&
        !codecFallbackTried
      ) {
        codecFallbackTried = true;
        startWhep(`检测到 ${detectedCodecName}，浏览器未声明 HLS/MSE 支持`);
        return;
      }

      if (supported === false) {
        showStatus(hlsCodecError(), 0);
        return;
      }

      showStatus(
        `${compatibilityNotice ? `${compatibilityNotice}\n` : ""}` +
        `LL-HLS 已就绪 · ${detectedCodecName} · 目标缓冲约 ${hlsWeakNetworkMode ? HLS_WEAK_TARGET_BUFFER_SECONDS : TARGET_BUFFER_SECONDS} 秒`,
        compatibilityNotice ? 6000 : 3500
      );
      video.play().catch(() => {
        showStatus(
          `${compatibilityNotice ? `${compatibilityNotice}\n` : ""}` +
          `LL-HLS 已就绪 · ${detectedCodecName}\n请点击播放器开始播放。`,
          0
        );
      });
    });

    instance.on(Hls.Events.FRAG_LOADED, () => {
      if (myGeneration !== generation) return;
      hlsConsecutiveNetworkErrors = 0;
    });


    instance.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      if (myGeneration !== generation) return;
      const level = instance.levels && instance.levels[data.level];
      if (level && level.videoCodec) {
        setDetectedCodec(level.videoCodec);
        const metadata = {
          videoCodec: detectedCodec,
          audioCodec: detectedAudioCodec,
          width: Number(level.width) || (lastStreamMetadata && lastStreamMetadata.width) || 1920,
          height: Number(level.height) || (lastStreamMetadata && lastStreamMetadata.height) || 1080,
          frameRate: Number(level.frameRate) || (lastStreamMetadata && lastStreamMetadata.frameRate) || 30,
          bandwidth: Number(level.bitrate) || (lastStreamMetadata && lastStreamMetadata.bandwidth) || 8000000
        };
        lastStreamMetadata = metadata;
        detectCodecCapability(metadata).catch(() => {});
      }
    });

    instance.on(Hls.Events.ERROR, (_event, data) => {
      if (myGeneration !== generation || !data) return;
      const details = String(data.details || "未知错误");
      const httpStatus = Number(data.response && data.response.code) || 0;
      const responseCode = httpStatus
        ? ` / HTTP ${httpStatus}`
        : "";

      if (!data.fatal) {
        // HLS.js has already recovered from BUFFER_SEEK_OVER_HOLE by seeking
        // to the next buffered range. Do not expose this benign recovery as a
        // user-facing warning.
        if (
          (Hls.ErrorDetails && details === Hls.ErrorDetails.BUFFER_SEEK_OVER_HOLE) ||
          details === "bufferSeekOverHole"
        ) {
          const hole = Number(data.hole || 0);
          if (window.console && typeof console.debug === "function") {
            console.debug(
              `[HLS] recovered buffer hole${hole > 0 ? ` (${hole.toFixed(3)}s)` : ""}`
            );
          }
          return;
        }

        if (
          (Hls.ErrorDetails && details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) ||
          details === "bufferStalledError"
        ) {
          markHlsStall();
          showStatus("网络波动导致播放缓冲不足，正在增加安全缓冲并保持音画同步…", 3200);
          return;
        }

        if (/buffer|codec|media/i.test(details)) {
          showStatus(`HLS 警告：${details}${responseCode}`, 5000);
        }
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hlsConsecutiveNetworkErrors += 1;
        applyHlsNetworkProfile(instance, true, "连续网络请求失败");
        if (httpStatus >= 500) {
          hlsServerFailureCount += 1;
          hlsLastHttpStatus = httpStatus;
        } else if (httpStatus > 0) {
          hlsServerFailureCount = 0;
          hlsLastHttpStatus = httpStatus;
        }

        if (
          requestedMode === "auto" &&
          !codecFallbackTried &&
          hlsServerFailureCount >= HLS_SERVER_FAILURE_FALLBACK_COUNT
        ) {
          codecFallbackTried = true;
          startWhep(
            `HLS 连续 ${hlsServerFailureCount} 次返回 HTTP ${httpStatus}，改用 WebRTC`
          );
          return;
        }

        const retryDelay = Math.min(
          8000,
          750 * Math.pow(2, Math.min(3, Math.max(0, hlsConsecutiveNetworkErrors - 1)))
        ) + Math.floor(Math.random() * 250);
        showStatus(
          `HLS 网络错误：${details}${responseCode}，约 ${Math.ceil(retryDelay / 1000)} 秒后恢复…`,
          0
        );
        queueHlsNetworkRecovery(/manifest|level/i.test(details) ? "reload" : "start");
        setTimeout(() => {
          runPendingHlsNetworkRecovery(myGeneration, instance);
        }, retryDelay);
        return;
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        if (isWhepPreferredCodec(detectedCodec) && requestedMode === "auto" && !codecFallbackTried) {
          codecFallbackTried = true;
          startWhep(`${detectedCodecName} HLS 媒体错误：${details}`);
          return;
        }
        if (isExactMseCodecSupported(detectedCodec) === false) {
          showStatus(hlsCodecError(), 0);
          return;
        }
        showStatus(`HLS 媒体错误：${details}，正在恢复…`, 0);
        try {
          instance.recoverMediaError();
        } catch (error) {
          showStatus(`HLS 恢复失败：${error.message || error}`, 0);
        }
        return;
      }

      showStatus(`HLS 不可恢复错误：${data.type} / ${details}${responseCode}`, 0);
    });

    video.addEventListener("waiting", () => {
      if (myGeneration !== generation || activeMode !== "hls") return;
      markHlsStall();
    });

    video.addEventListener("stalled", () => {
      if (myGeneration !== generation || activeMode !== "hls") return;
      markHlsStall();
    });

    video.addEventListener("playing", () => {
      if (
        myGeneration !== generation ||
        activeMode !== "hls" ||
        hls !== instance ||
        !hlsStallStartedAt
      ) {
        return;
      }
      maybeResyncHlsAfterStall(myGeneration, instance);
    });

    video.addEventListener("loadeddata", () => {
      if (myGeneration !== generation) return;
      clearTimeout(watchdogTimer);
      watchdogTimer = 0;
    }, { once: true });

    video.addEventListener("error", () => {
      if (myGeneration !== generation || activeMode !== "hls") return;
      showStatus(
        detectedCodec ? hlsCodecError() : "浏览器视频解码失败，尚未识别到编码。",
        0
      );
    }, { once: true });
  }

  function scheduleOfflineAutoRetry(myGeneration, reason) {
    const delay = HLS_OFFLINE_RETRY_DELAYS_MS[
      Math.min(hlsOfflineRetryAttempts, HLS_OFFLINE_RETRY_DELAYS_MS.length - 1)
    ];
    hlsOfflineRetryAttempts += 1;
    activeMode = "";
    setModeButtons();
    showStatus(
      `直播尚未开始：${reason}\n` +
      `将在约 ${Math.round(delay / 1000)} 秒后重新检查；离线时间较长时最多每 60 秒检查一次。`,
      0
    );
    hlsOfflineRetryTimer = setTimeout(() => {
      hlsOfflineRetryTimer = 0;
      if (myGeneration !== generation || requestedMode !== "auto") return;
      startAuto(true);
    }, delay);
  }

  async function startAuto(isOfflineRetry = false) {
    requestedMode = "auto";
    const myGeneration = ++generation;
    stopCurrentPlayer();
    if (!isOfflineRetry) hlsOfflineRetryAttempts = 0;
    whepReconnectAttempts = 0;
    codecFallbackTried = false;
    setDetectedCodec("");
    setDetectedAudioCodec("");
    setModeButtons();
    showStatus("正在检测直播编码…", 0);
    try {
      const metadata = await inspectManifest();
      if (myGeneration !== generation || requestedMode !== "auto") return;
      hlsServerFailureCount = 0;
      hlsLastHttpStatus = 0;
      const capability = await detectCodecCapability(metadata);
      if (myGeneration !== generation || requestedMode !== "auto") return;
      hlsOfflineRetryAttempts = 0;

      const hlsSupport = effectiveHlsSupport(capability);
      const whepSupport = effectiveWhepSupport(capability);
      if (hlsSupport === false && whepSupport === false) {
        showStatus(unsupportedCodecMessage(capability), 0);
        return;
      }

      if (hlsSupport === false && whepSupport !== false) {
        codecFallbackTried = true;
        await startWhep(`检测到 ${codecName(metadata.videoCodec)}，LL-HLS/MSE 不支持`);
        return;
      }

      if (isWhepPreferredCodec(metadata.videoCodec) && hlsSupport !== true && whepSupport === true) {
        codecFallbackTried = true;
        await startWhep(`检测到 ${codecName(metadata.videoCodec)}，WebRTC 接收能力更明确`);
        return;
      }

      startHls(
        metadata.videoCodec
          ? `检测到 ${codecName(metadata.videoCodec)}，设备能力检测完成`
          : ""
      );
    } catch (error) {
      if (myGeneration === generation && requestedMode === "auto") {
        const reason = error && error.message ? error.message : "等待直播流";
        const httpStatus = Number(error && error.httpStatus) || 0;
        if (httpStatus >= 500) {
          hlsServerFailureCount += 1;
          hlsLastHttpStatus = httpStatus;
          if (
            !codecFallbackTried &&
            hlsServerFailureCount >= HLS_SERVER_FAILURE_FALLBACK_COUNT
          ) {
            codecFallbackTried = true;
            startWhep(`HLS 清单连续 ${hlsServerFailureCount} 次返回 HTTP ${httpStatus}`);
            return;
          }
        } else if (httpStatus > 0) {
          hlsServerFailureCount = 0;
          hlsLastHttpStatus = httpStatus;
        }
        scheduleOfflineAutoRetry(myGeneration, reason);
      }
    }
  }

  autoButton.addEventListener("click", () => startAuto());
  hlsButton.addEventListener("click", () => {
    requestedMode = "hls";
    whepReconnectAttempts = 0;
    startHls("手动选择");
  });
  whepButton.addEventListener("click", () => {
    requestedMode = "whep";
    whepReconnectAttempts = 0;
    startWhep("手动选择");
  });
  soundButton.addEventListener("click", () => {
    video.muted = !video.muted;
    setSoundButton();

    if (!video.muted) {
      video.play().catch(() => {
        showStatus("浏览器仍阻止播放，请再点击播放器画面。", 0);
      });
      if (activeMode === "whep" && whepAudioWarning()) {
        showStatus(
          "已取消页面静音，但当前 WHEP 源音频是 AAC，WebRTC 无法传输该音频。" +
          "\n请切换 LL-HLS，或让 OBS 通过 WHIP 推送 Opus。",
          0
        );
      } else if (
        activeMode === "whep" &&
        peerConnection &&
        peerConnection.connectionState === "connected" &&
        !whepAudioTrackSeen
      ) {
        showStatus(whepMissingAudioMessage(), 0);
      } else {
        showStatus("直播声音已开启。", 2200);
      }
    } else {
      showStatus("播放器已静音。", 1800);
    }
  });
  video.addEventListener("volumechange", setSoundButton);

  window.addEventListener("offline", () => {
    if (activeMode === "hls") {
      showStatus("网络连接已中断，播放器将保留现有缓冲并等待恢复…", 0);
    } else if (activeMode === "whep") {
      showStatus("网络连接已中断，WebRTC 将在网络恢复后自动重连…", 0);
    }
  });

  window.addEventListener("online", () => {
    if (activeMode === "hls" && hls) {
      applyHlsNetworkProfile(hls, true, "网络刚恢复");
      if (!runPendingHlsNetworkRecovery(generation, hls)) {
        try { hls.startLoad(-1); } catch (_) {}
      }
      showStatus("网络已恢复，正在重新建立 LL-HLS 安全缓冲…", 3200);
    } else if (activeMode === "whep" && peerConnection && peerConnection.connectionState !== "connected") {
      scheduleWhepRecovery(generation, peerConnection, "浏览器报告网络已恢复。", 1000);
    } else if (requestedMode === "auto" && hlsOfflineRetryTimer) {
      clearTimeout(hlsOfflineRetryTimer);
      hlsOfflineRetryTimer = 0;
      startAuto(true);
    }
  });

  window.addEventListener("beforeunload", () => {
    generation++;
    stopCurrentPlayer();
  });

  window.__livePlayer = {
    get mode() {
      return { requested: requestedMode, active: activeMode };
    },
    get codec() {
      return {
        video: { name: detectedCodecName, value: detectedCodec },
        audio: { name: detectedAudioCodecName, value: detectedAudioCodec }
      };
    },
    get capabilities() {
      return codecCapability;
    },
    get sync() {
      return {
        hlsStallActive: Boolean(hlsStallStartedAt),
        whepConsecutiveDriftSamples: whepSyncDriftSamples,
        whepLastSyncDifferenceSeconds: whepLastSyncDiffSeconds,
        whepLastSyncMetric,
        whepPlayoutBaselineMs,
        whepLastResyncAt
      };
    },
    get network() {
      return {
        hlsWeakNetworkMode,
        hlsLowBufferSamples,
        hlsHealthySamples,
        hlsConsecutiveNetworkErrors,
        hlsOfflineRetryAttempts,
        hlsOfflineRetryScheduled: Boolean(hlsOfflineRetryTimer),
        hlsBufferAheadSeconds: activeMode === "hls" ? bufferedAheadSeconds(video) : null,
        hlsBandwidthEstimate: hls && Number.isFinite(hls.bandwidthEstimate) ? hls.bandwidthEstimate : null,
        whepReconnectAttempts,
        whepConnectionState: peerConnection ? peerConnection.connectionState : null,
        whepIceConnectionState: peerConnection ? peerConnection.iceConnectionState : null,
        whepLastIceSummary,
        online: navigator.onLine
      };
    },
    refreshCapabilities: () => lastStreamMetadata
      ? detectCodecCapability(lastStreamMetadata)
      : Promise.resolve(null),
    auto: startAuto,
    hls: startHls,
    whep: startWhep
  };

  setSoundButton();
  renderCodecCapability(null);
  startAuto();
})();
