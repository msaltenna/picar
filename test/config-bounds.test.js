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
