'use strict';

// The adaptive-bitrate WIRING, not the decision logic (that is
// video-bitrate-controller.test.js) and not the apply path (video-bitrate-sink.test.js).
//
// This file exists because the wiring is where this repo's defects live. Across eight review
// rounds the dominant shape has been "a correct rule with an untouched consumer", and two
// adversarial reviews on 2026-08-06 found it again. `app.js` has no test file, so anything
// left inline there is unverifiable — hence buildAdaptiveBitrate() and the onTick forwarding
// in buildTelemetryWiring(), both driven here.
//
// The properties that matter most are the REFUSALS. A silent no-op that looks active is
// worse than an obvious failure, and three of the four paths through buildAdaptiveBitrate
// return null.

const test   = require('node:test');
const assert = require('node:assert');
const { buildAdaptiveBitrate, createAdaptiveBitrate } = require('../video-adaptive-bitrate');
const { buildLadder, LADDER_STEPS, MIN_LADDER_FPS } = require('../video-bitrate-controller');

const BASE = { webrtc_width: 320, webrtc_height: 240, webrtc_fps: 10, webrtc_bitrate_kbps: 200 };
const quiet = () => {};

// Both entry points, recorded separately, because the whole point of the apply modes is
// WHICH one gets called — and observe mode must call neither.
function stubStream() {
  const noRestart = [];
  const restart = [];
  return {
    noRestart,
    restart,
    setParamsNoRestart(p) {
      noRestart.push(p);
      return Promise.resolve({ applied: p, rejected: [], restarted: false });
    },
    setParams(p) {
      restart.push(p);
      return { applied: p, rejected: [], restarted: true };
    },
  };
}

// ── The ladder is a ceiling, never a raise ───────────────────────────────────

test('the ladder never exceeds the configured bitrate', () => {
  const rungs = buildLadder({ width: 320, height: 240, fps: 10, bitrateKbps: 200 });
  const top = Math.max(...rungs.map((r) => r.bitrateKbps));
  assert.equal(top, 200,
    'adaptation must only ever REDUCE offered load — raising it above the tracked config ' +
    'would add load to a link that is already failing, and nothing else on this platform ' +
    'responds to congestion');
  assert.ok(rungs.every((r) => r.bitrateKbps <= 200));
});

test('resolution is identical on every rung', () => {
  const rungs = buildLadder({ width: 320, height: 240, fps: 10, bitrateKbps: 200 });
  assert.equal(new Set(rungs.map((r) => `${r.width}x${r.height}`)).size, 1,
    'a resolution change forces the browser decoder to reconfigure on top of the camera ' +
    'respawn — a second, independent hitch for no benefit');
});

test('the ladder ascends strictly in bitrate and threshold', () => {
  const rungs = buildLadder({ width: 640, height: 480, fps: 30, bitrateKbps: 900 });
  for (let i = 1; i < rungs.length; i++) {
    assert.ok(rungs[i].bitrateKbps > rungs[i - 1].bitrateKbps,
      `rung ${i} bitrate must exceed rung ${i - 1}`);
    assert.ok(rungs[i].upAtDbm > rungs[i - 1].upAtDbm,
      `rung ${i} threshold must exceed rung ${i - 1}`);
  }
  assert.equal(rungs.length, LADDER_STEPS.length);
});

test('frame rate never falls below the floor', () => {
  const rungs = buildLadder({ width: 320, height: 240, fps: 5, bitrateKbps: 400 });
  assert.ok(rungs.every((r) => r.fps >= MIN_LADDER_FPS),
    `a rung below ${MIN_LADDER_FPS} fps is not usable video`);
});

// A baseline low enough to collapse two rungs onto one bitrate must be refused loudly. The
// controller would otherwise throw its generic ordering error, which names neither cause.
test('a baseline too low to build a ladder throws, naming the cause', () => {
  assert.throws(() => buildLadder({ width: 320, height: 240, fps: 10, bitrateKbps: 3 }),
    (err) => err instanceof RangeError && /too low to build a ladder/.test(err.message));
});

