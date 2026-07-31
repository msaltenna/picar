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

// ── The drop decision AT ITS CALL SITE ───────────────────────────────────────
//
// These exist because mutation testing showed the previous tests covered only the
// pure predicates: inverting the gate inside each broadcast() left the whole suite
// green, so the code that actually decides anything was unverified. These drive the
// real fan-out loops with fake clients and assert who received what.

const { fanOutToClients } = h264;
const { writeFrameToClients } = mjpeg;

const OPEN = 1;
function fakeWs(backlog, readyState = OPEN) {
  return { readyState, bufferedAmount: backlog, sent: [], send(b) { this.sent.push(b); } };
}

test('h264 fan-out sends to a healthy client and drops for a backed-up one', () => {
  const healthy = fakeWs(0);
  const backedUp = fakeWs(ALL + 1);
  const clients = new Set([healthy, backedUp]);
  const pkt = Buffer.from([1, 2, 3]);

  const dropped = fanOutToClients(clients, pkt, false,
    { dropDeltaBytes: DELTA, dropAllBytes: ALL, openState: OPEN });

  assert.equal(healthy.sent.length, 1, 'a healthy client must receive the frame');
  assert.equal(backedUp.sent.length, 0, 'a backed-up client must not');
  assert.equal(dropped, 1, 'the drop must be counted');
});

test('h264 fan-out never drops for a client with zero backlog', () => {
  // This is the assertion that catches an inverted gate: inversion drops
  // everything for healthy clients.
  for (const isKey of [true, false]) {
    const ws = fakeWs(0);
    const dropped = fanOutToClients(new Set([ws]), Buffer.from([9]), isKey,
      { dropDeltaBytes: DELTA, dropAllBytes: ALL, openState: OPEN });
    assert.equal(ws.sent.length, 1, `isKeyframe=${isKey}: healthy client was starved`);
    assert.equal(dropped, 0);
  }
});

test('h264 fan-out keeps keyframes but sheds deltas for a mid-backlog client', () => {
  const ws = fakeWs(DELTA + 1);
  const opts = { dropDeltaBytes: DELTA, dropAllBytes: ALL, openState: OPEN };
  fanOutToClients(new Set([ws]), Buffer.from([1]), false, opts);
  assert.equal(ws.sent.length, 0, 'delta must be shed at mid backlog');
  fanOutToClients(new Set([ws]), Buffer.from([2]), true, opts);
  assert.equal(ws.sent.length, 1, 'keyframe must still get through so the client can resync');
});

test('h264 fan-out skips clients that are not open, without counting them as drops', () => {
  const closed = fakeWs(0, 3); // CLOSED
  const dropped = fanOutToClients(new Set([closed]), Buffer.from([1]), true,
    { dropDeltaBytes: DELTA, dropAllBytes: ALL, openState: OPEN });
  assert.equal(closed.sent.length, 0);
  assert.equal(dropped, 0);
});

test('h264 fan-out evicts a client whose send throws', () => {
  const bad = { readyState: OPEN, bufferedAmount: 0, send() { throw new Error('gone'); } };
  const clients = new Set([bad]);
  fanOutToClients(clients, Buffer.from([1]), true,
    { dropDeltaBytes: DELTA, dropAllBytes: ALL, openState: OPEN });
  assert.equal(clients.size, 0, 'a broken client must be removed');
});

function fakeRes(writableLength, writableEnded = false) {
  return { writableLength, writableEnded, writes: [], write(c) { this.writes.push(c); } };
}

test('mjpeg fan-out writes to a healthy client and skips a backed-up one', () => {
  const DROP = 64 * 1024;
  const healthy = fakeRes(0);
  const backedUp = fakeRes(DROP + 1);
  const clients = [healthy, backedUp];

  const dropped = writeFrameToClients(clients, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), DROP);

  assert.ok(healthy.writes.length >= 1, 'a healthy client must receive the frame');
  assert.equal(backedUp.writes.length, 0, 'a backed-up client must not');
  assert.equal(dropped, 1);
});

test('mjpeg fan-out never skips for a client with zero backlog', () => {
  const ws = fakeRes(0);
  const dropped = writeFrameToClients([ws], Buffer.from([1]), 64 * 1024);
  assert.ok(ws.writes.length >= 1, 'healthy client was starved');
  assert.equal(dropped, 0);
});

test('mjpeg fan-out removes ended clients from the list', () => {
  const ended = fakeRes(0, true);
  const live = fakeRes(0);
  const clients = [ended, live];
  writeFrameToClients(clients, Buffer.from([1]), 64 * 1024);
  assert.equal(clients.length, 1);
  assert.equal(clients[0], live);
});

