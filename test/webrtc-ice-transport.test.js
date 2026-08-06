'use strict';

// The ICE transport policy in the generated mediamtx.yml.
//
// WHY THIS IS A TEST AND NOT A COMMENT. `webrtcLocalTCPAddress: :8189` was hardcoded in
// the yml template, so every WebRTC session could silently fall back from UDP to TCP. It
// did, on every session of a failed out-of-sight drive on rover3 (2026-08-06), measured
// from MediaMTX's own log: `local candidate: host/tcp/192.168.10.224/8189, remote
// candidate: prflx/tcp/…`. TCP is the wrong transport for real-time video — it keeps
// WebRTC's assumption that media may be shed freely while running on a transport with
// head-of-line blocking — and the observed consequence was a starved hardware encoder
// (544 `ioctl(VIDIOC_QBUF) failed` in 112 s at only 200 kbps offered) plus 12 control
// fail-safe trips in the same ~100 s, because video and commands share half-duplex airtime.
//
// The yml reaches MediaMTX as a FILE, not as an API call, so the only way this policy can
// be asserted at all is by rendering the config and reading it. That is why
// generateMediaMTXConfig is exported.
//
// Expectations are written out literally rather than derived from the module under test.
// Deriving them is how a test comes to pass for every possible value.

const test   = require('node:test');
const assert = require('node:assert');
const { generateMediaMTXConfig } = require('../streams/webrtc.js');

const PARAMS = { width: 480, height: 360, fps: 20, bitrate: 350, idr_period: 10 };

function lines(yml) {
  return yml.split('\n');
}
function hasKey(yml, key) {
  return lines(yml).some((l) => l.startsWith(`${key}:`));
}
function valueOf(yml, key) {
  const l = lines(yml).find((x) => x.startsWith(`${key}:`));
  return l === undefined ? undefined : l.slice(key.length + 1).trim();
}

test('by default the yml offers UDP and NO TCP ICE candidate', () => {
  const yml = generateMediaMTXConfig({}, PARAMS);
  assert.ok(hasKey(yml, 'webrtcLocalUDPAddress'), 'UDP ICE must always be configured');
  assert.equal(hasKey(yml, 'webrtcLocalTCPAddress'), false,
    'webrtcLocalTCPAddress must be ABSENT by default — its presence is what let sessions ' +
    'silently fall back to TCP, which starved the encoder and broke the control path');
});

test('webrtc_ice_tcp: true restores the TCP candidate deliberately', () => {
  const yml = generateMediaMTXConfig({ webrtc_ice_tcp: true }, PARAMS);
  assert.ok(hasKey(yml, 'webrtcLocalTCPAddress'),
    'an explicit opt-in must work, or the escape hatch is not an escape hatch');
  assert.equal(valueOf(yml, 'webrtcLocalTCPAddress'), ':8189');
});

// The untracked overlay is hand-edited and JSON-typed, so a stray "true" or 1 is a
// realistic way to re-enable TCP by accident. Invariant 8 is about exactly this class of
// off-branch change, so the unsafe direction must require the literal boolean.
test('only the literal boolean true enables TCP — no truthy coercion', () => {
  for (const v of ['true', 'yes', 1, {}, [], 'TRUE']) {
    const yml = generateMediaMTXConfig({ webrtc_ice_tcp: v }, PARAMS);
    assert.equal(hasKey(yml, 'webrtcLocalTCPAddress'), false,
      `webrtc_ice_tcp=${JSON.stringify(v)} must NOT enable ICE-TCP — only === true may`);
  }
});

test('explicit false, null and undefined all leave TCP off', () => {
  for (const v of [false, null, undefined]) {
    const yml = generateMediaMTXConfig({ webrtc_ice_tcp: v }, PARAMS);
    assert.equal(hasKey(yml, 'webrtcLocalTCPAddress'), false);
  }
});

test('omitting the TCP line does not corrupt the surrounding yaml', () => {
  const yml = generateMediaMTXConfig({}, PARAMS);
  // A conditional line spliced into a template is the obvious way to leave a stray blank
  // line or to glue two keys together. Both would be silently accepted here and rejected
  // by MediaMTX at startup, which on a rover means no video and a confusing log.
  assert.ok(hasKey(yml, 'webrtcIPsFromInterfaces'),
    'the key that follows the conditional line must survive as its own line');
  assert.equal(valueOf(yml, 'webrtcIPsFromInterfaces'), 'true');
  assert.equal(/\n\n(webrtcIPsFromInterfaces)/.test(yml), false,
    'no blank line should be introduced where the TCP line was omitted');
  assert.equal(/webrtcLocalUDPAddress: :8189webrtc/.test(yml), false,
    'the UDP line and the next key must not be glued together');
});

test('the ICE port follows webrtc_udp_port for both transports', () => {
  const udp = generateMediaMTXConfig({ webrtc_udp_port: 9999 }, PARAMS);
  assert.equal(valueOf(udp, 'webrtcLocalUDPAddress'), ':9999');
  const both = generateMediaMTXConfig({ webrtc_udp_port: 9999, webrtc_ice_tcp: true }, PARAMS);
  assert.equal(valueOf(both, 'webrtcLocalTCPAddress'), ':9999',
    'the opt-in TCP listener must use the configured port, not a hardcoded 8189');
});

// ── maxReaders ───────────────────────────────────────────────────────────────
//
// A second viewer doubles the rover's uplink over the airtime the control channel needs.
// This is not hypothetical: on 2026-08-06 an agent's forgotten browser tab streamed video
// from a tunnelled address straight through a range test, logging `reader is too slow,
// discarding ~42 frames` every second while the operator was out at distance, and its
// discard messages were briefly mistaken for evidence about the operator's own session.

test('the camera path caps concurrent readers at 1 by default', () => {
  const yml = generateMediaMTXConfig({}, PARAMS);
  assert.equal(valueOf(yml, '    maxReaders'), '1',
    'an uncapped path lets a second viewer halve the link the operator is driving on');
});

test('a valid explicit reader cap is honoured', () => {
  assert.equal(valueOf(generateMediaMTXConfig({ webrtc_max_readers: 3 }, PARAMS), '    maxReaders'), '3');
});

// MediaMTX treats maxReaders: 0 as UNLIMITED, so 0 is the one value that must not pass
// through — it reads like "none" and means "no limit". Same for junk from a hand-edited
// overlay: the safe direction must be the default.
test('0, negatives and junk fall back to 1 rather than becoming unlimited', () => {
  for (const v of [0, -1, 2.5, '5', null, 'many', {}, NaN]) {
    assert.equal(valueOf(generateMediaMTXConfig({ webrtc_max_readers: v }, PARAMS), '    maxReaders'), '1',
      `webrtc_max_readers=${JSON.stringify(v)} must fall back to 1, not to MediaMTX's unlimited`);
  }
});
