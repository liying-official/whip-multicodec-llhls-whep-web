(() => {
  "use strict";

  const video = document.getElementById("video");
  const status = document.getElementById("status");
  const soundButton = document.getElementById("soundToggle");
  const autoButton = document.getElementById("autoMode");
  const hlsButton = document.getElementById("hlsMode");
  const whepButton = document.getElementById("whepMode");

  const HLS_URL = "/live/index.m3u8";
  const WHEP_URL = "/rtc/live/whep";
  const TARGET_BUFFER_SECONDS = 5;
  const HLS_STARTUP_TIMEOUT_MS = 12000;
  const HLS_SERVER_FAILURE_FALLBACK_COUNT = 3;

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
  let av1AutoTried = false;
  let hlsServerFailureCount = 0;
  let hlsLastHttpStatus = 0;

  video.muted = true;
  video.autoplay = true;

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
    return codec || "未知编码";
  }

  function isAv1(codec) {
    return String(codec || "").toLowerCase().startsWith("av01");
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
    let detail = String(body || "").trim();
    try {
      const parsed = JSON.parse(detail);
      detail = parsed.error || detail;
    } catch (_) {}
    return `${response.status} ${response.statusText}${detail ? `：${detail}` : ""}`;
  }

  function parseManifest(text) {
    const codecMatch = String(text).match(/CODECS="([^"]+)"/i);
    const resolutionMatch = String(text).match(/RESOLUTION=(\d+)x(\d+)/i);
    const frameRateMatch = String(text).match(/FRAME-RATE=([\d.]+)/i);
    const bandwidthMatch = String(text).match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i);
    const codecs = codecMatch ? codecMatch[1].split(",").map(v => v.trim()) : [];
    const videoCodec = codecs.find(codec =>
      /^(av01|avc1|avc3|hvc1|hev1)/i.test(codec)
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
      throw new Error(`HLS 清单暂不可用：${describeHttpError(response, body)}`);
    }
    const metadata = parseManifest(await response.text());
    setDetectedCodec(metadata.videoCodec);
    setDetectedAudioCodec(metadata.audioCodec);
    return metadata;
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
      "当前浏览器的 WebRTC 没有声明 AV1 解码能力。\n" +
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
          "通常是 AV1 profile/bit-depth 或浏览器解码器不兼容。"
        : "没有收到视频 RTP 包；请检查 PUBLIC_HOST、NAT 映射和 UDP/TCP 8189。";
      showStatus(
        `WebRTC 已连接但 12 秒内没有可显示画面。\n${detail}` +
        whepAudioWarning(),
        0
      );
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
        showStatus(
          "WebRTC 媒体连接失败。请检查服务器 TCP/UDP 8189 是否放行，或改用 LL-HLS。",
          0
        );
      } else if (state === "disconnected") {
        showStatus("WebRTC 媒体暂时中断，正在等待恢复…", 0);
      } else if (state === "connected") {
        const audioWarning = whepAudioWarning();
        showStatus(whepReadyMessage(), audioWarning ? 0 : 3500);
        armWhepAudioWatchdog(myGeneration, connection);
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
      if (isAv1(detectedCodec) && !/\bAV1\/90000\b/i.test(localSdp)) {
        throw new Error(whepCodecError());
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
        throw new Error(`WHEP 请求失败：${describeHttpError(response, answerSdp)}`);
      }
      if (!detectedCodec) {
        if (/\bAV1\/90000\b/i.test(answerSdp)) {
          setDetectedCodec("av01");
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
      await connection.setRemoteDescription({
        type: "answer",
        sdp: answerSdp
      });
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
    const av1Hint = isAv1(detectedCodec)
      ? "\n请点击“WebRTC / AV1”；自动模式也会为 AV1 优先选择 WHEP。"
      : "\n服务器不会转码，请改用支持该编码的浏览器/系统或在 OBS 改用 H.264。";
    return `当前浏览器无法通过 HLS/MSE 解码：${codecDetail}${av1Hint}`;
  }

  function armHlsWatchdog(myGeneration) {
    const startedAt = Date.now();
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      if (myGeneration !== generation || activeMode !== "hls") return;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;

      if (
        requestedMode === "auto" &&
        !av1AutoTried &&
        (isAv1(detectedCodec) || hlsServerFailureCount > 0)
      ) {
        av1AutoTried = true;
        const reason = hlsLastHttpStatus >= 500
          ? `HLS 清单持续返回 HTTP ${hlsLastHttpStatus}`
          : "AV1 的 HLS 在浏览器中没有产生可播放画面";
        startWhep(reason);
        return;
      }

      showStatus(
        `HLS 已等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒仍没有画面。\n` +
        `编码：${detectedCodecName}${detectedCodec ? ` (${detectedCodec})` : ""}\n` +
        "请检查浏览器解码支持；AV1 可切换到 WebRTC / AV1。",
        0
      );
    }, HLS_STARTUP_TIMEOUT_MS);
  }

  function startNativeHls(myGeneration) {
    video.src = HLS_URL;
    video.play().catch(() => {
      showStatus("原生 HLS 已就绪，请点击播放器开始播放。", 0);
    });
    armHlsWatchdog(myGeneration);
    showStatus("使用浏览器原生 HLS；编码支持由系统播放器决定。", 3500);
  }

  function startHls(reason = "") {
    const myGeneration = ++generation;
    stopCurrentPlayer();
    hlsServerFailureCount = 0;
    hlsLastHttpStatus = 0;
    activeMode = "hls";
    setModeButtons();
    showStatus(`正在连接 LL-HLS${reason ? `（${reason}）` : ""}…`, 0);

    if (!window.Hls) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        startNativeHls(myGeneration);
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
        startNativeHls(myGeneration);
      } else {
        showStatus("当前浏览器没有可用的 HLS/MSE 播放能力。", 0);
      }
      return;
    }

    const instance = new Hls({
      lowLatencyMode: true,
      liveSyncDuration: TARGET_BUFFER_SECONDS,
      liveMaxLatencyDuration: 15,
      maxBufferLength: 5,
      maxMaxBufferLength: 10,
      backBufferLength: 10,
      liveSyncOnStallIncrease: 0,
      maxLiveSyncPlaybackRate: 1.0
    });
    hls = instance;
    window.__liveHls = instance;
    instance.attachMedia(video);
    instance.loadSource(HLS_URL);
    armHlsWatchdog(myGeneration);

    instance.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      if (myGeneration !== generation) return;
      hlsServerFailureCount = 0;
      hlsLastHttpStatus = 0;
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

      const supported = isExactMseCodecSupported(detectedCodec);
      if (
        isAv1(detectedCodec) &&
        supported !== true &&
        requestedMode === "auto" &&
        !av1AutoTried
      ) {
        av1AutoTried = true;
        startWhep("检测到 AV1，浏览器未声明 HLS/MSE AV1 支持");
        return;
      }

      if (supported === false) {
        showStatus(hlsCodecError(), 0);
        return;
      }

      showStatus(
        `LL-HLS 已就绪 · ${detectedCodecName} · 目标缓冲约 ${TARGET_BUFFER_SECONDS} 秒`,
        3500
      );
      video.play().catch(() => {
        showStatus(
          `LL-HLS 已就绪 · ${detectedCodecName}\n请点击播放器开始播放。`,
          0
        );
      });
    });

    instance.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      if (myGeneration !== generation) return;
      const level = instance.levels && instance.levels[data.level];
      if (level && level.videoCodec) setDetectedCodec(level.videoCodec);
      status.title =
        `当前编码：${detectedCodecName}` +
        (detectedCodec ? ` (${detectedCodec})` : "");
    });

    instance.on(Hls.Events.ERROR, (_event, data) => {
      if (myGeneration !== generation || !data) return;
      const details = String(data.details || "未知错误");
      const httpStatus = Number(data.response && data.response.code) || 0;
      const responseCode = httpStatus
        ? ` / HTTP ${httpStatus}`
        : "";

      if (!data.fatal) {
        if (/buffer|codec|media/i.test(details)) {
          showStatus(`HLS 警告：${details}${responseCode}`, 5000);
        }
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (httpStatus >= 500) {
          hlsServerFailureCount += 1;
          hlsLastHttpStatus = httpStatus;
        } else if (httpStatus > 0) {
          hlsServerFailureCount = 0;
          hlsLastHttpStatus = httpStatus;
        }

        if (
          requestedMode === "auto" &&
          !av1AutoTried &&
          hlsServerFailureCount >= HLS_SERVER_FAILURE_FALLBACK_COUNT
        ) {
          av1AutoTried = true;
          startWhep(
            `HLS 连续 ${hlsServerFailureCount} 次返回 HTTP ${httpStatus}，改用 WebRTC`
          );
          return;
        }

        showStatus(`HLS 网络错误：${details}${responseCode}，正在重试…`, 0);
        setTimeout(() => {
          if (myGeneration === generation && hls === instance) {
            if (/manifest|level/i.test(details)) {
              instance.loadSource(HLS_URL);
            } else {
              instance.startLoad();
            }
          }
        }, Math.min(3000, 1000 * Math.max(1, hlsServerFailureCount)));
        return;
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        if (isAv1(detectedCodec) && requestedMode === "auto" && !av1AutoTried) {
          av1AutoTried = true;
          startWhep(`AV1 HLS 媒体错误：${details}`);
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

  async function startAuto() {
    requestedMode = "auto";
    av1AutoTried = false;
    setDetectedCodec("");
    setDetectedAudioCodec("");
    setModeButtons();
    showStatus("正在检测直播编码…", 0);
    try {
      const metadata = await inspectManifest();
      if (requestedMode !== "auto") return;
      if (isAv1(metadata.videoCodec)) {
        const mseSupport = isExactMseCodecSupported(metadata.videoCodec);
        if (mseSupport === true) {
          startHls("检测到 AV1，浏览器声明支持 HLS/MSE");
        } else {
          av1AutoTried = true;
          await startWhep("检测到 AV1，浏览器未声明 HLS/MSE 支持");
        }
      } else {
        startHls(metadata.videoCodec ? `检测到 ${codecName(metadata.videoCodec)}` : "");
      }
    } catch (error) {
      if (requestedMode === "auto") {
        const reason = error && error.message ? error.message : "等待直播流";
        startHls(reason);
      }
    }
  }

  autoButton.addEventListener("click", () => startAuto());
  hlsButton.addEventListener("click", () => {
    requestedMode = "hls";
    startHls("手动选择");
  });
  whepButton.addEventListener("click", () => {
    requestedMode = "whep";
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
    auto: startAuto,
    hls: startHls,
    whep: startWhep
  };

  setSoundButton();
  startAuto();
})();
