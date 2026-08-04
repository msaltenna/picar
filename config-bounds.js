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

// How long one full overlay attempt takes to complete, from its own schedule:
// writes are spaced 250 ms, then a 500 ms settle, then read-backs every 150 ms.
// Computed rather than assumed, because a larger overlay makes any fixed floor
// wrong — the previous 3000 ms floor was already shorter than the real 3650 ms
// chain, so a reassert could cancel the read-backs that would have confirmed it.
function overlayChainMs(entryCount, readCount) {
  const entries = Math.max(0, Number(entryCount) || 0);
  const reads   = Math.max(0, Number(readCount)  || 0);
  return entries * 250 + 500 + Math.max(0, reads - 1) * 150;
}

// Reassert no sooner than a full chain plus time for the replies to come back, and
// never so late (or so infinite) that the timer overflows into 1 ms.
const OVERLAY_RESPONSE_MARGIN_MS = 1500;
const OVERLAY_REASSERT_MAX_MS    = 60000;

function clampOverlayReassert(value, chainMs) {
  const floor = Math.max(1000, Number(chainMs) || 0) + OVERLAY_RESPONSE_MARGIN_MS;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return floor;
  return Math.min(OVERLAY_REASSERT_MAX_MS, Math.max(floor, n));
}

// A small finite integer. Ten attempts is already far more than a healthy link
// needs, and an unbounded count is what turned a retry into a storm.
const OVERLAY_ATTEMPTS_MAX = 10;

function clampOverlayAttempts(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 4;
  return Math.min(OVERLAY_ATTEMPTS_MAX, Math.max(1, Math.round(n)));
}

module.exports = {
  clampTelemetryInterval, TELEMETRY_INTERVAL_MIN_MS, TELEMETRY_INTERVAL_MAX_MS,
  overlayChainMs, clampOverlayReassert, clampOverlayAttempts,
  OVERLAY_REASSERT_MAX_MS, OVERLAY_ATTEMPTS_MAX,
};