test('a non-positive or non-finite baseline field throws', () => {
  for (const bad of [{ bitrateKbps: 0 }, { bitrateKbps: NaN }, { fps: -1 }, { width: Infinity }]) {
    assert.throws(
      () => buildLadder({ width: 320, height: 240, fps: 10, bitrateKbps: 200, ...bad }),
      TypeError, `expected a TypeError for ${JSON.stringify(bad)}`);
  }
});

// ── The refusals ─────────────────────────────────────────────────────────────

test('adaptation is opt-OUT: absent config still runs it', () => {
  assert.notEqual(buildAdaptiveBitrate({ config: BASE, stream: stubStream(), log: quiet }), null,
    'the whole point is that a degrading link is handled without anyone enabling anything');
});

test('video_adaptive_bitrate: false disables it', () => {
  assert.equal(
    buildAdaptiveBitrate({ config: { ...BASE, video_adaptive_bitrate: false }, stream: stubStream(), log: quiet }),
    null);
});

// Only `false` disables. A truthy-ish or absent value must not silently switch it off, since
// the untracked overlay is hand-edited.
test('only literal false disables it', () => {
  for (const v of [true, 0, '', null, undefined, 'false']) {
    assert.notEqual(
      buildAdaptiveBitrate({ config: { ...BASE, video_adaptive_bitrate: v }, stream: stubStream(), log: quiet }),
      null, `video_adaptive_bitrate=${JSON.stringify(v)} must not disable adaptation`);
  }
});

test('a stream that cannot change camera params at all is refused, not faked', () => {
  for (const s of [undefined, null, {}, { getStreamConfig: () => ({}) }]) {
    assert.equal(buildAdaptiveBitrate({ config: BASE, stream: s, log: quiet }), null,
      'h264 and mjpeg spawn rpicam-vid themselves; pretending to adapt would be a lie');
  }
});

test('an unbuildable ladder is refused rather than crashing picar', () => {
  const r = buildAdaptiveBitrate({
    config: { ...BASE, webrtc_bitrate_kbps: 3 }, stream: stubStream(), log: quiet });
  assert.equal(r, null, 'a bad ladder must be a logged no-op, not an exception at require time');
});

test('the refusal is logged in every case — a silent no-op looks like it is working', () => {
  for (const args of [
    { config: { ...BASE, video_adaptive_bitrate: false }, stream: stubStream() },
    { config: BASE, stream: {} },
    { config: { ...BASE, webrtc_bitrate_kbps: 3 }, stream: stubStream() },
  ]) {
    const lines = [];
    buildAdaptiveBitrate({ ...args, log: (...m) => lines.push(m.join(' ')) });
    assert.ok(lines.length > 0, 'every refusal path must say so');
    assert.match(lines.join('\n'), /video-adaptive/);
  }
})

// ── Behaviour on the tick ────────────────────────────────────────────────────

// OBSERVE IS THE DEFAULT, and it must apply NOTHING. Writing mediamtx.yml does not reach the
// encoder — measured on rover3, the mtxrpicam child kept its PID 40 s after the write — so a
// mode that called setParamsNoRestart would report a step it did not take.
test('the default mode decides a step but applies nothing', async () => {
  const stream = stubStream();
  const lines = [];
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: BASE, stream, log: (...m) => lines.push(m.join(' ')), now: () => t,
    minApplyIntervalMs: 0 });
  for (let i = 0; i < 20; i++) { t += 1000; a.onTelemetry({ wifi: { signalDbm: -80 } }); }
  await new Promise((r) => setImmediate(r));
  assert.equal(stream.noRestart.length, 0,
    'writing the yml does not reach the encoder, so calling it would be a no-op that lies');
  assert.equal(stream.restart.length, 0, 'observe mode must not restart mediamtx either');
  assert.match(lines.join('\n'), /OBSERVE ONLY/,
    'the decision must still be logged — that log IS the deliverable in observe mode, since ' +
    'it is the data needed to fit the dBm thresholds');
  assert.match(lines.join('\n'), /would apply 320x240@10 160kbps/);
  assert.equal(a.state().lastApplied, null, 'nothing was applied, so nothing may be recorded as applied');
});

