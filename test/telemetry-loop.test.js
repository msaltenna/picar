'use strict';

// Tests for the telemetry publish loop's WIRING.
//
// Every test in this file exists because a round-7 review applied a mutation to
// this code while it was inline in app.js and the whole suite stayed green. The
// parts were already covered — battery-warning.js and config-bounds.js each have
// their own tests — and that was the trap: extracting a rule to make it testable
// does nothing for the call site, and the call site is where all four defects were.
//
// So these drive the real startTelemetryLoop with injected collaborators and assert
// what it does to them.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { startTelemetryLoop, parseWirelessProc } = require('../telemetry-loop');
const { clampTelemetryInterval } = require('../config-bounds');

const WARN_CFG = { warnLevel: 20, warnVolts: 6.8, warnOnNoReading: true };

// A harness that records everything the loop does to the outside world, and lets a
// test drive the clock rather than wait on it.
function harness({ fc = {}, wifiText = null, wifiError = null, config = {} } = {}) {
  const calls = { statusBits: [], telemetry: [], emits: [], intervals: [], cleared: [] };
  let wifiReads = 0;
  const loop = startTelemetryLoop({
    getFcTelemetry: () => fc,
    fleetClient: {
      setStatusBit: (bit, value) => calls.statusBits.push([bit, value]),
      setTelemetry: (t) => calls.telemetry.push(t),
    },
    emit: (event, payload) => calls.emits.push([event, payload]),
    readWifi: () => {
      wifiReads += 1;
      return wifiError ? Promise.reject(wifiError) : Promise.resolve(wifiText);
    },
    config,
    batteryWarnCfg: WARN_CFG,
    setIntervalFn: (fn, ms) => { calls.intervals.push([fn, ms]); return { id: 1 }; },
    clearIntervalFn: (h) => calls.cleared.push(h),
  });
  return { loop, calls, wifiReads: () => wifiReads };
}

// ── The interval bound is applied at the CALL SITE ───────────────────────────

test('the loop clamps its own interval rather than trusting the config', () => {
  // Surviving mutation before this test existed:
  //   const telemetry_interval_ms = config.telemetry_interval_ms ?? 1000;
  // 1e400 is valid JSON in the untracked overlay and parses to Infinity;
  // setInterval(fn, Infinity) is coerced by Node to 1 ms, which runs a /proc read,
  // a telemetry snapshot and a socket broadcast every millisecond on the same event
  // loop as the 20 Hz override stream and the fail-safe timer (invariant 9).
  for (const raw of [0, -5, 1, Infinity, 1e400, NaN, null, undefined, 'soon', 1e9]) {
    const { loop, calls } = harness({ config: { telemetry_interval_ms: raw } });
    const want = clampTelemetryInterval(raw);
    assert.equal(loop.intervalMs, want, `interval for ${String(raw)}`);
    assert.equal(calls.intervals.length, 1, 'exactly one interval must be scheduled');
    assert.equal(calls.intervals[0][1], want,
      `setInterval was given ${calls.intervals[0][1]} ms, not the clamped ${want} ms — ` +
      'the bound was computed and then not used');
    assert.ok(loop.intervalMs >= 100 && loop.intervalMs <= 60000,
      `a clamped interval must be sane, got ${loop.intervalMs}`);
  }
});

// ── The Fleet Manager battery-trouble bit ────────────────────────────────────

test('the fleet battery-trouble bit follows the real battery state', () => {
  // Surviving mutation: fleetClient.setStatusBit(0, false). The dashboard bit this
  // branch exists to set would be permanently clear, and no test noticed.
  const low = harness({ fc: { linkUp: true, autopilotHeartbeat: true,
    battery: { voltageV: 6.1, remainingPct: 9, currentA: 1 } } });
  low.loop.tick();
  assert.deepEqual(low.calls.statusBits, [[0, true]],
    'a pack at 9% must raise the fleet battery-trouble bit');

  const ok = harness({ fc: { linkUp: true, autopilotHeartbeat: true,
    battery: { voltageV: 8.1, remainingPct: 80, currentA: 1 } } });
  ok.loop.tick();
  assert.deepEqual(ok.calls.statusBits, [[0, false]],
    'a healthy pack must NOT raise it — a bit that is always set is not a signal');
});

