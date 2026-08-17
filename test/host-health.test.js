'use strict';

// Host-side tests for CPU/thermal/service health reporting.
//
// The defect this closes: on 2026-08-14 rover1 was at 84 C with the firmware's SOFT TEMP LIMIT
// active and its clock pulled to 2256 of 2400 MHz, while `/status` reported a live link and
// 11/11 critical parameters verified. Nothing picar published could say the vehicle was
// throttled. These tests exist to keep that observable.
//
// The parsers are pure and tested against REAL captured strings — the throttle words below are
// the ones rover1 actually reported — because a wrong bit mask is exactly the kind of thing
// that reads fine and is wrong, and would otherwise only be discovered on hardware.

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  createHostHealth,
  parseThrottled, parseProcStat, cpuBusyPct, parseTempMilli, parseKhz,
  parseUnitShow, unitHealth,
} = require('../host-health.js');

// ── parseThrottled ───────────────────────────────────────────────────────────

test('0x0 is not throttled, and that is a MEASUREMENT not an absence', () => {
  const t = parseThrottled('throttled=0x0');
  assert.equal(t.active, false);
  assert.deepEqual(t.now, []);
  assert.deepEqual(t.sinceBoot, []);
  assert.equal(t.raw, '0x0');
});

test('0xf0006 — rover1, measured — decodes to capped+throttled now, all four historical', () => {
  const t = parseThrottled('throttled=0xf0006');
  assert.equal(t.active, true);
  assert.deepEqual(t.now.sort(), ['arm frequency capped', 'throttled']);
  assert.equal(t.sinceBoot.length, 4, 'all four latched bits are set in 0xf0000');
  assert.ok(t.sinceBoot.includes('under-voltage'));
});

test('0xf0008 — rover1 minutes later — is the soft temperature limit', () => {
  const t = parseThrottled('throttled=0xf0008');
  assert.equal(t.active, true);
  assert.deepEqual(t.now, ['soft temperature limit']);
});

test('historical bits alone must NOT report as currently active', () => {
  // The distinction an operator acts on. 0xf0000 means "this box has throttled and browned
  // out at some point since boot" — worth showing, but it is not happening now, and colouring
  // it as a live fault would train them to ignore the indicator.
  const t = parseThrottled('throttled=0xf0000');
  assert.equal(t.active, false, 'latched history is not a present condition');
  assert.deepEqual(t.now, []);
  assert.equal(t.sinceBoot.length, 4);
});

test('unparseable throttle output yields null, never a comfortable zero', () => {
  for (const bad of ['', 'VCHI initialization failed', 'throttled=', null, undefined, 'nonsense']) {
    assert.equal(parseThrottled(bad), null, `${JSON.stringify(bad)} must not read as 0x0`);
  }
});

// ── CPU busy ─────────────────────────────────────────────────────────────────

const STAT = (idle, total) => `cpu  ${total - idle} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 2 3 4\n`;

test('/proc/stat is parsed from the aggregate line', () => {
  const s = parseProcStat(STAT(400, 1000));
  assert.equal(s.idle, 400);
  assert.equal(s.total, 1000);
});

test('the first sample yields null busy, because a rate needs two points', () => {
  assert.equal(cpuBusyPct(null, parseProcStat(STAT(400, 1000))), null);
});

test('busy percent is computed from the delta, not the absolute counters', () => {
  // Absolute values say 60% busy overall; the DELTA says the machine was 25% busy in the
  // interval. Reporting the former would show a rover's lifetime average and never move.
  const prev = parseProcStat(STAT(400, 1000));
  const cur  = parseProcStat(STAT(475, 1100));   // 100 ticks passed, 75 idle
  assert.equal(cpuBusyPct(prev, cur), 25);
});

test('a counter that goes backwards or does not advance yields null', () => {
  const a = parseProcStat(STAT(400, 1000));
  assert.equal(cpuBusyPct(a, a), null, 'no elapsed time is not 0% busy');
  assert.equal(cpuBusyPct(a, parseProcStat(STAT(300, 900))), null, 'a reboot mid-sample');
});

test('busy percent is clamped into 0..100', () => {
  const prev = parseProcStat(STAT(400, 1000));
  const cur  = parseProcStat(STAT(400, 1100));   // all 100 new ticks busy
  assert.equal(cpuBusyPct(prev, cur), 100);
});

// ── Temperature ──────────────────────────────────────────────────────────────

test('millidegrees are converted, at rover1 and rover2 measured values', () => {
  assert.equal(parseTempMilli('84200\n'), 84.2);
  assert.equal(parseTempMilli('55500'), 55.5);
});

