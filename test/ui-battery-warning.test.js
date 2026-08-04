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

test('a missing battery on a LIVE link warns — it is not an all-clear', () => {
  // This test previously asserted the opposite, pinning the very defect the
  // fail-closed work exists to remove. Mutation could not have saved it: it was
  // asserting the bug. Something is talking (linkUp) and not reporting the pack.
  const f = loadFormatBattery();
  const out = f({ battery: null, linkUp: true }, CFG);
  assert.ok(out.includes('⚠'),
    `a live link with no battery reading must warn (got: ${out})`);
});

test('a missing battery on a DOWN link does not warn', () => {
  // The other side of the contract: a dropped link is a link fault, surfaced
  // separately. Warning here would fire on every blip and make the flag useless.
  const f = loadFormatBattery();
  const out = f({ battery: null, linkUp: false }, CFG);
  assert.equal(out, 'Batt: --', `a down link must not claim battery trouble (got: ${out})`);
  assert.equal(f({ battery: null }, CFG), 'Batt: --', 'no link info means no claim');
});

test('the missing-battery warning respects the opt-out', () => {
  const f = loadFormatBattery();
  const off = { ...CFG, batteryWarnOnNoReading: false };
  assert.equal(f({ battery: null, linkUp: true }, off), 'Batt: --');
});

// ── The flight-controller link indicator ─────────────────────────────────────
//
// This existed nowhere in the operator UI until a review pointed out that the
// justification "a down link is surfaced separately" was untrue of this file. The
// gap became concrete on 2026-08-03: MAVProxy wedged, picar streamed overrides into
// a dead socket for over an hour, and this screen looked healthy throughout — rails
// and battery read "--", which is indistinguishable from "not fitted".

function loadFn(name) {
  const start = html.indexOf(`function ${name}()`);
  assert.notEqual(start, -1, `${name}() not found in socket.html — renamed?`);
  const end = html.indexOf('\n    }', start) + 6;
  const src = html.slice(start, end);
  return (telemetry, telemetryCfg) =>
    new Function('telemetry', 'telemetryCfg', `${src}; return ${name}();`)(telemetry, telemetryCfg);
}

test('a down FC link is shown as a warning, not as a dash', () => {
  const f = loadFn('formatFcLink');
  const out = f({ linkUp: false }, CFG);
  assert.ok(out.includes('DOWN') && out.includes('⚠'), `got: ${out}`);
});

test('a live link with no autopilot is distinguished from a healthy one', () => {
  const f = loadFn('formatFcLink');
  const awaiting = f({ linkUp: true, awaitingAutopilot: true }, CFG);
  assert.ok(awaiting.includes('⚠'), `awaiting autopilot must warn: ${awaiting}`);

  const silent = f({ linkUp: true, awaitingAutopilot: false, autopilotHeartbeat: false }, CFG);
  assert.ok(silent.includes('⚠'), `a silent autopilot must warn: ${silent}`);

  // NOTE: this fixture now carries verified params. It used to omit them, which
  // meant this test asserted that a live link with a live heartbeat and ZERO
  // verified critical parameters was "healthy" — the exact state the vehicle was
  // in while it ran as FRAME_CLASS=2 with the bar reading 'FC: ok'. The test was
  // pinning the defect.
  const ok = f({
    linkUp: true, awaitingAutopilot: false, autopilotHeartbeat: true,
    params: { verified: ['FRAME_CLASS'], missing: [], mismatched: {} },
  }, CFG);
  assert.ok(!ok.includes('⚠'), `a healthy link must not warn: ${ok}`);
  assert.ok(ok.includes('ok'), ok);
});

test('a link whose critical params are unverified is NOT reported as ok', () => {
  // Invariant 7: arming requires read-back confirmation of every entry in
  // EXPECTED_CRITICAL_PARAMS. The driver tracked that and reported it in
  // telemetry.params; this bar rendered 'FC: ok' regardless, so the one surface
  // that could have shown the FRAME_CLASS=2 incident showed an all-clear.
  const f = loadFn('formatFcLink');
  const base = { linkUp: true, awaitingAutopilot: false, autopilotHeartbeat: true };

  const unverified = f({ ...base,
    params: { verified: [], missing: ['FRAME_CLASS', 'SERVO1_FUNCTION'], mismatched: {} } }, CFG);
  assert.ok(unverified.includes('⚠'), `unverified params must warn: ${unverified}`);
  assert.ok(!unverified.includes('ok'), `must not read as ok: ${unverified}`);
  assert.ok(unverified.includes('2'), `the operator needs the count: ${unverified}`);

  const mismatch = f({ ...base,
    params: { verified: [], missing: [], mismatched: { FRAME_CLASS: { expected: 1, actual: 2 } } } }, CFG);
  assert.ok(mismatch.includes('⚠'), `a mismatch must warn: ${mismatch}`);
  assert.ok(!mismatch.includes('ok'), `must not read as ok: ${mismatch}`);

  // Fail closed on the path not taken: a server that reports no params at all is
  // an unknown, and an unknown is not a pass.
  const absent = f(base, CFG);
  assert.ok(absent.includes('⚠'), `absent param status must warn: ${absent}`);
  assert.ok(!absent.includes('ok'), `must not read as ok: ${absent}`);
});