test("apply='restart' routes to setParams, the only mechanism proven to reach the encoder", async () => {
  const stream = stubStream();
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: { ...BASE, video_adaptive_apply: 'restart' }, stream, log: quiet,
    now: () => t, minApplyIntervalMs: 0 });
  for (let i = 0; i < 20; i++) { t += 1000; a.onTelemetry({ wifi: { signalDbm: -80 } }); }
  await new Promise((r) => setImmediate(r));
  assert.equal(stream.restart.length, 1, 'exactly one rung applied per decision');
  assert.deepEqual(stream.restart[0], { width: 320, height: 240, fps: 10, bitrate: 160 });
  assert.equal(stream.noRestart.length, 0, 'the yml-only path must not be used — it does not work');
});

// Only the exact string opts in. A typo must land on the safe mode, not on a mode that drops
// the operator's video session on every step.
test("only the exact string 'restart' selects the restarting mode", async () => {
  for (const v of ['Restart', 'RESTART', true, 1, 'yes', 'observe', undefined]) {
    const stream = stubStream();
    let t = 0;
    const a = buildAdaptiveBitrate({
      config: { ...BASE, video_adaptive_apply: v }, stream, log: quiet,
      now: () => t, minApplyIntervalMs: 0 });
    for (let i = 0; i < 20; i++) { t += 1000; a.onTelemetry({ wifi: { signalDbm: -80 } }); }
    await new Promise((r) => setImmediate(r));
    assert.equal(stream.restart.length, 0,
      `video_adaptive_apply=${JSON.stringify(v)} must NOT restart mediamtx`);
  }
});

test('a strong signal applies nothing at all', async () => {
  const stream = stubStream();
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: BASE, stream, log: quiet, now: () => t, minApplyIntervalMs: 0 });
  for (let i = 0; i < 60; i++) { t += 1000; a.onTelemetry({ wifi: { signalDbm: -35 } }); }
  await new Promise((r) => setImmediate(r));
  assert.equal(stream.noRestart.length + stream.restart.length, 0,
    'already at the configured ceiling — every apply costs a camera respawn');
});

// An unreadable signal must not read as a good link, but must also not react to one bad
// /proc read. The controller enforces the window; this proves the wiring passes null through
// rather than coercing it to a number.
test('a missing wifi reading is passed through as null, not as 0 dBm', async () => {
  const stream = stubStream();
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: { ...BASE, video_adaptive_apply: 'restart' }, stream, log: quiet,
    now: () => t, minApplyIntervalMs: 0 });
  t += 1000;
  a.onTelemetry({ wifi: null });
  await new Promise((r) => setImmediate(r));
  // 0 dBm would be the strongest possible signal and would hold at the ceiling forever.
  assert.equal(stream.restart.length, 0, 'one unreadable sample must not change anything yet');
  assert.equal(a.state().current.bitrateKbps, 200, 'still at the ceiling after one bad read');
  for (let i = 0; i < 20; i++) { t += 1000; a.onTelemetry({}); }
  await new Promise((r) => setImmediate(r));
  assert.equal(stream.restart.length, 1, 'a SUSTAINED unreadable signal must step down');
  assert.ok(stream.restart[0].bitrate < 200);
});

// ── It must never throw into the telemetry tick ──────────────────────────────

test('a throwing controller cannot escape into the caller', () => {
  const a = createAdaptiveBitrate({
    controller: { sample() { throw new Error('boom'); }, current: () => ({}), currentIndex: () => 0 },
    sink: { applyProfile: () => Promise.resolve({ applied: true }) },
    log: quiet,
  });
  assert.doesNotThrow(() => a.onTelemetry({ wifi: { signalDbm: -60 } }),
    'this runs inside the telemetry tick, which also sets the fleet battery bit and ' +
    'broadcasts telemetry — an escape would take both down, and the process with them');
  assert.equal(a.state().applyErrors, 1, 'the failure must be counted, not just swallowed');
});