test('an implausible temperature is refused rather than reported', () => {
  // Same reasoning as telemetry.sh's battery plausibility window: a sensor reading 300 C is
  // a broken sensor, and printing it as a temperature invites someone to act on it.
  for (const bad of ['300000', '-40000', 'abc', '', null]) {
    assert.equal(parseTempMilli(bad), null, `${JSON.stringify(bad)} must not be reported`);
  }
});

// ── Unit states ──────────────────────────────────────────────────────────────

const SHOW = (units) => units.map((u) =>
  `Result=${u.result || 'success'}\nNRestarts=${u.restarts ?? 0}\nId=${u.id}.service\n` +
  `ActiveState=${u.state}\nSubState=${u.sub}`).join('\n\n');

test('units are keyed by Id, not by position', () => {
  // The previous parser zipped output lines against the requested list, so short or reordered
  // output silently attributed one unit's state to another — a wrong answer that looks right.
  const out = parseUnitShow(SHOW([
    { id: 'mediamtx', state: 'active',   sub: 'running' },
    { id: 'picar',    state: 'inactive', sub: 'dead' },
  ]));
  assert.equal(out.picar.state, 'inactive');
  assert.equal(out.mediamtx.state, 'active');
});

test('restart counts and last result are captured', () => {
  const out = parseUnitShow(SHOW([
    { id: 'mavproxy', state: 'active', sub: 'running', restarts: 5, result: 'exit-code' },
  ]));
  assert.equal(out.mavproxy.restarts, 5);
  assert.equal(out.mavproxy.result, 'exit-code');
});

test('empty output is null, not units reported as fine', () => {
  assert.equal(parseUnitShow(''), null);
  assert.equal(parseUnitShow(null), null);
});

// ── active is not the same as working ────────────────────────────────────────

test('a plain active/running unit is healthy', () => {
  const h = unitHealth({ state: 'active', sub: 'running', result: 'success', restarts: 0 }, 0);
  assert.equal(h.ok, true);
  assert.equal(h.why, null);
});

test('a CRASH-LOOPING unit is not healthy even though it is active', () => {
  // The case that motivated this. systemd reports `active` for a unit it is restarting every
  // few seconds, so `is-active` shows green while the service is failing continuously.
  const h = unitHealth({ state: 'active', sub: 'auto-restart', result: 'exit-code', restarts: 9 }, 9);
  assert.equal(h.ok, false);
  assert.equal(h.why, 'restart-looping');
});

test('a unit whose restart count is CLIMBING is failing right now', () => {
  // A non-zero count means it restarted at some point; an INCREASING count means it is
  // failing now. Only comparing against the previous poll can tell those apart.
  const u = { state: 'active', sub: 'running', result: 'success', restarts: 4 };
  assert.equal(unitHealth(u, 3).ok, false, 'count went 3 -> 4 between polls');
  assert.equal(unitHealth(u, 3).why, 'restarting');
  assert.equal(unitHealth(u, 4).ok, true, 'a stable non-zero count is history, not a fault');
});

test('a bad last exit is reported even after systemd brings it back', () => {
  const h = unitHealth({ state: 'active', sub: 'running', result: 'exit-code', restarts: 2 }, 2);
  assert.equal(h.ok, false);
  assert.match(h.why, /last-exit:exit-code/);
});

test('an inactive or failed unit reports its state as the reason', () => {
  assert.deepEqual(unitHealth({ state: 'failed', sub: 'failed' }, 0), { ok: false, why: 'failed' });
  assert.deepEqual(unitHealth({ state: 'inactive', sub: 'dead' }, 0), { ok: false, why: 'inactive' });
  assert.equal(unitHealth(null, 0).ok, false);
});

test('kHz sysfs values convert to MHz', () => {
  assert.equal(parseKhz('2400000\n'), 2400);
  assert.equal(parseKhz('1500000'), 1500);
  assert.equal(parseKhz('garbage'), null);
  // Number('') is 0, not NaN — an empty sysfs read must not report a stopped CPU.
  assert.equal(parseKhz(''), null);
  assert.equal(parseKhz(null), null);
});

// ── The sampler ──────────────────────────────────────────────────────────────

function fakeFs(files) {
  return (p) => (p in files
    ? Promise.resolve(files[p])
    : Promise.reject(new Error(`ENOENT ${p}`)));
}
const ROVER1_FILES = {
  '/sys/class/thermal/thermal_zone0/temp': '84200',
  '/proc/stat': STAT(400, 1000),
  '/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq': '2256000',
  '/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq': '2400000',
  '/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor': 'performance\n',
};
const settle = () => new Promise((r) => setTimeout(r, 60));

