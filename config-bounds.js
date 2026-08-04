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
function sanitizeParamOverlay(value, fallback) {
  const rejected = [];
  if (value === undefined || value === null) {
    return { overlay: { ...fallback }, rejected, usedFallback: true };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    rejected.push(`whole overlay is ${Array.isArray(value) ? 'an array' : `a ${typeof value}`}, not an object`);
    return { overlay: { ...fallback }, rejected, usedFallback: true };
  }
  const overlay = {};
  for (const [name, raw] of Object.entries(value)) {
    const n = typeof raw === 'number' ? raw : NaN; // a numeric STRING is a config
                                                   // error worth surfacing, not
                                                   // something to quietly coerce
    if (!Number.isFinite(n)) { rejected.push(`${name}=${JSON.stringify(raw)}`); continue; }
    overlay[name] = n;
  }
  return { overlay, rejected, usedFallback: false };
}

module.exports = {
  sanitizeParamOverlay,
  clampTelemetryInterval, TELEMETRY_INTERVAL_MIN_MS, TELEMETRY_INTERVAL_MAX_MS,
  overlayChainMs, clampOverlayReassert, clampOverlayAttempts,
  OVERLAY_REASSERT_MAX_MS, OVERLAY_ATTEMPTS_MAX,
  OVERLAY_WRITE_SPACING_MS, OVERLAY_SETTLE_MS, OVERLAY_READ_SPACING_MS,
};
