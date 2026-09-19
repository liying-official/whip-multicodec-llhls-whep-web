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
    // V2: both exit paths admit a current continuous 6s buffer; READY is separate.
    STABLE_RECOVERY_BUFFER_SECONDS: 6,
    STABLE_RECOVERY_SAMPLES: 30,
    // A two-second segment plus one monitor tick bounds a normal cadence valley.
    STABLE_RECOVERY_EVIDENCE_HOLD_MS: 3000,
    STABLE_RECOVERY_STALL_QUIET_MS: 30000,
    STABLE_RECOVERY_NETWORK_QUIET_MS: 30000,
    RECOVERY_SAMPLE_GAP_MS: 3000,
    RECOVERY_SAMPLE_MIN_MS: 500,
    MEDIA_EVIDENCE_MIN_MS: 6000,
    MEDIA_EVIDENCE_MAX_MS: 30000,
    RTT_RECOVERY_REQUESTS: 4,
    // Half the existing +200ms entry margin supplies relative exit hysteresis.
    RTT_RECOVERY_MARGIN_MS: 100,
    RTT_BASELINE_MAX_AGE_MS: 300000,
    // Only the missing-reference recovery branch uses this conservative cap,
    // below the existing 250ms minimum RTT-entry threshold. It is not a new
    // normal-mode classifier or a claim about all healthy long-distance links.
    RTT_REQUALIFY_OVERHEAD_CAP_MS: 200,
    RTT_REQUALIFY_COLLECT_REQUESTS: 8,
    RTT_REQUALIFY_VALIDATE_REQUESTS: 4,
    RTT_REQUALIFY_MIN_SPAN_MS: 6000
  });

  function createState() {
    return {
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
      requestScope: "",
      requestKind: "",
      requestContexts: {},
      rttReference: null,
      rttRecoverySamples: 0,
      rttRecoveryAt: null,
      rttRequalification: null,
      rttEvidenceMaxAgeMs: 6000,
      mediaTransferAt: null,
      mediaTransferSerial: 0,
      mediaEvidenceMaxAgeMs: 6000,
      recoveryLastSampleAt: null,
      recoveryNeedsMedia: false,
      recoveryAfterSerial: 0,
      recoveryMotion: null,
      recoveryMotionAt: null
    };
  }

  function resetTransitionCounters(state) {
    state.lowBandwidthSamples = 0;
    state.fastRecoverySamples = 0;
    state.stableRecoverySamples = 0;
    state.stableRecoveryLastEvidenceAt = 0;
  }

  function evidenceMaxAgeMs(duration) {
    return Number.isFinite(duration) && duration > 0 && duration <= 30
      ? Math.max(constants.MEDIA_EVIDENCE_MIN_MS,
        Math.min(constants.MEDIA_EVIDENCE_MAX_MS, duration * 3000 + 2000))
      : constants.MEDIA_EVIDENCE_MIN_MS;
  }

  function freshAt(at, now, budget) {
    return at !== null && Number.isFinite(at) && Number.isFinite(now) &&
      at >= 0 && now >= at && now - at <= budget;
  }

  function noteMediaTransfer(state, input) {
    const now = input.now;
    if (!Number.isFinite(now) || now < 0 ||
      (state.mediaTransferAt !== null && now < state.mediaTransferAt)) return;
    state.mediaTransferAt = now;
    state.mediaTransferSerial += 1;
    state.mediaEvidenceMaxAgeMs = evidenceMaxAgeMs(input.duration);
  }

  function mediaEvidenceFresh(state, now) {
    return !state.wasOffline && freshAt(state.mediaTransferAt, now, state.mediaEvidenceMaxAgeMs);
  }

  function sampleMediaEvidence(state, input) {
    const point = { time: input.currentTime, end: input.bufferEnd };
    const previous = state.recoveryMotion;
    const motion = previous && ((Number.isFinite(point.time) && point.time > previous.time + 0.05) ||
      (Number.isFinite(point.end) && point.end > previous.end + 0.05));
    if (motion) state.recoveryMotionAt = input.now;
    state.recoveryMotion = point;
    if (state.recoveryNeedsMedia && state.mediaTransferSerial > state.recoveryAfterSerial && motion) {
      state.recoveryNeedsMedia = false;
    }
  }

  function recoveryEvidenceFresh(state, now) {
    return !state.recoveryNeedsMedia && mediaEvidenceFresh(state, now) &&
      freshAt(state.recoveryMotionAt, now, state.mediaEvidenceMaxAgeMs);
  }

  function qualifiedRecoveryPath(state, input) {
    const now = input.now, ratio = input.bandwidthRatio, buffer = input.bufferAhead;
    if (!Number.isFinite(now) || now < 0 || !Number.isFinite(buffer) || buffer < 6 ||
      !Number.isFinite(ratio) || input.online === false || state.wasOffline || input.paused || input.seeking ||
      input.noRecentNetworkErrors !== true || !recoveryEvidenceFresh(state, now) ||
      !freshAt(state.recoveryLastSampleAt, now, constants.RECOVERY_SAMPLE_GAP_MS)) return "";
    if (state.weakNetworkClass === "rtt" && (!state.rttReference ||
      state.rttRecoverySamples < constants.RTT_RECOVERY_REQUESTS || !freshAt(state.rttRecoveryAt, now, state.rttEvidenceMaxAgeMs))) return "";
    const quiet = quietForSince(state.lastStallAt, now), networkQuiet = quietForSince(state.lastNetworkErrorAt, now);
    if (state.fastRecoverySamples >= constants.FAST_RECOVERY_SAMPLES && ratio >= constants.FAST_RECOVERY_BANDWIDTH_RATIO &&
      quiet >= constants.FAST_RECOVERY_STALL_QUIET_MS && networkQuiet >= constants.FAST_RECOVERY_NETWORK_QUIET_MS) return "fast";
    if (state.stableRecoverySamples >= constants.STABLE_RECOVERY_SAMPLES && ratio >= constants.STABLE_RECOVERY_BANDWIDTH_RATIO &&
      quiet >= constants.STABLE_RECOVERY_STALL_QUIET_MS && networkQuiet >= constants.STABLE_RECOVERY_NETWORK_QUIET_MS) return "stable";
    return "";
  }

  function invalidateRecovery(state) {
    state.fastRecoverySamples = 0;
    state.stableRecoverySamples = 0;
    state.stableRecoveryLastEvidenceAt = 0;
    state.recoveryLastSampleAt = null;
    state.recoveryNeedsMedia = true;
    state.recoveryAfterSerial = state.mediaTransferSerial;
    state.rttRecoverySamples = 0;
    state.rttRecoveryAt = null;
    state.rttRequalification = null;
  }

  function resetRequestContext(state) {
    state.requestScope = "";
    state.requestKind = "";
    state.requestContexts = {};
    state.requestOverheadBaseline = [];
    state.requestOverheadBaselineMs = null;
    state.requestOverheadMs = null;
    state.requestOverheadSamples = 0;
    state.lastRequestSampleAt = 0;
    state.rttReference = null;
    invalidateRecovery(state);
    state.mediaTransferAt = null;
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
    if (timestamp === null || !Number.isFinite(eventAt) || eventAt < 0) return Number.POSITIVE_INFINITY;
    const current = Number(now);
    return Number.isFinite(current) ? Math.max(0, current - eventAt) : 0;
  }

  function markNetworkError(state, now) {
    const timestamp = Number(now);
    if (Number.isFinite(now) && timestamp >= 0) state.lastNetworkErrorAt = timestamp;
    state.fastRecoverySamples = 0;
    state.stableRecoverySamples = 0;
    state.stableRecoveryLastEvidenceAt = 0;
    state.requestOverheadSamples = 0;
    state.rttRequalification = null;
  }

  function resetNetworkSamples(state, preserveHealthy = false) {
    const fresh = createState();
    for (const key of ["previousBufferAhead", "previousBufferSampleAt", "networkSamples",
      "bufferDrainSamples", "bufferSlope", "requestOverheadMs",
      "requestOverheadSamples", "lastRequestSampleAt"]) {
      state[key] = fresh[key];
    }
    if (!preserveHealthy) resetRequestContext(state);
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
    if (input.paused === true || input.seeking === true || state.wasOffline ||
      !Number.isFinite(input.now) || now < 0 || !Number.isFinite(input.requestOverheadMs) || overhead < 0 ||
      !Number.isFinite(buffer)) {
      state.requestOverheadSamples = 0;
      state.rttRecoverySamples = 0;
      state.rttRecoveryAt = null;
      state.rttRequalification = null;
      return "";
    }
    // At most two request shapes in one level/discontinuity context. Never
    // compare a Part.stats measurement against a Fragment.stats baseline.
    const kind = input.requestKind === "part" ? "part" : "whole";
    const scope = String(input.requestScope || "0/0");
    if (state.requestScope && state.requestScope !== scope) resetRequestContext(state);
    state.requestScope = scope;
    if (state.requestKind !== kind) state.requestOverheadSamples = 0;
    state.requestKind = kind;
    let context = state.requestContexts[kind];
    if (context && (context.baseline !== null || !state.weakNetworkClass) &&
      !freshAt(context.at, now, constants.RTT_BASELINE_MAX_AGE_MS)) {
      delete state.requestContexts[kind];
      context = null;
      if (state.rttReference && state.rttReference.kind === kind) {
        state.rttReference = null;
        state.rttRecoverySamples = 0;
        state.rttRecoveryAt = null;
      }
    }
    if (!context) context = state.requestContexts[kind] = { values: [], baseline: null, at: now, lastSampleAt: null };
    if (context.lastSampleAt !== null && now <= context.lastSampleAt) return "";
    context.lastSampleAt = now;
    state.requestOverheadBaseline = context.values;
    state.requestOverheadBaselineMs = context.baseline;
    const gap = now - state.lastRequestSampleAt;
    if (gap <= 0 || gap > 5000) state.requestOverheadSamples = 0;
    state.lastRequestSampleAt = now;
    state.requestOverheadMs = overhead;
    const headroom = Number.isFinite(ratio) && ratio >= 1.35 && !recentNetworkError(state, now);
    const baseline = context.baseline;
    const elevated = baseline !== null && overhead >= Math.max(250, baseline + 200);
    const pressured = buffer < 6 || (state.bufferSlope !== null && state.bufferSlope <= -0.15);
    state.requestOverheadSamples = !state.weakNetworkClass && headroom && pressured && elevated
      ? state.requestOverheadSamples + 1 : 0;
    if (state.weakNetworkClass) {
      const reference = state.rttReference;
      const budget = evidenceMaxAgeMs(input.duration);
      const comparable = reference && reference.kind === kind && reference.scope === scope &&
        freshAt(reference.at, now, constants.RTT_BASELINE_MAX_AGE_MS);
      if (comparable) {
        state.rttRequalification = null;
        const improved = headroom && overhead <= reference.baseline + constants.RTT_RECOVERY_MARGIN_MS;
        const continuous = freshAt(state.rttRecoveryAt, now, budget) && now > state.rttRecoveryAt;
        state.rttRecoverySamples = improved ? (continuous ? state.rttRecoverySamples + 1 : 1) : 0;
        state.rttRecoveryAt = improved ? now : null;
        state.rttEvidenceMaxAgeMs = budget;
        if (improved) reference.at = context.at = now;
      } else if (state.weakNetworkClass === "rtt") {
        // Evidence for a different request shape cannot finish an almost-ready
        // exit while this current shape is still deteriorated or unknown.
        state.rttRecoverySamples = 0;
        state.rttRecoveryAt = null;
        sampleRttRequalification(state, input, context, kind, scope);
      }
      return "";
    }
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
        context.baseline = state.requestOverheadBaselineMs;
      }
      context.at = now;
    }
    return state.requestOverheadSamples >= 4 ? "rtt" : "";
  }

  function sampleRttRequalification(state, input, context, kind, scope) {
    const now = input.now, duration = input.duration;
    const budget = evidenceMaxAgeMs(duration);
    const eligible = kind === "whole" && Number.isFinite(duration) && duration > 0 && duration <= 30 &&
      input.requestOverheadMs <= constants.RTT_REQUALIFY_OVERHEAD_CAP_MS &&
      Number.isFinite(input.bandwidthRatio) && input.bandwidthRatio >= constants.STABLE_RECOVERY_BANDWIDTH_RATIO &&
      Number.isFinite(input.bufferAhead) && input.bufferAhead >= 6 &&
      !recentNetworkError(state, now) && !state.recoveryNeedsMedia && mediaEvidenceFresh(state, now) &&
      freshAt(state.recoveryMotionAt, now, state.mediaEvidenceMaxAgeMs);
    if (!eligible) { state.rttRequalification = null; return; }
    let candidate = state.rttRequalification;
    // Two independent, bounded windows: collected observations are not yet a
    // healthy reference. Later requests must validate them before promotion.
    const maxAge = budget * (constants.RTT_REQUALIFY_COLLECT_REQUESTS + constants.RTT_REQUALIFY_VALIDATE_REQUESTS + 2);
    if (!candidate || candidate.scope !== scope || candidate.context !== context ||
      !freshAt(candidate.lastAt, now, budget) || now - candidate.startedAt > maxAge) {
      candidate = state.rttRequalification = { scope, context, startedAt: now, lastAt: now,
        phase: "collecting", values: [], mean: null, validated: 0 };
    }
    candidate.lastAt = now;
    if (candidate.phase === "collecting") {
      candidate.values.push(input.requestOverheadMs);
      if (candidate.values.length > constants.RTT_REQUALIFY_COLLECT_REQUESTS) candidate.values.shift();
      if (candidate.values.length === constants.RTT_REQUALIFY_COLLECT_REQUESTS &&
        now - candidate.startedAt >= constants.RTT_REQUALIFY_MIN_SPAN_MS) {
        candidate.mean = candidate.values.reduce((a, b) => a + b, 0) / candidate.values.length;
        candidate.phase = "validating";
      }
      return;
    }
    if (input.requestOverheadMs > candidate.mean + constants.RTT_RECOVERY_MARGIN_MS) {
      state.rttRequalification = null;
      return;
    }
    candidate.validated += 1;
    if (candidate.validated < constants.RTT_REQUALIFY_VALIDATE_REQUESTS) return;
    context.values = candidate.values.slice(); context.baseline = candidate.mean; context.at = now;
    state.requestOverheadBaseline = context.values;
    state.requestOverheadBaselineMs = context.baseline;
    state.rttReference = { kind, scope, baseline: context.baseline, at: now, origin: "requalified" };
    state.rttRecoverySamples = constants.RTT_RECOVERY_REQUESTS;
    state.rttRecoveryAt = now; state.rttEvidenceMaxAgeMs = budget;
    state.rttRequalification = null;
  }

  function sampleBufferReadiness(state, bufferAhead) {
    const buffer = Number(bufferAhead);
    state.weakBufferReady = Boolean(state.weakNetworkClass) && Number.isFinite(buffer) &&
      buffer >= (state.weakBufferReady ? 6 : 8);
    return state.weakBufferReady;
  }

  function sampleRecovery(state, input) {
    const ratio = input.bandwidthRatio;
    const bufferAhead = Number(input.bufferAhead);
    const now = input.now;
    const lastSampleAt = state.recoveryLastSampleAt;
    const gap = lastSampleAt === null ? null : now - lastSampleAt;
    const allowed = Number.isFinite(now) && now >= 0 && input.online !== false &&
      !state.wasOffline && input.paused !== true && input.seeking !== true;
    const empty = () => ({ fastSamples: state.fastRecoverySamples,
      stableSamples: state.stableRecoverySamples, networkQuietFor: quietForSince(state.lastNetworkErrorAt, now), path: "" });
    if (!allowed || (gap !== null && (gap < 0 || gap > constants.RECOVERY_SAMPLE_GAP_MS))) {
      invalidateRecovery(state);
      return empty();
    }
    if (gap !== null && gap < constants.RECOVERY_SAMPLE_MIN_MS) return empty();
    state.recoveryLastSampleAt = now;
    sampleMediaEvidence(state, input);
    const mediaHealthy = recoveryEvidenceFresh(state, now);
    const rttHealthy = state.weakNetworkClass !== "rtt" ||
      (state.rttReference && state.rttRecoverySamples >= constants.RTT_RECOVERY_REQUESTS &&
        freshAt(state.rttRecoveryAt, now, state.rttEvidenceMaxAgeMs));
    const networkQuietFor = quietForSince(state.lastNetworkErrorAt, now);
    const downloadsHealthy = input.noRecentNetworkErrors === true && mediaHealthy && rttHealthy;
    const fastHealthy = Number.isFinite(ratio) &&
      ratio >= constants.FAST_RECOVERY_BANDWIDTH_RATIO &&
      Number.isFinite(bufferAhead) && bufferAhead >= constants.FAST_RECOVERY_BUFFER_SECONDS &&
      downloadsHealthy;
    const stableNetworkHealthy = Number.isFinite(ratio) &&
      ratio >= constants.STABLE_RECOVERY_BANDWIDTH_RATIO &&
      downloadsHealthy;
    const stableBufferHealthy = Number.isFinite(bufferAhead) && bufferAhead >= constants.STABLE_RECOVERY_BUFFER_SECONDS;
    const lastStableEvidenceAt = Number(state.stableRecoveryLastEvidenceAt);
    const stableEvidenceFresh = state.stableRecoverySamples > 0 && lastStableEvidenceAt >= 0 && Number.isFinite(now) &&
      Math.max(0, now - lastStableEvidenceAt) <= constants.STABLE_RECOVERY_EVIDENCE_HOLD_MS;

    state.fastRecoverySamples = fastHealthy ? state.fastRecoverySamples + 1 : 0;
    // Complete two-second segments create a sawtooth buffer even on a stable
    // link. Count only >=6s samples, hold evidence through short cadence valleys,
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

    const path = qualifiedRecoveryPath(state, input);
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
    const timeDuplicate = !episodeAlreadyActive && previous !== null &&
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
    const kind = state.requestContexts.whole?.baseline !== null && state.requestContexts.whole
      ? "whole" : state.requestKind;
    const context = state.requestContexts[kind];
    state.rttReference = context && context.baseline !== null
      ? { kind, scope: state.requestScope, baseline: context.baseline, at: context.at } : null;
    state.rttRecoverySamples = 0;
    state.rttRecoveryAt = null;
  }

  function markWeakRecovery(state, path) {
    resetTransitionCounters(state);
    resetNetworkSamples(state, true);
    state.weakNetworkClass = "";
    state.weakBufferReady = false;
    state.stallIncidents = [];
    state.lastStallAt = null;
    endStallEpisode(state);
    state.weakRecoveryPath = path === "stable" ? "stable" : "fast";
  }

  function markOffline(state) {
    state.wasOffline = true;
    invalidateRecovery(state);
  }

  function consumeOnlineAfterOffline(state) {
    const recovered = state.wasOffline === true;
    state.wasOffline = false;
    if (recovered) invalidateRecovery(state);
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

  function createRequestObserver(hooks) {
    // Observe the pinned Loader's existing stats; adding onProgress would
    // change progressive delivery. No XHR/fetch patch, body copy or new timer.
    const active = new Set();
    let epoch = 0, sequence = 0, idleActionSpent = false;
    let completed = new WeakMap();
    const totals = { success: 0, error: 0, timeout: 0, abort: 0, destroy: 0, throw: 0, idleActions: 0 };
    let last = null;
    // A statistics reset is not cancellation of a live native Loader attempt.
    // Native abort/destroy/replacement and the player owner govern callbacks;
    // the observation epoch separately governs attribution of their statistics.
    const current = record => !record.terminal && record.loader.observation === record && hooks.isCurrent();
    const currentStats = record => current(record) && record.epoch === epoch;
    function sample(record) {
      if (!currentStats(record)) return;
      const stats = record.loader.stats;
      if (!stats) return;
      const now = hooks.now();
      if (!Number.isFinite(now) || now < record.startedAt) return;
      const retry = Number(stats.retry) || 0;
      const bytes = stats.loaded;
      if (retry !== record.retry || (Number.isFinite(bytes) && bytes < record.bytes)) {
        record.attempt += 1; record.retry = retry; record.bytes = 0;
        record.lastGrowthAt = null; record.growthSamples = 0;
      }
      if (!stats.aborted && Number.isFinite(bytes) && bytes > record.bytes) {
        record.bytes = bytes; record.lastGrowthAt = now; record.growthSamples += 1;
        if (record.media && hooks.isRelevant(record.context)) hooks.onTransfer(record.context, now);
      }
      const first = stats.loading && stats.loading.first;
      record.firstByteAt = Number.isFinite(first) && first > 0 ? first : null;
    }
    function finish(record, reason) {
      if (record.terminal) return false;
      sample(record);
      const owned = current(record);
      const ownsStats = currentStats(record);
      record.terminal = true;
      active.delete(record);
      if (ownsStats) {
        totals[reason] += 1;
        last = { id: record.id, attempt: record.attempt, kind: record.kind, reason,
          bytes: record.bytes, growthSamples: record.growthSamples };
        if (reason === "success" && record.media && record.loader.stats) {
          completed.set(record.loader.stats, { epoch, frag: record.context.frag, part: record.context.part });
        }
      }
      return owned;
    }
    return {
      wrap(Base) {
        return class ObservedRequestLoader extends Base {
          load(context, config, callbacks) {
            if (this.observation) return super.load(context, config, callbacks);
            // Hls registers its MANIFEST_LOADING listener before the app. Reset
            // source evidence here, before the new request (including a cache /
            // synchronous response) starts, rather than in a later event listener.
            if (context?.type === "manifest" && hooks.isCurrent() && hooks.onManifestRequest) {
              hooks.onManifestRequest();
            }
            const frag = context && context.frag;
            const media = Boolean(frag && frag.type === "main" && frag.sn !== "initSegment");
            const record = { id: ++sequence, attempt: 1, epoch, loader: this, context,
              media, kind: media ? (context.part ? "part" : "whole") : frag ? "other-media" : "other",
              startedAt: hooks.now(), firstByteAt: null, bytes: 0, retry: Number(this.stats?.retry) || 0,
              lastGrowthAt: null, growthSamples: 0, terminal: false };
            this.observation = record;
            // Excess parallel requests retain native loading but no telemetry.
            if (active.size < 32) active.add(record);
            const forwarded = { ...callbacks };
            for (const [name, reason] of [["onSuccess", "success"], ["onError", "error"], ["onTimeout", "timeout"], ["onAbort", "abort"]]) {
              if (typeof callbacks[name] !== "function") continue;
              forwarded[name] = (...args) => {
                if (!finish(record, reason)) return;
                return callbacks[name].apply(callbacks, args);
              };
            }
            if (typeof callbacks.onProgress === "function") forwarded.onProgress = (...args) => {
              if (!current(record)) return;
              sample(record);
              return callbacks.onProgress.apply(callbacks, args);
            };
            try { return super.load(context, config, forwarded); }
            catch (error) { finish(record, "throw"); throw error; }
          }
          abort() {
            const record = this.observation;
            if (record && record.terminal) return;
            // Native abort invokes the existing onAbort path (not onTimeout),
            // so no synthetic timeout/retry competes with the application queue.
            try { return super.abort(); }
            finally { if (record) finish(record, "abort"); }
          }
          destroy() {
            if (this.observation) finish(this.observation, "destroy");
            return super.destroy();
          }
        };
      },
      accepts(stats, frag, part) {
        const done = completed.get(stats);
        return Boolean(done && done.epoch === epoch && done.frag === frag && (done.part || null) === (part || null));
      },
      invalidate() {
        epoch += 1; active.clear(); completed = new WeakMap();
      },
      poll() {
        const rows = [];
        for (const record of [...active]) {
          if (!currentStats(record)) { active.delete(record); continue; }
          sample(record);
          const now = hooks.now();
          const facts = hooks.mediaState(record.context);
          const idleMs = record.lastGrowthAt === null ? null : now - record.lastGrowthAt;
          const budgetMs = evidenceMaxAgeMs(facts.duration);
          // Absence of browser progress events is not wire-level proof. This
          // candidate is observation-only unless the independent release gate
          // explicitly enables the application hook after browser validation.
          const candidate = record.media && hooks.isRelevant(record.context) && record.kind === "whole" && record.retry === 0 &&
            facts.published === true && facts.needed === true && facts.playing === true &&
            Number.isFinite(facts.duration) && facts.duration > 0 && facts.duration <= 30 &&
            Number.isFinite(facts.bufferAhead) && facts.bufferAhead < 3 &&
            record.bytes > 0 && idleMs !== null && idleMs >= budgetMs;
          rows.push({ id: record.id, attempt: record.attempt, kind: record.kind,
            bytes: record.bytes, growthSamples: record.growthSamples, idleMs,
            firstByteObserved: record.firstByteAt !== null, bodyIdleCandidate: Boolean(candidate),
            progressCertainty: "event-limited", budgetMs });
          if (candidate && hooks.activeRecovery === true && !idleActionSpent && current(record)) {
            idleActionSpent = true;
            // Only this still-owned attempt can be aborted. Reentrant callbacks
            // may replace the player; the application rechecks before queuing.
            record.loader.abort();
            totals.idleActions += 1;
            if (record.epoch === epoch && hooks.isCurrent()) hooks.onIdle();
          }
        }
        return rows;
      },
      snapshot() { return { active: active.size, activeRecoveryEnabled: hooks.activeRecovery === true, ...totals, last }; }
    };
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
    evidenceMaxAgeMs,
    noteMediaTransfer,
    mediaEvidenceFresh,
    sampleMediaEvidence,
    recoveryEvidenceFresh,
    qualifiedRecoveryPath,
    invalidateRecovery,
    resetRequestContext,
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
    createRequestObserver,
    withAppendOwnership,
    profileFor,
    isSafeBacktrack,
    weakSafePoint
  });
});
