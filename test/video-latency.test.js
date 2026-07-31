'use strict';

// Host-side tests for bounded video latency.
//
// Everything here drives the REAL exported logic. The frame-drop rules and the
// NAL parser are exported from their modules precisely so these tests cannot
// pass by reimplementing the rule they are meant to police — a copy of the
// comparison in a test would not catch an inversion in the module.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const h264  = require('../streams/h264.js');
const mjpeg = require('../streams/mjpeg.js');

const { NalParser, shouldSendFrame, MAX_NAL_BUFFER } = h264;
const { shouldSkipFrame } = mjpeg;

const DELTA = 48 * 1024;
const ALL   = 200 * 1024;

// ── The h264 frame-drop rule ─────────────────────────────────────────────────

test('a client with no backlog receives every frame', () => {
  assert.equal(shouldSendFrame(true,  0, DELTA, ALL), true);
  assert.equal(shouldSendFrame(false, 0, DELTA, ALL), true);
});

test('delta frames are shed first, at the delta threshold', () => {
  assert.equal(shouldSendFrame(false, DELTA,     DELTA, ALL), true, 'at the limit still sends');
  assert.equal(shouldSendFrame(false, DELTA + 1, DELTA, ALL), false, 'past the limit drops');
});

test('keyframes survive a delta-level backlog so the client can resync', () => {
  assert.equal(shouldSendFrame(true, DELTA + 1, DELTA, ALL), true);
  assert.equal(shouldSendFrame(true, ALL,       DELTA, ALL), true);
});

test('a hard backlog drops everything, keyframes included', () => {
  assert.equal(shouldSendFrame(true,  ALL + 1, DELTA, ALL), false);
  assert.equal(shouldSendFrame(false, ALL + 1, DELTA, ALL), false);
});

test('the drop rule is monotonic in backlog — more backlog never sends more', () => {
  // Guards against a mis-ordered comparison that would, say, resume sending at
  // very high backlog.
  for (const isKey of [true, false]) {
    let seenDrop = false;
    for (let backlog = 0; backlog <= ALL * 2; backlog += 4096) {
      const send = shouldSendFrame(isKey, backlog, DELTA, ALL);
      if (!send) seenDrop = true;
      if (seenDrop) {
        assert.equal(send, false,
          `isKeyframe=${isKey} resumed sending at backlog=${backlog} after dropping`);
      }
    }
  }
});

// ── The mjpeg frame-drop rule ────────────────────────────────────────────────

test('mjpeg skips only when the socket is genuinely backed up', () => {
  assert.equal(shouldSkipFrame(0, 64 * 1024), false);
  assert.equal(shouldSkipFrame(64 * 1024, 64 * 1024), false);
  assert.equal(shouldSkipFrame(64 * 1024 + 1, 64 * 1024), true);
});

// ── NAL framing, byte-exact ──────────────────────────────────────────────────

const SC4 = Buffer.from([0, 0, 0, 1]);
const SC3 = Buffer.from([0, 0, 1]);

function nal(type, len = 6, sc = SC4) {
  return Buffer.concat([sc, Buffer.from([type & 0x1f]), Buffer.alloc(len, 0xa5)]);
}

function collect(chunks) {
  const packets = [];
  const p = new NalParser((data, isKey) => packets.push({ data, isKey }));
  for (const c of chunks) p.push(c);
  return { packets, parser: p };
}

test('an SPS+PPS+IDR sequence emits one keyframe packet containing all three', () => {
  const sps = nal(7), pps = nal(8), idr = nal(5);
  // A trailing start code is required to terminate the IDR.
  const { packets } = collect([Buffer.concat([sps, pps, idr, SC4])]);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].isKey, true);
  const got = packets[0].data;
  assert.ok(got.includes(sps), 'keyframe packet must carry the SPS');
  assert.ok(got.includes(pps), 'keyframe packet must carry the PPS');
  assert.ok(got.includes(idr), 'keyframe packet must carry the IDR slice');
});

test('a non-IDR slice emits a delta packet', () => {
  const { packets } = collect([Buffer.concat([nal(1), SC4])]);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].isKey, false);
});

test('framing is identical however the bytes are split across chunks', () => {
  const stream = Buffer.concat([nal(7), nal(8), nal(5), nal(1), nal(1), SC4]);

  const whole = collect([stream]).packets;
  assert.equal(whole.length, 3, 'expected one keyframe and two delta frames');
  assert.deepEqual(whole.map((p) => p.isKey), [true, false, false]);

  // Split at every possible byte boundary, including inside start codes, and
  // require byte-identical output. This is the property the incremental
  // `scanned` optimisation could plausibly break.
  for (let cut = 1; cut < stream.length; cut++) {
    const split = collect([stream.subarray(0, cut), stream.subarray(cut)]).packets;
    assert.equal(split.length, whole.length, `packet count changed at cut=${cut}`);
    for (let i = 0; i < whole.length; i++) {
      assert.equal(split[i].isKey, whole[i].isKey, `keyframe flag changed at cut=${cut}`);
      assert.ok(split[i].data.equals(whole[i].data), `packet ${i} bytes changed at cut=${cut}`);
    }
  }
});

