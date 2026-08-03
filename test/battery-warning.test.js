'use strict';

// The battery-trouble rule must fail CLOSED.
//
// A Codex review found this fail-open: SYS_STATUS maps both a 0 mV and a 65535 mV
// voltage_battery to null, and `null` percentage + `null` voltage returned false.
// So at 1 % remaining the vehicle reported battery trouble, and at a genuine 0 V —
// a dead pack, or a failed power module — it reported none. Verified live on rover3
// before the fix: `{voltageV: null, pctSource: null} -> trouble = false`.
//
// This rule lives in its own module for one reason: it used to be inline in app.js,
// which binds both HTTPS ports and the MAVProxy socket at require time and so is
// unreachable from a host test. A mutation reverting the fail-closed clause left
// the entire suite green.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { batteryTrouble } = require('../battery-warning.js');

const CFG = { warnLevel: 20, warnVolts: null, warnOnNoReading: true };

test('a healthy pack is not in trouble', () => {
  assert.equal(batteryTrouble({ remainingPct: 78, voltageV: 7.9 }, CFG), false);
  assert.equal(batteryTrouble({ remainingPct: 21, voltageV: 6.5 }, CFG), false,
    'just above the threshold is still fine');
});

test('a percentage at or below the threshold is trouble', () => {
  assert.equal(batteryTrouble({ remainingPct: 20, voltageV: 6.5 }, CFG), true, 'at the threshold');
  assert.equal(batteryTrouble({ remainingPct: 10, voltageV: 6.2 }, CFG), true);
  assert.equal(batteryTrouble({ remainingPct: 1,  voltageV: 6.0 }, CFG), true);
  assert.equal(batteryTrouble({ remainingPct: 0,  voltageV: 6.0 }, CFG), true,
    'a reported 0% is trouble, not an absence of information');
});

test('an unreadable battery monitor is TROUBLE, not an all-clear', () => {
  // The fail-open that was fixed. Both a 0 mV and a 65535 mV voltage_battery reach
  // here as null, and with no pack range configured there is no percentage either.
  // Reporting "fine" for that is the worst available answer.
  assert.equal(batteryTrouble({ remainingPct: null, voltageV: null }, CFG), true,
    'no usable reading at all must raise the warning');
  assert.equal(batteryTrouble({ remainingPct: undefined, voltageV: undefined }, CFG), true,
    'undefined must be treated the same as null');
});

test('the fail-closed behaviour is opt-out for a vehicle with no monitor', () => {
  // A vehicle that genuinely has no battery monitor would otherwise warn forever,
  // which is noise rather than information — so it is configurable. Default true.
  const off = { ...CFG, warnOnNoReading: false };
  assert.equal(batteryTrouble({ remainingPct: null, voltageV: null }, off), false);
  // ...but turning it off must not suppress a REAL low reading.
  assert.equal(batteryTrouble({ remainingPct: 5, voltageV: 6.1 }, off), true);
  assert.equal(batteryTrouble({ remainingPct: null, voltageV: 6.0 },
    { ...off, warnVolts: 6.5 }), true);
});

test('the default is fail-closed when no options are supplied', () => {
  // A caller that forgets the config must get the safe behaviour, not the unsafe one.
  assert.equal(batteryTrouble({ remainingPct: null, voltageV: null }), true);
  assert.equal(batteryTrouble({ remainingPct: 10, voltageV: 6.2 }), true);
  assert.equal(batteryTrouble({ remainingPct: 78, voltageV: 7.9 }), false);
});

test('a voltage threshold works independently of the percentage', () => {
  const cfg = { ...CFG, warnVolts: 6.6 };
  assert.equal(batteryTrouble({ remainingPct: 90, voltageV: 6.6 }, cfg), true,
    'voltage alone can raise the warning even at a high reported percentage');
  assert.equal(batteryTrouble({ remainingPct: 90, voltageV: 6.7 }, cfg), false);
});

test('no battery entry at all is a link problem, not battery trouble', () => {
  // telemetry.battery is null when no SYS_STATUS has arrived — that is the MAVLink
  // link being down, which is surfaced separately as linkUp / autopilotHeartbeat.
  // Claiming battery trouble for it would make the flag meaningless whenever the
  // link drops.
  assert.equal(batteryTrouble(null, CFG), false);
  assert.equal(batteryTrouble(undefined, CFG), false);
});