test('a snapshot reports rover1 as it actually was', async () => {
  const h = createHostHealth({
    readFile: fakeFs(ROVER1_FILES),
    run: (cmd) => Promise.resolve(cmd === 'vcgencmd' ? 'throttled=0xf0008'
      : SHOW([{ id: 'picar', state: 'active', sub: 'running' },
              { id: 'mavproxy', state: 'active', sub: 'running' },
              { id: 'mediamtx', state: 'active', sub: 'running' }])),
  });
  try {
    await settle();
    const s = h.snapshot();
    assert.equal(s.cpu.tempC, 84.2);
    assert.equal(s.cpu.freqMhz, 2256);
    assert.equal(s.cpu.maxFreqMhz, 2400);
    assert.equal(s.cpu.governor, 'performance');
    assert.equal(s.throttled.active, true);
    assert.equal(s.services.picar.ok, true);
    assert.equal(s.services.mavproxy.state, 'active');
    assert.equal(s.services.mediamtx.ok, true);
  } finally { h.stop(); }
});

test('an unreadable source reports null AND says why', async () => {
  const h = createHostHealth({
    readFile: fakeFs({}),                        // nothing readable
    run: () => Promise.reject(new Error('vcgencmd: not found')),
  });
  try {
    await settle();
    const s = h.snapshot();
    assert.equal(s.cpu.tempC, null, 'an unreadable thermal zone is not 0 C');
    assert.equal(s.throttled, null, 'a missing vcgencmd is not "no throttling"');
    assert.notEqual(s.errors, null, 'and the reason must be reported');
    assert.match(JSON.stringify(s.errors), /not found|ENOENT/);
  } finally { h.stop(); }
});

test('systemctl exiting non-zero still yields the unit states', async () => {
  // `systemctl is-active` exits 3 when any unit is inactive. Treating that as failure would
  // report every unit as unknown precisely when one of them has stopped — the moment the
  // field matters most.
  const h = createHostHealth({
    readFile: fakeFs(ROVER1_FILES),
    run: (cmd) => {
      if (cmd === 'vcgencmd') return Promise.resolve('throttled=0x0');
      const e = new Error('Command failed');
      e.stdout = SHOW([{ id: 'picar', state: 'active', sub: 'running' },
                       { id: 'mavproxy', state: 'inactive', sub: 'dead' },
                       { id: 'mediamtx', state: 'active', sub: 'running' }]);
      return Promise.reject(e);
    },
  });
  try {
    await settle();
    const s = h.snapshot();
    assert.equal(s.services.picar.ok, true);
    assert.equal(s.services.mavproxy.ok, false, 'an inactive unit is not ok');
    assert.equal(s.services.mavproxy.why, 'inactive');
  } finally { h.stop(); }
});

test('snapshot() does no I/O and is instant', async () => {
  // It is called from the /status request path, which shares the event loop with the input
  // watchdog and the 20 Hz override stream. A read or a fork here is a safety defect, not a
  // slow function.
  let reads = 0;
  const h = createHostHealth({
    readFile: (p) => { reads++; return fakeFs(ROVER1_FILES)(p); },
    run: () => Promise.resolve('throttled=0x0'),
  });
  try {
    await settle();
    const before = reads;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) h.snapshot();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(reads, before, 'snapshot() performed I/O');
    assert.ok(ms < 50, `1000 snapshots took ${ms.toFixed(1)} ms`);
  } finally { h.stop(); }
});

test('the poll intervals are clamped against the untracked overlay', () => {
  // invariant 8: picar-cfg.local.json can set any key with no review. Zero would become
  // setInterval(fn, 0) on the control event loop — app.js records the telemetry interval
  // costing ~10% of a core when it reached 1 ms.
  const mk = (fastMs, slowMs) => createHostHealth({
    readFile: fakeFs(ROVER1_FILES), run: () => Promise.resolve('throttled=0x0'), fastMs, slowMs,
  });
  const cases = [
    [0, 0,             2000, 15000],   // zero must not mean "as fast as possible"
    [-5, -5,           2000, 15000],
    [1, 1,             500,  5000],    // clamped up to the floor
    [1e9, 1e9,         60000, 300000], // and down to the ceiling
    [undefined, undefined, 2000, 15000],
    ['x', 'x',         2000, 15000],
    [3000, 30000,      3000, 30000],   // a sane value is honoured
  ];
  for (const [f, s, wantF, wantS] of cases) {
    const h = mk(f, s);
    try {
      assert.deepEqual(h.intervals(), { fastMs: wantF, slowMs: wantS },
        `fastMs=${f} slowMs=${s}`);
    } finally { h.stop(); }
  }
});

