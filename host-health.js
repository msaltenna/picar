'use strict';

// Host health: CPU load, temperature, clock, throttling, and unit status.
//
// WHY THIS EXISTS. On 2026-08-14 rover1 sat at 84 C with SOFT TEMP LIMIT ACTIVE, its clock
// pulled down to 2256 of 2400 MHz, while `/status` reported a healthy link and 11/11 critical
// parameters verified. Nothing picar published could have told an operator that the vehicle
// was thermally throttled, and the only way to see it was to SSH in. That is the same shape as
// the audit's other finding — BRD_SAFETY_DEFLT inhibited every PWM output while picar reported
// "FC: ok" — where the thing that decided whether the vehicle worked was outside everything
// picar looked at.
//
// INVARIANT 9 GOVERNS THIS FILE. It runs on the event loop that carries the 20 Hz override
// stream and the input watchdog. So:
//   - every source is read ASYNCHRONOUSLY, on an unref'd interval, and cached;
//   - `snapshot()` is a synchronous cache read and never performs I/O;
//   - the two sources that need a SUBPROCESS (vcgencmd, systemctl) are polled on their own
//     slower interval, because spawning at the telemetry rate is exactly the defect
//     CLAUDE.md records in pwm_libgpiod (~200 execSync/s).
//
// REPORTS, DOES NOT JUDGE. It emits numbers plus the decoded flags the firmware itself sets.
// It deliberately does NOT compute an "unhealthy" verdict: the audit's lesson is that picar
// asserting health is how a vehicle that could not move was reported as fine. The UI decides
// what to colour red.
//
// `null` means "could not determine" and is never collapsed to 0. A 0 C reading and an
// unreadable thermal zone are different facts, and the reader-count work in streams/webrtc.js
// hit the same distinction: reporting a guess as a measurement is how the original stub
// (`clientCount() { return 0 }`) misled everyone for months.

const THERMAL_ZONE = '/sys/class/thermal/thermal_zone0/temp';
const PROC_STAT    = '/proc/stat';
const CPUFREQ_DIR  = '/sys/devices/system/cpu/cpu0/cpufreq';

// The units whose state an operator needs to see. picar itself is included deliberately: if
// picar is answering /status then picar is up, but the field keeps the shape uniform and
// makes a degraded-but-running state visible.
const WATCHED_UNITS = ['picar', 'mavproxy', 'mediamtx'];

// Which units this rover is actually EXPECTED to run, derived from the effective config.
//
// A reviewer caught the original watching all three unconditionally. That is wrong on
// supported configurations: install.sh disables MediaMTX for the h264 and mjpeg stream
// codecs, and MAVProxy is irrelevant to the four GPIO drivers. Those rovers are healthy, and
// a permanent red "SVC mediamtx:inactive" on a healthy rover trains an operator to ignore the
// exact alert that is supposed to reveal a real failure — the same way a status bar that
// flickers 'FC: ok' -> 'FC: unverified' taught people to stop reading it.
//
// So an intentionally-absent service is not watched at all, rather than watched and excused.
function expectedUnits(config = {}) {
  const units = ['picar'];
  // The mavproxy driver is the only one that speaks MAVLink; `use_mavproxy: false` disables
  // the unit even when the driver is selected.
  if ((config.pwm_method || 'mavproxy') === 'mavproxy' && config.use_mavproxy !== false) {
    units.push('mavproxy');
  }
  // MediaMTX serves the webrtc codec only; h264 and mjpeg are served by picar itself.
  if ((config.stream_codec || 'webrtc') === 'webrtc') units.push('mediamtx');
  return units;
}

// ── Pure parsers ─────────────────────────────────────────────────────────────
// Separated from I/O so they are testable without a Pi, and so a wrong bit mask fails a
// host test rather than being discovered on a rover.

