'use strict';

// Host-side tests for the WebRTC reader count.
//
// What this replaces: `clientCount() { return 0; }` — a hardcoded stub that reported zero
// viewers on every rover, forever. That is why a forgotten browser tab could stream through
// the middle of a range test on 2026-08-06, discarding ~42 frames/s over the same half-duplex
// airtime the control channel needs, with nothing on the rover saying so.
//
// The proposed fix at the time was a hard one-viewer cap. This is the other answer: make the
// count VISIBLE. A cap blocks the legitimate second viewer (a mesh peer, a second operator) to
// hide the illegitimate one; reporting the number costs nothing and blocks nobody.

const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');

const webrtc = require('../streams/webrtc.js');

// A stand-in for MediaMTX's API. Returns whatever the test wants for /v3/paths/get/<path>.
function apiStub(handler) {
  const server = http.createServer((rq, rs) => handler(rq, rs));
  return server;
}

// A distinct API port per test: node:test runs files concurrently, and a shared 9997 makes
// one test's stub collide with another's — which showed up as EADDRINUSE masking the real
// assertion.
let nextPort = 19997;
function mkStream(extra = {}) {
  return webrtc({
    mediamtx_autostart: false,
    webrtc_path: 'cam',
    mediamtx_yml: '/tmp/webrtc-reader-count-test.yml',
    ...extra,
  });
}
function PARAMS() {
  return { width: 480, height: 360, fps: 20, bitrate: 350, idr_period: 10 };
}

// ── The generated config ─────────────────────────────────────────────────────

test('the generated config enables the API on LOOPBACK only', () => {
  // The count is unobtainable without it. Bound to 127.0.0.1 because this server has no
  // authentication at all (invariant 1 is open) and the API exposes session detail.
  const yml = webrtc.generateMediaMTXConfig({}, PARAMS());
  assert.match(yml, /^api: yes$/m, 'the API must be enabled or clientCount can never work');
  assert.match(yml, /^apiAddress: 127\.0\.0\.1:9997$/m);
  assert.doesNotMatch(yml, /^apiAddress: *:9997$/m,
    'binding the API to all interfaces would publish session data off-box');
  assert.doesNotMatch(yml, /^apiAddress: 0\.0\.0\.0/m);
});

test('the config is still valid YAML-ish after the API block', () => {
  // The API comment block sits inside a template literal. A backtick in it silently
  // terminates the literal — measured, it did, and `node --check` caught what review would
  // not have. Assert the keys that follow it still render.
  const yml = webrtc.generateMediaMTXConfig({}, PARAMS());
  for (const key of ['rtsp:', 'webrtc:', 'webrtcAddress:', 'paths:']) {
    assert.ok(yml.includes(key), `${key} missing — the template literal is broken`);
  }
  assert.doesNotMatch(yml, /\$\{/, 'an unsubstituted placeholder means the literal broke');
});

// ── The count itself ─────────────────────────────────────────────────────────

test('an unreachable API reports null, NOT zero', async () => {
  // The distinction this test exists for. 0 is a real answer meaning "nobody is watching";
  // null means "picar cannot tell". Collapsing them reintroduces the original defect in a
  // new costume — an operator would read "0 viewers" and believe it.
  const s = mkStream({ webrtc_reader_poll_ms: 1000, mediamtx_api_port: nextPort++ });
  try {
    await new Promise((r) => setTimeout(r, 300));   // nothing is listening on that port
    assert.equal(s.clientCount(), null);
    assert.notEqual(s.clientCountError(), null, 'and it must say why');
  } finally { s.stop(); }
});

test('a live API is polled and the reader count reported', async () => {
  let asked = null;
  const port = nextPort++;
  const server = apiStub((rq, rs) => {
    asked = rq.url;
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify({ name: 'cam', readers: [{ type: 'webrtcSession' },
                                                    { type: 'webrtcSession' }] }));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const s = mkStream({ webrtc_reader_poll_ms: 1000, mediamtx_api_port: port });
  try {
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.clientCount(), 2, 'two sessions must report as two readers');
    assert.equal(s.clientCountError(), null);
    assert.match(asked, /\/v3\/paths\/get\/cam$/, 'it must ask about the configured path');
  } finally { s.stop(); await new Promise((r) => server.close(r)); }
});

test('zero readers is reported as 0, distinctly from unknown', async () => {
  const port = nextPort++;
  const server = apiStub((rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify({ name: 'cam', readers: [] }));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const s = mkStream({ webrtc_reader_poll_ms: 1000, mediamtx_api_port: port });
  try {
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.clientCount(), 0, 'an idle camera reports 0');
    assert.equal(s.clientCountError(), null, 'and that is not an error state');
  } finally { s.stop(); await new Promise((r) => server.close(r)); }
});

test('a malformed API response does not report a made-up count', async () => {
  const port = nextPort++;
  const server = apiStub((rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end('{ this is not json');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const s = mkStream({ webrtc_reader_poll_ms: 1000, mediamtx_api_port: port });
  try {
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.clientCount(), null);
    assert.match(s.clientCountError(), /unparseable/);
  } finally { s.stop(); await new Promise((r) => server.close(r)); }
});

test('a non-200 from the API is not read as a count', async () => {
  const port = nextPort++;
  const server = apiStub((rq, rs) => { rs.writeHead(404); rs.end('no such path'); });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const s = mkStream({ webrtc_reader_poll_ms: 1000, mediamtx_api_port: port });
  try {
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.clientCount(), null);
    assert.match(s.clientCountError(), /HTTP 404/);
  } finally { s.stop(); await new Promise((r) => server.close(r)); }
});

// ── Invariant 9: this must never block the control loop ──────────────────────

test('clientCount() is synchronous and returns instantly from cache', async () => {
  // It is read from request and telemetry paths, which share the event loop with the input
  // watchdog and the 20 Hz override stream. An awaited or synchronous HTTP call here is a
  // safety defect, not a slow function.
  const port = nextPort++;
  const server = apiStub((rq, rs) => {
    // Deliberately slow: if clientCount() waited on the network this would show up.
    setTimeout(() => {
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({ readers: [{}] }));
    }, 800);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const s = mkStream({ webrtc_reader_poll_ms: 1000 });
  try {
    await new Promise((r) => setTimeout(r, 50));
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 500; i++) s.clientCount();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 50, `500 calls took ${ms.toFixed(1)} ms — clientCount() is not cached`);
  } finally { s.stop(); await new Promise((r) => server.close(r)); }
});

test('stop() clears the poll timer so the process can exit', async () => {
  // A leaked interval makes `node --test` hang, and a hang reads as a pass — which is why
  // this is asserted rather than assumed. The timer is also unref'd; both matter.
  const s = mkStream({ webrtc_reader_poll_ms: 1000 });
  s.stop();
  const before = process._getActiveHandles().length;
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(process._getActiveHandles().length <= before + 1,
    'stop() must not leave the reader poll interval running');
});
