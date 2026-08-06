'use strict';

// The camera argv, and specifically `--inline`.
//
// WHY THIS TEST EXISTS. rpicam-vid defaults --inline to 0, which makes it emit SPS/PPS
// exactly once at stream start. Measured off rover3's live socket on 2026-08-06, two
// consecutive key frames carried NAL types [7,8,5] and then [5] alone — so every key
// frame after the first lacked the parameter sets that streams/h264.js documents it as
// carrying. A client that connects late or reconnects after the link drops then receives
// a key frame it cannot configure a VideoDecoder from, and video never returns.
//
// That defect was invisible to the existing suite because the argv was built inline in
// start(), which no test can reach without spawning a camera. Extracting the builder is
// what makes it assertable — the same "correct rule, untested consumer" shape CLAUDE.md
// names as this repo's dominant one, in the direction that actually helps.
//
// The on-target counterpart is the real proof and was run: after this change every key
// frame off the live socket carries 7, 8 and 5. A host test cannot see that, so it is
// recorded in HANDOFF.md rather than claimed here.

const test   = require('node:test');
const assert = require('node:assert');
const { buildCameraArgs } = require('../streams/h264');

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test('every I-frame repeats SPS/PPS', () => {
  const args = buildCameraArgs({ width: 320, height: 240, fps: 10, bitrate: 250000, intra: 10 });
  assert.ok(args.includes('--inline'),
    'without --inline, rpicam-vid sends SPS/PPS once at stream start and a reconnecting ' +
    'client can never configure its decoder');
});

test('--inline is a bare flag, not given a value that would swallow the next argument', () => {
  const args = buildCameraArgs({ width: 320, height: 240, fps: 10, bitrate: 250000, intra: 10 });
  const next = args[args.indexOf('--inline') + 1];
  // rpicam-vid declares it as `--inline [=arg(=1)] (=0)`, so the value form must use `=`.
  // A bare '--inline' followed by a separate token would leave that token as a positional
  // argument, and rpicam-vid would reject the whole command line.
  assert.ok(next === undefined || next.startsWith('-'),
    `--inline must not be followed by a value token, found ${JSON.stringify(next)}`);
});

test('encoder parameters reach the argv unchanged', () => {
  // Distinct values so a transposed pair cannot pass: width/height and fps/intra are the
  // plausible transpositions, and equal values would hide them.
  const args = buildCameraArgs({ width: 640, height: 360, fps: 24, bitrate: 512000, intra: 17 });
  assert.equal(argValue(args, '--width'),     '640');
  assert.equal(argValue(args, '--height'),    '360');
  assert.equal(argValue(args, '--framerate'), '24');
  assert.equal(argValue(args, '--bitrate'),   '512000');
  assert.equal(argValue(args, '--intra'),     '17');
});

test('baseline profile and stdout piping are preserved', () => {
  const args = buildCameraArgs({ width: 320, height: 240, fps: 10, bitrate: 250000, intra: 10 });
  // Baseline has no B-frames, which is what lets the NAL parser treat one access unit as
  // one decodable packet with no reordering.
  assert.equal(argValue(args, '--profile'), 'baseline');
  assert.equal(argValue(args, '-o'), '-', 'output must go to stdout for the parser to read');
  assert.equal(argValue(args, '-t'), '0', 'a non-zero timeout would end the stream on its own');
  assert.ok(args.includes('--nopreview'));
  assert.equal(argValue(args, '--codec'), 'h264');
});
