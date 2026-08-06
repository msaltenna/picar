#!/usr/bin/env node
'use strict';

// ON-TARGET: every key frame on the live socket must carry SPS+PPS.
//
// This is the consumer half of test/h264-camera-args.test.js. That host test proves
// buildCameraArgs() emits --inline; it cannot prove start() still calls it. Replacing the
// call site with a literal argv missing --inline leaves the host suite green at 310/310 —
// measured, not assumed — so the only thing that closes the gap is observing real frames.
//
// WHAT IT CATCHES. rpicam-vid defaults --inline to 0 and then sends SPS/PPS exactly once,
// at stream start. Measured on rover3 on 2026-08-06, before the fix: consecutive key
// frames carried NAL types [7,8,5] and then [5] alone. New clients wait in wsPending for
// a key frame, so a client that connects late — or reconnects after the link drops out of
// range — gets a key frame with no parameter sets, cannot configure its VideoDecoder, and
// shows nothing until the camera process itself restarts. That is the "video never comes
// back" failure the h264 transport was chosen to avoid, hiding inside the fix for it.
//
// SAFE BY DEFAULT: read-only. It opens a video WebSocket and nothing else — it does not
// arm, does not command any servo, and never touches the throttle. There is no motion
// opt-in flag because there is no motion.
//
//   Usage: node test/on-target/video-keyframes.js [seconds]

const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const { WebSocket } = require(path.join(REPO, 'node_modules', 'ws'));

const SECONDS = Number(process.argv[2] || 20);
const URL     = 'wss://localhost:8081/stream';

// Proper Annex-B scan. A 4-byte start code 00 00 00 01 also contains the 3-byte pattern
// 00 00 01 at the next offset, so a naive scan reports every NAL twice — which is
// harmless for a presence check and misleading for a count. Skip past each header instead.
function nalTypes(buf) {
  const types = [];
  let i = 0;
  while (i + 3 < buf.length) {
    let hdr = 0;
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) hdr = 3;
    else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) hdr = 4;
    if (hdr === 0) { i++; continue; }
    const at = i + hdr;
    if (at < buf.length) types.push(buf[at] & 0x1f);
    i = at + 1;
  }
  return types;
}

const SPS = 7, PPS = 8, IDR = 5;

let frames = 0, keyframes = 0, bytes = 0;
let firstWasKey = null;
const badKeyframes = [];
let started = null, ended = null;

const ws = new WebSocket(URL, { rejectUnauthorized: false });

ws.on('open', () => console.log(`connected to ${URL}, sampling ${SECONDS}s`));
ws.on('error', (err) => { console.error(`FAIL: websocket error: ${err.message}`); process.exit(2); });

ws.on('message', (msg) => {
  const b = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
  if (b.length < 6) return;                       // 5-byte header + at least one byte
  const isKey = b[0] === 1;
  frames++;
  bytes += b.length;
  if (started === null) { started = Date.now(); firstWasKey = isKey; }
  ended = Date.now();
  if (!isKey) return;

  keyframes++;
  const types = nalTypes(b.subarray(5));
  const missing = [[SPS, 'SPS(7)'], [PPS, 'PPS(8)'], [IDR, 'IDR(5)']]
    .filter(([t]) => !types.includes(t)).map(([, n]) => n);
  if (missing.length) {
    badKeyframes.push({ index: keyframes, bytes: b.length, missing, types });
  }
});

setTimeout(() => {
  const secs = started && ended ? Math.max((ended - started) / 1000, 0.001) : 0;
  console.log(`frames=${frames} keyframes=${keyframes} bytes=${bytes}` +
              (secs ? ` fps=${(frames / secs).toFixed(2)} kbps=${((bytes * 8) / secs / 1000).toFixed(1)}` : ''));

  const fails = [];
  if (frames === 0)    fails.push('no frames received at all — is picar on the h264 codec and mediamtx stopped?');
  if (keyframes < 2)   fails.push(`only ${keyframes} key frame(s) in ${SECONDS}s; need at least 2 to prove the SECOND one repeats its headers`);
  if (firstWasKey === false) fails.push('the first delivered frame was a delta — wsPending must hold a client until a key frame');
  for (const k of badKeyframes) {
    fails.push(`key frame #${k.index} (${k.bytes}B) missing ${k.missing.join('+')} — nal types [${k.types.join(',')}]`);
  }

  if (fails.length) {
    console.error('FAIL:');
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`PASS: all ${keyframes} key frames carry SPS+PPS+IDR, and the first frame was a key frame`);
  process.exit(0);
}, SECONDS * 1000);
