'use strict';

// A crash must stop the vehicle before the process dies.
//
// app.js registered only process.on('SIGINT'), so a fail-safe ran on a polite shutdown and
// on nothing else. Any uncaught exception ended the process with the channel buffer still
// holding the last commanded throttle, and NO neutral RC_CHANNELS_OVERRIDE packet and no
// DISARM ever reached the link. Invariant 6 lists "process shutdown" as a path that must
// put neutral on the wire first; only half of it was covered.
//
// And it was reachable without authentication: node-static's finish() calls
// res.writeHead() again after a 206 has streamed, so
//   curl -k -H 'Range: bytes=0-99' https://rover:8443/socket.html
// throws ERR_HTTP_HEADERS_SENT out of the request handler. Reproduced locally against the
// same node-static the rovers run. With Restart=always that was a crash-restart loop, each
// cycle leaving the vehicle armed with throttle applied — on a rover with a flight battery
// and a flight controller that ignores DISARM.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { installCrashFailSafe, stripRangeHeader } = require('../crash-failsafe');

// A stand-in for `process` that records handlers instead of installing them.
function fakeProc() {
  const handlers = {};
  return {
    handlers,
    on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); },
    exitCalls: [],
    exit(code) { this.exitCalls.push(code); },
  };
}

function harness({ failSafeStop, stopStream } = {}) {
  const proc = fakeProc();
  const calls = { stops: [], streamStops: 0, logs: [], exits: [], timers: [] };
  const api = installCrashFailSafe({
    proc,
    failSafeStop: failSafeStop || ((reason) => calls.stops.push(reason)),
    stopStream: stopStream || (() => { calls.streamStops += 1; }),
    log: (...a) => calls.logs.push(a.join(' ')),
    exit: (code) => calls.exits.push(code),
    setTimeoutFn: (fn, ms) => { calls.timers.push(ms); fn(); return { unref() {} }; },
  });
  return { proc, calls, api };
}

// ── The handler must be installed at all ─────────────────────────────────────

test('both fatal events are handled, not just uncaughtException', () => {
  // An unhandled rejection is fatal by default in Node 15+ and reaches the same place:
  // the process ends with no fail-safe unless it is handled too.
  const { proc } = harness();
  assert.ok(proc.handlers.uncaughtException, 'uncaughtException must be handled');
  assert.ok(proc.handlers.unhandledRejection, 'unhandledRejection must be handled');
});

test('an uncaught exception runs the fail-safe BEFORE exiting', () => {
  const { proc, calls } = harness();
  proc.handlers.uncaughtException[0](new Error('boom'));
  assert.equal(calls.stops.length, 1, 'failSafeStop must run');
  assert.match(calls.stops[0], /fatal uncaughtException/);
  assert.deepEqual(calls.exits, [1], 'and then exit non-zero so systemd sees a failure');
});

test('an unhandled rejection runs the fail-safe too', () => {
  const { proc, calls } = harness();
  proc.handlers.unhandledRejection[0](new Error('nope'));
  assert.equal(calls.stops.length, 1);
  assert.match(calls.stops[0], /fatal unhandledRejection/);
});

test('the fail-safe runs before the exit, not after', () => {
  // Ordering is the whole point: exiting first would leave the last throttle on the wire.
  const order = [];
  const proc = fakeProc();
  installCrashFailSafe({
    proc,
    failSafeStop: () => order.push('stop'),
    log: () => {},
    exit: () => order.push('exit'),
    setTimeoutFn: (fn) => { fn(); return { unref() {} }; },
  });
  proc.handlers.uncaughtException[0](new Error('x'));
  assert.deepEqual(order, ['stop', 'exit'],
    'neutral must reach the wire before the process goes away');
});

// ── It must survive its own failure modes ────────────────────────────────────

test('a throwing failSafeStop still exits instead of hanging or recursing', () => {
  // If the stop throws and we did not catch it, the handler would re-enter itself and
  // recurse instead of dying — leaving the vehicle armed with throttle applied, which is
  // exactly the outcome this exists to prevent.
  const { proc, calls } = harness({
    failSafeStop: () => { throw new Error('driver is gone'); },
  });
  proc.handlers.uncaughtException[0](new Error('boom'));
  assert.deepEqual(calls.exits, [1], 'must still exit');
  assert.ok(calls.logs.some((l) => /failSafeStop threw/.test(l)),
    'and must say so rather than swallowing it');
});

test('a throwing stopStream does not prevent the exit', () => {
  const { proc, calls } = harness({ stopStream: () => { throw new Error('mediamtx'); } });
  proc.handlers.uncaughtException[0](new Error('boom'));
  assert.equal(calls.stops.length, 1, 'the vehicle stop must already have happened');
  assert.deepEqual(calls.exits, [1]);
});

test('re-entry exits immediately instead of looping', () => {
  const proc = fakeProc();
  const exits = [];
  let depth = 0;
  installCrashFailSafe({
    proc,
    // Simulate the stop itself raising another fatal event.
    failSafeStop: () => {
      depth += 1;
      if (depth < 3) proc.handlers.uncaughtException[0](new Error('again'));
    },
    log: () => {},
    exit: (c) => exits.push(c),
    setTimeoutFn: (fn) => { fn(); return { unref() {} }; },
  });
  proc.handlers.uncaughtException[0](new Error('first'));
  assert.ok(depth <= 2, `must not recurse indefinitely, depth=${depth}`);
  assert.ok(exits.length >= 1, 'and must exit');
});

test('it refuses to install without a fail-safe to call', () => {
  // A silent no-op install would look like protection and provide none.
  assert.throws(() => installCrashFailSafe({ proc: fakeProc() }), /requires failSafeStop/);
});

