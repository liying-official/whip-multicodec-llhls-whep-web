(function (root, factory) {
  "use strict";
  const policy = factory();
  if (typeof module === "object" && module.exports) module.exports = policy;
  if (root) root.HlsWeakNetworkPolicy = policy;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const constants = Object.freeze({
    WEAK_BANDWIDTH_RATIO: 1.2,
    LOW_BANDWIDTH_CONFIRM_SAMPLES: 6,
    BANDWIDTH_BUFFER_CEILING_SECONDS: 4,
    STALL_NETWORK_HEALTHY_RATIO: 1.45,
    STALL_HEALTHY_BUFFER_SECONDS: 2,
    STALL_INCIDENT_DEDUP_MS: 1500,
    STALL_CONFIRM_COUNT: 2,
    STALL_WINDOW_MS: 15000,
    FAST_RECOVERY_BANDWIDTH_RATIO: 1.7,
    FAST_RECOVERY_BUFFER_SECONDS: 6,
    FAST_RECOVERY_SAMPLES: 20,
    FAST_RECOVERY_STALL_QUIET_MS: 15000,
    FAST_RECOVERY_NETWORK_QUIET_MS: 15000,
    STABLE_RECOVERY_BANDWIDTH_RATIO: 1.5,
    // Preserve the established recovery hysteresis independently of readiness.
    STABLE_RECOVERY_BUFFER_SECONDS: 7,
    STABLE_RECOVERY_SAMPLES: 30,
    // A two-second segment plus one monitor tick bounds a normal cadence valley.
    STABLE_RECOVERY_EVIDENCE_HOLD_MS: 3000,
    STABLE_RECOVERY_STALL_QUIET_MS: 30000,
    STABLE_RECOVERY_NETWORK_QUIET_MS: 30000
  });

  function createState() {
    return {
      lowBandwidthSamples: 0,
      fastRecoverySamples: 0,
      stableRecoverySamples: 0,
      stableRecoveryLastEvidenceAt: 0,
      lastStallAt: 0,
      stallIncidents: [],
      stallEpisodeActive: false,
      stallEpisodeStartedAt: 0,
      stallEpisodeClassification: "",
      lastNetworkErrorAt: 0,
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
      lastRequestSampleAt: 0
    };
  }

  function resetTransitionCounters(state) {
    state.lowBandwidthSamples = 0;
    state.fastRecoverySamples = 0;
    state.stableRecoverySamples = 0;
    state.stableRecoveryLastEvidenceAt = 0;
  }

  function bandwidthRatio(bandwidth, streamBitrate) {
    const estimate = Number(bandwidth);
    const bitrate = Number(streamBitrate);
    return Number.isFinite(estimate) && bitrate > 0 ? estimate / bitrate : null;
  }

  function isBandwidthRisk(input) {
    return input.paused !== true &&
      Number.isFinite(input.bandwidthRatio) &&
      input.bandwidthRatio < constants.WEAK_BANDWIDTH_RATIO &&
      Number(input.bufferAhead) < constants.BANDWIDTH_BUFFER_CEILING_SECONDS;
  }

  function sampleLowBandwidth(state, risk) {
    state.lowBandwidthSamples = risk ? state.lowBandwidthSamples + 1 : 0;
    return {
      samples: state.lowBandwidthSamples,
      confirmed: state.lowBandwidthSamples >= constants.LOW_BANDWIDTH_CONFIRM_SAMPLES
    };
  }

  function quietForSince(timestamp, now) {
    const eventAt = Number(timestamp);
    if (!(eventAt > 0)) return Number.POSITIVE_INFINITY;
    const current = Number(now);
    return Number.isFinite(current) ? Math.max(0, current - eventAt) : 0;
  }

  function markNetworkError(state, now) {
    const timestamp = Number(now);
    if (Number.isFinite(timestamp) && timestamp > 0) state.lastNetworkErrorAt = timestamp;
    state.fastRecoverySamples = 0;
    state.stableRecoverySamples = 0;
    state.stableRecoveryLastEvidenceAt = 0;
    state.requestOverheadSamples = 0;
  }

  function resetNetworkSamples(state) {
    const fresh = createState();
    for (const key of ["previousBufferAhead", "previousBufferSampleAt", "networkSamples",
      "bufferDrainSamples", "bufferSlope", "requestOverheadMs", "requestOverheadBaselineMs",
      "requestOverheadBaseline", "requestOverheadSamples", "lastRequestSampleAt"]) {
      state[key] = fresh[key];
    }
  }

  function recentNetworkError(state, now) {
    return quietForSince(state.lastNetworkErrorAt, now) < constants.FAST_RECOVERY_NETWORK_QUIET_MS;
  }

  function sampleNetworkTrend(state, input) {
    const now = Number(input.now);
    const buffer = Number(input.bufferAhead);
    const elapsed = (now - state.previousBufferSampleAt) / 1000;
    const usable = Number.isFinite(now) && Number.isFinite(buffer) && buffer >= 0 &&
      input.paused !== true && input.seeking !== true;
    const intervalValid = usable && state.previousBufferSampleAt > 0 && elapsed >= 0.5 && elapsed <= 2.5;
    state.bufferSlope = intervalValid ? (buffer - state.previousBufferAhead) / elapsed : null;
    state.networkSamples = intervalValid ? state.networkSamples + 1 : usable ? 1 : 0;
    state.previousBufferAhead = usable ? buffer : null;
    state.previousBufferSampleAt = usable ? now : 0;
    const ratio = input.bandwidthRatio;
    const loss = recentNetworkError(state, now);
    const risk = loss || (Number.isFinite(ratio) && ratio < 1.35);
    const drain = intervalValid && buffer < 6 && state.bufferSlope <= -0.25 && risk;
    state.bufferDrainSamples = drain ? state.bufferDrainSamples + 1 : 0;
    if (!usable || state.weakNetworkClass) return "";
    // Three samples allow objective network evidence before the stall warmup.
    const starved = state.networkSamples >= 3 && buffer < 1.5 &&
      (loss || (Number.isFinite(ratio) && ratio < constants.WEAK_BANDWIDTH_RATIO));
    return state.bufferDrainSamples >= 3 || starved ? "bandwidth-loss" : "";
  }

  function sampleRequestOverhead(state, input) {
    const now = Number(input.now);
    const overhead = Number(input.requestOverheadMs);
    const ratio = input.bandwidthRatio;
    const buffer = Number(input.bufferAhead);
    if (state.weakNetworkClass || input.paused === true || input.seeking === true ||
      !Number.isFinite(now) || !Number.isFinite(overhead) || overhead < 0 ||
      !Number.isFinite(buffer)) {
      state.requestOverheadSamples = 0;
      return "";
    }
    const gap = now - state.lastRequestSampleAt;
    if (gap <= 0 || gap > 5000) state.requestOverheadSamples = 0;
    state.lastRequestSampleAt = now;
    state.requestOverheadMs = overhead;
    const headroom = Number.isFinite(ratio) && ratio >= 1.35 && !recentNetworkError(state, now);
    const baseline = state.requestOverheadBaselineMs;
    const elevated = baseline !== null && overhead >= Math.max(250, baseline + 200);
    const pressured = buffer < 6 || (state.bufferSlope !== null && state.bufferSlope <= -0.15);
    state.requestOverheadSamples = headroom && pressured && elevated
      ? state.requestOverheadSamples + 1 : 0;
    // A 6s latency target normally exposes only 4-6s of downloaded media.
    // Learn only with stronger headroom and safe buffer; never let
    // elevated samples drag an established healthy baseline upwards.
    // Do not reject a normal segment's pre-append cadence valley just because
    // the most recent one-second monitor slope was negative.
    if (headroom && ratio >= 1.7 && buffer >= 4 && !elevated) {
      state.requestOverheadBaseline.push(overhead);
      if (state.requestOverheadBaseline.length > 8) state.requestOverheadBaseline.shift();
      if (state.requestOverheadBaseline.length >= 4) {
        state.requestOverheadBaselineMs = state.requestOverheadBaseline.reduce((a, b) => a + b, 0) /
          state.requestOverheadBaseline.length;
      }
    }
    return state.requestOverheadSamples >= 4 ? "rtt" : "";
  }

  function sampleBufferReadiness(state, bufferAhead) {
    const buffer = Number(bufferAhead);
    state.weakBufferReady = Boolean(state.weakNetworkClass) && Number.isFinite(buffer) &&
      buffer >= (state.weakBufferReady ? 6 : 8);
    return state.weakBufferReady;
  }

  function sampleRecovery(state, input) {
    const ratio = Number(input.bandwidthRatio);
    const bufferAhead = Number(input.bufferAhead);
    const now = Number(input.now);
    const networkQuietFor = quietForSince(state.lastNetworkErrorAt, now);
    const downloadsHealthy = input.noRecentNetworkErrors === true;
    const fastHealthy = Number.isFinite(ratio) &&
      ratio >= constants.FAST_RECOVERY_BANDWIDTH_RATIO &&
      bufferAhead >= constants.FAST_RECOVERY_BUFFER_SECONDS &&
      downloadsHealthy;
    const stableNetworkHealthy = Number.isFinite(ratio) &&
      ratio >= constants.STABLE_RECOVERY_BANDWIDTH_RATIO &&
      downloadsHealthy;
    const stableBufferHealthy = bufferAhead >= constants.STABLE_RECOVERY_BUFFER_SECONDS;
    const lastStableEvidenceAt = Number(state.stableRecoveryLastEvidenceAt);
    const stableEvidenceFresh = lastStableEvidenceAt > 0 && Number.isFinite(now) &&
      Math.max(0, now - lastStableEvidenceAt) <= constants.STABLE_RECOVERY_EVIDENCE_HOLD_MS;

    state.fastRecoverySamples = fastHealthy ? state.fastRecoverySamples + 1 : 0;
    // Complete two-second segments create a sawtooth buffer even on a stable
    // link. Count only >=7s samples, hold evidence through short cadence valleys,
    // and reset it after a prolonged valley or a return to the weak-entry region.
    if (!stableNetworkHealthy || bufferAhead < constants.BANDWIDTH_BUFFER_CEILING_SECONDS) {
      state.stableRecoverySamples = 0;
      state.stableRecoveryLastEvidenceAt = 0;
    } else if (stableBufferHealthy) {
      if (state.stableRecoverySamples > 0 && !stableEvidenceFresh) {
        state.stableRecoverySamples = 0;
      }
      state.stableRecoverySamples += 1;
      state.stableRecoveryLastEvidenceAt = Number.isFinite(now) && now > 0 ? now : 0;
    } else if (!stableEvidenceFresh) {
      state.stableRecoverySamples = 0;
      state.stableRecoveryLastEvidenceAt = 0;
    }

    const quietFor = state.lastStallAt > 0 && Number.isFinite(now)
      ? Math.max(0, now - state.lastStallAt)
      : Number.POSITIVE_INFINITY;
    let path = "";
    if (
      state.fastRecoverySamples >= constants.FAST_RECOVERY_SAMPLES &&
      quietFor >= constants.FAST_RECOVERY_STALL_QUIET_MS &&
      networkQuietFor >= constants.FAST_RECOVERY_NETWORK_QUIET_MS
    ) {
      path = "fast";
    } else if (
      state.stableRecoverySamples >= constants.STABLE_RECOVERY_SAMPLES &&
      quietFor >= constants.STABLE_RECOVERY_STALL_QUIET_MS &&
      networkQuietFor >= constants.STABLE_RECOVERY_NETWORK_QUIET_MS
    ) {
      path = "stable";
    }
    return {
      fastSamples: state.fastRecoverySamples,
      stableSamples: state.stableRecoverySamples,
      networkQuietFor,
      path
    };
  }

  function recordStall(state, input) {
    const now = Number(input.now);
    const previous = state.lastStallAt;
    const episodeAlreadyActive = state.stallEpisodeActive === true;
    const timeDuplicate = !episodeAlreadyActive && previous > 0 &&
      now - previous < constants.STALL_INCIDENT_DEDUP_MS;
    const networkClearlyHealthy = Number.isFinite(input.bandwidthRatio) &&
      input.bandwidthRatio >= constants.STALL_NETWORK_HEALTHY_RATIO &&
      Number(input.bufferAhead) >= constants.STALL_HEALTHY_BUFFER_SECONDS &&
      input.noRecentNetworkErrors === true &&
      quietForSince(state.lastNetworkErrorAt, now) >= constants.FAST_RECOVERY_NETWORK_QUIET_MS;
    if (!episodeAlreadyActive) {
      state.stallEpisodeActive = true;
      state.stallEpisodeStartedAt = now;
      state.stallEpisodeClassification = "";
    }
    // Decoder/browser scheduling stalls with healthy transport evidence must
    // not erase the samples or quiet time used to leave weak-network mode.
    if (networkClearlyHealthy) {
      if (!state.stallEpisodeClassification) {
        state.stallEpisodeClassification = timeDuplicate ? "deduplicated" : "healthy";
      }
      return {
        deduplicated: episodeAlreadyActive || timeDuplicate,
        ignoredAsNetworkHealthy: true,
        enterWeak: false
      };
    }

    state.lastStallAt = now;
    state.fastRecoverySamples = 0;
    state.stableRecoverySamples = 0;
    state.stableRecoveryLastEvidenceAt = 0;
    if (
      timeDuplicate ||
      state.stallEpisodeClassification === "network" ||
      state.stallEpisodeClassification === "warmup" ||
      state.stallEpisodeClassification === "deduplicated"
    ) {
      if (timeDuplicate) state.stallEpisodeClassification = "deduplicated";
      return { deduplicated: true, ignoredAsNetworkHealthy: false, enterWeak: false };
    }

    if (input.pastStartupWarmup !== true) {
      state.stallEpisodeClassification = "warmup";
      state.stallIncidents = [];
      return {
        deduplicated: false,
        ignoredAsNetworkHealthy: false,
        ignoredDuringWarmup: true,
        enterWeak: false
      };
    }

    state.stallIncidents = state.stallIncidents.filter(
      incidentAt => now - incidentAt <= constants.STALL_WINDOW_MS
    );
    state.stallIncidents.push(now);
    state.stallEpisodeClassification = "network";
    return {
      deduplicated: false,
      ignoredAsNetworkHealthy: false,
      ignoredDuringWarmup: false,
      enterWeak: state.stallIncidents.length >= constants.STALL_CONFIRM_COUNT
    };
  }

  function endStallEpisode(state) {
    state.stallEpisodeActive = false;
    state.stallEpisodeStartedAt = 0;
    state.stallEpisodeClassification = "";
  }

  function markWeakEntry(state, now, reason, weakClass = "bandwidth-loss") {
    resetTransitionCounters(state);
    state.weakEnterTimestamp = Number(now) || 0;
    state.weakTriggerReason = String(reason || "");
    state.weakRecoveryPath = "";
    state.weakNetworkClass = weakClass === "rtt" ? "rtt" : "bandwidth-loss";
    state.weakBufferReady = false;
  }

  function markWeakRecovery(state, path) {
    resetTransitionCounters(state);
    resetNetworkSamples(state);
    state.weakNetworkClass = "";
    state.weakBufferReady = false;
    state.stallIncidents = [];
    state.lastStallAt = 0;
    endStallEpisode(state);
    state.weakRecoveryPath = path === "stable" ? "stable" : "fast";
  }

  function markOffline(state) {
    state.wasOffline = true;
  }

  function consumeOnlineAfterOffline(state) {
    const recovered = state.wasOffline === true;
    state.wasOffline = false;
    return recovered;
  }

  function isFatalNetworkError(fatal, type, networkType) {
    return fatal === true && type === networkType;
  }

  function shouldProtectPlaylistBuffer(input) {
    // A blocking reload timeout is already failed-request evidence. Waiting
    // for three additional drain samples can exhaust the normal 6s reserve.
    // Keep startup, user seeks, healthy buffers and unrelated errors separate.
    return input.fatal === false &&
      (input.details === "levelLoadTimeOut" || input.details === "audioTrackLoadTimeOut") &&
      input.paused !== true && input.seeking !== true &&
      Number.isFinite(input.playbackAgeMs) && input.playbackAgeMs >= 8000 &&
      Number.isFinite(input.bufferAhead) && input.bufferAhead >= 0 && input.bufferAhead < 6;
  }

  function withAppendOwnership(Base) {
    // hls.js 1.7.2's append deadline is stored on the track, but completion
    // clears it through the current queue head. A displaced head can leave a
    // deadline behind. An idle abort resets MSE's random-access requirement
    // and silently drops following non-key AV1 frames. Bind each deadline to
    // its actual append, SourceBuffer, track and operation instead.
    return class OwnedAppendBufferController extends Base {
      appendExecutor(data, type) {
        const track = this.tracks[type];
        const sb = track && track.buffer;
        if (!sb) return super.appendExecutor(data, type);
        this.clearBufferAppendTimeoutId(track);
        track.ending = false;
        track.ended = false;
        const owners = this.appendOwners || (this.appendOwners = new Map());
        const operation = this.currentOp(type);
        const owner = { track, sb, operation, timer: undefined, finish: null };
        owner.finish = () => {
          self.clearTimeout(owner.timer);
          sb.removeEventListener("updateend", owner.finish);
          sb.removeEventListener("error", owner.finish);
          if (owners.get(type) === owner) owners.delete(type);
          if (track.bufferAppendTimeoutId === owner.timer) track.bufferAppendTimeoutId = undefined;
        };
        owners.set(type, owner);
        // Independent of queue-head completion; a reentrant append's timer
        // cannot be canceled by this append's later updateend listener.
        sb.addEventListener("updateend", owner.finish, { once: true });
        sb.addEventListener("error", owner.finish, { once: true });
        if (this.hls.config.appendTimeout !== Infinity) {
          const timeout = this.calculateAppendTimeoutTime(sb);
          owner.timer = self.setTimeout(() => {
            const current = owners.get(type) === owner && this.tracks[type] === track &&
              track.buffer === sb && this.currentOp(type) === operation && sb.updating;
            owner.finish();
            if (current) super.appendTimeoutHandler(type, sb, timeout);
          }, timeout);
          track.bufferAppendTimeoutId = owner.timer;
        }
        try { sb.appendBuffer(data); } catch (error) { owner.finish(); throw error; }
      }

      clearBufferAppendTimeoutId(track) {
        if (this.appendOwners) {
          for (const owner of [...this.appendOwners.values()]) {
            if (owner.track === track) owner.finish();
          }
        }
        super.clearBufferAppendTimeoutId(track);
      }

      destroy() {
        if (this.appendOwners) {
          for (const owner of [...this.appendOwners.values()]) owner.finish();
        }
        super.destroy();
      }
    };
  }

  function profileFor(weak) {
    return weak ? {
      lowLatencyMode: weak !== "rtt",
      targetLatency: 12,
      liveMaxLatencyDuration: 24,
      maxBufferLength: 16,
      maxMaxBufferLength: 24,
      maxLiveSyncPlaybackRate: 1,
      minActualForwardBuffer: 8,
      bufferReadyLowWatermark: 6
    } : {
      lowLatencyMode: true,
      targetLatency: 6,
      liveMaxLatencyDuration: 18,
      maxBufferLength: 10,
      maxMaxBufferLength: 15,
      maxLiveSyncPlaybackRate: 1.05
    };
  }

  function isSafeBacktrack(ranges, current, target, minBacktrack, maxBacktrack) {
    const currentTime = Number(current);
    const targetTime = Number(target);
    const backtrack = currentTime - targetTime;
    if (
      !Number.isFinite(currentTime) ||
      !Number.isFinite(targetTime) ||
      targetTime >= currentTime ||
      backtrack < Number(minBacktrack) ||
      backtrack > Number(maxBacktrack)
    ) {
      return false;
    }
    return Array.isArray(ranges) && ranges.some(range => {
      const start = Number(range.start);
      const end = Number(range.end);
      return Number.isFinite(start) && Number.isFinite(end) &&
        targetTime >= start + 0.05 &&
        currentTime <= end + 0.05 &&
        currentTime >= start - 0.05;
    });
  }

  function weakSafePoint(ranges, current, liveSyncPosition, minBacktrack, maxBacktrack) {
    const range = ranges.find(range => current >= range.start && current <= range.end);
    if (!range || !Number.isFinite(liveSyncPosition) || range.end - current >= 8) return null;
    const target = Math.min(range.end - 8, liveSyncPosition);
    return isSafeBacktrack(ranges, current, target, minBacktrack, maxBacktrack) ? target : null;
  }

  return Object.freeze({
    constants,
    createState,
    resetTransitionCounters,
    bandwidthRatio,
    isBandwidthRisk,
    sampleLowBandwidth,
    sampleNetworkTrend,
    sampleRequestOverhead,
    sampleBufferReadiness,
    markNetworkError,
    sampleRecovery,
    recordStall,
    endStallEpisode,
    markWeakEntry,
    markWeakRecovery,
    markOffline,
    consumeOnlineAfterOffline,
    isFatalNetworkError,
    shouldProtectPlaylistBuffer,
    withAppendOwnership,
    profileFor,
    isSafeBacktrack,
    weakSafePoint
  });
});