test('stop() clears both timers so the process can exit', async () => {
  // A leaked interval makes `node --test` hang, and CLAUDE.md notes a hang reads as a pass.
  const h = createHostHealth({
    readFile: fakeFs(ROVER1_FILES), run: () => Promise.resolve('throttled=0x0'), fastMs: 500,
  });
  await settle();
  h.stop();
  const reads = [];
  const h2 = createHostHealth({
    readFile: (p) => { reads.push(p); return fakeFs(ROVER1_FILES)(p); },
    run: () => Promise.resolve('throttled=0x0'), fastMs: 500,
  });
  await settle();
  h2.stop();
  const after = reads.length;
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(reads.length, after, 'polling continued after stop()');
});

test('a STALLED source cannot accumulate polls without bound', async () => {
  // A reviewer's finding, and it is an invariant 9 defect rather than an inefficiency. The
  // original used setInterval for both pollers, which fires on a fixed period whether or not
  // the previous run finished — so one wedged sysfs read or hung vcgencmd would leave a poll
  // pending while every later tick enqueued another, accumulating file handles and child
  // processes on the process that carries the 20 Hz override stream and the input watchdog.
  //
  // Each poll now schedules the next only after it settles, under a hard deadline. At most
  // one is ever in flight.
  let started = 0;
  const h = createHostHealth({
    readFile: () => { started++; return new Promise(() => {}); },   // never settles, ever
    run: () => new Promise(() => {}),
    fastMs: 500,
  });
  try {
    await new Promise((r) => setTimeout(r, 2500));
    // Five intervals have elapsed. With setInterval and no guard this would be ~5 concurrent
    // polls, each issuing 5 reads. Bounded, it is one poll at a time — so the read count
    // tracks deadline expiries, not wall-clock ticks.
    assert.ok(started <= 15,
      `${started} reads started against a never-settling source — polls are accumulating`);
  } finally { h.stop(); }
});

test('a stalled source is reported rather than silently retried forever', async () => {
  const h = createHostHealth({
    readFile: () => new Promise(() => {}),
    run: () => new Promise(() => {}),
    fastMs: 500,
  });
  try {
    await new Promise((r) => setTimeout(r, 1200));
    const s = h.snapshot();
    assert.equal(s.cpu.tempC, null);
    assert.notEqual(s.errors, null, 'a wedged source must surface, not just read as absent');
  } finally { h.stop(); }
});

// ── Which units a rover is expected to run ───────────────────────────────────

const { expectedUnits } = require('../host-health.js');

test('a webrtc + mavproxy rover watches all three units', () => {
  assert.deepEqual(expectedUnits({ stream_codec: 'webrtc', pwm_method: 'mavproxy' }),
    ['picar', 'mavproxy', 'mediamtx']);
});

test('an h264 or mjpeg rover does NOT watch mediamtx', () => {
  // install.sh disables MediaMTX for these codecs; picar serves the stream itself. Watching
  // it would put a permanent red SVC warning on a healthy rover, which trains an operator to
  // ignore the alert that is meant to reveal a real failure.
  for (const codec of ['h264', 'mjpeg']) {
    assert.deepEqual(expectedUnits({ stream_codec: codec }), ['picar', 'mavproxy'],
      `${codec} must not expect mediamtx`);
  }
});

test('a GPIO rover does NOT watch mavproxy', () => {
  // Four of the five drivers are GPIO and speak no MAVLink at all.
  assert.deepEqual(expectedUnits({ pwm_method: 'pigpio' }), ['picar', 'mediamtx']);
  assert.deepEqual(expectedUnits({ pwm_method: 'mavproxy', use_mavproxy: false }),
    ['picar', 'mediamtx'], 'use_mavproxy:false disables the unit even on the mavproxy driver');
});

test('the defaults match the shipped config', () => {
  // picar-cfg.json ships stream_codec: webrtc and pwm_method: mavproxy.
  assert.deepEqual(expectedUnits({}), ['picar', 'mavproxy', 'mediamtx']);
});

test('a permanently stalled source starts NO additional operations', async () => {
  // The reviewer MEASURED the previous attempt failing this: outstanding reads grew from 5 at
  // 0.6 s to 25 at 4.6 s, because racing a deadline abandons the read and reschedules anyway.
  // The guard is now held until the work actually settles, so a wedged source must produce
  // exactly ONE outstanding operation of each kind no matter how long it is left.
  const h = createHostHealth({
    readFile: () => new Promise(() => {}),          // never settles
    run: () => new Promise(() => {}),
    fastMs: 500, slowMs: 5000,
  });
  try {
    await new Promise((r) => setTimeout(r, 600));
    const early = h.startedCount();
    await new Promise((r) => setTimeout(r, 4000));
    const late = h.startedCount();
    assert.equal(late, early,
      `operations started grew ${early} -> ${late} against a stalled source; ` +
      'the in-flight guard is not holding');
    assert.ok(late <= 2, `at most one fast and one slow poll may ever be outstanding, got ${late}`);
  } finally { h.stop(); }
});