test('a partially valid radio frame never renders the literal string null', () => {
  // The driver drops a frame whose BOTH rssi fields are the 255 sentinel, but a
  // partially valid frame survives with some fields null — and interpolating those
  // printed "Radio: null/null rem 42" while still suppressing the Wi-Fi reading.
  const f = loadFn('formatRadio');
  const out = f({
    radio: { rssi: null, remRssi: 42, noise: null, remNoise: null },
    wifi: { qualityPct: 70, signalDbm: -61 },
  }, CFG);
  assert.ok(!out.includes('null'), `must not render the literal "null": ${out}`);
  assert.ok(out.includes('42'), `must still report the measurement it does have: ${out}`);
});

test('a radio frame with no usable signal falls through to Wi-Fi', () => {
  const f = loadFn('formatRadio');
  const out = f({
    radio: { rssi: null, remRssi: null, noise: null, remNoise: null },
    wifi: { qualityPct: 70, signalDbm: -61 },
  }, CFG);
  assert.ok(!out.startsWith('Radio:'),
    `no usable radio measurement must not suppress the Wi-Fi fallback: ${out}`);
});

// Execute the real renderStatusBar() against stub column elements, with the real
// formatters wired in. This replaces a pair of regexes over the source text that
// looked like they policed the no-toggle rule and did not: round 7 defeated both
// with `if (uiCfg.showFcLink) { c3.push(formatFcLink()); }` — braces, 199/0 green,
// and because showFcLink is in no CFG_DEFAULTS the FC indicator vanished from the
// bar entirely. That is the precise outcome the assertion existed to prevent, which
// makes it a worked example of why a test that restates a rule in a different
// notation proves nothing about the code.
function renderStatusBarWith({ uiCfg = {}, telemetry = null, telemetryCfg = CFG } = {}) {
  const grab = (name) => {
    const at = html.indexOf(`function ${name}()`);
    assert.notEqual(at, -1, `${name}() not found in socket.html — renamed?`);
    return html.slice(at, html.indexOf('\n    }', at) + 6);
  };
  const cols = { 1: '', 2: '', 3: '' };
  const stub = (n) => ({ set innerHTML(v) { cols[n] = v; }, get innerHTML() { return cols[n]; } });
  const src = ['formatBattery', 'formatRadio', 'formatRails', 'formatFcLink']
    .map(grab).join('\n') + '\n' + grab('renderStatusBar') + '\nrenderStatusBar();';
  new Function('uiCfg', 'telemetry', 'telemetryCfg', 'statusCol1', 'statusCol2', 'statusCol3',
    'isConnected', 'controlMode', 'liveStats', 'throttleValue', 'steeringValue', 'applyCurve', src)(
    uiCfg, telemetry, telemetryCfg, stub(1), stub(2), stub(3),
    true, 'keyboard',
    { downKbps: null, upKbps: null, fps: null, latencyMs: null, resW: null, resH: null },
    0, 0, (v) => v);
  return cols[3];
}

test('the status bar renders the FC link indicator with every toggle OFF', () => {
  // The no-toggle rule, asserted by observing the rendered output rather than by
  // pattern-matching the source. An operator must not be able to hide the one
  // indicator that distinguishes a live vehicle from a silent one — on 2026-08-03
  // MAVProxy wedged, picar streamed overrides into a dead socket for over an hour,
  // and this screen looked healthy throughout.
  const allOff = renderStatusBarWith({ uiCfg: {}, telemetry: { linkUp: false } });
  assert.ok(allOff.includes('FC:'),
    `the FC indicator must survive every toggle being off, got: ${JSON.stringify(allOff)}`);
  assert.ok(allOff.includes('DOWN'), allOff);

  // And it is still there when the toggles are all ON, alongside the rest.
  const allOn = renderStatusBarWith({
    uiCfg: { showThrottle: true, showSteering: true, showBattery: true,
             showRadio: true, showRails: true },
    telemetry: { linkUp: true, awaitingAutopilot: false, autopilotHeartbeat: true,
                 params: { verified: ['FRAME_CLASS'], missing: [], mismatched: {} },
                 battery: { voltageV: 7.9, currentA: 0.4, remainingPct: 79, pctSource: 'voltage' } },
  });
  assert.ok(allOn.includes('FC: ok'), allOn);
  assert.ok(allOn.includes('7.9V'), allOn);
});

test('the rendered bar surfaces unverified params, not just a live link', () => {
  // End to end through the real render path: driver-reported param status reaches
  // the operator's screen. Every earlier version of this coverage stopped at the
  // formatter and so could not see whether anything called it.
  const out = renderStatusBarWith({
    uiCfg: {},
    telemetry: { linkUp: true, awaitingAutopilot: false, autopilotHeartbeat: true,
                 params: { verified: [], missing: ['FRAME_CLASS'], mismatched: {} } },
  });
  assert.ok(out.includes('⚠'), `unverified params must reach the bar: ${out}`);
  assert.ok(!out.includes('FC: ok'), out);
});
