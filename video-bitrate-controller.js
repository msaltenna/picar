'use strict';

// Decide what video bitrate the link can currently afford.
//
// WHY THIS EXISTS. `rpiCameraBitrate` is a fixed target: the encoder holds it regardless
// of conditions, and MediaMTX's rpicamera source does not act on WebRTC congestion
// feedback (REMB/TWCC). So as the operator drives away and the MCS rate collapses, video
// keeps demanding the same bitrate while each bit costs far more airtime. WiFi is
// half-duplex, so that starves the *downlink* the operator's commands arrive on — measured
// on rover3 as 61 `no input for 1000 ms` fail-safe trips in a 36-second window, each one
// forcing neutral and disarming.
//
// Reducing offered load is the only lever that helps the command path. DSCP/WMM marking
// can prioritise what the ROVER transmits, but commands are downlink; the rover cannot
// prioritise what the access point sends it. Freeing airtime helps both directions.
//
// THIS MODULE IS THE DECISION ONLY. Applying a bitrate is a separate concern behind a
// sink interface, because how cheaply it can be applied is a hardware question that has
// not been settled on this hardware yet — see APPLY MECHANISMS at the bottom.
//
// DESIGN CONSTRAINTS, each of which a test pins:
//
//   * Asymmetric response. Step DOWN quickly, recover SLOWLY. A degrading link is
//     urgent — that is when commands are being dropped. A recovering one is not, and
//     every change costs a camera respawn, so eagerly stepping back up trades the
//     operator's video for nothing.
//   * Hysteresis, not thresholds. A single boundary makes the ladder oscillate when the
//     signal sits on it, and each oscillation is a video interruption. Entering a profile
//     upward requires a better signal than leaving it downward.
//   * A minimum dwell. Bounds interruptions per minute no matter how the signal behaves.
//   * Fail to the LOWEST profile on an unreadable signal, but only after the same
//     sustain window. "I cannot measure the link" is not evidence the link is good, and
//     the conservative direction protects the command path. Requiring the window stops a
//     single failed /proc read from dropping quality.

// Ordered worst-to-best. `upAtDbm` is the signal required to ENTER this profile from
// below; leaving it downward uses the profile below's threshold minus the hysteresis
// margin, so the two directions never share a boundary.
//
// The dBm values are STARTING POINTS, not measurements. They have not been fitted to a
// logged drive — rover3 went off the network before one could be captured. They are
// deliberately conservative, and `TASKS.md` carries the item to fit them to real data.
const DEFAULT_PROFILES = [
  { name: 'minimal', bitrateKbps: 120, width: 320, height: 240, fps: 8,  upAtDbm: -Infinity },
  { name: 'low',     bitrateKbps: 200, width: 320, height: 240, fps: 12, upAtDbm: -70 },
  { name: 'medium',  bitrateKbps: 400, width: 480, height: 360, fps: 15, upAtDbm: -62 },
  { name: 'high',    bitrateKbps: 800, width: 640, height: 480, fps: 20, upAtDbm: -54 },
];

const DEFAULTS = {
  downSustainMs: 8000,    // a bad link is urgent, but not so urgent that one dip counts
  upSustainMs:   45000,   // recovery is not urgent, and each step costs video
  minDwellMs:    20000,   // hard bound on interruptions per minute
  hysteresisDb:  4,       // dead band between entering upward and leaving downward
};

