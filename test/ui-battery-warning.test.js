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
  const src = ['formatBattery', 'formatRadio', 'formatRails', 'formatFcLink', 'formatHost',
               'formatHostUrgent']
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

// ── Telemetry staleness in the UI ────────────────────────────────────────────

test('telemetry that stopped arriving expires instead of being shown as live', () => {
  // Round 7 found that deleting `telemetry = null` from the disconnect handler
  // survived the suite: the bar kept the last battery voltage indefinitely. Worse
  // than blank — the last frame carried linkUp:true, so a dead UI rendered 'FC: ok'.
  //
  // The handler is still there, but it only covers a dropped socket. A socket that
  // stays up while the server's publish loop dies is the 2026-08-03 wedge shape, and
  // nothing covered it. This is the rule that does.
  const start = html.indexOf('function telemetryExpired(');
  assert.notEqual(start, -1, 'telemetryExpired() not found in socket.html — renamed?');
  const src = html.slice(start, html.indexOf('\n    }', start) + 6);
  const expired = new Function(`${src}; return telemetryExpired;`)();

  const T = { linkUp: true, battery: { voltageV: 7.9 } };
  assert.equal(expired(T, 10_000, 3000, 11_000), false, 'a fresh frame is live');
  assert.equal(expired(T, 10_000, 3000, 13_000), false, 'exactly at the window is still live');
  assert.equal(expired(T, 10_000, 3000, 13_001), true,
    'past the window the frame must expire — a last-known value dressed up as live is ' +
    'what made the wedge invisible');
  assert.equal(expired(null, 0, 3000, 999_999), false,
    'already-cleared telemetry must not re-trigger a render every second');
});

test('the expiry WATCH actually clears telemetry and re-renders', () => {
  // Both reviewers deleted the setInterval block that called telemetryExpired and got
  // 222/222 green; one deleted it together with the disconnect clear and fully
  // restored the round-7 defect with no red test. The rule was tested, its caller was
  // an anonymous arrow inside a timer, and nothing reached it.
  //
  // So drive the real caller. The generated scope declares the page's telemetry state
  // and a renderStatusBar that records what `telemetry` held when it was called, so
  // this observes the assignment rather than inferring it.
  const grab = (name) => {
    const at = html.indexOf(`function ${name}(`);
    assert.notEqual(at, -1, `${name}() not found in socket.html — renamed?`);
    return html.slice(at, html.indexOf('\n    }', at) + 6);
  };
  const run = (ageMs) => new Function(`
    let telemetry = { linkUp: true, battery: { voltageV: 7.9 } };
    let telemetryAt = 10000;
    let telemetryStaleMs = 3000;
    const renders = [];
    function renderStatusBar() { renders.push(telemetry); }
    ${grab('telemetryExpired')}
    ${grab('telemetryExpiryTick')}
    ${grab('startTelemetryExpiryWatch')}
    let registered = null, registeredDelay = null;
    startTelemetryExpiryWatch((fn, ms) => { registered = fn; registeredDelay = ms; return 1; });
    if (typeof registered !== 'function') return { error: 'the watch scheduled no callback' };
    const nowStub = 10000 + ${ageMs};
    const origNow = Date.now;
    Date.now = () => nowStub;
    try { registered(); } finally { Date.now = origNow; }
    return { renders, after: telemetry, registeredDelay };
  `)();

  const stale = run(9000);
  assert.equal(stale.error, undefined, stale.error);
  assert.ok(stale.registeredDelay <= 1000,
    `the watch must poll at least once a second, got ${stale.registeredDelay}`);
  assert.equal(stale.after, null,
    'the scheduled callback must CLEAR telemetry — otherwise a dead link keeps ' +
    'rendering its last frame, and the last frame said linkUp:true');
  assert.equal(stale.renders.length, 1, 'and it must re-render the bar');
  assert.equal(stale.renders[0], null, 'the re-render must see the cleared value');

  const fresh = run(500);
  assert.equal(fresh.renders.length, 0, 'a fresh frame must not be cleared or re-rendered');
  assert.notEqual(fresh.after, null);
});

test('the expiry watch is actually started at page scope', () => {
  // The behavioural test above proves the watch works and the tick clears telemetry.
  // Deleting the one line that STARTS it survived all of that, which restores the
  // defect for any page that stays open past a publish gap.
  //
  // socket.html has no module boundary, so this asserts on source. That is weaker
  // than executing it and cannot survive a rename — but a rename is already covered:
  // the behavioural test grabs these functions BY NAME and fails if they move. What
  // this catches is the deletion, which is the regression that actually happened.
  assert.match(html, /^\s*startTelemetryExpiryWatch\(setInterval\);\s*$/m,
    'nothing starts the telemetry expiry watch — stale telemetry will render as live');
});