test('a rejecting sink cannot become an unhandled rejection', async () => {
  const a = createAdaptiveBitrate({
    controller: {
      sample: () => ({ change: { name: 'x', width: 1, height: 1, fps: 1, bitrateKbps: 1 }, reason: 'down' }),
      current: () => ({}), currentIndex: () => 0,
    },
    sink: { applyProfile: () => Promise.reject(new Error('nope')) },
    log: quiet,
  });
  a.onTelemetry({ wifi: { signalDbm: -90 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(a.state().applyErrors, 1);
});

test('a sink that reports not-applied is recorded as a failure, not a success', async () => {
  const a = createAdaptiveBitrate({
    controller: {
      sample: () => ({ change: { name: 'x', width: 1, height: 1, fps: 1, bitrateKbps: 1 }, reason: 'down' }),
      current: () => ({}), currentIndex: () => 0,
    },
    sink: { applyProfile: () => Promise.resolve({ applied: false, reason: 'too soon' }) },
    log: quiet,
  });
  a.onTelemetry({ wifi: { signalDbm: -90 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(a.state().applyErrors, 1);
  assert.equal(a.state().lastApplied, null,
    'reporting an unapplied change as applied is the lie that cost a debugging round already');
});

test('constructing without a controller or sink throws immediately', () => {
  assert.throws(() => createAdaptiveBitrate({ sink: { applyProfile() {} } }), TypeError);
  assert.throws(() => createAdaptiveBitrate({ controller: { sample() {} } }), TypeError);
});

// ── The trace, which is the deliverable of an observe-mode drive ──────────────

test('a periodic trace is emitted even when nothing ever steps', () => {
  const lines = [];
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: BASE, stream: stubStream(), log: (...m) => lines.push(m.join(' ')),
    now: () => t, minApplyIntervalMs: 0 });
  // A strong, steady signal: the controller holds at the ceiling and decides nothing.
  for (let i = 0; i < 12; i++) { t += 2000; a.onTelemetry({ wifi: { signalDbm: -41 } }); }
  const traces = lines.filter((l) => /trace signal=/.test(l));
  assert.ok(traces.length >= 4,
    'without a trace an observe run that never steps produces NO data, and fitting the dBm ' +
    `thresholds becomes guesswork again — got ${traces.length} trace lines`);
  assert.match(traces[0], /signal=-41dBm/);
  assert.match(traces[0], /rung=full\(200k@10\)/);
});

test('the trace records an unreadable signal as such, not as a number', () => {
  const lines = [];
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: BASE, stream: stubStream(), log: (...m) => lines.push(m.join(' ')),
    now: () => t, minApplyIntervalMs: 0 });
  t += 6000;
  a.onTelemetry({ wifi: null });
  assert.match(lines.filter((l) => /trace/.test(l)).join('\n'), /signal=unreadable/,
    'a missing reading must be distinguishable in the log from a strong one');
});

test('the trace names what the controller is leaning towards', () => {
  const lines = [];
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: BASE, stream: stubStream(), log: (...m) => lines.push(m.join(' ')),
    now: () => t, minApplyIntervalMs: 0 });
  // Below 'full' but above 'low': a step is pending but the sustain window has not elapsed.
  t += 6000; a.onTelemetry({ wifi: { signalDbm: -68 } });
  t += 6000; a.onTelemetry({ wifi: { signalDbm: -68 } });
  const traces = lines.filter((l) => /trace/.test(l));
  assert.match(traces.join('\n'), /pending=medium/,
    'the pending target is what tells us whether a threshold was nearly crossed — the most ' +
    'useful signal for deciding they are too pessimistic');
});