test('an unreadable battery on a live link raises the bit, and a dead link does not', () => {
  const live = harness({ fc: { linkUp: true, autopilotHeartbeat: true, battery: null } });
  live.loop.tick();
  assert.deepEqual(live.calls.statusBits, [[0, true]],
    'something is talking and not reporting the pack: fail closed');

  const dead = harness({ fc: { linkUp: false, battery: null } });
  dead.loop.tick();
  assert.deepEqual(dead.calls.statusBits, [[0, false]],
    'a dropped link is a link fault, surfaced separately — warning here fires on every blip');
});

// ── The operator broadcast ───────────────────────────────────────────────────

test('every tick broadcasts telemetry to the operator UI', () => {
  // Surviving mutation: delete io.emit('telemetry', t). Every indicator in the
  // status bar silently reverts to '--' / 'FC: DOWN', which is exactly the
  // "looked healthy while wedged" failure the FC indicator was added for.
  const h = harness({ fc: { linkUp: true, battery: { voltageV: 7.9 } } });
  h.loop.tick();
  const emits = h.calls.emits.filter(([e]) => e === 'telemetry');
  assert.equal(emits.length, 1, 'a tick must broadcast exactly one telemetry frame');
  assert.equal(emits[0][1].battery.voltageV, 7.9, 'and it must carry the real reading');
});

test('the broadcast, /status and a joining socket cannot disagree', () => {
  // current() is the single source of truth. Three callers formatting their own
  // snapshot is how a dashboard and a status bar come to show different vehicles.
  const h = harness({ fc: { linkUp: true, battery: { voltageV: 7.9, remainingPct: 60 } } });
  const broadcast = h.loop.tick();
  assert.deepEqual(h.loop.current(), broadcast);
});

test('a voltage-derived percentage is forwarded to the fleet as an estimate', () => {
  const h = harness({ fc: { linkUp: true,
    battery: { voltageV: 7.4, remainingPct: 52, currentA: 0.4, pctSource: 'voltage' } } });
  h.loop.tick();
  assert.equal(h.calls.telemetry[0].batteryPctSource, 'voltage',
    'without this the dashboard presents an estimate as a measurement');
  assert.equal(h.calls.telemetry[0].batteryPct, 52);
});

test('a missing subsystem is forwarded as null, never as undefined or 0', () => {
  // 0 V and "no reading" must not look alike on a dashboard.
  const h = harness({ fc: { linkUp: false } });
  h.loop.tick();
  const t = h.calls.telemetry[0];
  for (const key of ['batteryV', 'batteryPct', 'batteryA', 'radioRssi',
                     'boardV', 'servoV', 'wifiPct', 'wifiDbm']) {
    assert.equal(t[key], null, `${key} must be null, got ${JSON.stringify(t[key])}`);
  }
  assert.equal(t.linkUp, false);
  assert.equal(t.autopilotHeartbeat, false, 'coerced to a boolean, not left undefined');
});

// ── The /proc read must not block the event loop ─────────────────────────────

test('the wifi read is asynchronous — a tick never waits on /proc', async () => {
  // Surviving mutation: fs.readFileSync('/proc/net/wireless', 'utf8'). Invariant 9:
  // this runs on the same event loop as the override stream and the fail-safe
  // timer. Taking the reader as a promise-returning dependency is what makes
  // "it is asynchronous" assertable instead of a comment — a synchronous
  // implementation cannot satisfy this contract at all.
  const h = harness({ fc: { linkUp: true }, wifiText: 'x\ny\nwlan0: 0000 65. -58. -95.' });
  h.loop.tick();
  assert.equal(h.calls.emits[0][1].wifi, null,
    'the first tick must publish without having waited for the /proc read');
  await new Promise((r) => setImmediate(r));
  h.loop.tick();
  assert.deepEqual(h.calls.emits[1][1].wifi,
    { iface: 'wlan0', qualityPct: 93, signalDbm: -58, noiseDbm: -95, snrDb: 37,
      kind: 'wireless' },
    'and the next tick must carry the reading the async read produced');
});