test('an expired bar reports no link and warns about the pack', () => {
  // The consequence of expiry, through the real render path: not merely blank, but
  // actively flagged. 'FC: --' and a battery warning are both honest; 'FC: ok' with a
  // three-minute-old voltage is not.
  const out = renderStatusBarWith({ uiCfg: { showBattery: true }, telemetry: null });
  assert.ok(out.includes('FC: --'), `an expired bar must not claim a link: ${out}`);
  assert.ok(out.includes('Batt: --'), out);
});

test('a vehicle with no flight controller shows n/a, and a dead link still shows DOWN', () => {
  const f = loadFn('formatFcLink');
  assert.equal(f({ fcSupported: false }, CFG), 'FC: n/a');
  // The fail-open to guard against: 'n/a' must not swallow a real link failure.
  const down = f({ linkUp: false }, CFG);
  assert.ok(down.includes('DOWN') && down.includes('⚠'), down);
});

// ── CPU thermal indicator ────────────────────────────────────────────────────

test('a COOL rover still shows its CPU reading', () => {
  // This asserted the opposite until the operator pointed out they could not see any CPU
  // telemetry. The original rendered only during a fault, which meant the field could never
  // be sanity-checked before one — and rover1 sat at 84 C for an unknown length of time with
  // every other indicator on this bar reading healthy. A reading you cannot see beforehand is
  // not much better than no reading.
  const out = renderStatusBarWith({
    uiCfg: { showCpu: true },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: 55.5, busyPct: 12 },
                         throttled: { active: false, now: [], sinceBoot: [] } } },
  });
  assert.match(out, /CPU/);
  assert.match(out, /55\.5°C/);
  assert.match(out, /12%/, 'CPU busy percent must be shown, not just temperature');
});

test('an ACTIVE throttle is shown and NAMES what is being limited', () => {
  // rover1's real state on 2026-08-14. "THROTTLED" alone would send an operator looking for
  // a heat problem when the firmware may be reporting under-voltage instead.
  const out = renderStatusBarWith({
    uiCfg: { showCpu: true },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: 84.2 },
                         throttled: { active: true, now: ['soft temperature limit'],
                                      sinceBoot: ['under-voltage'] } } },
  });
  assert.match(out, /84\.2°C/);
  assert.match(out, /soft temperature limit/);
});

test('temperature colour escalates before the limit is reached', () => {
  const at = (t) => renderStatusBarWith({
    uiCfg: { showCpu: true },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: t, busyPct: 5 },
                         throttled: { active: false, now: [], sinceBoot: [] } } } });
  assert.match(at(55), /#9f9/,  'cool renders green');
  assert.match(at(68), /#fc6/,  'warm renders amber before anything is throttled');
  assert.match(at(78), /#f66/,  'hot renders red');
  assert.match(at(78), /78\.0°C/);
});

test('LATCHED history is not coloured as a live fault', () => {
  // 0xf0000 means "this box has throttled at some point since boot". Real, worth recording,
  // but not happening now — colouring it as a present fault trains operators to ignore it.
  const out = renderStatusBarWith({
    uiCfg: { showCpu: true },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: 60.0, busyPct: 4 },
                         throttled: { active: false, now: [], sinceBoot: ['throttled'] } } },
  });
  assert.match(out, /CPU/, 'the reading is still shown');
  assert.doesNotMatch(out, /#f66/, 'but not in the live-fault colour');
});

test('an unknown temperature is not rendered as cool', () => {
  // null means picar could not read the sensor. If the firmware still reports an active
  // limit, that must surface even without a number to attach to it.
  const out = renderStatusBarWith({
    uiCfg: { showCpu: true },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: null },
                         throttled: { active: true, now: ['throttled'], sinceBoot: [] } } },
  });
  assert.match(out, /--°C/, `an unreadable sensor must not render as a temperature: ${out}`);
  assert.match(out, /throttled/);
});

test('a rover reporting no host block at all renders nothing extra', () => {
  // Older rovers, and every GPIO driver, have no sampler. Absence must be silent rather
  // than rendering a row of dashes on every bar.
  const out = renderStatusBarWith({
    telemetry: { linkUp: true, autopilotHeartbeat: true },
  });
  assert.doesNotMatch(out, /CPU/);
});

