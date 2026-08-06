'use strict';

// The adaptive-bitrate decision logic.
//
// It exists because rpiCameraBitrate is a fixed target the encoder holds regardless of
// conditions, and MediaMTX's rpicamera source ignores WebRTC congestion feedback. As the
// link degrades each bit costs more airtime, and because WiFi is half-duplex that starves
// the downlink the operator's COMMANDS arrive on — measured on rover3 as 61
// `no input for 1000 ms` fail-safe trips in 36 seconds, each forcing neutral and disarming.
//
// Every rule here is asymmetric or delayed for a reason, and each reason is a test:
// stepping down is urgent, stepping up is not, and every change costs the operator video.

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  createBitrateController, profileForSignal, DEFAULT_PROFILES, DEFAULTS,
} = require('../video-bitrate-controller');

const S = 1000;
// A controller with round numbers so the arithmetic in each test is obvious.
function ctl(over = {}) {
  return createBitrateController({
    downSustainMs: 5 * S, upSustainMs: 30 * S, minDwellMs: 10 * S, hysteresisDb: 4,
    ...over,
  });
}
// Feed a constant signal for a span, one sample per second, returning every change.
function feed(c, signalDbm, fromMs, toMs) {
  const changes = [];
  for (let t = fromMs; t <= toMs; t += S) {
    const r = c.sample({ signalDbm, at: t });
    if (r.change) changes.push({ at: t, name: r.change.name, reason: r.reason });
  }
  return changes;
}

// ── The ladder itself ────────────────────────────────────────────────────────

test('the shipped profile ladder is ordered and self-consistent', () => {
  // Index 0 must be the cheapest. Every decision below assumes it, so a mis-ordered table
  // would step the wrong way under load — worse than not adapting at all.
  for (let i = 1; i < DEFAULT_PROFILES.length; i++) {
    assert.ok(DEFAULT_PROFILES[i].bitrateKbps > DEFAULT_PROFILES[i - 1].bitrateKbps,
      `profile ${i} must cost more than ${i - 1}`);
    assert.ok(DEFAULT_PROFILES[i].upAtDbm > DEFAULT_PROFILES[i - 1].upAtDbm,
      `profile ${i} must require a better signal than ${i - 1}`);
  }
  assert.equal(DEFAULT_PROFILES[0].upAtDbm, -Infinity,
    'the cheapest profile must always be reachable — it is the fail-safe floor');
});

test('a mis-ordered ladder is refused at construction', () => {
  // Fail loudly rather than adapt backwards.
  const bad = [
    { name: 'a', bitrateKbps: 500, upAtDbm: -70 },
    { name: 'b', bitrateKbps: 200, upAtDbm: -60 },
  ];
  assert.throws(() => createBitrateController({ profiles: bad }), /ascending bitrateKbps/);
  assert.throws(() => createBitrateController({
    profiles: [{ name: 'a', bitrateKbps: 100, upAtDbm: -60 },
               { name: 'b', bitrateKbps: 200, upAtDbm: -70 }],
  }), /ascending upAtDbm/);
  assert.throws(() => createBitrateController({ profiles: [DEFAULT_PROFILES[0]] }),
    /at least two profiles/);
});

// ── Stepping down is urgent; stepping up is not ─────────────────────────────

test('a degraded link steps DOWN after the short sustain window', () => {
  const c = ctl({ startIndex: 3 });
  // Signal that only justifies the lowest profile.
  const early = feed(c, -85, 0, 4 * S);
  assert.deepEqual(early, [], 'must not react before the window elapses');
  const changes = feed(c, -85, 5 * S, 5 * S);
  assert.equal(changes.length, 1, 'and must react once it has');
  assert.equal(changes[0].reason, 'down');
  assert.equal(c.currentIndex(), 2, 'ONE step at a time, not straight to the bottom');
});

test('a recovered link takes far longer to step UP', () => {
  const c = ctl({ startIndex: 0 });
  // A signal good enough for the top profile.
  assert.deepEqual(feed(c, -40, 0, 29 * S), [],
    'must not step up on the down-window; recovery is not urgent');
  const changes = feed(c, -40, 30 * S, 30 * S);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].reason, 'up');
});