test('every tick re-reads the wifi link rather than freezing the startup sample', () => {
  // Surviving mutation: delete refreshWifi() from tick(). The startup read still
  // populates the value, so the UI shows a plausible signal reading — one taken once
  // at boot and never updated again. A frozen-but-plausible reading is the exact
  // failure mode of the 2026-08-03 wedge, where a stale snapshot read as live data.
  const h = harness({ fc: { linkUp: true }, wifiText: 'x\ny\nwlan0: 0000 65. -58. -95.' });
  const afterStartup = h.wifiReads();
  h.loop.tick();
  h.loop.tick();
  assert.equal(h.wifiReads(), afterStartup + 2,
    'each tick must trigger a fresh /proc read, or the signal reading is a boot-time ' +
    `snapshot forever (reads went ${afterStartup} -> ${h.wifiReads()})`);
});

test('an unreadable /proc/net/wireless yields null, not a crash or a stale value', async () => {
  const h = harness({ fc: { linkUp: true }, wifiText: 'x\ny\nwlan0: 0000 65. -58. -95.' });
  await h.loop.refreshWifi();
  assert.ok(h.loop.current().wifi, 'precondition: a reading was established');

  const gone = harness({ fc: { linkUp: true }, wifiError: new Error('ENOENT') });
  await gone.loop.refreshWifi();
  assert.equal(gone.loop.current().wifi, null,
    'a failed read must clear the value — a stale signal reading is worse than none');
});

// ── The /proc parser ─────────────────────────────────────────────────────────

test('parseWirelessProc reads a real /proc/net/wireless', () => {
  const real = [
    'Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE',
    ' face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22',
    ' wlan0: 0000   65.  -58.  -95.       0      0      0      0     41        0',
  ].join('\n');
  // Note the noise column, -95, and the 37 dB margin it yields. This fixture always carried
  // it — the parser simply never read it, so SNR was uncomputable from data already in hand.
  assert.deepEqual(parseWirelessProc(real),
    { iface: 'wlan0', qualityPct: 93, signalDbm: -58, noiseDbm: -95, snrDb: 37 });
});

test('parseWirelessProc returns null when no interface is present', () => {
  // A Pi with wifi down still has the header lines. Reporting a bogus 0% would
  // read as a working-but-terrible link instead of no link.
  const headerOnly = 'Inter-| sta-|   Quality\n face | tus | link level noise\n';
  assert.equal(parseWirelessProc(headerOnly), null);
  assert.equal(parseWirelessProc(''), null);
});

