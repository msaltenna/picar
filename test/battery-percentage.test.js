'use strict';

// Voltage-derived battery percentage.
//
// Why this exists at all: the flight controller's own battery_remaining is only
// usable when it coulomb-counts, and on this vehicle it does not. Measured on
// rover3 2026-08-03 — BATT_MONITOR=4 and BATT_CAPACITY=3300 are both set, yet
// 24169 BATTERY_STATUS frames carried current_consumed = -1 (not measured) and
// battery_remaining = 0, across 23993 SYS_STATUS frames. Voltage was valid and
// stable throughout (7.95 V, 0.46 A). So a percentage has to come from voltage,
// and it has to be labelled as an estimate because it sags under load.

const test   = require('node:test');
const assert = require('node:assert/strict');

const PWMMavproxy = require('../pwm_mavproxy_servo.js');

const MSG_SYS_STATUS = 1;

// A 2S LiPo: 3.0 V/cell empty, 4.2 V/cell full.
const PACK = { battery_empty_volts: 6.0, battery_full_volts: 8.4 };

function driver(extra = {}) {
  return new PWMMavproxy({ mavproxy_autostart: false, ...extra });
}

// SYS_STATUS wire order: sensors present/enabled/health (3x uint32), load(uint16),
// voltage_battery(uint16, mV), current_battery(int16, cA), drop_rate_comm,
// errors_comm, errors_count1..4 (uint16), battery_remaining(int8, %).
function sysStatus(mV, cA = 46, remaining = 0) {
  const p = Buffer.alloc(31);
  p.writeUInt16LE(mV, 14);
  p.writeInt16LE(cA, 16);
  p.writeInt8(remaining, 30);
  return p;
}

function batteryAfter(d, frames) {
  for (const f of frames) d.handleMessage(MSG_SYS_STATUS, f);
  return d.telemetry.battery;
}

// ── The mapping ──────────────────────────────────────────────────────────────

test('voltage maps linearly between the configured empty and full points', () => {
  for (const [mV, expected] of [[6000, 0], [7200, 50], [8400, 100], [6600, 25], [7800, 75]]) {
    const b = batteryAfter(driver(PACK), [sysStatus(mV)]);
    assert.equal(b.remainingPct, expected, `${mV} mV should read ${expected}%`);
    assert.equal(b.pctSource, 'voltage');
  }
});

test('the percentage is clamped outside the configured range', () => {
  // A pack above "full" (freshly charged, or a bench supply) must not read 130%,
  // and one below "empty" must not read negative — either would break a
  // downstream threshold comparison as well as looking absurd.
  assert.equal(batteryAfter(driver(PACK), [sysStatus(9000)]).remainingPct, 100);
  assert.equal(batteryAfter(driver(PACK), [sysStatus(5000)]).remainingPct, 0);
  assert.equal(batteryAfter(driver(PACK), [sysStatus(1)]).remainingPct, 0);
});

test("rover3's real measured voltage produces a sane percentage", () => {
  // Regression anchor against the actual live reading, so a future refactor that
  // silently changes the mapping is visible against real hardware data.
  const b = batteryAfter(driver(PACK), [sysStatus(7954, 46, 0)]);
  assert.equal(b.remainingPct, 81);
  assert.equal(b.pctSource, 'voltage');
  assert.equal(b.voltageV, 7.954);
  assert.equal(b.currentA, 0.46);
});

// ── Which source wins ────────────────────────────────────────────────────────

test('a coulomb-counted percentage from the flight controller wins over the estimate', () => {
  // If a vehicle ever does report a real percentage, it is more accurate than an
  // interpolation and must not be overridden.
  const b = batteryAfter(driver(PACK), [sysStatus(7954, 46, 87)]);
  assert.equal(b.remainingPct, 87);
  assert.equal(b.pctSource, 'flightcontroller');
});

test('an unusable flight-controller percentage falls through to the estimate', () => {
  for (const remaining of [0, -1]) {
    const b = batteryAfter(driver(PACK), [sysStatus(7200, 46, remaining)]);
    assert.equal(b.remainingPct, 50, `remaining=${remaining} must fall through`);
    assert.equal(b.pctSource, 'voltage');
  }
});

