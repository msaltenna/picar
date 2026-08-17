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

// ── On-demand encoding and encoder capability ────────────────────────────────

const SHIPPED = require('../picar-cfg.json');   // the config that actually ships

test('the SHIPPED config selects the codec by hardware, not by a hardcoded value', () => {
  // This is the test whose absence hid a defect that made the whole feature a no-op.
  // picar-cfg.json shipped `"webrtc_codec": "hardwareH264"`, and the code read
  // `cfg.webrtc_codec || detect(...)` — so the tracked config always won and the detection
  // never ran on any rover. A fresh CM5 would still have been handed a codec its hardware
  // cannot run. The earlier tests generated from `{}` and so could never see it.
  const sw = webrtc.generateMediaMTXConfig({ ...SHIPPED, _hasHardwareEncoder: false }, PARAMS());
  assert.match(sw, /rpiCameraCodec: softwareH264/,
    'a board with no hardware encoder must get software, even with the shipped config');
  const hw = webrtc.generateMediaMTXConfig({ ...SHIPPED, _hasHardwareEncoder: true }, PARAMS());
  assert.match(hw, /rpiCameraCodec: hardwareH264/);
});

test('an explicit codec in config still overrides detection', () => {
  const yml = webrtc.generateMediaMTXConfig(
    { ...SHIPPED, webrtc_codec: 'softwareH264', _hasHardwareEncoder: true }, PARAMS());
  assert.match(yml, /rpiCameraCodec: softwareH264/);
});

test('on-demand is OFF by default on the pinned MediaMTX', () => {
  // install.sh pins v1.17.1, confirmed running on rover1. That release has a first-reader
  // race with sourceOnDemand — a player connecting before SPS/PPS are available gets
  // undecodable H.264 and stays BLACK, and the browser retries only if ICE reaches `failed`.
  // Fixed upstream in v1.19.2. A persistent black stream for the first operator of a
  // teleoperated vehicle is worse than the encoder cost it saves.
  const yml = webrtc.generateMediaMTXConfig({ ...SHIPPED }, PARAMS());
  assert.match(yml, /^\s*sourceOnDemand: false$/m);
});

test('on-demand can be enabled deliberately, once MediaMTX is upgraded', () => {
  const yml = webrtc.generateMediaMTXConfig(
    { ...SHIPPED, webrtc_camera_on_demand: true }, PARAMS());
  assert.match(yml, /^\s*sourceOnDemand: true$/m);
  assert.match(yml, /sourceOnDemandCloseAfter: 60s/, 'and it must stay warm between viewers');
});

test('the close-after window is clamped against the untracked overlay', () => {
  // invariant 8. Zero would tear the camera down the instant the last viewer left, turning a
  // reload into a restart mid-drive.
  const at = (v) => /sourceOnDemandCloseAfter: (\d+)s/.exec(webrtc.generateMediaMTXConfig(
    { ...SHIPPED, webrtc_camera_on_demand: true, webrtc_on_demand_close_after_s: v }, PARAMS()))[1];
  assert.equal(at(0), '60',    'zero must not mean "close immediately"');
  assert.equal(at(-5), '60');
  assert.equal(at(1), '10',    'clamped up to the floor');
  assert.equal(at(99999), '600', 'and down to the ceiling');
  assert.equal(at(120), '120', 'a sane value is honoured');
});

test('hardware-only encoder options are NOT emitted for a software encoder', () => {
  const sw = webrtc.generateMediaMTXConfig({ ...SHIPPED, _hasHardwareEncoder: false }, PARAMS());
  assert.doesNotMatch(sw, /rpiCameraHardwareH264Profile/);
  assert.doesNotMatch(sw, /rpiCameraHardwareH264Level/);
  const hw = webrtc.generateMediaMTXConfig({ ...SHIPPED, _hasHardwareEncoder: true }, PARAMS());
  assert.match(hw, /rpiCameraHardwareH264Profile: baseline/);
});