test('parseWirelessProc reports null for an unparseable field, not NaN', () => {
  const junk = 'h1\nh2\nwlan0: 0000   ??.  ??.  -95.';
  const out = parseWirelessProc(junk);
  assert.equal(out.qualityPct, null);
  assert.equal(out.signalDbm, null);
  assert.equal(out.iface, 'wlan0');
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

test('the interval is scheduled with tick, not with a no-op', () => {
  // Surviving mutation found by the red team: setIntervalFn(() => {}, intervalMs).
  // The harness asserted the interval COUNT and its DELAY but never invoked the
  // function argument — every other test drives loop.tick() through its own
  // reference. In production that mutation means one telemetry frame at connect and
  // then silence: the fleet battery-trouble bit never updates again, wifi stays at
  // the boot sample, and the dashboard presents boot-time values as live.
  const h = harness({ fc: { linkUp: true, battery: { voltageV: 7.9, remainingPct: 80 } } });
  assert.equal(h.calls.intervals.length, 1);
  const scheduled = h.calls.intervals[0][0];
  assert.equal(typeof scheduled, 'function', 'a function must be scheduled');

  const emitsBefore = h.calls.emits.length;
  const bitsBefore  = h.calls.statusBits.length;
  scheduled();
  assert.equal(h.calls.emits.length, emitsBefore + 1,
    'invoking what was scheduled must broadcast telemetry — it is not the real tick');
  assert.equal(h.calls.statusBits.length, bitsBefore + 1,
    'and it must refresh the fleet battery-trouble bit');
});

test('stop() clears the interval it created', () => {
  const h = harness();
  h.loop.stop();
  assert.equal(h.calls.cleared.length, 1, 'the interval must be cleared, not leaked');
});

// ── The wiring app.js used to inline ─────────────────────────────────────────
//
// Every test below exists because a round-8 review mutated one of these lambdas
// while it lived in app.js and the suite stayed green at 222/222. Extracting the
// loop had moved the untested boundary, not removed it, and one of the survivors was
// a fail-open on a safety indicator.

const { buildTelemetryWiring, batteryWarnCfgFrom } = require('../telemetry-loop');

test('the wiring forwards a broadcast to the real emitter', () => {
  // Surviving mutation: emit: () => {}. The operator UI never receives a telemetry
  // frame; every indicator sits at '--' / 'FC: --' forever. The commit that
  // extracted the loop claimed this mutation was dead. It was not.
  const emitted = [];
  const w = buildTelemetryWiring({
    pwm: {}, fleetClient: {}, config: {}, fs: { promises: { readFile: async () => '' } },
    io: { emit: (event, payload) => emitted.push([event, payload]) },
  });
  w.emit('telemetry', { battery: { voltageV: 7.9 } });
  assert.equal(emitted.length, 1, 'the broadcast must reach io.emit');
  assert.deepEqual(emitted[0], ['telemetry', { battery: { voltageV: 7.9 } }]);
});

test('the wiring reads /proc asynchronously and never synchronously', async () => {
  // Surviving mutation: readWifi: (p, e) => Promise.resolve(fs.readFileSync(p, e)).
  // It satisfies the promise contract while still blocking the control event loop at
  // the telemetry rate (invariant 9). Asserting readFileSync is NOT called is what
  // closes the gap the extraction commit could only admit to.
  let syncCalls = 0;
  let asyncCalls = 0;
  const w = buildTelemetryWiring({
    pwm: {}, fleetClient: {}, io: { emit() {} }, config: {},
    fs: {
      promises: { readFile: async (p) => { asyncCalls += 1; return `read:${p}`; } },
      readFileSync: () => { syncCalls += 1; return ''; },
    },
  });
  const out = await w.readWifi('/proc/net/wireless', 'utf8');
  assert.equal(out, 'read:/proc/net/wireless');
  assert.equal(asyncCalls, 1, 'must go through fs.promises.readFile');
  assert.equal(syncCalls, 0,
    'fs.readFileSync must never be called — a synchronous /proc read on the control ' +
    'event loop freezes the fail-safe (invariant 9)');
});

test('the wiring derives the battery warning config, and fails closed', () => {
  // Surviving mutation: warnOnNoReading: false, hardwired. An unreadable battery
  // monitor on a live link then raises NEITHER the UI warning NOR the Fleet Manager
  // battery-trouble bit — and battery-warning.js and formatBattery() both implement
  // fail-closed correctly, so neither is ever reached. A one-token change to a
  // safety indicator's call site that no test could see.
  const w = buildTelemetryWiring({
    pwm: {}, fleetClient: {}, io: { emit() {} },
    fs: { promises: { readFile: async () => '' } },
    config: { batteryWarnLevel: 15, batteryWarnVolts: 6.6 },
  });
  assert.deepEqual(w.batteryWarnCfg, { warnLevel: 15, warnVolts: 6.6, warnOnNoReading: true });

  // Fail closed on every shape of "not explicitly disabled".
  for (const raw of [undefined, null, true, 1, 'yes']) {
    assert.equal(batteryWarnCfgFrom({ batteryWarnOnNoReading: raw }).warnOnNoReading, true,
      `batteryWarnOnNoReading=${JSON.stringify(raw)} must still warn`);
  }
  assert.equal(batteryWarnCfgFrom({ batteryWarnOnNoReading: false }).warnOnNoReading, false,
    'and only an explicit false opts out');
  assert.deepEqual(batteryWarnCfgFrom({}), { warnLevel: 20, warnVolts: null, warnOnNoReading: true });
});

test('the wiring passes the real config through, so bounds are applied to it', () => {
  // Surviving mutation: config: {}. telemetry_interval_ms silently ignored. Benign
  // in isolation (it defaults) but it is the same hole as the others.
  const w = buildTelemetryWiring({
    pwm: {}, fleetClient: {}, io: { emit() {} },
    fs: { promises: { readFile: async () => '' } },
    config: { telemetry_interval_ms: 250, rover_id: 3 },
  });
  assert.equal(w.config.telemetry_interval_ms, 250);
  const loop = startTelemetryLoop({ ...w, setIntervalFn: () => ({}), clearIntervalFn: () => {} });
  assert.equal(loop.intervalMs, 250, 'the configured interval must reach the loop');
});

test('a driver with no telemetry support yields an empty snapshot, not a throw', () => {
  // Four of the five drivers are GPIO and have no getTelemetry at all.
  const w = buildTelemetryWiring({
    pwm: {}, fleetClient: {}, io: { emit() {} }, config: {},
    fs: { promises: { readFile: async () => '' } },
  });
  // fcSupported:false rather than {} — see the 'no flight controller' test below for
  // why an empty snapshot was not good enough.
  assert.deepEqual(w.getFcTelemetry(), { fcSupported: false });

  const w2 = buildTelemetryWiring({
    pwm: { getTelemetry: () => ({ linkUp: true }) }, fleetClient: {}, io: { emit() {} }, config: {},
    fs: { promises: { readFile: async () => '' } },
  });
  assert.deepEqual(w2.getFcTelemetry(), { linkUp: true });
});

test('a driver with no flight controller reports n/a, not a permanent link failure', () => {
  // The four GPIO drivers have no getTelemetry, which yielded {} — leaving linkUp
  // undefined, so the status bar showed a standing 'FC: DOWN ⚠' about a link the
  // vehicle was never built with. A permanent warning is indistinguishable from no
  // warning to the operator who has learned to ignore it.
  const w = buildTelemetryWiring({
    pwm: {}, fleetClient: {}, io: { emit() {} }, config: {},
    fs: { promises: { readFile: async () => '' } },
  });
  assert.equal(w.getFcTelemetry().fcSupported, false);

  // And a driver that DOES support telemetry must never be reported as unsupported —
  // that would be a fail-open, hiding a genuinely dead link behind 'FC: n/a'.
  const w2 = buildTelemetryWiring({
    pwm: { getTelemetry: () => ({ linkUp: false }) }, fleetClient: {}, io: { emit() {} },
    config: {}, fs: { promises: { readFile: async () => '' } },
  });
  assert.notEqual(w2.getFcTelemetry().fcSupported, false,
    'a mavproxy driver with a down link must still report DOWN, not n/a');
});

test('an unwatchable pack is reported, and a watchable one is not', () => {
  // Surviving mutation before this test existed: delete the startup guard entirely.
  // It is the ONLY mitigation for a rover on which no state of charge can raise a
  // warning — the percentage branch has no percentage, the voltage branch has no
  // threshold, and the fail-closed branch needs the voltage to be missing too. A 2S
  // pack at 3.0 V total (cells at 1.5 V, destroyed) renders with no warning and sets
  // no fleet status bit.
  const { batteryWarnabilityWarning } = require('../telemetry-loop');

  // Unwatchable: no threshold, and the driver has no usable range.
  assert.ok(batteryWarnabilityWarning({}, null), 'the shipped tracked config must warn');
  assert.match(batteryWarnabilityWarning({}, null), /NEVER raise a battery warning/);

  // Half-configured is the case the FIRST version of this guard missed: it tested
  // whether battery_empty_volts was present, and setting only that satisfied it while
  // the driver still refused to build a range.
  assert.ok(batteryWarnabilityWarning({ battery_empty_volts: 6.0 }, null),
    'a half-configured range leaves the pack unwatchable and must still warn');

  // Watchable either way: an explicit voltage threshold...
  assert.equal(batteryWarnabilityWarning({ batteryWarnVolts: 6.8 }, null), null);
  // ...or a driver that can derive a percentage from voltage.
  assert.equal(batteryWarnabilityWarning({}, { emptyV: 6.0, fullV: 8.4 }), null);
  // A threshold of 0 is a real threshold, not an absent one.
  assert.equal(batteryWarnabilityWarning({ batteryWarnVolts: 0 }, null), null);
});

test('the TRACKED config ships a pack that can actually raise a warning', () => {
  // Pins the shipped value, because "no threshold configured" is invisible in normal
  // operation: everything renders, nothing warns, and the failure only appears on the
  // one day a pack is flat. batteryWarnVolts was null until 2026-08-04 and, because
  // ArduPilot reports battery_remaining=0 on this fleet, the percentage branch never
  // fired either — so no state of charge could raise a warning at all.
  //
  // Deliberately reads the tracked config and NOT picar-cfg.local.json: a threshold
  // that only exists in the untracked per-rover overlay is exactly what invariant 8
  // forbids for safety-relevant config, and it is how rover3 came to have a
  // PLACEHOLDER pack range standing in for a real one.
  const cfg = require('../picar-cfg.json');
  const { batteryWarnabilityWarning, batteryWarnCfgFrom } = require('../telemetry-loop');

  assert.equal(batteryWarnabilityWarning(cfg, null), null,
    'the tracked config leaves the pack unwatchable — see the startup warning this ' +
    'returns for what the operator would be told');

  const warn = batteryWarnCfgFrom(cfg);
  assert.ok(Number.isFinite(warn.warnVolts) && warn.warnVolts > 0,
    `batteryWarnVolts must be a positive number, got ${JSON.stringify(warn.warnVolts)}`);
  // Sanity-bound it. A threshold above a full pack warns constantly (and is therefore
  // ignored); one near zero never warns at all. 2S LiPo is 6.0-8.4 V.
  assert.ok(warn.warnVolts >= 5.5 && warn.warnVolts <= 8.0,
    `batteryWarnVolts=${warn.warnVolts} is outside a sane 2S range — if the fleet's cell ` +
    'count changed, update this bound with it rather than deleting it');
  assert.equal(warn.warnOnNoReading, true, 'and an unreadable monitor must still warn');
});

// ── The link metric follows the default route ────────────────────────────────
//
// The fleet moved to ethernet and the link metric went blank, because it was read solely from
// /proc/net/wireless — which on a wired rover holds only its two header lines. "Link: --" on a
// rover with a gigabit connection reads as a dead link, on the field meant to describe the
// connection the operator depends on.

const { parseDefaultIface, parseWiredLink } = require('../telemetry-loop.js');

const ROUTE = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask',
  'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000',
  'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF',
].join('\n');

test('the default-route interface is identified from /proc/net/route', () => {
  assert.equal(parseDefaultIface(ROUTE), 'eth0');
});

test('a non-default route is not mistaken for the default', () => {
  // Destination must be 00000000. Matching on the UP flag alone would pick a subnet route.
  const onlySubnet = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask',
    'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF',
  ].join('\n');
  assert.equal(parseDefaultIface(onlySubnet), null);
});

