'use strict';

// The operator-facing battery warning, tested by extracting the REAL formatBattery()
// out of socket.html and running it.
//
// socket.html is a single-page app with inline script and no module boundary, so
// there is no clean way to require it — which is why it had zero test coverage, and
// why a mutation removing the unreadable-battery warning from the status bar
// survived the entire suite. Extracting the function is imperfect (it is coupled to
// the source text) but it exercises the code that actually ships, which is strictly
// better than asserting nothing.
//
// The gap it closes: the server's batteryTrouble() already treated an unreadable
// monitor as trouble and set the fleet status bit, but this bar rendered a bare
// "Batt: --" with no warning. The dashboard flagged a problem the operator looking
// at the vehicle could not see.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'socket.html'), 'utf8');

function loadFormatBattery() {
  const start = html.indexOf('function formatBattery()');
  assert.notEqual(start, -1, 'formatBattery() not found in socket.html — has it been renamed?');
  const end = html.indexOf('\n    }', start) + 6;
  const src = html.slice(start, end);
  assert.ok(src.includes('remainingPct'), 'extracted the wrong block');
  return (telemetry, telemetryCfg) =>
    new Function('telemetry', 'telemetryCfg', `${src}; return formatBattery();`)(telemetry, telemetryCfg);
}

const CFG = { batteryWarnLevel: 20, batteryWarnVolts: null, batteryWarnOnNoReading: true };
const batt = (o) => ({ battery: { pctSource: 'voltage', ...o } });

test('a healthy pack renders no warning', () => {
  const f = loadFormatBattery();
  const out = f(batt({ voltageV: 7.9, currentA: 0.45, remainingPct: 79 }), CFG);
  assert.ok(out.includes('7.9V'), out);
  assert.ok(out.includes('79%'), out);
  assert.ok(!out.includes('⚠'), `must not warn when healthy: ${out}`);
});

test('a percentage at or below the threshold renders a warning', () => {
  const f = loadFormatBattery();
  assert.ok(f(batt({ voltageV: 6.2, currentA: 0.45, remainingPct: 10 }), CFG).includes('⚠'));
  assert.ok(f(batt({ voltageV: 6.5, currentA: 0.45, remainingPct: 20 }), CFG).includes('⚠'));
});

test('an UNREADABLE battery renders a warning, not a silent dash', () => {
  const f = loadFormatBattery();
  const out = f(batt({ voltageV: null, currentA: null, remainingPct: null, pctSource: null }), CFG);
  assert.ok(out.includes('⚠'),
    `an unreadable monitor must warn — a dead pack and a missing monitor look ` +
    `identical from here and neither is an all-clear (got: ${out})`);
});

test('the unreadable-battery warning is opt-out, matching the server', () => {
  const f = loadFormatBattery();
  const off = { ...CFG, batteryWarnOnNoReading: false };
  const out = f(batt({ voltageV: null, currentA: null, remainingPct: null, pctSource: null }), off);
  assert.ok(!out.includes('⚠'), `opt-out must suppress it: ${out}`);
  // ...but never suppress a real low reading.
  assert.ok(f(batt({ voltageV: 6.2, currentA: 0.45, remainingPct: 10 }), off).includes('⚠'));
});

test('a voltage-derived percentage is marked with a leading tilde', () => {
  const f = loadFormatBattery();
  assert.ok(f(batt({ voltageV: 7.9, currentA: 0.45, remainingPct: 79, pctSource: 'voltage' }), CFG)
    .includes('~79%'));
  assert.ok(!f(batt({ voltageV: 7.9, currentA: 0.45, remainingPct: 79, pctSource: 'flightcontroller' }), CFG)
    .includes('~'), 'a coulomb-counted percentage must NOT be marked as an estimate');
});

test('a missing battery entry renders the absent form', () => {
  const f = loadFormatBattery();
  assert.equal(f({ battery: null }, CFG), 'Batt: --');
});
