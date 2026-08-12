// config-bounds.js — clamps for config values reachable through the untracked
// picar-cfg.local.json overlay.
//
// Extracted from app.js because app.js binds both HTTPS ports and the MAVProxy
// socket at require time, so nothing in it is reachable from a host test — and a
// mutation removing an upper bound therefore survived the whole suite.
//
// The overlay can set ANY key with no branch, diff, review or validation record
// (an open P0), so every value it can reach needs a bound that holds regardless of
// what it says.
'use strict';

// Node stores a setInterval delay in a 32-bit signed int. Infinity, NaN via a
// string, or anything past 2^31-1 is coerced to **1 ms** — measured
// _idleTimeout === 1 — which is the opposite of the slow interval the value
// implies, and revives exactly the CPU churn the lower bound exists to prevent.
// So both ends are clamped.
const TELEMETRY_INTERVAL_MIN_MS = 250;
const TELEMETRY_INTERVAL_MAX_MS = 60000;

function clampTelemetryInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1000;          // absent, 0, NaN, Infinity
  return Math.min(TELEMETRY_INTERVAL_MAX_MS, Math.max(TELEMETRY_INTERVAL_MIN_MS, n));
}

// ── Param-overlay reassert bounds ────────────────────────────────────────────
//
// Both of these were previously lower-bounded only, which is not a bound at all
// for a value reachable through the untracked overlay: `1e400` is valid JSON that
// parses as Infinity, Node coerces the infinite timer to 1 ms, and with the attempt
// count also unbounded the result was a permanent 1 ms loop rebuilding the overlay
// chain and firing PARAM_SET roughly every millisecond. The commit that introduced
// it claimed the loop was "bounded" and "cannot spin"; a review reproduced both.

// The overlay's schedule, OWNED HERE and imported by applyParamOverlay so the two
// cannot drift. A previous version hand-copied these numbers into both files, and a
// review proved the consequence: mutating the driver's real spacing from 250 ms to
// 500 ms left the whole 166-test suite green while the actual chain grew past the
// floor derived from the stale copy. "Derived from the schedule" has to mean the
// same constants, not a transcription of them.
const OVERLAY_WRITE_SPACING_MS = 250;
const OVERLAY_SETTLE_MS        = 500;
const OVERLAY_READ_SPACING_MS  = 150;

// How long one full overlay attempt takes: writes spaced, then a settle, then
// read-backs spaced. Computed rather than assumed, because a larger overlay makes
// any fixed floor wrong — the original 3000 ms floor was already shorter than the
// real 3650 ms chain, so a reassert cancelled the read-backs that would have
// confirmed it.
function overlayChainMs(entryCount, readCount) {
  const entries = Math.max(0, Number(entryCount) || 0);
  const reads   = Math.max(0, Number(readCount)  || 0);
  return entries * OVERLAY_WRITE_SPACING_MS + OVERLAY_SETTLE_MS
       + Math.max(0, reads - 1) * OVERLAY_READ_SPACING_MS;
}

// Reassert no sooner than a full chain plus time for the replies to come back, and
// never so late (or so infinite) that the timer overflows into 1 ms.
const OVERLAY_RESPONSE_MARGIN_MS = 1500;
const OVERLAY_REASSERT_MAX_MS    = 60000;

function clampOverlayReassert(value, chainMs) {
  const floor = Math.max(1000, Number(chainMs) || 0) + OVERLAY_RESPONSE_MARGIN_MS;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return floor;
  // The ceiling must never drop below the floor. Applying a flat 60 s cap AFTER the
  // floor meant that once the chain exceeded 60 s — reachable with a large custom
  // mavproxy_param_overlay, which the untracked config can set with no review — every
  // FINITE configured value collapsed to 60 000 ms, i.e. back inside the chain, and
  // each reassert cancelled the writes and read-backs still in flight so no attempt
  // ever completed. The inversion was the tell: an ABSENT value was safe (it returns
  // the uncapped floor) while an explicit, sane 5000 was broken.
  const ceiling = Math.max(OVERLAY_REASSERT_MAX_MS, floor);
  return Math.min(ceiling, Math.max(floor, n));
}