function isFiniteSignal(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Which profile a given signal justifies, ignoring history. An unreadable signal maps to
// the lowest profile — see the fail-to-lowest reasoning above.
function profileForSignal(profiles, signalDbm, hysteresisDb, currentIndex) {
  if (!isFiniteSignal(signalDbm)) return 0;
  // Walk down from the best profile the signal qualifies for.
  let target = 0;
  for (let i = profiles.length - 1; i >= 0; i--) {
    // Entering profile i from BELOW needs upAtDbm. Staying in i (or leaving it) uses a
    // more forgiving threshold, so sitting on a boundary does not oscillate.
    const threshold = i > currentIndex
      ? profiles[i].upAtDbm
      : profiles[i].upAtDbm - hysteresisDb;
    if (signalDbm >= threshold) { target = i; break; }
  }
  return target;
}

function createBitrateController({
  profiles = DEFAULT_PROFILES,
  startIndex = null,
  downSustainMs = DEFAULTS.downSustainMs,
  upSustainMs = DEFAULTS.upSustainMs,
  minDwellMs = DEFAULTS.minDwellMs,
  hysteresisDb = DEFAULTS.hysteresisDb,
} = {}) {
  if (!Array.isArray(profiles) || profiles.length < 2) {
    throw new TypeError('createBitrateController needs at least two profiles');
  }
  // Ascending bitrate is what makes "index 0 is the cheapest" true, and the whole ladder
  // depends on it. A mis-ordered table would step the wrong way under load.
  for (let i = 1; i < profiles.length; i++) {
    if (!(profiles[i].bitrateKbps > profiles[i - 1].bitrateKbps)) {
      throw new TypeError('profiles must be ordered by ascending bitrateKbps');
    }
    if (!(profiles[i].upAtDbm > profiles[i - 1].upAtDbm)) {
      throw new TypeError('profiles must be ordered by ascending upAtDbm');
    }
  }

  // Start at the top only if told to. Defaulting to the best profile would mean every
  // boot offers maximum bitrate until the first sustain window elapses.
  let index = Number.isInteger(startIndex)
    ? Math.max(0, Math.min(profiles.length - 1, startIndex))
    : profiles.length - 1;
  let lastChangeAt = null;
  let pendingTarget = null;
  let pendingSince = null;

  // Feed one link sample. Returns the profile to apply, or null for "no change".
  function sample({ signalDbm, at }) {
    if (!Number.isFinite(at)) throw new TypeError('sample needs a finite timestamp `at`');
    const target = profileForSignal(profiles, signalDbm, hysteresisDb, index);

    if (target === index) {
      // Back where we are: abandon any pending move. This is what makes the sustain
      // window a SUSTAINED condition rather than a count of samples that ever occurred.
      pendingTarget = null;
      pendingSince = null;
      return { change: null, reason: 'holding', index, pendingTarget: null };
    }

    if (pendingTarget !== target) {
      pendingTarget = target;
      pendingSince = at;
      return { change: null, reason: 'pending', index, pendingTarget: target };
    }

    const needMs = target < index ? downSustainMs : upSustainMs;
    if (at - pendingSince < needMs) {
      return { change: null, reason: 'pending', index, pendingTarget: target };
    }
    if (lastChangeAt !== null && at - lastChangeAt < minDwellMs) {
      // Sustained and justified, but too soon. Keep the intent pending rather than
      // discarding it, so the change lands as soon as the dwell expires.
      return { change: null, reason: 'dwell', index, pendingTarget: target };
    }

    // Move ONE step, not straight to the target. A single step per decision keeps the
    // change small and lets the next samples confirm the new level actually helped.
    const nextIndex = target < index ? index - 1 : index + 1;
    const direction = target < index ? 'down' : 'up';
    index = nextIndex;
    lastChangeAt = at;
    pendingTarget = null;
    pendingSince = null;
    return {
      change: profiles[index],
      reason: direction,
      index,
      pendingTarget: null,
    };
  }

  return {
    sample,
    profiles,
    current: () => profiles[index],
    currentIndex: () => index,
    state: () => ({ index, lastChangeAt, pendingTarget, pendingSince }),
  };
}

// ── APPLY MECHANISMS — what is settled and what is not ───────────────────────
//
// The controller above is hardware-independent. Applying a bitrate is not, and the two
// candidate mechanisms differ by an order of magnitude in cost:
//
//  1. REWRITE mediamtx.yml AND LET MEDIAMTX RELOAD IT. This works today and is
//     evidenced: on 2026-08-05 at 20:03:01 picar's startup wrote the yml with new
//     dimensions and MediaMTX logged `configuring streams: (0) 320x240` with a new camera
//     child, while its systemd ActiveEnterTimestamp stayed at 18:30:42 — the service was
//     never restarted. So the cost of a change is a CAMERA RESPAWN (~1-2 s of video), not
//     a service restart.
//
//     Note the consequence for the existing code: `setParams()` calls
//     `systemctl restart mediamtx` explicitly, which is a strictly larger interruption
//     than the reload it would have got for free. That restart looks redundant and is
//     worth removing on its own merits — filed in TASKS.md rather than changed here,
//     because it needs on-target confirmation that a reload alone is reliably picked up.
//
//  2. SET THE ENCODER'S BITRATE AT RUNTIME, with no respawn at all. On this SoC the
//     hardware H.264 encoder is a V4L2 stateful device exposing a `video_bitrate`
//     control, which is settable while streaming. That would make adaptation free and is
//     the reason to prefer option C at all.
//
//     UNVERIFIED ON THIS HARDWARE, and deliberately not implemented on assumption. Two
//     things must be established on a rover first: whether MediaMTX's embedded
//     `mtxrpicam` uses the V4L2 encoder in a way that an external control write affects
//     (V4L2 controls can be per-file-handle, in which case it will not), and whether a
//     mid-stream bitrate change is honoured without an IDR or a decoder reset at the
//     browser. Guessing at either is how three earlier hypotheses in this project turned
//     out wrong.
//
// So the sink is an interface and the controller does not care which one is behind it.
// Mechanism 1 is implementable now; mechanism 2 slots in unchanged once measured.
module.exports = {
  createBitrateController,
  profileForSignal,
  DEFAULT_PROFILES,
  DEFAULTS,
};