test('the up window is longer than the down window in the shipped defaults', () => {
  // The asymmetry is the point: a bad link is dropping commands now, a good one is not.
  assert.ok(DEFAULTS.upSustainMs > DEFAULTS.downSustainMs * 2,
    `up ${DEFAULTS.upSustainMs} must be much longer than down ${DEFAULTS.downSustainMs}`);
});

// ── Sustained means sustained ───────────────────────────────────────────────

test('a brief dip does not step down', () => {
  // The failure this prevents: one bad /proc sample, or a momentary fade as the rover
  // passes a wall, costing the operator a video interruption.
  const c = ctl({ startIndex: 3 });
  for (let t = 0; t <= 20 * S; t += S) {
    // Bad for 2 s out of every 5 — never sustained.
    const sig = (t / S) % 5 < 2 ? -85 : -40;
    const r = c.sample({ signalDbm: sig, at: t });
    assert.equal(r.change, null, `must not change at t=${t / S}s`);
  }
  assert.equal(c.currentIndex(), 3, 'and must still be at the top');
});

test('an interrupted sustain window restarts, it does not accumulate', () => {
  const c = ctl({ startIndex: 3 });
  feed(c, -85, 0, 4 * S);              // 4 s of bad, one short
  feed(c, -40, 5 * S, 5 * S);          // one good sample resets it
  // The window restarts at t=6s, so it elapses at t=11s — not t=10s. An earlier version of
  // this test asserted 10s and failed; the arithmetic was the test's, not the code's.
  assert.deepEqual(feed(c, -85, 6 * S, 10 * S), [],
    'the earlier 4 s must not count towards the new window');
  assert.equal(feed(c, -85, 11 * S, 11 * S).length, 1, 'a fresh full window does');
});

// ── Hysteresis and dwell bound the interruptions ────────────────────────────

test('a signal sitting exactly on a boundary does not oscillate', () => {
  // Each oscillation is a camera respawn, so a shared boundary would cost the operator
  // video repeatedly for no benefit.
  const c = ctl({ startIndex: 2 });
  const boundary = DEFAULT_PROFILES[2].upAtDbm;   // the threshold for the profile we are in
  let changes = 0;
  for (let t = 0; t <= 300 * S; t += S) {
    if (c.sample({ signalDbm: boundary, at: t }).change) changes += 1;
  }
  assert.equal(changes, 0,
    `a signal at exactly ${boundary} dBm must not move the ladder in either direction`);
});

test('a signal within the hysteresis margin does not step down', () => {
  // This is what the margin is FOR, and testing exactly on the boundary did not prove it:
  // there both variants agree. The margin means leaving a profile downward needs a WORSE
  // signal than entering it upward required, so a link hovering a decibel or two below the
  // entry threshold holds instead of costing the operator a camera respawn.
  const c = ctl({ startIndex: 2 });
  const entry = DEFAULT_PROFILES[2].upAtDbm;      // -62
  const inMargin = entry - 3;                     // -65: below entry, inside the 4 dB margin
  let changes = 0;
  for (let t = 0; t <= 120 * S; t += S) {
    if (c.sample({ signalDbm: inMargin, at: t }).change) changes += 1;
  }
  assert.equal(changes, 0,
    `${inMargin} dBm is within the margin of the ${entry} dBm entry threshold and must hold`);
  assert.equal(c.currentIndex(), 2);

  // Just OUTSIDE the margin must still step down, or the margin has become a deadband that
  // swallows real degradation.
  const c2 = ctl({ startIndex: 2 });
  const outside = entry - 5;                      // -67: past the 4 dB margin
  let stepped = 0;
  for (let t = 0; t <= 20 * S; t += S) {
    if (c2.sample({ signalDbm: outside, at: t }).change) stepped += 1;
  }
  assert.ok(stepped >= 1, `${outside} dBm is past the margin and must step down`);
});

test('signal noise straddling a boundary does not thrash the ladder', () => {
  // Each change is a video interruption, so a noisy link sitting near a threshold must not
  // produce a stream of them.
  const c = ctl({ startIndex: 2 });
  const entry = DEFAULT_PROFILES[2].upAtDbm;
  let changes = 0;
  for (let t = 0; t <= 300 * S; t += S) {
    const sig = entry + ((t / S) % 2 === 0 ? 1 : -1);   // ±1 dB either side
    if (c.sample({ signalDbm: sig, at: t }).change) changes += 1;
  }
  assert.equal(changes, 0, `noise of 1 dB around ${entry} produced ${changes} interruptions`);
});

