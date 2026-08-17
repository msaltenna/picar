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
  parseThrottled, parseProcStat, cpuBusyPct, parseTempMilli, parseUnitStates, parseKhz,
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

test('one systemctl call maps to the units IN ORDER', () => {
  const s = parseUnitStates('active\nactive\nfailed\n', ['picar', 'mavproxy', 'mediamtx']);
  assert.deepEqual(s, { picar: 'active', mavproxy: 'active', mediamtx: 'failed' });
});

test('a missing line leaves that unit null rather than shifting the others', () => {
  // If output were shorter than the unit list, a naive zip would report mediamtx's state for
  // mavproxy — a wrong answer that looks right.
  const s = parseUnitStates('active\n', ['picar', 'mavproxy', 'mediamtx']);
  assert.equal(s.picar, 'active');
  assert.equal(s.mavproxy, null);
  assert.equal(s.mediamtx, null);
});

test('empty output is null, not three units reported as fine', () => {
  assert.equal(parseUnitStates('', ['picar']), null);
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
    run: (cmd) => Promise.resolve(cmd === 'vcgencmd' ? 'throttled=0xf0008' : 'active\nactive\nactive\n'),
  });
  try {
    await settle();
    const s = h.snapshot();
    assert.equal(s.cpu.tempC, 84.2);
    assert.equal(s.cpu.freqMhz, 2256);
    assert.equal(s.cpu.maxFreqMhz, 2400);
    assert.equal(s.cpu.governor, 'performance');
    assert.equal(s.throttled.active, true);
    assert.deepEqual(s.services, { picar: 'active', mavproxy: 'active', mediamtx: 'active' });
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
      e.stdout = 'active\ninactive\nactive\n';
      return Promise.reject(e);
    },
  });
  try {
    await settle();
    const s = h.snapshot();
    assert.deepEqual(s.services, { picar: 'active', mavproxy: 'inactive', mediamtx: 'active' });
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