test('with two default routes the LOWEST metric wins', () => {
  // A rover with both wired and wireless up must report the one the kernel actually uses,
  // not whichever appears first in the file.
  const both = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask',
    'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000',
    'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000',
  ].join('\n');
  assert.equal(parseDefaultIface(both), 'eth0');
});

test('a route that is not UP is ignored', () => {
  const down = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask',
    'eth0\t00000000\t0101A8C0\t0002\t0\t0\t100\t00000000',
  ].join('\n');
  assert.equal(parseDefaultIface(down), null);
});

test('empty or malformed route data yields null, not a guess', () => {
  for (const bad of ['', null, 'garbage', 'Iface\tDestination\n']) {
    assert.equal(parseDefaultIface(bad), null);
  }
});

test('wired link facts are read from sysfs — rover3s real values', () => {
  const l = parseWiredLink('eth0', { speed: '1000\n', duplex: 'full\n',
                                     carrier: '1\n', operstate: 'up\n' });
  assert.equal(l.kind, 'wired');
  assert.equal(l.speedMbps, 1000);
  assert.equal(l.duplex, 'full');
  assert.equal(l.carrier, true);
  assert.equal(l.up, true);
});

test('a down interface reports unknown speed, not a number', () => {
  // /sys/class/net/*/speed reads -1 (or errors) when the link is down. Reporting -1 Mb/s as a
  // speed would be worse than saying nothing.
  const l = parseWiredLink('eth0', { speed: '-1', duplex: 'unknown',
                                     carrier: '0', operstate: 'down' });
  assert.equal(l.speedMbps, null);
  assert.equal(l.carrier, false);
  assert.equal(l.up, false);
});