// A truthy-but-empty applied set must not read as a successful step.
test('an empty applied set is not a successful step', async () => {
  const a = createAdaptiveBitrate({
    controller: {
      sample: () => ({ change: { name: 'x', width: 1, height: 1, fps: 1, bitrateKbps: 1 }, reason: 'down' }),
      current: () => ({ name: 'x', bitrateKbps: 1, fps: 1 }), currentIndex: () => 0, profiles: [],
    },
    sink: { applyProfile: () => Promise.resolve({ applied: {} }) },
    log: quiet,
    traceEveryMs: 0,
  });
  a.onTelemetry({ wifi: { signalDbm: -90 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(a.state().lastApplied, null,
    '{applied: {}} is truthy but means nothing was applied');
  assert.equal(a.state().applyErrors, 1);
});

// ── Retry rate and tx bitrate in the trace ───────────────────────────────────
//
// dBm alone could not explain the 2026-08-06 freeze: it happened at −67 dBm on a link whose
// nominal tx rate was 72 Mbit/s. These two fields separate the hypotheses — retries/s measures
// airtime burned on retransmission, tx bitrate measures MCS collapse.

test('the trace reports retries as a RATE, differenced from the cumulative counter', () => {
  const lines = [];
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: BASE, stream: stubStream(), log: (...m) => lines.push(m.join(' ')),
    now: () => t, minApplyIntervalMs: 0, readTxBitrate: () => Promise.resolve(null) });
  // First trace has no previous sample to difference against.
  t += 6000; a.onTelemetry({ wifi: { signalDbm: -50, retries: 1000 } });
  // 60 more retries over 6 s = 10/s.
  t += 6000; a.onTelemetry({ wifi: { signalDbm: -50, retries: 1060 } });
  const traces = lines.filter((l) => /trace/.test(l));
  assert.match(traces[0], /retries=n\/a/, 'the first sample has nothing to difference against');
  assert.match(traces[1], /retries=10\.0\/s/,
    'a cumulative counter means nothing at a glance; the rate is the diagnostic');
});

test('a retry counter that resets is reported as such, not as a negative rate', () => {
  const lines = [];
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: BASE, stream: stubStream(), log: (...m) => lines.push(m.join(' ')),
    now: () => t, minApplyIntervalMs: 0, readTxBitrate: () => Promise.resolve(null) });
  t += 6000; a.onTelemetry({ wifi: { signalDbm: -50, retries: 5000 } });
  t += 6000; a.onTelemetry({ wifi: { signalDbm: -50, retries: 12 } });   // interface reinit
  assert.match(lines.filter((l) => /trace/.test(l))[1], /retries=reset/,
    'an interface reinit must not print a nonsensical negative rate');
});

test('a missing retry field degrades to n/a rather than NaN', () => {
  const lines = [];
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: BASE, stream: stubStream(), log: (...m) => lines.push(m.join(' ')),
    now: () => t, minApplyIntervalMs: 0, readTxBitrate: () => Promise.resolve(null) });
  t += 6000; a.onTelemetry({ wifi: { signalDbm: -50 } });
  t += 6000; a.onTelemetry({ wifi: { signalDbm: -50 } });
  assert.doesNotMatch(lines.join('\n'), /NaN/, 'NaN in a log poisons any later arithmetic on it');
});

test('the tx bitrate appears once the reader has resolved, and n/a until then', async () => {
  const lines = [];
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: BASE, stream: stubStream(), log: (...m) => lines.push(m.join(' ')),
    now: () => t, minApplyIntervalMs: 0,
    readTxBitrate: () => Promise.resolve('72.2MBit/s') });
  t += 6000; a.onTelemetry({ wifi: { signalDbm: -50, retries: 1 } });
  await new Promise((r) => setImmediate(r));
  t += 6000; a.onTelemetry({ wifi: { signalDbm: -50, retries: 2 } });
  const traces = lines.filter((l) => /trace/.test(l));
  assert.match(traces[0], /tx=n\/a/, 'the first trace fires before any read has resolved');
  assert.match(traces[1], /tx=72\.2MBit\/s/);
});

// The reader runs a subprocess on the box that also runs the fail-safe. It must never reject,
// never throw, and never let a failure masquerade as a reading.
test('a failing tx-bitrate reader never breaks the trace and never invents a value', async () => {
  for (const bad of [() => Promise.reject(new Error('no iw')),
                     () => { throw new Error('spawn failed'); },
                     () => Promise.resolve(undefined),
                     () => Promise.resolve(''),
                     () => Promise.resolve(42)]) {
    const lines = [];
    let t = 0;
    const a = buildAdaptiveBitrate({
      config: BASE, stream: stubStream(), log: (...m) => lines.push(m.join(' ')),
      now: () => t, minApplyIntervalMs: 0, readTxBitrate: bad });
    t += 6000;
    assert.doesNotThrow(() => a.onTelemetry({ wifi: { signalDbm: -50, retries: 1 } }));
    await new Promise((r) => setImmediate(r));
    t += 6000;
    assert.doesNotThrow(() => a.onTelemetry({ wifi: { signalDbm: -50, retries: 2 } }));
    assert.match(lines.filter((l) => /trace/.test(l))[1], /tx=n\/a/,
      'an unavailable tx rate must read as n/a, never as a stale or fabricated number');
  }
});
