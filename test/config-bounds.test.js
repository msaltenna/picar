'use strict';

// Bounds on config values the untracked overlay can reach.
//
// The upper bound matters as much as the lower one and is much less obvious: Node
// stores a setInterval delay in a 32-bit signed int, so Infinity or anything past
// 2^31-1 becomes **1 ms**. A value that reads as "poll very slowly" produces the
// fastest possible loop — the exact CPU churn the lower bound exists to prevent.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { clampTelemetryInterval, TELEMETRY_INTERVAL_MIN_MS, TELEMETRY_INTERVAL_MAX_MS }
  = require('../config-bounds.js');

test('a sane value passes through unchanged', () => {
  assert.equal(clampTelemetryInterval(1000), 1000);
  assert.equal(clampTelemetryInterval(250), 250);
  assert.equal(clampTelemetryInterval(60000), 60000);
});

test('too-fast values are raised to the floor', () => {
  for (const v of [1, 10, 249]) assert.equal(clampTelemetryInterval(v), TELEMETRY_INTERVAL_MIN_MS);
});

test('absent, zero and negative fall back to the default', () => {
  for (const v of [undefined, null, 0, -1, -99999, '']) {
    assert.equal(clampTelemetryInterval(v), 1000, `${JSON.stringify(v)} must default`);
  }
});

test('values Node would coerce to 1 ms are neutralised', () => {
  // The whole point. Verified empirically: setInterval(fn, Infinity) yields
  // _idleTimeout === 1, and so does 2**31.
  //
  // Two safe outcomes, and which one applies depends on the input rather than being
  // arbitrary: a FINITE but absurd value is clamped to the ceiling, while a
  // non-finite one is not a quantity at all and falls back to the default. An
  // earlier draft asserted the ceiling for both, which was just a guess.
  for (const v of [2 ** 31, 2 ** 31 + 1, 1e12, Number.MAX_SAFE_INTEGER]) {
    assert.equal(clampTelemetryInterval(v), TELEMETRY_INTERVAL_MAX_MS,
      `finite-but-absurd ${v} must clamp to the ceiling`);
  }
  assert.equal(clampTelemetryInterval(Infinity), 1000, 'Infinity is not a quantity');
  assert.equal(clampTelemetryInterval(-Infinity), 1000);
  assert.equal(clampTelemetryInterval(NaN), 1000);

  // What unites them: none may fit outside a 32-bit signed int.
  for (const v of [2 ** 31, Infinity, NaN, 1e12]) {
    assert.ok(clampTelemetryInterval(v) < 2 ** 31);
  }
});

test('the clamped result never produces a 1 ms timer', () => {
  // Assert the property that actually matters, against real timers.
  for (const v of [Infinity, 2 ** 31, 0, -5, 1, 'x']) {
    const t = setInterval(() => {}, clampTelemetryInterval(v));
    const actual = t._idleTimeout;
    clearInterval(t);
    assert.ok(actual >= TELEMETRY_INTERVAL_MIN_MS,
      `input ${v} produced a ${actual} ms timer`);
  }
});

test('a non-numeric string does not become a hot loop', () => {
  assert.equal(clampTelemetryInterval('abc'), 1000);
  assert.equal(clampTelemetryInterval({}), 1000);
  assert.equal(clampTelemetryInterval([]), 1000);
});

// ── Overlay reassert bounds ──────────────────────────────────────────────────
//
// The reason these exist: both settings were lower-bounded only, which is no bound
// at all for a value the untracked overlay can reach. `1e400` is VALID JSON that
// parses as Infinity, Node coerces the infinite timer to 1 ms, and with the attempt
// count also unbounded the result was a permanent 1 ms loop rebuilding the overlay
// chain and firing PARAM_SET roughly every millisecond — on the same event loop as
// the 20 Hz override stream and the fail-safe watchdog.

const { overlayChainMs, clampOverlayReassert, clampOverlayAttempts,
        OVERLAY_REASSERT_MAX_MS, OVERLAY_ATTEMPTS_MAX } = require('../config-bounds.js');