// Raspberry Pi firmware throttle word. The low nibble is NOW, bits 16-19 are SINCE BOOT.
// Measured on rover1: 0xf0006 (arm capped + throttled now, all four historical bits) and
// later 0xf0008 (soft temp limit active now).
const THROTTLE_BITS = [
  { mask: 0x1,     now: true,  label: 'under-voltage' },
  { mask: 0x2,     now: true,  label: 'arm frequency capped' },
  { mask: 0x4,     now: true,  label: 'throttled' },
  { mask: 0x8,     now: true,  label: 'soft temperature limit' },
  { mask: 0x10000, now: false, label: 'under-voltage' },
  { mask: 0x20000, now: false, label: 'arm frequency capped' },
  { mask: 0x40000, now: false, label: 'throttled' },
  { mask: 0x80000, now: false, label: 'soft temperature limit' },
];

// `vcgencmd get_throttled` prints `throttled=0x0`. Returns null on anything unparseable
// rather than guessing zero — "no throttling" and "could not ask" must not look alike.
function parseThrottled(text) {
  const m = /throttled=0x([0-9a-fA-F]+)/.exec(String(text || ''));
  if (!m) return null;
  const word = parseInt(m[1], 16);
  if (!Number.isFinite(word)) return null;
  const now = [], since = [];
  for (const b of THROTTLE_BITS) {
    if ((word & b.mask) === 0) continue;
    (b.now ? now : since).push(b.label);
  }
  return {
    raw: `0x${word.toString(16)}`,
    // The single field a UI should colour on: something is being limited RIGHT NOW.
    active: now.length > 0,
    now,
    // Historical bits latch until reboot. Useful ("this box has browned out before") but
    // NOT a current condition, so they are reported separately and never set `active`.
    sinceBoot: since,
  };
}

// First line of /proc/stat: cpu user nice system idle iowait irq softirq steal ...
function parseProcStat(text) {
  const line = String(text || '').split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const cols = line.trim().split(/\s+/).slice(1).map(Number);
  if (cols.length < 4 || cols.some((n) => !Number.isFinite(n))) return null;
  const idle  = cols[3] + (cols[4] || 0);            // idle + iowait
  const total = cols.reduce((a, b) => a + b, 0);
  return { idle, total };
}

// Busy percentage between two /proc/stat samples. Needs TWO samples by construction — an
// instantaneous read cannot yield a rate, and `loadavg` is not a substitute because it is a
// 1-minute average that lags the thermal behaviour being investigated here.
function cpuBusyPct(prev, cur) {
  if (!prev || !cur) return null;
  const dTotal = cur.total - prev.total;
  const dIdle  = cur.idle  - prev.idle;
  // A counter that did not advance, or went backwards (a reboot between samples), yields
  // no answer rather than a divide-by-zero or a negative percentage.
  if (!(dTotal > 0) || dIdle < 0) return null;
  return Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10));
}

// thermal_zone*/temp is millidegrees C.
//
// The empty-string guard is load-bearing and was added because a test caught this file
// violating its own rule: `Number('')` is 0, not NaN, so an EMPTY read — a truncated sysfs
// file, a permission error swallowed upstream — was being reported as a confident 0 C.
// `null` means "could not determine"; 0 is a temperature.
function parseTempMilli(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const c = n / 1000;
  // A plausibility window, for the same reason telemetry.sh has one on battery voltage: a
  // sensor reading -40 C or 300 C is a broken sensor, and reporting it as a temperature
  // invites someone to act on it.
  if (c < -20 || c > 150) return null;
  return Math.round(c * 10) / 10;
}

// `systemctl is-active a b c` prints one state per line, in the order asked. It exits
// non-zero when ANY unit is inactive, so the exit status must be ignored and the output
// parsed — treating non-zero as failure would report every unit as unknown whenever one
// of them was legitimately stopped.
function parseUnitStates(text, units = WATCHED_UNITS) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const out = {};
  units.forEach((u, i) => { out[u] = lines[i] || null; });
  return out;
}

function parseKhz(text) {
  // Same empty-string trap as parseTempMilli: an empty read must not become 0 MHz, which
  // would look like a stopped CPU rather than an unreadable file.
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n / 1000) : null;
}

// ── The sampler ──────────────────────────────────────────────────────────────