// ── The mediamtx restart must not block the event loop ───────────────────────
//
// Replaces a source-text test that asserted the absence of the string "execSync(".
// That test passed while the restart was fully synchronous, because execFileSync,
// spawnSync, and an aliased require all defeat the regex. This asserts the
// behaviour instead: setParams must return before the child completes.

// webrtc.js destructures `spawn` at module load, so a stub installed after the
// module is cached has no effect. Load it fresh per test.
function loadWebrtcFresh() {
  delete require.cache[require.resolve('../streams/webrtc.js')];
  return require('../streams/webrtc.js');
}

test('setParams returns without waiting for the mediamtx restart to finish', () => {
  const { EventEmitter } = require('events');
  const cp = require('child_process');
  const realSpawn = cp.spawn;
  let child = null;
  let spawns = 0;
  cp.spawn = () => {
    spawns++;
    child = new EventEmitter();
    child.kill = () => {};
    return child;
  };
  try {
    const tmp = path.join(require('os').tmpdir(), `mediamtx-test-${process.pid}.yml`);
    const stream = loadWebrtcFresh()({ mediamtx_yml: tmp });

    let closedBeforeReturn = false;
    child = null;
    stream.setParams({ fps: 15 });
    // If the restart were synchronous, the child would already have completed by
    // the time setParams returned.
    closedBeforeReturn = child === null;
    assert.equal(spawns, 1, 'exactly one restart should have been spawned');
    assert.equal(closedBeforeReturn, false,
      'a child should exist and still be running — setParams must not have waited');

    // A second request while one is in flight must coalesce, not spawn again.
    stream.setParams({ fps: 20 });
    assert.equal(spawns, 1, 'a concurrent restart request must coalesce');

    // ...and must be applied once the first completes.
    child.emit('close', 0);
    assert.equal(spawns, 2, 'the coalesced request must run after the first finishes');

    child.emit('close', 0);
    stream.stop();
    fs.rmSync(tmp, { force: true });
  } finally {
    cp.spawn = realSpawn;
  }
});

test('stop() prevents a queued restart from spawning during shutdown', () => {
  const { EventEmitter } = require('events');
  const cp = require('child_process');
  const realSpawn = cp.spawn;
  let child = null;
  let spawns = 0;
  cp.spawn = () => { spawns++; child = new EventEmitter(); child.kill = () => {}; return child; };
  try {
    const tmp = path.join(require('os').tmpdir(), `mediamtx-stop-${process.pid}.yml`);
    const stream = loadWebrtcFresh()({ mediamtx_yml: tmp });
    stream.setParams({ fps: 15 });            // spawn #1
    const first = child;
    stream.stop();                            // shutdown latches
    stream.setParams({ fps: 25 });            // arrives during teardown
    first.emit('close', 0);                   // dying child's handler runs
    assert.equal(spawns, 1,
      'no restart may be spawned during or after shutdown');
    fs.rmSync(tmp, { force: true });
  } finally {
    cp.spawn = realSpawn;
  }
});

// ── The incremental scan frontier must actually be used ──────────────────────
//
// Defeating it changes cost, not output, so no behavioural assertion can catch it.
// The parser therefore counts bytes examined, and this asserts the count stays
// linear. Without the frontier, a NAL arriving in N chunks is rescanned from byte 0
// each time, which is quadratic.

test('scanning a large access unit stays linear in its size', () => {
  const AU_BYTES = 256 * 1024;
  const CHUNK = 2048;
  const stream = Buffer.concat([
    SC4, Buffer.from([5]), Buffer.alloc(AU_BYTES, 0xa5),
    SC4, Buffer.from([1]), Buffer.alloc(64, 0x11), SC4,
  ]);
  const p = new NalParser(() => {});
  for (let i = 0; i < stream.length; i += CHUNK) p.push(stream.subarray(i, i + CHUNK));

  // Linear would be ~stream.length; quadratic over N=~130 chunks would be orders
  // of magnitude more. 4x gives generous headroom for the legitimate re-scan of
  // the 3-byte straddle window while still failing hard on a full rescan.
  const budget = stream.length * 4;
  assert.ok(p.scanBytes < budget,
    `scan examined ${p.scanBytes} bytes for a ${stream.length}-byte stream ` +
    `(budget ${budget}) — the incremental frontier is not being used`);
});

// ── MJPEG framing: the split-SOI fix and the buffer cap ─────────────────────

