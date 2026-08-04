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
    { iface: 'wlan0', qualityPct: 93, signalDbm: -58 },
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
    { iface: 'wlan0', qualityPct: 93, signalDbm: -58 });
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

test('stop() clears the interval it created', () => {
  const h = harness();
  h.loop.stop();
  assert.equal(h.calls.cleared.length, 1, 'the interval must be cleared, not leaked');
});
