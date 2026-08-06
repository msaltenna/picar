'use strict';

// Applying a bitrate profile to the running encoder.
//
// Applying costs a camera respawn — roughly 1-2 s with no video, at exactly the moment
// the link is worst and the operator most needs to see where the rover is. Everything in
// this file bounds that cost or proves the sink reports honestly when a change did not
// happen.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { createBitrateSink } = require('../video-bitrate-sink');

const P = (name, kbps) => ({ name, bitrateKbps: kbps, width: 320, height: 240, fps: 12 });

// A controllable clock, so intervals are exercised without waiting on them.
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function sink({ applyImpl, minApplyIntervalMs = 5000, start = 0 } = {}) {
  const c = clock(start);
  const calls = [];
  const logs = [];
  const s = createBitrateSink({
    apply: applyImpl || (async (p) => { calls.push(p); return { applied: { ...p } }; }),
    minApplyIntervalMs,
    now: c.now,
    log: (m) => logs.push(m),
  });
  return { s, c, calls, logs };
}

// ── The happy path ──────────────────────────────────────────────────────────

test('a profile is applied and reported', async () => {
  const { s, calls } = sink();
  const r = await s.applyProfile(P('low', 200));
  assert.equal(r.applied, true, r.reason);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { width: 320, height: 240, fps: 12, bitrate: 200 },
    'the sink must translate bitrateKbps to the driver\'s `bitrate` field');
  assert.equal(s.lastApplied().name, 'low');
});

test('it refuses to apply nothing', async () => {
  const { s, calls } = sink();
  for (const bad of [null, undefined, 'low', 42]) {
    const r = await s.applyProfile(bad);
    assert.equal(r.applied, false, `${JSON.stringify(bad) ?? 'undefined'} must be refused`);
  }
  assert.equal(calls.length, 0);
});

// ── Failure must be reported, never assumed ─────────────────────────────────

test('a throwing apply is reported, not propagated', async () => {
  // This runs on the control event loop. An unhandled rejection here would reach the crash
  // fail-safe — which exists, but relying on it for an ordinary video failure is backwards.
  const { s } = sink({ applyImpl: async () => { throw new Error('ENOSPC'); } });
  const r = await s.applyProfile(P('low', 200));
  assert.equal(r.applied, false);
  assert.match(r.reason, /apply threw: ENOSPC/);
  assert.equal(s.lastApplied(), null, 'a failed apply must not be recorded as applied');
});

test('an apply that reports an error is a failure', async () => {
  const { s } = sink({ applyImpl: async () => ({ applied: {}, error: 'EACCES' }) });
  const r = await s.applyProfile(P('low', 200));
  assert.equal(r.applied, false);
  assert.match(r.reason, /EACCES/);
});

test('an apply that reports NOTHING applied is a failure, not a success', async () => {
  // The driver returns {applied:{}} when it rejected every value. Treating that as success
  // is the specific lie this project has already paid for twice: a UI reporting settings as
  // applied when they were not.
  const { s } = sink({ applyImpl: async () => ({ applied: {} }) });
  const r = await s.applyProfile(P('low', 200));
  assert.equal(r.applied, false);
  assert.match(r.reason, /nothing applied/);
  assert.equal(s.lastApplied(), null);
});

// ── Serialisation: two writes must never overlap ────────────────────────────

test('a second apply during an in-flight one does not run concurrently', async () => {
  // Two concurrent writes would interleave into a malformed yml, and MediaMTX reloads
  // whatever it finds. This is the same class of defect as the overlay corruption that
  // bricked a rover earlier in this project.
  let concurrent = 0, maxConcurrent = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { s } = sink({
    applyImpl: async (p) => {
      concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gate;
      concurrent -= 1;
      return { applied: { ...p } };
    },
    minApplyIntervalMs: 0,
  });

  const first = s.applyProfile(P('low', 200));
  const second = await s.applyProfile(P('medium', 400));   // resolves immediately as queued
  assert.equal(second.applied, false);
  assert.match(second.reason, /queued/);
  release();
  await first;
  assert.equal(maxConcurrent, 1, 'two applies must never be in flight at once');
});