const { extractJpegFrames } = mjpeg;

function jpeg(payloadLen, fill) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), Buffer.alloc(payloadLen, fill), Buffer.from([0xff, 0xd9]),
  ]);
}

test('mjpeg framing recovers every frame however the bytes are split', () => {
  const stream = Buffer.concat([jpeg(8, 0x11), jpeg(12, 0x22), jpeg(6, 0x33)]);

  const whole = [];
  extractJpegFrames(Buffer.alloc(0), stream, 1 << 20, (f) => whole.push(Buffer.from(f)));
  assert.equal(whole.length, 3, 'expected 3 frames from the unsplit stream');

  // Split at every byte boundary. Cuts that fall between the ff and d8 of an SOI
  // marker are the ones that used to silently lose a frame.
  for (let cut = 1; cut < stream.length; cut++) {
    const got = [];
    let buf = Buffer.alloc(0);
    buf = extractJpegFrames(buf, stream.subarray(0, cut), 1 << 20, (f) => got.push(Buffer.from(f)));
    buf = extractJpegFrames(buf, stream.subarray(cut), 1 << 20, (f) => got.push(Buffer.from(f)));
    assert.equal(got.length, whole.length, `lost a frame at cut=${cut}`);
    for (let i = 0; i < whole.length; i++) {
      assert.ok(got[i].equals(whole[i]), `frame ${i} bytes differ at cut=${cut}`);
    }
  }
});

test('mjpeg framing survives one byte at a time', () => {
  const stream = Buffer.concat([jpeg(8, 0x11), jpeg(5, 0x22)]);
  const got = [];
  let buf = Buffer.alloc(0);
  for (const b of stream) {
    buf = extractJpegFrames(buf, Buffer.from([b]), 1 << 20, (f) => got.push(Buffer.from(f)));
  }
  assert.equal(got.length, 2);
});

test('the mjpeg buffer is capped and resyncs rather than growing without limit', () => {
  const CAP = 64 * 1024;
  const got = [];
  let buf = Buffer.alloc(0);
  // Bytes containing an SOI but never an EOI: the uncapped version grew forever.
  buf = extractJpegFrames(buf, Buffer.from([0xff, 0xd8]), CAP, (f) => got.push(f));
  for (let i = 0; i < 8; i++) {
    buf = extractJpegFrames(buf, Buffer.alloc(32 * 1024, 0x44), CAP, (f) => got.push(f));
    assert.ok(buf.length <= CAP,
      `buffer grew to ${buf.length}, above the ${CAP} cap`);
  }
  assert.equal(got.length, 0, 'no frame should be emitted from garbage');
});

// ── Fleet discovery backoff ──────────────────────────────────────────────────

const { SweepBackoff, MAX_SWEEP_BACKOFF_MS } = require('../fleetmgr-client.js');

test('a fresh backoff is due immediately', () => {
  const b = new SweepBackoff(5000, MAX_SWEEP_BACKOFF_MS);
  assert.equal(b.dueNow(0), true);
  assert.equal(b.dueNow(1_000_000), true);
});

test('failed sweeps double from the tick interval up to the ceiling', () => {
  const b = new SweepBackoff(5000, 300000);
  const seen = [];
  let now = 0;
  for (let i = 0; i < 9; i++) { seen.push(b.fail(now)); now += seen[seen.length - 1]; }
  assert.deepEqual(seen, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000],
    'expected doubling then a hard ceiling');
});

test('a backoff blocks sweeps until its delay has elapsed', () => {
  const b = new SweepBackoff(5000, 300000);
  b.fail(1000);                       // next due at 6000
  assert.equal(b.dueNow(5999), false, 'must not sweep early');
  assert.equal(b.dueNow(6000), true,  'must sweep once due');
});

test('a successful discovery resets the backoff completely', () => {
  // Regression guard: without the reset, a rover that found a Fleet Manager and
  // later lost it would keep the ceiling delay forever, taking up to 5 minutes to
  // reappear on the dashboard instead of one tick.
  const b = new SweepBackoff(5000, 300000);
  let now = 0;
  for (let i = 0; i < 8; i++) { now += b.fail(now); }
  assert.ok(b.delayMs >= 300000, 'precondition: backoff should be at the ceiling');

  b.succeed();

  assert.equal(b.delayMs, 0, 'delay must reset to zero');
  assert.equal(b.dueNow(now), true, 'must be immediately due again after success');
  assert.equal(b.fail(now), 5000, 'the next failure must restart at the tick interval');
});
