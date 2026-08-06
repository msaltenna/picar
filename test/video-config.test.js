'use strict';

// The tracked video configuration had NO test at all. Verified by mutation before this
// file existed: setting stream_codec to "nonsense", or h264_width / h264_bitrate_kbps /
// h264_intra_period to 0, each left the suite at 302/302 green. A codec typo is not a
// harmless typo — streams/index.js logs to console.error and silently falls back to
// h264, so on a rover configured for webrtc the operator gets no video and no failure
// that names the cause.
//
// These assertions are deliberately about COHERENCE, not about a particular choice.
// Pinning stream_codec to a literal would make a legitimate revert to 'webrtc' fail the
// suite, which is how a test stops being a safety net and becomes an obstacle.
//
// Bounds are written out here rather than read from the config under test. Deriving the
// expectation from the table being tested is a mistake already made twice in this repo:
// the test then passes for every value, including absurd ones.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const config = require('../picar-cfg.json');

// The set of codecs is not hardcoded here — it is proven by resolving the module the
// dispatcher would require. That makes the assertion about something real (a module
// exists and is loadable for the configured codec) rather than about matching source
// text, which is the vacuous shape CLAUDE.md warns about.
test('stream_codec names a stream module that actually exists', () => {
  const codec = (config.stream_codec || 'h264').toLowerCase();
  assert.equal(codec, config.stream_codec,
    'stream_codec should be written in the lower case the dispatcher compares against');
  assert.doesNotThrow(
    () => require.resolve(path.join(__dirname, '..', 'streams', codec)),
    `no streams/${codec}.js — streams/index.js would fall through to its default branch ` +
    'and serve h264 while the operator believes they configured something else');
});

test('h264 encoder parameters are physically sane', () => {
  const int = (name) => {
    const v = config[name];
    assert.ok(Number.isInteger(v) && v > 0, `${name} must be a positive integer, got ${v}`);
    return v;
  };
  const w   = int('h264_width');
  const h   = int('h264_height');
  const fps = int('h264_framerate');
  const kbps = int('h264_bitrate_kbps');
  const intra = int('h264_intra_period');

  // Generous outer bounds: the point is to catch a zero, a negative, or a value off by
  // orders of magnitude, not to police a considered choice.
  assert.ok(w >= 160 && w <= 1920, `h264_width ${w} outside 160-1920`);
  assert.ok(h >= 120 && h <= 1080, `h264_height ${h} outside 120-1080`);
  assert.ok(fps >= 5 && fps <= 60, `h264_framerate ${fps} outside 5-60`);
  assert.ok(kbps >= 50 && kbps <= 8000, `h264_bitrate_kbps ${kbps} outside 50-8000`);

  // An IDR interval longer than two seconds of video means a picture frozen by shed
  // frames stays frozen for over two seconds. Recovery is the entire reason this
  // transport was chosen over WebRTC, so the keyframe cost is the point.
  assert.ok(intra <= fps * 2,
    `h264_intra_period ${intra} exceeds two seconds at ${fps} fps — recovery after ` +
    'frame loss would be slower than the transport was chosen to deliver');
});

// This ordering is a real defect if inverted, not a style preference. fanOutToClients
// checks the hard threshold FIRST, so with dropAll below dropDelta the hard rule fires
// first and keyframes are dropped too — leaving a client that can never resync, which is
// exactly the "video never comes back" failure the h264 path exists to avoid.
test('the delta drop threshold sits below the hard drop threshold', () => {
  const delta = config.h264_drop_delta_bytes;
  const all   = config.h264_drop_all_bytes;
  assert.ok(Number.isInteger(delta) && delta > 0, `h264_drop_delta_bytes bad: ${delta}`);
  assert.ok(Number.isInteger(all) && all > 0, `h264_drop_all_bytes bad: ${all}`);
  assert.ok(delta < all,
    `h264_drop_delta_bytes (${delta}) must be below h264_drop_all_bytes (${all}), or the ` +
    'hard threshold fires first and keyframes are dropped, stranding the client');
});

// Guards the coupling the config comment claims: choosing a non-webrtc codec means
// rpicam-vid opens the camera directly, so mediamtx must not also hold it. Nothing in
// the code enforces this, and a test cannot check a systemd unit on the host — so this
// asserts only the part that is checkable, that the claim is still documented where an
// operator will read it before switching.
test('the camera-ownership constraint is documented on the codec key', () => {
  const note = `${config.comment3 || ''}`;
  assert.match(note, /mediamtx/i,
    'comment3 must keep naming mediamtx: the h264 and mjpeg paths cannot open the ' +
    'camera while mediamtx.service holds it, and that is not enforced in code');
});