// ── The prevention half ──────────────────────────────────────────────────────

test('Range and If-Range are removed before node-static sees them', () => {
  const req = { headers: { range: 'bytes=0-99', 'if-range': 'x', accept: '*/*' } };
  assert.equal(stripRangeHeader(req), true, 'must report that it stripped something');
  assert.equal(req.headers.range, undefined);
  assert.equal(req.headers['if-range'], undefined);
  assert.equal(req.headers.accept, '*/*', 'and must not touch anything else');
});

test('a request with no Range is left alone and reports nothing', () => {
  const req = { headers: { accept: '*/*' } };
  assert.equal(stripRangeHeader(req), false, 'no log line for ordinary requests');
  assert.deepEqual(req.headers, { accept: '*/*' });
});

test('stripRangeHeader tolerates malformed requests', () => {
  // It runs on the request path; throwing here would be the crash it exists to prevent.
  assert.equal(stripRangeHeader(undefined), false);
  assert.equal(stripRangeHeader({}), false);
  assert.equal(stripRangeHeader({ headers: null }), false);
});

// ── End to end: the actual crash, against the real node-static ───────────────

test('a Range request no longer crashes the static handler', async () => {
  // The regression test for the reported defect, driven through real HTTP against the same
  // node-static the rovers run. Without the strip this throws ERR_HTTP_HEADERS_SENT out of
  // the request handler; with it the response is an ordinary 200.
  const http   = require('http');
  const fs     = require('fs');
  const os     = require('os');
  const path   = require('path');
  const staticServer = require('node-static');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picar-range-'));
  fs.writeFileSync(path.join(dir, 'socket.html'), 'x'.repeat(50000));
  const file = new staticServer.Server(dir);

  let thrown = null;
  const srv = http.createServer((req, res) => {
    try {
      stripRangeHeader(req);
      file.serve(req, res);
    } catch (err) { thrown = err; res.end(); }
  });
  // Catch the asynchronous throw too — node-static's double writeHead happens after the
  // body has streamed, so it does not surface from the call above.
  const onErr = (err) => { thrown = err; };
  process.on('uncaughtException', onErr);

  try {
    await new Promise((resolve) => srv.listen(0, resolve));
    const port = srv.address().port;
    const status = await new Promise((resolve, reject) => {
      http.get({ port, path: '/socket.html', headers: { Range: 'bytes=0-99' } }, (res) => {
        res.resume();
        res.on('end', () => setTimeout(() => resolve(res.statusCode), 60));
      }).on('error', reject);
    });
    assert.equal(thrown, null,
      `a Range request must not throw: ${thrown && thrown.code}`);
    assert.equal(status, 200,
      'the 206 path is what double-writes the header, so it must not be taken');
  } finally {
    process.removeListener('uncaughtException', onErr);
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The consumer, because the rule alone was not enough ──────────────────────

test('serveStatic strips Range and then delegates', () => {
  // Surviving mutation while this was inline in app.js: skip the strip entirely. The rule
  // was tested, its only caller was not — the shape that has now recurred on four branches
  // of this repo.
  const { serveStatic } = require('../crash-failsafe');
  const served = [];
  const logs = [];
  const file = { serve: (req, res) => { served.push([req, res]); return 'served'; } };
  const req = { method: 'GET', url: '/socket.html', headers: { range: 'bytes=0-99' } };
  const res = {};

  const out = serveStatic(file, req, res, { log: (m) => logs.push(m), describe: () => '/socket.html' });
  assert.equal(req.headers.range, undefined, 'Range must be gone before node-static sees it');
  assert.equal(served.length, 1, 'and the request must still be served');
  assert.equal(served[0][1], res);
  assert.equal(out, 'served', 'the return value must be passed through');
  assert.equal(logs.length, 1, 'a stripped Range is worth seeing on the control port');
  assert.match(logs[0], /Range/);
});

test('serveStatic is silent for ordinary requests', () => {
  const { serveStatic } = require('../crash-failsafe');
  const logs = [];
  let servedCount = 0;
  serveStatic({ serve: () => { servedCount += 1; } },
    { method: 'GET', url: '/', headers: {} }, {}, { log: (m) => logs.push(m) });
  assert.equal(logs.length, 0, 'no log line for the normal case');
  assert.equal(servedCount, 1);
});

test('a throwing logger cannot stop the response being served', () => {
  const { serveStatic } = require('../crash-failsafe');
  let servedCount = 0;
  assert.doesNotThrow(() => serveStatic(
    { serve: () => { servedCount += 1; } },
    { method: 'GET', url: '/x', headers: { range: 'bytes=0-1' } }, {},
    { log: () => { throw new Error('log broke'); } }));
  assert.equal(servedCount, 1, 'the request must still be served');
});

test('app.js installs the crash fail-safe and uses serveStatic', () => {
  // Source-level, and deliberately so: app.js binds two HTTPS ports and the MAVProxy
  // socket at require time, so it cannot be loaded here. This is the deletion-catching
  // kind of source assertion, not the kind that restates a rule in a second notation — the
  // two mutations it exists for are "remove the call" and "stop using the wrapper", both of
  // which survived everything else in this file.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(src, /^installCrashFailSafe\(\{/m,
    'app.js must install the crash fail-safe at top level, unconditionally');
  assert.match(src, /failSafeStop,/,
    'and hand it the real failSafeStop, not a stub');
  assert.match(src, /serveStatic\(file, req, res/,
    'static requests must go through serveStatic so Range is stripped');
  assert.doesNotMatch(src, /(?<!\/\/[^\n]*)\bfile\.serve\(req, res\)/,
    'nothing may bypass serveStatic by calling file.serve directly');
});