test('the minimum dwell bounds how often video can be interrupted', () => {
  const c = ctl({ startIndex: 3, downSustainMs: 1 * S, minDwellMs: 10 * S });
  const changes = feed(c, -85, 0, 60 * S);
  // 60 s with a 10 s dwell can permit at most 6 changes, and the ladder is only 4 deep.
  assert.ok(changes.length <= 3, `at most 3 steps down a 4-deep ladder, got ${changes.length}`);
  for (let i = 1; i < changes.length; i++) {
    assert.ok(changes[i].at - changes[i - 1].at >= 10 * S,
      `changes ${i - 1} and ${i} are ${changes[i].at - changes[i - 1].at}ms apart, under the dwell`);
  }
  assert.equal(c.currentIndex(), 0, 'and it must still reach the bottom eventually');
});

test('a change blocked by the dwell is kept pending, not discarded', () => {
  // Discarding it would restart the whole sustain window and delay a needed step down.
  const c = ctl({ startIndex: 3, downSustainMs: 1 * S, minDwellMs: 10 * S });
  feed(c, -85, 0, 2 * S);                             // first step lands
  const r = c.sample({ signalDbm: -85, at: 3 * S });
  assert.equal(r.change, null);
  assert.equal(r.reason, 'dwell', 'must say why, so a log can explain the delay');
  assert.equal(r.pendingTarget, 0, 'and must still intend to go lower');
});

// ── Unreadable signal ──────────────────────────────────────────────────────

test('an unreadable signal falls to the LOWEST profile, after the same window', () => {
  // "I cannot measure the link" is not evidence the link is good, and the conservative
  // direction protects the command path. But requiring the window means one failed /proc
  // read cannot cost the operator video.
  for (const bad of [null, undefined, NaN, 'strong', {}]) {
    const c = ctl({ startIndex: 3 });
    assert.deepEqual(feed(c, bad, 0, 4 * S), [], `${JSON.stringify(bad) ?? 'undefined'}: not immediate`);
    assert.equal(feed(c, bad, 5 * S, 5 * S).length, 1, 'but it does step down');
  }
});

test('profileForSignal maps a signal to a profile without history', () => {
  const p = DEFAULT_PROFILES;
  assert.equal(profileForSignal(p, -40, 4, 0), 3, 'a strong signal justifies the top');
  assert.equal(profileForSignal(p, -95, 4, 3), 0, 'a dead link justifies the floor');
  assert.equal(profileForSignal(p, null, 4, 3), 0, 'and so does an unreadable one');
});

// ── Contract ───────────────────────────────────────────────────────────────

test('a sample without a usable timestamp is refused', () => {
  // Silently treating a missing clock as 0 would make every window elapse instantly.
  const c = ctl();
  for (const at of [undefined, null, NaN, 'now']) {
    assert.throws(() => c.sample({ signalDbm: -40, at }), /finite timestamp/);
  }
});

test('the controller starts at the top only when asked', () => {
  // Defaulting to the best profile would offer maximum bitrate on every boot until the
  // first window elapsed — the opposite of conservative.
  assert.equal(ctl({ startIndex: 0 }).currentIndex(), 0);
  assert.equal(ctl({ startIndex: 1 }).currentIndex(), 1);
  assert.equal(ctl({ startIndex: 99 }).currentIndex(), DEFAULT_PROFILES.length - 1,
    'an out-of-range start is clamped, not thrown');
  assert.equal(ctl({ startIndex: -5 }).currentIndex(), 0);
});

test('a returned change carries everything the sink needs to apply it', () => {
  const c = ctl({ startIndex: 3, downSustainMs: 1 * S });
  const changes = feed(c, -85, 0, 2 * S);
  assert.equal(changes.length, 1);
  const p = c.current();
  for (const k of ['name', 'bitrateKbps', 'width', 'height', 'fps']) {
    assert.ok(p[k] !== undefined, `a profile must carry ${k}`);
  }
});