// A small finite integer. Ten attempts is already far more than a healthy link
// needs, and an unbounded count is what turned a retry into a storm.
const OVERLAY_ATTEMPTS_MAX = 10;

function clampOverlayAttempts(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 4;
  return Math.min(OVERLAY_ATTEMPTS_MAX, Math.max(1, Math.round(n)));
}

// ── Parameter-overlay shape validation ────────────────────────────────────────
//
// The overlay is reachable from untracked picar-cfg.local.json, so its VALUE is
// operator-supplied and its SHAPE was never checked. Two concrete failures:
//
//   mavproxy_param_overlay: []      -> truthy, so it replaced the defaults, and
//                                      Object.entries([]) is empty. The overlay
//                                      silently pushed nothing, FRAME_CLASS was
//                                      never corrected, and every read-back
//                                      "verified" whatever the FC already held.
//   mavproxy_param_overlay: "x"     -> Object.entries('x') yields ['0','x'], and
//                                      buf.writeFloatLE(NaN...) is fine but the
//                                      name padding throws inside a setTimeout —
//                                      an uncaught exception in a timer, which
//                                      takes the process down WHILE ARMED.
//
// So coerce to a plain object of finite numbers and report everything dropped.
// Rejecting loudly beats a config typo disabling the safety overlay in silence.
// MAVLink PARAM_SET carries param_id as char[16], and buildParamSet() does
// `String(name).slice(0, 16)`. So the WIRE name is the first 16 characters, and a longer key
// is a different JavaScript property that becomes the SAME parameter on the flight
// controller. `RC_OVERRIDE_TIME` is exactly 16 characters, so `RC_OVERRIDE_TIMEX` would pass
// any name-based check and then land on the FC as `RC_OVERRIDE_TIME` — setting the
// stale-override expiry 15x longer on an armed vehicle. Names longer than this are refused
// rather than truncated: silent truncation is how that bypass exists at all.
const MAX_PARAM_ID_LEN = 16;

// Parameters the UNTRACKED overlay is permitted to change. Empty, deliberately.
//
// Safety invariant 8: safety-relevant configuration cannot be overridden off-branch. Every
// parameter this driver pushes is output mapping, failsafe timing, sensor configuration or
// throttle calibration — there is no safety-neutral entry here.
//
// So a real per-rover difference (different servo wiring, a different frame, a recalibrated
// RC3_TRIM) has to be a REVIEWED change to the tracked overlay below. Note what that means
// honestly: no per-rover PROFILE mechanism exists. app.js shallow-merges the untracked config
// and discards which file a value came from, and there is exactly one DEFAULT_PARAM_OVERLAY for
// the whole fleet. An earlier revision of this comment promised "a tracked rover profile" as
// though that were available; it is not. Until it is, a rover needing different parameters
// cannot be served by this mechanism at all, and pretending otherwise by allowlisting critical
// names here is the one resolution that must not be chosen.
//
// This is an ALLOWLIST, and the distinction is not academic. The first version of this fix
// blacklisted EXPECTED_CRITICAL_PARAMS, which let through everything outside that 11-name
// table — including `RCMAP_THROTTLE`, which remaps which channel IS the throttle, and the two
// GPS parameters this overlay pushes but does not verify. If a name genuinely needs to become
// overridable, add it HERE with the reason, so the decision appears in a diff.
const OVERRIDABLE_PARAMS = new Set([]);

