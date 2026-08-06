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

function stubStream() {
  const calls = [];
  return {
    calls,
    setParamsNoRestart(p) {
      calls.push(p);
      return Promise.resolve({ applied: p, rejected: [], restarted: false });
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

test('a stream that cannot change bitrate without a restart is refused, not faked', () => {
  for (const s of [undefined, null, {}, { setParams: () => {} }]) {
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

test('a sustained weak signal steps down and applies it', async () => {
  const stream = stubStream();
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: BASE, stream, log: quiet, now: () => t, minApplyIntervalMs: 0 });
  // Well past the 8 s down-sustain window.
  for (let i = 0; i < 20; i++) { t += 1000; a.onTelemetry({ wifi: { signalDbm: -80 } }); }
  await new Promise((r) => setImmediate(r));
  assert.equal(stream.calls.length, 1, 'exactly one rung should be applied per decision');
  assert.deepEqual(stream.calls[0], { width: 320, height: 240, fps: 10, bitrate: 160 });
});

test('a strong signal applies nothing at all', async () => {
  const stream = stubStream();
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: BASE, stream, log: quiet, now: () => t, minApplyIntervalMs: 0 });
  for (let i = 0; i < 60; i++) { t += 1000; a.onTelemetry({ wifi: { signalDbm: -35 } }); }
  await new Promise((r) => setImmediate(r));
  assert.equal(stream.calls.length, 0,
    'already at the configured ceiling — every apply costs a camera respawn');
});

// An unreadable signal must not read as a good link, but must also not react to one bad
// /proc read. The controller enforces the window; this proves the wiring passes null through
// rather than coercing it to a number.
test('a missing wifi reading is passed through as null, not as 0 dBm', async () => {
  const stream = stubStream();
  let t = 0;
  const a = buildAdaptiveBitrate({
    config: BASE, stream, log: quiet, now: () => t, minApplyIntervalMs: 0 });
  t += 1000;
  a.onTelemetry({ wifi: null });
  await new Promise((r) => setImmediate(r));
  // 0 dBm would be the strongest possible signal and would hold at the ceiling forever.
  assert.equal(stream.calls.length, 0, 'one unreadable sample must not change anything yet');
  for (let i = 0; i < 20; i++) { t += 1000; a.onTelemetry({}); }
  await new Promise((r) => setImmediate(r));
  assert.equal(stream.calls.length, 1, 'a SUSTAINED unreadable signal must step down');
  assert.ok(stream.calls[0].bitrate < 200);
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