test('the config still renders whole with the hardware block omitted', () => {
  const sw = webrtc.generateMediaMTXConfig({ ...SHIPPED, _hasHardwareEncoder: false }, PARAMS());
  assert.match(sw, /^\s*rpiCameraBitrate: \d+$/m);
  assert.match(sw, /^\s*rpiCameraDenoise: \w+$/m);
  assert.doesNotMatch(sw, /\$\{/, 'an unsubstituted placeholder means the literal broke');
});

// ── Dead-source detection ────────────────────────────────────────────────────
//
// rover2's hardware encoder failed permanently on 2026-08-17: the path reported ready:true
// with bytesReceived FROZEN at 0 B/s while rover3 produced 46,840 B/s on identical hardware.
// MediaMTX advertises a path that delivers nothing, so a viewer gets a black screen and no
// error, and only a restart recovers it.

function apiSeq(responses) {
  // Serve a scripted sequence of API bodies, repeating the last one.
  let i = 0;
  return http.createServer((rq, rs) => {
    const body = responses[Math.min(i++, responses.length - 1)];
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify(body));
  });
}
const READY = (bytes) => ({ name: 'cam', ready: true, readers: [], bytesReceived: bytes });

test('a READY path with frozen bytes is declared dead and recovered', async () => {
  const port = nextPort++;
  const server = apiSeq([READY(100), READY(100), READY(100), READY(100), READY(100), READY(100)]);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  // `_restartFn` MUST be passed at construction. An earlier version assigned `s.__restart`
  // afterwards, which does nothing — so this test reached the stall threshold and called the
  // production restartMediamtx(), spawning a real `systemctl restart mediamtx`. `npm test` is
  // run on live rovers, where that drops active video and mutates host service state. No host
  // unit test may invoke systemctl. Found by adversarial review.
  const restarts = [];
  const s = mkStream({ webrtc_reader_poll_ms: 1000, mediamtx_api_port: port,
                       webrtc_source_stall_polls: 2,
                       _restartFn: () => restarts.push(Date.now()) });
  try {
    // The poll interval is floored at 1000 ms, so N stall polls need more than N+1 seconds.
    await new Promise((r) => setTimeout(r, 3600));
    const h = s.sourceHealth();
    assert.equal(h.dead, true, `frozen bytes on a ready path must be declared dead: ${JSON.stringify(h)}`);
    assert.ok(h.recoveries >= 1, 'and a recovery must have been attempted');
    assert.ok(restarts.length >= 1, 'through the injected stub, never a real systemctl');
  } finally { s.stop(); await new Promise((r) => server.close(r)); }
});

test('a path producing data is never declared dead', async () => {
  // The negative control. Without it, "dead" could be hardwired true and every healthy rover
  // would restart mediamtx in a loop.
  const port = nextPort++;
  const server = apiSeq([READY(100), READY(200), READY(300), READY(400), READY(500), READY(600)]);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const s = mkStream({ webrtc_reader_poll_ms: 1000, mediamtx_api_port: port,
                       webrtc_source_stall_polls: 2 });
  try {
    await new Promise((r) => setTimeout(r, 3600));
    const h = s.sourceHealth();
    assert.equal(h.dead, false, 'a healthy encoder must not be restarted');
    assert.equal(h.recoveries, 0);
  } finally { s.stop(); await new Promise((r) => server.close(r)); }
});