test('only the LATEST queued profile is applied, not every intermediate rung', async () => {
  // An intermediate rung is stale by the time it would land. Applying it would spend a
  // camera respawn on a level already superseded.
  let release;
  const gate = new Promise((r) => { release = r; });
  const { s, calls, logs } = sink({
    applyImpl: async (p) => { if (calls.length === 0) { calls.push(p); await gate; return { applied: { ...p } }; }
                              calls.push(p); return { applied: { ...p } }; },
    minApplyIntervalMs: 0,
  });
  const first = s.applyProfile(P('high', 800));
  await s.applyProfile(P('medium', 400));
  await s.applyProfile(P('low', 200));
  release();
  await first;
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 2, `expected the first and the latest only, got ${calls.length}`);
  assert.equal(calls[1].bitrate, 200, 'the latest queued profile must be the one applied');
  assert.ok(logs.some((l) => /superseded/.test(l)), 'and the drop must be logged');
});

// ── The minimum interval bounds interruptions ─────────────────────────────

test('an apply inside the minimum interval is refused', async () => {
  const { s, c, calls } = sink({ minApplyIntervalMs: 5000 });
  assert.equal((await s.applyProfile(P('low', 200))).applied, true);
  c.advance(1000);
  const r = await s.applyProfile(P('medium', 400));
  assert.equal(r.applied, false);
  assert.match(r.reason, /too soon/);
  assert.equal(calls.length, 1, 'the driver must not be called at all');
});

test('an apply after the interval is allowed', async () => {
  const { s, c, calls } = sink({ minApplyIntervalMs: 5000 });
  await s.applyProfile(P('low', 200));
  c.advance(5000);
  assert.equal((await s.applyProfile(P('medium', 400))).applied, true);
  assert.equal(calls.length, 2);
});

test('the interval is measured from the last SUCCESS, not the last attempt', async () => {
  // Otherwise a run of failures would lock out the retry that might succeed.
  let failNext = true;
  const { s, c } = sink({
    applyImpl: async (p) => {
      if (failNext) { failNext = false; throw new Error('transient'); }
      return { applied: { ...p } };
    },
    minApplyIntervalMs: 5000,
  });
  assert.equal((await s.applyProfile(P('low', 200))).applied, false);
  c.advance(10);
  assert.equal((await s.applyProfile(P('low', 200))).applied, true,
    'a failed attempt must not start the interval clock');
});

test('a queued profile still cannot bypass the minimum interval', async () => {
  // The queue drains after the in-flight apply completes, which is exactly when a naive
  // implementation would let it through unchecked.
  let release;
  const gate = new Promise((r) => { release = r; });
  const { s, calls, c, logs } = sink({
    applyImpl: async (p) => { calls.push(p); if (calls.length === 1) await gate; return { applied: { ...p } }; },
    minApplyIntervalMs: 5000,
  });
  const first = s.applyProfile(P('high', 800));
  await s.applyProfile(P('low', 200));
  release();
  await first;
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1, 'the queued apply must be dropped, not run inside the interval');
  assert.ok(logs.some((l) => /dropped queued/.test(l)), 'and the drop must be visible');
  c.advance(5000);
  assert.equal((await s.applyProfile(P('low', 200))).applied, true, 'and it works once the interval passes');
});

// ── Contract ───────────────────────────────────────────────────────────────

test('it refuses to construct without an apply function', () => {
  // A no-op sink would look like adaptation and provide none.
  assert.throws(() => createBitrateSink({}), /requires an apply function/);
  assert.throws(() => createBitrateSink({ apply: 'yes' }), /requires an apply function/);
});

test('a throwing logger cannot break an apply', async () => {
  const { s } = sink();
  const bad = createBitrateSink({
    apply: async (p) => ({ applied: { ...p } }),
    log: () => { throw new Error('log broke'); },
    now: () => 0,
  });
  assert.equal((await bad.applyProfile(P('low', 200))).applied, true);
});

// ── The driver path it is built for ────────────────────────────────────────