test('the chain duration matches the overlay schedule it is derived from', () => {
  // writes 250 ms apart, 500 ms settle, read-backs 150 ms apart. With the default
  // 9-entry overlay and 7 critical params a review measured the final read at
  // 3650 ms — this must agree, or the floor below is wrong.
  assert.equal(overlayChainMs(9, 7), 3650);
  assert.equal(overlayChainMs(0, 0), 500, 'an empty overlay is just the settle');
  assert.ok(overlayChainMs(20, 7) > overlayChainMs(9, 7), 'a larger overlay takes longer');
});

test('reassert never fires before a full chain could have been confirmed', () => {
  // The old fixed 3000 ms floor was SHORTER than the 3650 ms chain, so a reassert
  // cancelled the very read-backs that would have confirmed the previous attempt.
  const chain = overlayChainMs(9, 7);
  for (const v of [undefined, null, 0, -5, 1, 3000, 3649, 'x', {}]) {
    const got = clampOverlayReassert(v, chain);
    assert.ok(got > chain, `${JSON.stringify(v)} gave ${got}, which is inside the ${chain} ms chain`);
  }
});

test('a JSON-reachable infinity cannot become a 1 ms timer', () => {
  // 1e400 is the case that matters: it is legal JSON, so it can arrive through
  // picar-cfg.local.json with no review.
  const chain = overlayChainMs(9, 7);
  for (const v of [Infinity, -Infinity, NaN, 1e400, 2 ** 31, 2 ** 31 + 1, 1e12]) {
    const got = clampOverlayReassert(v, chain);
    assert.ok(Number.isFinite(got), `${v} produced a non-finite delay`);
    assert.ok(got > chain && got <= OVERLAY_REASSERT_MAX_MS, `${v} -> ${got}`);
    const t = setInterval(() => {}, got);
    const actual = t._idleTimeout;
    clearInterval(t);
    assert.ok(actual > 1000, `${v} produced a ${actual} ms timer`);
  }
});

test('a sane explicit reassert value is respected', () => {
  const chain = overlayChainMs(9, 7);
  assert.equal(clampOverlayReassert(20000, chain), 20000);
  assert.equal(clampOverlayReassert(60000, chain), 60000);
});

test('attempts are a small finite integer, always', () => {
  assert.equal(clampOverlayAttempts(undefined), 4);
  assert.equal(clampOverlayAttempts(1), 1);
  assert.equal(clampOverlayAttempts(4), 4);
  for (const v of [Infinity, 1e400, NaN, 'x', {}, 0, -3]) {
    const got = clampOverlayAttempts(v);
    assert.ok(Number.isInteger(got) && got >= 1 && got <= OVERLAY_ATTEMPTS_MAX,
      `${JSON.stringify(v)} -> ${got}`);
  }
  assert.equal(clampOverlayAttempts(9999), OVERLAY_ATTEMPTS_MAX, 'an absurd count is capped');
});

test('the driver actually uses these bounds, not its own arithmetic', () => {
  // Pinning the WIRING, not the helper. An inline lower-bound-only clamp is exactly
  // what survived mutation last round.
  const PWMMavproxy = require('../pwm_mavproxy_servo.js');
  const d = new PWMMavproxy({
    mavproxy_autostart: false,
    mavproxy_overlay_reassert_ms: 1e400,      // JSON-reachable Infinity
    mavproxy_overlay_max_attempts: 1e400,
  });
  assert.ok(Number.isFinite(d.overlayReassertMs), 'reassert delay must be finite');
  assert.ok(d.overlayReassertMs > d.overlayChainMs,
    `reassert ${d.overlayReassertMs} must exceed the ${d.overlayChainMs} ms chain`);
  assert.ok(Number.isInteger(d.maxOverlayAttempts) && d.maxOverlayAttempts <= OVERLAY_ATTEMPTS_MAX,
    `attempts must be a small finite integer, got ${d.maxOverlayAttempts}`);
});