test('an ON-DEMAND idle camera is NOT mistaken for a dead one', async () => {
  // The guard that makes this safe alongside sourceOnDemand. With nobody watching the camera
  // is deliberately stopped and bytesReceived legitimately does not advance — but the path
  // reports ready:false. Without this check an idle rover would be declared dead and
  // restarted forever.
  const port = nextPort++;
  const server = apiSeq([{ name: 'cam', ready: false, readers: [], bytesReceived: 100 }]);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const s = mkStream({ webrtc_reader_poll_ms: 1000, mediamtx_api_port: port,
                       webrtc_source_stall_polls: 2,
                       // MUST be declared on-demand. Without this the test pinned the
                       // opposite defect: a failed always-on camera reported healthy.
                       webrtc_camera_on_demand: true,
                       _restartFn: () => {} });
  try {
    await new Promise((r) => setTimeout(r, 3600));
    const h = s.sourceHealth();
    assert.equal(h.dead, false, 'an idle on-demand camera is not a fault');
    assert.equal(h.recoveries, 0, 'and must never trigger a restart');
  } finally { s.stop(); await new Promise((r) => server.close(r)); }
});

test('recovery attempts are CAPPED so a broken rover is reported, not looped', async () => {
  // An endless restart loop hides a broken rover rather than fixing it, and takes the video
  // server down repeatedly while doing so.
  const port = nextPort++;
  const server = apiSeq([READY(100)]);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const restarts = [];
  const s = mkStream({ webrtc_reader_poll_ms: 1000, mediamtx_api_port: port,
                       webrtc_source_stall_polls: 2, webrtc_max_source_recoveries: 2,
                       // Injected so the CAP is what is under test rather than the timing of
                       // a spawned systemctl that does not exist on this host.
                       _restartFn: () => restarts.push(Date.now()) });
  try {
    // Each recovery cycle costs ~3 polls (reset, seed, stall, stall) at the 1000 ms floor, so
    // the window must be long enough that an UNCAPPED implementation would exceed 2. At 16 s
    // that is ~5 attempts — measured: removing the cap makes this test fail.
    await new Promise((r) => setTimeout(r, 16000));
    const h = s.sourceHealth();
    // The bound, not an exact count: restartMediamtx sets `restarting` until the spawned
    // child settles, which paces attempts unpredictably on a host with no mediamtx unit.
    // What must hold is that the cap is never exceeded — measured: removing the cap makes
    // this exceed 2 within this window.
    assert.equal(h.recoveries, 2, `recoveries must stop AT the cap, got ${h.recoveries}`);
    assert.equal(restarts.length, 2, 'and exactly that many restarts may be issued');
    assert.equal(h.maxRecoveries, 2);
  } finally { s.stop(); await new Promise((r) => server.close(r)); }
});

test('dead -> restart -> advancing bytes leaves the source reported healthy', async () => {
  const port = nextPort++;
  // Frozen long enough to be declared dead, then advancing again as a restart would produce.
  const seq = [READY(100), READY(100), READY(100), READY(100),
               READY(200), READY(300), READY(400), READY(500)];
  let i = 0;
  const server = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify(seq[Math.min(i++, seq.length - 1)]));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const restarts = [];
  const s = mkStream({ webrtc_reader_poll_ms: 1000, mediamtx_api_port: port,
                       webrtc_source_stall_polls: 2,
                       _restartFn: () => restarts.push(1) });
  try {
    await new Promise((r) => setTimeout(r, 3600));
    assert.equal(s.sourceHealth().dead, true, 'precondition: declared dead while frozen');
    await new Promise((r) => setTimeout(r, 4000));
    assert.equal(s.sourceHealth().dead, false,
      'once bytes advance again the fault must clear, or the rover reads broken forever');
  } finally { s.stop(); await new Promise((r) => server.close(r)); }
});

test('nonsense recovery settings cannot defeat BOTH guards', () => {
  // Math.max(2, "invalid") is NaN, and NaN fails both comparisons in the UNSAFE direction:
  // `stalledPolls < NaN` is false so a healthy path is declared dead immediately, and
  // `recoveryCount >= NaN` is false so the restart cap never engages — an endless restart
  // loop on a working rover. Both keys are reachable from the untracked overlay.
  for (const bad of ['invalid', {}, [], null, NaN, Infinity, -1, 0.5, 1e9]) {
    const s = mkStream({ mediamtx_api_port: nextPort++,
                         webrtc_source_stall_polls: bad, webrtc_max_source_recoveries: bad,
                         _restartFn: () => {} });
    try {
      const h = s.sourceHealth();
      assert.ok(Number.isInteger(h.maxRecoveries) && h.maxRecoveries >= 0 && h.maxRecoveries <= 20,
        `maxRecoveries became ${h.maxRecoveries} for ${JSON.stringify(bad)}`);
    } finally { s.stop(); }
  }
});