test('the webrtc driver can apply params without restarting mediamtx', async () => {
  // Mechanism 1 end to end against the real driver: the yml is rewritten and NOTHING is
  // spawned. MediaMTX reloads the file itself, which is a camera respawn rather than a
  // service restart — the cheaper path, and the reason this sink exists.
  const os   = require('os');
  const fs   = require('fs');
  const path = require('path');
  const makeWebrtc = require('../streams/webrtc.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picar-sink-'));
  const yml = path.join(dir, 'mediamtx.yml');
  // A canary the restart would touch. `spawned` used to be a local counter nothing ever
  // incremented, so `assert.equal(spawned, 0)` was vacuous — it passed whether or not a
  // restart happened. This asserts the real thing.
  const canary = path.join(dir, 'restart-ran');
  const stream = makeWebrtc({ mediamtx_yml: yml },
    { restartCmd: ['touch', canary] });
  try {
    const s = createBitrateSink({
      apply: (p) => stream.setParamsNoRestart(p),
      minApplyIntervalMs: 0,
      now: () => 0,
      log: () => {},
    });
    const r = await s.applyProfile(P('low', 200));
    assert.equal(r.applied, true, r.reason);
    const written = fs.readFileSync(yml, 'utf8');
    assert.match(written, /rpiCameraBitrate: 200000/, 'the new bitrate must reach the yml');
    assert.match(written, /rpiCameraWidth: 320/);
    assert.equal(stream.getStreamConfig().bitrate, 200,
      'and the effective config must report it');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(fs.existsSync(canary), false,
      'setParamsNoRestart must NOT restart the service — MediaMTX reloads the file itself, ' +
      'and a restart is a strictly larger interruption than the free reload');

    // And the UI path, for contrast, DOES restart — so the assertion above is measuring
    // something rather than passing because the canary never fires.
    stream.setParams({ bitrate: 300 });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(fs.existsSync(canary), true,
      'the UI path restarts, which is what makes the no-restart path distinguishable');
  } finally {
    if (typeof stream.stop === 'function') stream.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setParamsNoRestart refuses invalid values rather than writing them', async () => {
  const os   = require('os');
  const fs   = require('fs');
  const path = require('path');
  const makeWebrtc = require('../streams/webrtc.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picar-sink-'));
  const yml = path.join(dir, 'mediamtx.yml');
  const stream = makeWebrtc({ mediamtx_yml: yml }, { restartCmd: ['true'] });
  try {
    const before = fs.readFileSync(yml, 'utf8');
    const r = await stream.setParamsNoRestart({ bitrate: 99999, fps: 'fast' });
    assert.deepEqual(r.applied, {}, 'nothing invalid may be applied');
    assert.ok(r.rejected.length >= 2);
    assert.equal(fs.readFileSync(yml, 'utf8'), before, 'and the yml must be untouched');
  } finally {
    if (typeof stream.stop === 'function') stream.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the runtime yml write is asynchronous, never writeFileSync', async () => {
  // Invariant 9. Adaptive bitrate rewrites this file while the vehicle is driving, on the
  // same event loop as the 20 Hz override stream and the fail-safe timers. A mutation
  // swapping the async write for fs.writeFileSync survived the entire suite until this
  // test existed — the comment saying "async on purpose" was doing no work.
  const os   = require('os');
  const realFs = require('fs');
  const path = require('path');
  const makeWebrtc = require('../streams/webrtc.js');

  const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'picar-async-'));
  const yml = path.join(dir, 'mediamtx.yml');
  let syncWrites = 0;
  let asyncWrites = 0;
  const spy = {
    ...realFs,
    writeFileSync: (...a) => { syncWrites += 1; return realFs.writeFileSync(...a); },
    promises: {
      ...realFs.promises,
      writeFile: (...a) => { asyncWrites += 1; return realFs.promises.writeFile(...a); },
    },
  };
  const stream = makeWebrtc({ mediamtx_yml: yml }, { restartCmd: ['true'], fs: spy });
  try {
    // Startup is allowed to be synchronous — it runs once, before the control loops exist.
    const syncAtStartup = syncWrites;
    await stream.setParamsNoRestart({ bitrate: 200, width: 320, height: 240, fps: 12 });
    assert.equal(asyncWrites, 1, 'the runtime write must go through fs.promises.writeFile');
    assert.equal(syncWrites, syncAtStartup,
      'the runtime path must not add a synchronous write on the control event loop');
  } finally {
    if (typeof stream.stop === 'function') stream.stop();
    realFs.rmSync(dir, { recursive: true, force: true });
  }
});