test('an INACTIVE unit is the loudest thing on the bar', () => {
  // The reviewer's finding: formatHost ignored `services` entirely, so a dead mavproxy —
  // no link to the flight controller at all — rendered exactly like a healthy rover.
  const out = renderStatusBarWith({
    uiCfg: { showCpu: true },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: 50 }, throttled: { active: false, now: [], sinceBoot: [] },
                         services: { picar: { ok: true, state: 'active' },
                                     mavproxy: { ok: false, why: 'failed', state: 'failed' },
                                     mediamtx: { ok: true, state: 'active' } } } },
  });
  assert.match(out, /SVC/);
  assert.match(out, /mavproxy:failed/);
  assert.doesNotMatch(out, /picar:/, 'a healthy unit must not add noise');
});

test('all-healthy services are STILL shown, in green', () => {
  const out = renderStatusBarWith({
    uiCfg: { showCpu: true },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: 50 }, throttled: { active: false, now: [], sinceBoot: [] },
                         services: { picar: { ok: true }, mavproxy: { ok: true },
                                     mediamtx: { ok: true } } } },
  });
  assert.match(out, /SVC/, 'the line is permanent — healthy units are shown as healthy');
  assert.doesNotMatch(out, /#f66/, 'but nothing is red');
});

test('a sampler that cannot read its sources says so', () => {
  // Silence would assert "cool and all services up" — the one claim it cannot make.
  const out = renderStatusBarWith({
    uiCfg: { showCpu: true },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: null }, throttled: null,
                         errors: { tempC: 'ENOENT', throttled: 'vcgencmd: not found' } } },
  });
  assert.match(out, /HEALTH\?/);
  assert.match(out, /tempC/);
});

test('switching the CPU field OFF still surfaces an ACTIVE throttle', () => {
  // An operator may hide a number. They must not be able to hide the condition the number
  // exists to reveal — the same rule the FC link indicator follows.
  const out = renderStatusBarWith({
    uiCfg: { showCpu: false },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: 84.2, busyPct: 3 },
                         throttled: { active: true, now: ['soft temperature limit'], sinceBoot: [] } } },
  });
  assert.match(out, /soft temperature limit/);
});

test('switching it OFF still surfaces a dead service', () => {
  const out = renderStatusBarWith({
    uiCfg: { showCpu: false },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: 50, busyPct: 2 },
                         throttled: { active: false, now: [], sinceBoot: [] },
                         services: { picar: { ok: true, state: 'active' },
                                     mavproxy: { ok: false, why: 'failed', state: 'failed' },
                                     mediamtx: { ok: true, state: 'active' } } } },
  });
  assert.match(out, /mavproxy:failed/);
});

test('switching it OFF hides the routine reading on a healthy rover', () => {
  const out = renderStatusBarWith({
    uiCfg: { showCpu: false },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: 55, busyPct: 5 },
                         throttled: { active: false, now: [], sinceBoot: [] },
                         services: { picar: { ok: true }, mavproxy: { ok: true },
                                     mediamtx: { ok: true } } } },
  });
  assert.doesNotMatch(out, /CPU/, 'the toggle must actually do something');
});


// ── active is not the same as working, on the bar ────────────────────────────

test('a CRASH-LOOPING unit renders red even though it is active', () => {
  // The case the operator raised: a service can be `active` and still be failing. systemd
  // reports a unit it restarts every few seconds as active/running most of the time.
  const out = renderStatusBarWith({
    uiCfg: { showCpu: true },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: 55, busyPct: 5 },
                         throttled: { active: false, now: [], sinceBoot: [] },
                         services: { picar: { ok: true },
                                     mediamtx: { ok: false, why: 'restart-looping',
                                                 state: 'active', sub: 'auto-restart' } } } },
  });
  assert.match(out, /restart-looping/, 'the REASON must be named, not just a red marker');
  assert.match(out, /#f66/);
});

test('the service line names WHAT is wrong, per unit', () => {
  // "mav:inactive" and "mav:restart-looping" call for completely different responses.
  const out = renderStatusBarWith({
    uiCfg: { showCpu: true },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: 55, busyPct: 5 },
                         throttled: { active: false, now: [], sinceBoot: [] },
                         services: { picar: { ok: true },
                                     mavproxy: { ok: false, why: 'inactive' },
                                     mediamtx: { ok: false, why: 'last-exit:exit-code' } } } },
  });
  assert.match(out, /inactive/);
  assert.match(out, /last-exit:exit-code/);
});

test('services that could not be determined are not rendered as healthy', () => {
  const out = renderStatusBarWith({
    uiCfg: { showCpu: true },
    telemetry: { linkUp: true, autopilotHeartbeat: true,
                 host: { cpu: { tempC: 55, busyPct: 5 },
                         throttled: { active: false, now: [], sinceBoot: [] },
                         services: null } },
  });
  assert.match(out, /SVC --/, 'unknown must not look like "all fine"');
  assert.doesNotMatch(out, /\u2713/);
});