// All I/O is injected so the whole thing is testable without a Pi, and so "it is
// asynchronous" is an assertable property rather than a comment — the same reasoning
// telemetry-loop.js gives for taking `readWifi` as a promise-returning dependency.
//
// fastMs polls the cheap sysfs reads. slowMs polls the two that SPAWN A PROCESS. They are
// separate intervals on purpose: vcgencmd and systemctl at the telemetry rate would put a
// fork on the control loop several times a second.
// Both intervals are CLAMPED, not defaulted. `fastMs = 2000` in a destructuring default only
// applies to `undefined`, so a rover-local `"host_health_fast_ms": 0` in the untracked overlay
// would become setInterval(fn, 0) — a busy loop on the control event loop. That is not
// hypothetical: app.js's own comment records the telemetry interval being measured at ~10% of
// a core from the /proc read alone when it reached 1 ms. Invariant 8 says the overlay can set
// any key with no review, so the bound belongs here rather than in the caller.
function clampMs(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, n));
}

function createHostHealth({
  readFile,
  run,                       // (cmd, args) => Promise<string>; may reject
  fastMs,
  slowMs,
  units  = WATCHED_UNITS,
} = {}) {
  // Floors chosen against what these actually cost: the fast path is four small sysfs reads,
  // the slow path forks twice.
  const fastInterval = clampMs(fastMs, 2000, 500, 60000);
  const slowInterval = clampMs(slowMs, 15000, 5000, 300000);
  let cpu       = { tempC: null, busyPct: null, freqMhz: null, maxFreqMhz: null, governor: null };
  let throttled = null;
  let services  = null;
  let lastStat  = null;
  let errors    = {};
  let stopped   = false;

  const note = (k, e) => { errors[k] = e && e.message ? e.message : String(e); };
  const clear = (k) => { delete errors[k]; };

  async function readOne(key, path, parse) {
    try {
      const v = parse(await readFile(path, 'utf8'));
      if (v === null) { note(key, new Error('unparseable')); return null; }
      clear(key);
      return v;
    } catch (e) { note(key, e); return null; }
  }

  async function pollFast() {
    if (stopped) return;
    const [tempC, statText, freq, maxFreq, gov] = await Promise.all([
      readOne('tempC', THERMAL_ZONE, parseTempMilli),
      readFile(PROC_STAT, 'utf8').then((t) => t, (e) => { note('busyPct', e); return null; }),
      readOne('freqMhz', `${CPUFREQ_DIR}/scaling_cur_freq`, parseKhz),
      readOne('maxFreqMhz', `${CPUFREQ_DIR}/scaling_max_freq`, parseKhz),
      readOne('governor', `${CPUFREQ_DIR}/scaling_governor`, (t) => String(t).trim() || null),
    ]);

    let busyPct = null;
    const cur = statText === null ? null : parseProcStat(statText);
    if (cur) {
      busyPct = cpuBusyPct(lastStat, cur);   // null on the FIRST sample, correctly
      lastStat = cur;
      clear('busyPct');
    }
    cpu = { tempC, busyPct, freqMhz: freq, maxFreqMhz: maxFreq, governor: gov };
  }

  async function pollSlow() {
    if (stopped) return;
    try {
      throttled = parseThrottled(await run('vcgencmd', ['get_throttled']));
      if (throttled === null) note('throttled', new Error('unparseable'));
      else clear('throttled');
    } catch (e) { throttled = null; note('throttled', e); }

    try {
      services = parseUnitStates(await run('systemctl', ['is-active', ...units]), units);
      if (services === null) note('services', new Error('no output'));
      else clear('services');
    } catch (e) {
      // systemctl exits non-zero when any unit is inactive, so a rejection carrying output
      // is still a usable answer. Only a rejection with nothing to parse is an error.
      const out = e && e.stdout;
      services = out ? parseUnitStates(out, units) : null;
      if (services === null) note('services', e); else clear('services');
    }
  }

  // AT MOST ONE POLL OF EACH KIND EVER IN FLIGHT, and the guard is held until the underlying
  // operation ACTUALLY SETTLES — not until a deadline expires.
  //
  // This is the second attempt. The first replaced setInterval with a deadline-and-reschedule
  // loop, and a reviewer measured it still accumulating: against a never-settling read,
  // outstanding operations grew from 5 at 0.6 s to 25 at 4.6 s. Racing a deadline ABANDONS
  // the underlying promise — Node offers no cancellation for an in-flight read — so
  // rescheduling on deadline expiry starts a replacement while the original is still pending.
  // The comment claiming "at most one in flight" was simply false.
  //
  // Why it matters: this runs in the process carrying the 20 Hz override stream and the input
  // watchdog, so unbounded file handles and child processes are an invariant 9 failure. A
  // late completion overwriting newer cache state is the second hazard, handled by the
  // generation check below.
  //
  // The deadline still exists, but it only marks the sample STALE. It never launches a
  // replacement.
  let fastTimer = null, slowTimer = null;
  const inFlight = { fastPoll: false, slowPoll: false };
  let generation = 0;

  // ONE code path for the first poll and every later one. An earlier revision had a separate
  // `startNow` that skipped the deadline, so a source wedged from the very first read was
  // never reported — the failure mode most likely on a rover that boots with a bad sensor.
  function runPoll(fn, intervalMs, deadlineMs, what, assign) {
    if (stopped) return;
    // THE BOUND IS THE RESCHEDULE POINT, not a flag. `arm()` is called ONLY from the
    // `.finally()` below, so the next poll cannot start until this one has genuinely settled.
    //
    // An earlier revision also carried an `if (inFlight[what]) ...` guard here. Mutation
    // testing showed it was UNREACHABLE — nothing can call runPoll while work is outstanding,
    // precisely because arm() is gated on settle — so deleting it changed no behaviour and
    // failed no test. Unreachable code that looks like a safety check is worse than none: it
    // invites the reader to believe the bound lives somewhere it does not.
    //
    // The accepted cost: a source that NEVER settles freezes this poller permanently. That is
    // deliberate. The alternative — rescheduling when a deadline expires — is what the
    // previous attempt did, and a reviewer measured it growing from 5 outstanding operations
    // at 0.6 s to 25 at 4.6 s, in the process that carries the override stream and the input
    // watchdog. A frozen sampler is visible (`errors` reports the stall and the values go
    // stale); an unbounded one takes the vehicle with it.
    inFlight[what] = true;
    ++generation;
    let settled = false;
    const deadline = setTimeout(() => {
      if (!settled) note(what, new Error(`exceeded ${deadlineMs} ms`));
    }, deadlineMs);
    if (typeof deadline.unref === 'function') deadline.unref();

    Promise.resolve()
      .then(() => fn())
      .catch((e) => note(what, e))
      .finally(() => {
        settled = true;
        clearTimeout(deadline);
        inFlight[what] = false;          // released only when the work truly finished
        arm(fn, intervalMs, deadlineMs, what, assign);
      });
  }

  function arm(fn, intervalMs, deadlineMs, what, assign) {
    if (stopped) return;
    const t = setTimeout(() => runPoll(fn, intervalMs, deadlineMs, what, assign), intervalMs);
    if (typeof t.unref === 'function') t.unref();
    assign(t);
  }

  runPoll(pollFast, fastInterval, Math.min(fastInterval, 5000), 'fastPoll', (t) => { fastTimer = t; });
  runPoll(pollSlow, slowInterval, 10000, 'slowPoll', (t) => { slowTimer = t; });

  // How many operations this sampler has ever started. Exposed so the BOUND is assertable
  // against a stalled dependency — the previous version's claim could not be checked, which
  // is why it stayed wrong for a round.
  function startedCount() { return generation; }

  return {
    // Synchronous cache read. Never does I/O — see the invariant 9 note at the top.
    snapshot() {
      return {
        cpu: { ...cpu },
        throttled,
        services: services ? { ...services } : null,
        errors: Object.keys(errors).length ? { ...errors } : null,
      };
    },
    // Exposed so the clamped values are assertable — a bound nothing can observe is a bound
    // nothing can test.
    intervals() { return { fastMs: fastInterval, slowMs: slowInterval }; },
    startedCount,
    stop() {
      stopped = true;
      if (fastTimer) clearTimeout(fastTimer);
      if (slowTimer) clearTimeout(slowTimer);
    },
  };
}

module.exports = {
  createHostHealth, expectedUnits,
  parseThrottled, parseProcStat, cpuBusyPct, parseTempMilli, parseUnitStates, parseKhz,
  THERMAL_ZONE, PROC_STAT, CPUFREQ_DIR, WATCHED_UNITS,
};