test('with no pack configured the behaviour is exactly as before', () => {
  // The feature must be inert until an operator states the pack. Guessing a
  // default range would put a confidently wrong number on a safety display.
  const b = batteryAfter(driver(), [sysStatus(7954, 46, 0)]);
  assert.equal(b.remainingPct, null);
  assert.equal(b.pctSource, null);
  assert.equal(b.voltageV, 7.954, 'voltage is still reported');
});

test('an unmeasured voltage yields no percentage even when a pack is configured', () => {
  for (const mV of [0, 0xFFFF]) {
    const b = batteryAfter(driver(PACK), [sysStatus(mV)]);
    assert.equal(b.voltageV, null);
    assert.equal(b.remainingPct, null, 'no voltage means no estimate');
    assert.equal(b.pctSource, null);
  }
});

// ── Rejecting a bad configuration ────────────────────────────────────────────

test('a half-configured, inverted or non-finite pack range disables the estimate', () => {
  const bad = [
    { battery_empty_volts: 6.0 },                                  // full missing
    { battery_full_volts: 8.4 },                                   // empty missing
    { battery_empty_volts: 8.4, battery_full_volts: 6.0 },         // inverted
    { battery_empty_volts: 7.0, battery_full_volts: 7.0 },         // zero span
    { battery_empty_volts: 'x', battery_full_volts: 8.4 },          // non-numeric
    { battery_empty_volts: 6.0, battery_full_volts: 'y' },
    { battery_empty_volts: -1, battery_full_volts: 8.4 },           // negative
  ];
  for (const cfg of bad) {
    const d = driver(cfg);
    assert.equal(d.batteryRange, null, `must reject ${JSON.stringify(cfg)}`);
    const b = batteryAfter(d, [sysStatus(7200)]);
    assert.equal(b.remainingPct, null, `must not estimate for ${JSON.stringify(cfg)}`);
    assert.equal(b.pctSource, null);
  }
});

// ── Smoothing ────────────────────────────────────────────────────────────────

test('a single voltage sag under throttle does not drag the percentage down', () => {
  // The behaviour that motivated smoothing. A hard acceleration pulls the pack
  // down briefly; an unsmoothed reading would dive and recover, which on an
  // operator's display is indistinguishable from a failing battery.
  const d = driver({ ...PACK, battery_pct_median_samples: 5 });
  const steady = sysStatus(7800);            // 75%
  batteryAfter(d, [steady, steady, steady, steady]);

  const before = d.telemetry.battery.remainingPct;
  const sagged = batteryAfter(d, [sysStatus(6600)]).remainingPct;   // would be 25% alone
  assert.equal(before, 75);
  assert.equal(sagged, 75, 'one low sample must not move the median');
});

test('a sustained decline does move the percentage', () => {
  // The other half of the contract: smoothing must not make the gauge inert. A
  // pack that is genuinely draining has to be reflected.
  const d = driver({ ...PACK, battery_pct_median_samples: 5 });
  batteryAfter(d, Array(5).fill(sysStatus(8400)));
  assert.equal(d.telemetry.battery.remainingPct, 100);

  const b = batteryAfter(d, Array(5).fill(sysStatus(6600)));
  assert.equal(b.remainingPct, 25, 'a sustained drop must be reflected');
});

test('the voltage history is bounded and the window is clamped', () => {
  // This array is appended on every SYS_STATUS frame, ~4 Hz, on a process meant to
  // stay up for days.
  const d = driver({ ...PACK, battery_pct_median_samples: 5 });
  batteryAfter(d, Array(500).fill(sysStatus(7200)));
  assert.equal(d.batteryVoltHistory.length, 5, 'history must not grow without bound');

  assert.equal(driver({ ...PACK, battery_pct_median_samples: 9999 }).batteryPctSamples, 31,
    'an absurd window is clamped');
  assert.equal(driver({ ...PACK, battery_pct_median_samples: 0 }).batteryPctSamples, 1);
  assert.equal(driver({ ...PACK, battery_pct_median_samples: -5 }).batteryPctSamples, 1);
  assert.equal(driver({ ...PACK, battery_pct_median_samples: 'x' }).batteryPctSamples, 5,
    'a non-numeric window falls back to the default');
});