// `allowedNames` is the allowlist above; anything outside it is refused. Passed in rather than
// read directly so the rule is testable against a small fixture instead of the real table.
function sanitizeParamOverlay(value, fallback, allowedNames) {
  const rejected = [];
  const allowed  = new Set(allowedNames || []);

  // MERGE, never replace. This used to build `const overlay = {}` and populate it only from
  // the caller's value, so `{FRAME_CLASS: 1}` in untracked picar-cfg.local.json produced an
  // overlay of exactly ONE parameter — silently discarding all six SERVOn_FUNCTION entries,
  // MOT_SLEWRATE, RC_OVERRIDE_TIME, RC3_DZ, RC3_TRIM, AHRS_GPS_USE and GPS1_TYPE. Losing
  // SERVO1_FUNCTION=26/SERVO3_FUNCTION=70 is what makes steering drive throttle.
  //
  // Read-back would then have reported at most 10 of the 11 VERIFIED parameters missing —
  // not "12 of 13", which an earlier revision of this comment claimed by conflating the 13
  // pushed with the 11 read back, and by counting FS_* entries that live on an unmerged
  // branch rather than here. Two of the 13 are pushed and never verified at all
  // (AHRS_GPS_USE, GPS1_TYPE), which is its own tracked gap.
  //
  // Either way nothing gates arming on verification (invariant 7), so the report was a log
  // line and not a refusal. Starting from the built-in set means a partial overlay can only
  // ADD or adjust, never subtract.
  const overlay = { ...fallback };

  if (value === undefined || value === null) {
    return { overlay, rejected, invalidShape: true, applied: [] };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    rejected.push(`whole overlay is ${Array.isArray(value) ? 'an array' : `a ${typeof value}`}, not an object`);
    return { overlay, rejected, invalidShape: true, applied: [] };
  }

  const applied = [];
  for (const [name, raw] of Object.entries(value)) {
    const n = typeof raw === 'number' ? raw : NaN; // a numeric STRING is a config
                                                   // error worth surfacing, not
                                                   // something to quietly coerce
    if (!Number.isFinite(n)) { rejected.push(`${name}=${JSON.stringify(raw)}`); continue; }

    // Refuse before the allowlist check, because a too-long name is not the name it looks
    // like: it becomes a DIFFERENT parameter's wire ID after truncation.
    if (name.length > MAX_PARAM_ID_LEN) {
      rejected.push(`${name} is longer than ${MAX_PARAM_ID_LEN} characters, so PARAM_SET ` +
                    `would silently send it as "${name.slice(0, MAX_PARAM_ID_LEN)}"`);
      continue;
    }

    // Safety invariant 8. Refused regardless of value, INCLUDING a value identical to the
    // built-in one. Accepting an identical restatement looks harmless and creates ownership
    // ambiguity: the local file appears to own the parameter, and when a later reviewed
    // branch changes the built-in, the same local entry starts being refused while the rover
    // runs the new value and the file still declares the old one. Refusing on sight exposes
    // the illegal ownership the moment the file is introduced.
    if (!allowed.has(name)) {
      const builtIn = Object.prototype.hasOwnProperty.call(fallback, name) ? fallback[name] : undefined;
      rejected.push(builtIn === undefined
        ? `${name}=${n} may not be introduced from untracked config — safety-relevant ` +
          'parameters are owned by the tracked overlay'
        : `${name}=${n} may not be overridden off-branch (keeping the built-in ${builtIn})`);
      continue;
    }

    overlay[name] = n;
    applied.push(name);
  }
  return { overlay, rejected, invalidShape: false, applied };
}

module.exports = {
  sanitizeParamOverlay, OVERRIDABLE_PARAMS, MAX_PARAM_ID_LEN,
  clampTelemetryInterval, TELEMETRY_INTERVAL_MIN_MS, TELEMETRY_INTERVAL_MAX_MS,
  overlayChainMs, clampOverlayReassert, clampOverlayAttempts,
  OVERLAY_REASSERT_MAX_MS, OVERLAY_ATTEMPTS_MAX,
  OVERLAY_WRITE_SPACING_MS, OVERLAY_SETTLE_MS, OVERLAY_READ_SPACING_MS,
};
