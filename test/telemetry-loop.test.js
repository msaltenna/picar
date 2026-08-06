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
    { iface: 'wlan0', qualityPct: 93, signalDbm: -58, retries: null },
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
  assert.deepEqual(parseWirelessProc(real),
    { iface: 'wlan0', qualityPct: 93, signalDbm: -58, retries: 0 });
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

// ── onTick: the hook adaptive video rides ────────────────────────────────────
//
// Adaptive bitrate consumes this rather than owning a second timer and a second /proc read
// on the event loop that runs the input watchdog (invariant 9). Two properties matter, and
// the second matters more: the hook must fire, and a broken subscriber must NOT be able to
// take telemetry down with it. Everything before onTick in the tick body is load-bearing —
// the Fleet Manager battery-trouble bit and the operator's telemetry broadcast — and under
// the crash fail-safe an escaping exception would end the process.

test('onTick receives the same snapshot that was broadcast', () => {
  const seen = [];
  const emitted = [];
  const loop = startTelemetryLoop({
    getFcTelemetry: () => ({ linkUp: true }),
    fleetClient: { setStatusBit: () => {}, setTelemetry: () => {} },
    emit: (ev, payload) => emitted.push([ev, payload]),
    readWifi: () => Promise.resolve(''),
    config: {},
    batteryWarnCfg: { warnLevel: 20, warnVolts: null, warnOnNoReading: true },
    onTick: (t) => seen.push(t),
    setIntervalFn: () => 0,
  });
  const returned = loop.tick();
  assert.equal(seen.length, 1, 'the hook must be called once per tick');
  assert.strictEqual(seen[0], returned,
    'the subscriber must see the SAME object the loop returned and broadcast, or the ' +
    'controller and /status can disagree about the signal');
  assert.strictEqual(seen[0], emitted.find(([ev]) => ev === 'telemetry')[1]);
});

test('a throwing onTick does not stop the broadcast or the fleet update', () => {
  const emitted = [];
  const bits = [];
  const loop = startTelemetryLoop({
    getFcTelemetry: () => ({ linkUp: true }),
    fleetClient: {
      setStatusBit: (i, v) => bits.push([i, v]),
      setTelemetry: () => {},
    },
    emit: (ev, payload) => emitted.push([ev, payload]),
    readWifi: () => Promise.resolve(''),
    config: {},
    batteryWarnCfg: { warnLevel: 20, warnVolts: null, warnOnNoReading: true },
    onTick: () => { throw new Error('subscriber exploded'); },
    setIntervalFn: () => 0,
  });
  assert.doesNotThrow(() => loop.tick(),
    'a video-quality subscriber must never be able to end the telemetry loop');
  assert.ok(emitted.some(([ev]) => ev === 'telemetry'),
    'the operator UI must still receive its frame');
  assert.equal(bits.length, 1, 'the fleet battery-trouble bit must still be set');
});

test('a null onTick is a no-op, not a crash', () => {
  const loop = startTelemetryLoop({
    getFcTelemetry: () => ({}),
    fleetClient: { setStatusBit: () => {}, setTelemetry: () => {} },
    emit: () => {},
    readWifi: () => Promise.resolve(''),
    config: {},
    batteryWarnCfg: { warnLevel: 20, warnVolts: null, warnOnNoReading: true },
    onTick: null,
    setIntervalFn: () => 0,
  });
  assert.doesNotThrow(() => loop.tick());
});

test('buildTelemetryWiring forwards onTick rather than dropping it', () => {
  const fn = () => {};
  const wiring = buildTelemetryWiring({
    pwm: { getTelemetry: () => ({}) },
    io: { emit: () => {} },
    fleetClient: { setStatusBit: () => {}, setTelemetry: () => {} },
    fs: { promises: { readFile: () => Promise.resolve('') } },
    config: {},
    onTick: fn,
  });
  assert.strictEqual(wiring.onTick, fn,
    'app.js passes onTick through this builder; dropping it here would silently disable ' +
    'adaptive bitrate with every unit test still green');
});


// ── The retry counter ────────────────────────────────────────────────────────
//
// Free to collect — /proc/net/wireless is already read once a second — and it measures what
// dBm cannot: airtime burned on retransmission. The drive on 2026-08-06 froze at −67 dBm on a
// link whose nominal tx rate was 72 Mbit/s, so signal strength alone could not explain it, and
// there was no retry record for the window to check against.

test('parseWirelessProc reads the retry counter from column 7', () => {
  const real = [
    'Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE',
    ' face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22',
    ' wlan0: 0000   63.  -47.  -256        0      0      0    747      0        0',
  ].join('\n');
  const w = parseWirelessProc(real);
  assert.equal(w.retries, 747,
    'column 7 is retry; picking a neighbouring column would silently report nwid, frag or misc');
  // Pinned together so an off-by-one in the column index cannot pass by coincidence.
  assert.equal(w.signalDbm, -47);
  assert.equal(w.qualityPct, 90);
});

test('a short /proc line with no retry column yields null, not NaN', () => {
  const w = parseWirelessProc('x\ny\nwlan0: 0000 65. -58. -95.');
  assert.equal(w.retries, null,
    'NaN would render as "NaN" in the trace and silently poison any rate arithmetic');
});