test('a window of 1 disables smoothing without breaking the estimate', () => {
  const d = driver({ ...PACK, battery_pct_median_samples: 1 });
  assert.equal(batteryAfter(d, [sysStatus(7800)]).remainingPct, 75);
  assert.equal(batteryAfter(d, [sysStatus(6600)]).remainingPct, 25, 'no smoothing at all');
});

test('the median is exposed through the driver so smoothing is testable alone', () => {
  const d = driver({ ...PACK, battery_pct_median_samples: 5 });
  for (const v of [7.0, 8.0, 7.5]) d.smoothedBatteryVolts(v);
  assert.equal(d.smoothedBatteryVolts(7.4), 7.45, 'even count averages the two middles');
  assert.equal(d.smoothedBatteryVolts(NaN), null, 'a non-finite reading is not recorded');
  assert.equal(d.batteryVoltHistory.length, 4, 'and does not enter the history');
});

// ── The reported shape ───────────────────────────────────────────────────────

test('getTelemetry exposes pctSource alongside the percentage', () => {
  // A consumer that wants only measured values must be able to tell them apart,
  // which is the whole point of shipping the source rather than just the number.
  const d = driver(PACK);
  batteryAfter(d, [sysStatus(7200)]);
  const t = d.getTelemetry();
  assert.equal(t.battery.remainingPct, 50);
  assert.equal(t.battery.pctSource, 'voltage');
  assert.equal(typeof t.battery.ageMs, 'number');
});

// ── A PAUSED stream, not just a closed socket ────────────────────────────────

test('a gap in the SYS_STATUS stream discards the smoothing window', () => {
  // The case that matters most and the one the first fix missed. Clearing the window
  // only in the socket-close handler left a Pixhawk reboot — or any paused
  // SYS_STATUS stream — with MAVProxy still connected: five stale 8.4 V samples then
  // outvoted a fresh 6.0 V reading and reported ~100%, which does not merely look
  // wrong, it CLEARS the low-battery warning.
  //
  // `now` is injected rather than faked globally so this is deterministic.
  const d = driver({ ...PACK, battery_pct_median_samples: 5 });
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) d.smoothedBatteryVolts(8.4, t0 + i * 250);
  assert.equal(d.batteryPctFromVolts(d.smoothedBatteryVolts(8.4, t0 + 1250)), 100);

  // A gap longer than the staleness window, then a genuine low reading.
  const afterGap = d.smoothedBatteryVolts(6.0, t0 + 60_000);
  assert.equal(afterGap, 6.0, 'the window must contain only the fresh sample');
  assert.equal(d.batteryPctFromVolts(afterGap), 0,
    'a fresh 6.0 V reading must not be masked by pre-gap samples');
  assert.equal(d.batteryVoltHistory.length, 1);
});

test('a normal 4 Hz stream is NOT treated as a gap', () => {
  // The other direction: smoothing must still smooth. If the gap threshold were too
  // tight, every sample would reset the window and the feature would do nothing.
  const d = driver({ ...PACK, battery_pct_median_samples: 5 });
  const t0 = 2_000_000;
  for (let i = 0; i < 5; i++) d.smoothedBatteryVolts(7.8, t0 + i * 250);   // 4 Hz
  assert.equal(d.batteryVoltHistory.length, 5, 'a live stream must accumulate');

  // One sag inside a live stream must still be outvoted.
  const sagged = d.smoothedBatteryVolts(6.6, t0 + 1250);
  assert.equal(d.batteryPctFromVolts(sagged), 75, 'the median must still reject a spike');
});

test('the gap check works through the real SYS_STATUS path, not just the helper', () => {
  // Drive handleMessage so the wiring is covered, not only smoothedBatteryVolts.
  const d = driver(PACK);
  for (let i = 0; i < 5; i++) d.handleMessage(MSG_SYS_STATUS, sysStatus(8400));
  assert.equal(d.telemetry.battery.remainingPct, 100);

  // Age every retained sample past the staleness window, as a paused stream would.
  for (const e of d.batteryVoltHistory) e.at -= 60_000;
  d.handleMessage(MSG_SYS_STATUS, sysStatus(6000));
  assert.equal(d.telemetry.battery.remainingPct, 0,
    'the live path must discard stale samples too');
});