test('framing survives being fed one byte at a time', () => {
  const stream = Buffer.concat([nal(7), nal(8), nal(5), nal(1), SC4]);
  const oneByte = [];
  for (const b of stream) oneByte.push(Buffer.from([b]));
  const drip = collect(oneByte).packets;
  const whole = collect([stream]).packets;
  assert.equal(drip.length, whole.length);
  for (let i = 0; i < whole.length; i++) {
    assert.ok(drip[i].data.equals(whole[i].data), `packet ${i} differs when dripped`);
  }
});

test('3-byte and 4-byte start codes are both accepted', () => {
  const s3 = Buffer.concat([nal(7, 6, SC3), nal(5, 6, SC3), SC3]);
  const { packets } = collect([s3]);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].isKey, true);
});

test('the parser buffer is bounded and resyncs instead of growing without limit', () => {
  const packets = [];
  const p = new NalParser((d, k) => packets.push({ d, k }));
  // Bytes containing a start code but never a second one: the old code grew this
  // buffer forever.
  p.push(Buffer.concat([SC4, Buffer.alloc(1024, 0x11)]));
  const chunk = Buffer.alloc(512 * 1024, 0x22);
  for (let i = 0; i < 12; i++) p.push(chunk);   // ~6 MB, past the 4 MB cap
  assert.ok(p.buf.length <= MAX_NAL_BUFFER,
    `buffer grew to ${p.buf.length}, above the ${MAX_NAL_BUFFER} cap`);
  assert.equal(packets.length, 0, 'no packet should be emitted from garbage');
});

test('reset clears the incremental scan position too', () => {
  const p = new NalParser(() => {});
  p.push(Buffer.concat([SC4, Buffer.alloc(64, 0x33)]));
  assert.ok(p.scanned > 0, 'expected a recorded scan frontier');
  p.reset();
  assert.equal(p.scanned, 0);
  assert.equal(p.buf.length, 0);
});

// ── The webrtc path must never block the event loop ──────────────────────────

test('streams/webrtc.js does not restart mediamtx synchronously', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'streams', 'webrtc.js'), 'utf8');
  // execSync there blocks the event loop for the whole unit restart — seconds —
  // freezing the Socket.IO control stream, the 20 Hz override loop, and every
  // fail-safe timer. A video setting must not be able to stall C2.
  assert.doesNotMatch(src, /execSync\s*\(/, 'a synchronous restart would block the event loop');
  assert.match(src, /spawn\(/);
});

// ── Fuzz: framing must be chunk-independent for ANY split pattern ────────────
//
// The `scanned` frontier is the riskiest part of this parser: if it is ever left
// stale, or pointing past data that a later slice moved, the parser silently
// mis-frames video. Hand-reasoning about it is not sufficient, so this compares
// randomly-chunked input against whole-buffer input over many generated streams.
// Deterministic LCG so a failure is reproducible.

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
}

test('framing is chunk-independent across randomly generated streams and splits', () => {
  const rand = lcg(0xC0FFEE);
  const types = [7, 8, 6, 9, 5, 1, 1, 1];

  for (let iter = 0; iter < 300; iter++) {
    // Build a random stream of NALs with random sizes and both start-code lengths.
    const parts = [];
    const nalCount = 2 + Math.floor(rand() * 6);
    for (let i = 0; i < nalCount; i++) {
      const type = types[Math.floor(rand() * types.length)];
      const len  = 1 + Math.floor(rand() * 40);
      const sc   = rand() < 0.5 ? SC3 : SC4;
      parts.push(nal(type, len, sc));
    }
    parts.push(rand() < 0.5 ? SC3 : SC4);   // terminate the last NAL
    const stream = Buffer.concat(parts);

    const whole = collect([stream]).packets;

    // Random split into 1..6 chunks.
    const cuts = new Set();
    const nCuts = 1 + Math.floor(rand() * 5);
    for (let i = 0; i < nCuts; i++) cuts.add(1 + Math.floor(rand() * (stream.length - 1)));
    const sorted = [...cuts].sort((a, b) => a - b);
    const chunks = [];
    let prev = 0;
    for (const c of sorted) { chunks.push(stream.subarray(prev, c)); prev = c; }
    chunks.push(stream.subarray(prev));

    const split = collect(chunks).packets;

    assert.equal(split.length, whole.length,
      `iter ${iter}: packet count differs for cuts ${sorted.join(',')}`);
    for (let i = 0; i < whole.length; i++) {
      assert.equal(split[i].isKey, whole[i].isKey,
        `iter ${iter}: keyframe flag differs on packet ${i} for cuts ${sorted.join(',')}`);
      assert.ok(split[i].data.equals(whole[i].data),
        `iter ${iter}: packet ${i} bytes differ for cuts ${sorted.join(',')}`);
    }
  }
});

test('the scan frontier never exceeds the buffer it indexes', () => {
  const rand = lcg(0xBEEF);
  const p = new NalParser(() => {});
  for (let i = 0; i < 500; i++) {
    const len = 1 + Math.floor(rand() * 32);
    const chunk = Buffer.alloc(len);
    for (let j = 0; j < len; j++) chunk[j] = Math.floor(rand() * 256);
    p.push(chunk);
    assert.ok(p.scanned <= p.buf.length,
      `scanned=${p.scanned} exceeds buffer length ${p.buf.length} at i=${i}`);
    assert.ok(p.scanned >= 0);
  }
});