test('a wired link never reports a fake signal strength', () => {
  // A consumer written for the wireless shape must not read a wired link as 0% / 0 dBm.
  // Absent and zero are different facts.
  const l = parseWiredLink('eth0', { speed: '1000', duplex: 'full', carrier: '1', operstate: 'up' });
  assert.equal(l.qualityPct, null);
  assert.equal(l.signalDbm, null);
});

// ── Signal-to-noise ──────────────────────────────────────────────────────────
//
// The noise column of /proc/net/wireless was listed in parseWirelessProc's own comment and
// then never read, so SNR was uncomputable from a WiFi rover even though the kernel had
// already measured it. SNR is the number that predicts whether a link holds — a strong signal
// in a noisy band still drops packets.

const W = (q, sig, noi) => `Inter-|\nface |\nwlan0: 0000  ${q}.  ${sig}.  ${noi}.`;

test('SNR is computed from the noise column that was being dropped', () => {
  // -58 dBm signal against -95 dBm noise is a 37 dB margin — a healthy link.
  const w = parseWirelessProc(W(65, -58, -95));
  assert.equal(w.signalDbm, -58);
  assert.equal(w.noiseDbm, -95);
  assert.equal(w.snrDb, 37);
});

test('a weak signal in a noisy band reports a poor SNR', () => {
  // The case raw RSSI alone cannot express: -70 dBm looks survivable until you see the noise
  // floor is -75, leaving 5 dB.
  assert.equal(parseWirelessProc(W(20, -70, -75)).snrDb, 5);
});

test('the -256 noise sentinel does not become a confident SNR', () => {
  // Some drivers hardwire the noise column to -256 rather than measuring it. Subtracting it
  // would yield a triumphant ~200 dB margin from a driver that measured nothing.
  const w = parseWirelessProc(W(65, -58, -256));
  assert.equal(w.snrDb, null, 'an unmeasured noise floor must not produce an SNR');
  assert.equal(w.signalDbm, -58, 'while the signal it did measure is still reported');
});

test('a missing noise column yields null SNR, not a guess', () => {
  const w = parseWirelessProc('Inter-|\nface |\nwlan0: 0000  65.  -58.');
  assert.equal(w.snrDb, null);
  assert.equal(w.noiseDbm, null);
});

test('a wired link reports no SNR at all', () => {
  // An ethernet PHY has no signal-to-noise measurement; the kernel exposes none. Reporting 0
  // would be inventing one.
  const l = parseWiredLink('eth0', { speed: '1000', duplex: 'full', carrier: '1', operstate: 'up' });
  assert.equal(l.snrDb, undefined, 'a wired link must not carry an snrDb field at all');
});
