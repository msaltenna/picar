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

module.exports = { clampTelemetryInterval, TELEMETRY_INTERVAL_MIN_MS, TELEMETRY_INTERVAL_MAX_MS };