test('an ALWAYS-ON camera that never becomes ready is a FAULT, not idleness', async () => {
  // The shipped configuration is always-on, so `ready:false` means the camera failed to start
  // or disappeared — no viewer can get video. Clearing the fault there reported a broken rover
  // as healthy: dead:false, readersError:null, no recovery attempted. Same "reports healthy
  // while broken" shape this branch exists to remove, reproduced inside it.
  const port = nextPort++;
  const server = apiSeq([{ name: 'cam', ready: false, readers: [], bytesReceived: 0 }]);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const restarts = [];
  const s = mkStream({ webrtc_reader_poll_ms: 1000, mediamtx_api_port: port,
                       webrtc_source_stall_polls: 2,          // always-on: no on-demand flag
                       _restartFn: () => restarts.push(1) });
  try {
    await new Promise((r) => setTimeout(r, 4600));
    const h = s.sourceHealth();
    assert.equal(h.dead, true,
      `an always-on camera stuck not-ready must be a fault: ${JSON.stringify(h)}`);
    assert.ok(restarts.length >= 1, 'and recovery must be attempted');
  } finally { s.stop(); await new Promise((r) => server.close(r)); }
});

test('a malformed poll interval cannot become a 1 ms actuator', () => {
  // Math.max(1000, "invalid") is NaN, and Node schedules a NaN interval at 1 ms: an HTTP GET
  // every millisecond on the event loop carrying the override stream and the watchdog, AND a
  // stall detector that counts samples rather than elapsed time would declare a healthy
  // encoder dead and restart MediaMTX. One malformed overlay key, two failures.
  for (const bad of ['invalid', {}, [], NaN, Infinity, null, -1, 0]) {
    const s = mkStream({ mediamtx_api_port: nextPort++, webrtc_reader_poll_ms: bad,
                         _restartFn: () => {} });
    try {
      const ms = s.pollIntervalMs();
      assert.ok(Number.isFinite(ms) && ms >= 1000 && ms <= 60000,
        `poll interval became ${ms} for ${JSON.stringify(bad)}`);
    } finally { s.stop(); }
  }
});

test('a successfully recovered incident does not consume the budget forever', async () => {
  // The cap bounds ONE restart loop. Spending it across a process lifetime meant three
  // separate, successfully-recovered stalls disabled recovery permanently, so a later
  // recoverable stall stayed black until someone intervened.
  const port = nextPort++;
  const seq = [READY(100), READY(100), READY(100), READY(100)]
    .concat(Array.from({ length: 14 }, (_, k) => READY(200 + k * 100)));
  let i = 0;
  const server = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify(seq[Math.min(i++, seq.length - 1)]));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const s = mkStream({ webrtc_reader_poll_ms: 1000, mediamtx_api_port: port,
                       webrtc_source_stall_polls: 2, webrtc_healthy_polls_to_reset: 3,
                       _restartFn: () => {} });
  try {
    await new Promise((r) => setTimeout(r, 3600));
    assert.ok(s.sourceHealth().recoveries >= 1, 'precondition: an incident was recovered');
    await new Promise((r) => setTimeout(r, 6000));
    const h = s.sourceHealth();
    assert.equal(h.recoveries, 0, 'a sustained healthy run must free the budget for next time');
    assert.ok(h.totalRecoveries >= 1, 'while the lifetime figure is kept for observability');
  } finally { s.stop(); await new Promise((r) => server.close(r)); }
});
