'use strict';

// The gate that decides whether the on-target script may command motion on rover3.
//
// It used to decide from the battery reading: `voltageV > 3` meant a pack was present and the
// run was refused; ANY other reading fell through and commanded motion. rover3's analog voltage
// sense is broken — /status reports 0.007 V while current reports 0.54 A — so the gate concluded
// "no pack" and opened, with no flag required, on a vehicle with a pack installed, armed
// continuously, whose flight controller refuses DISARM. FOUR of the five readings rover3 can
// produce opened it, including the exact `3.0` boundary a strict `> 3` lets through.
//
// A dead sensor read as a safety certificate. This file exists so that cannot come back.
//
// It drives the REAL exported functions, and runs the REAL script against a local stub that
// RECORDS REQUEST BODIES — so "no motion was commanded" is asserted on the wire rather than
// inferred from the absence of a log line. That distinction is the repo's own invariant-6
// lesson: a mock that records calls cannot see the defect.

const test    = require('node:test');
const assert  = require('node:assert');
const path    = require('node:path');
const fs      = require('node:fs');
const { execFile } = require('node:child_process');
const {
  assertSafeToCommand, motionFlagGiven, withDeadline, hardwareReadyForMotion,
} = require('./on-target/control-e2e.js');

const SCRIPT   = path.join(__dirname, 'on-target', 'control-e2e.js');
const KEY_PATH = path.join(__dirname, '..', 'certs', 'key.pem');
const CRT_PATH = path.join(__dirname, '..', 'certs', 'cert.pem');

const READINGS = {
  'the broken sense measured on rover3': { battery: { voltageV: 0.007, currentA: 0.54, remainingPct: 95, pctSource: 'flightcontroller' }, openedOldGate: true },
  'the exact 3.0 boundary':              { battery: { voltageV: 3.0,   currentA: 0.2,  remainingPct: 5,  pctSource: 'voltage' }, openedOldGate: true },
  'an exactly-zero reading':             { battery: { voltageV: 0,     currentA: 0,    remainingPct: 0,  pctSource: 'voltage' }, openedOldGate: true },
  'a null voltage':                      { battery: { voltageV: null,  currentA: null, remainingPct: null, pctSource: null }, openedOldGate: true },
  'a healthy pack':                      { battery: { voltageV: 7.905, currentA: 0.42, remainingPct: 77, pctSource: 'voltage' }, openedOldGate: false },
  'a mis-scaled 40 V reading':           { battery: { voltageV: 40,    currentA: 0.42, remainingPct: 77, pctSource: 'voltage' }, openedOldGate: false },
  'a string voltage (schema violation)': { battery: { voltageV: '7.905', currentA: '0.42', remainingPct: 77, pctSource: 'voltage' }, openedOldGate: false },
};

function harness(battery, { status = 200, throws = null, hang = false } = {}) {
  const out = [], calls = [];
  return {
    out, calls,
    deps: {
      req: async (method, reqPath, body, opts) => {
        calls.push({ method, path: reqPath, opts });
        if (hang) return new Promise(() => {});      // never settles
        if (throws) throw new Error(throws);
        return { status, body: JSON.stringify({ telemetry: battery === null ? null : { battery } }) };
      },
      log: (m) => out.push(m),
    },
  };
}

// ── The battery must never authorise ─────────────────────────────────────────

test('NO battery reading can authorise motion without the flag', async () => {
  for (const [label, { battery }] of Object.entries(READINGS)) {
    const h = harness(battery);
    assert.equal(await assertSafeToCommand(false, h.deps), false,
      `${label} authorised motion with no --allow-motion flag`);
    assert.match(h.out.join('\n'), /MOTION NOT AUTHORISED/);
  }
});

test('the flag is the only thing the BATTERY gate consults', async () => {
  for (const [label, { battery }] of Object.entries(READINGS)) {
    const h = harness(battery);
    assert.equal(await assertSafeToCommand(true, h.deps), true, `${label} blocked despite the flag`);
    assert.match(h.out.join('\n'), /THE WHEELS CAN TURN/);
  }
});

test('the old voltage>3 rule would have opened the gate on four of seven readings', async () => {
  let opened = 0;
  for (const [label, { battery, openedOldGate }] of Object.entries(READINGS)) {
    const live = battery && battery.voltageV != null && battery.voltageV > 3;
    assert.equal(!live, openedOldGate, `${label}: old-rule expectation is wrong`);
    if (!live) opened++;
    const h = harness(battery);
    assert.equal(await assertSafeToCommand(false, h.deps), false, `${label} must be refused now`);
  }
  assert.equal(opened, 4, 'the old rule opened on exactly four of these readings');
});

test('the guard requests GET /status and nothing else', async () => {
  const h = harness(READINGS['a healthy pack'].battery);
  await assertSafeToCommand(true, h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'GET');
  assert.equal(h.calls[0].path, '/status');
  assert.ok(h.calls[0].opts && h.calls[0].opts.timeoutMs > 0, 'socket timeout must be requested');
});

test('a non-200 response is not treated as a battery record', async () => {
  const h = harness(READINGS['a healthy pack'].battery, { status: 503 });
  await assertSafeToCommand(true, h.deps);
  assert.match(h.out.join('\n'), /HTTP 503/);
  assert.doesNotMatch(h.out.join('\n'), /7\.905 V/);
});

test('an unreadable /status refuses rather than proceeding', async () => {
  for (const msg of ['ECONNREFUSED', 'response aborted']) {
    const h = harness(null, { throws: msg });
    assert.equal(await assertSafeToCommand(false, h.deps), false);
    assert.match(h.out.join('\n'), new RegExp(msg.split(' ')[0]));
  }
});

test('a /status that NEVER SETTLES hits an absolute deadline, not an inactivity timeout', async () => {
  // r.setTimeout is socket-INACTIVITY based, so a response trickling one byte every 4 s
  // postpones it forever and the gate hangs — neither a refusal nor an authorisation. A
  // reviewer showed the previous version's only timeout assertion was that the CALLER passed
  // an option, so deleting the real timer survived.
  const h = harness(null, { hang: true });
  // Raced against a timer this test owns, deliberately NOT unref'd. Without it, removing the
  // guard's deadline leaves nothing holding the event loop open, Node exits mid-file, and the
  // run reports "not ok" lines with "# fail 0" — an abnormal exit that is detected but reads
  // ambiguously. Owning the timer turns that into a clean, named assertion failure.
  const TIMED_OUT = Symbol('test-timeout');
  let guardTimer;
  const raced = await Promise.race([
    assertSafeToCommand(false, h.deps),
    new Promise((r) => { guardTimer = setTimeout(() => r(TIMED_OUT), 12000); }),
  ]);
  clearTimeout(guardTimer);
  assert.notEqual(raced, TIMED_OUT,
    'the guard never returned — it does not enforce its own deadline on a hanging /status');
  assert.equal(raced, false, 'a hanging /status must refuse');
  assert.match(h.out.join('\n'), /deadline/, 'and must say the deadline was exceeded');
});

test('withDeadline rejects a promise that never settles, and passes one that does', async () => {
  await assert.rejects(() => withDeadline(new Promise(() => {}), 50, 'probe'), /deadline/);
  assert.equal(await withDeadline(Promise.resolve('v'), 50, 'probe'), 'v');
});

test('both plausibility bounds are enforced, and a string voltage is not coerced', async () => {
  for (const label of ['the broken sense measured on rover3', 'a mis-scaled 40 V reading',
                       'a string voltage (schema violation)']) {
    const h = harness(READINGS[label].battery);
    await assertSafeToCommand(true, h.deps);
    assert.match(h.out.join('\n'), /IMPLAUSIBLE/, `${label} must be flagged`);
  }
  const good = harness(READINGS['a healthy pack'].battery);
  await assertSafeToCommand(true, good.deps);
  assert.doesNotMatch(good.out.join('\n'), /IMPLAUSIBLE/);
});

test('the whole reading is reported, not just the voltage', async () => {
  const h = harness(READINGS['a healthy pack'].battery);
  await assertSafeToCommand(false, h.deps);
  for (const frag of ['7.905 V', '0.42 A', '77%', 'voltage']) {
    assert.ok(h.out.join('\n').includes(frag), `the reading must include ${frag}`);
  }
});

// ── The flag must be an exact token, and not honoured after `--` ─────────────

test('--allow-motion is an exact token and is ignored after the option terminator', () => {
  const argv = (...a) => ['node', 'control-e2e.js', ...a];
  assert.equal(motionFlagGiven(argv('--allow-motion')), true);
  assert.equal(motionFlagGiven(argv('-v', '--allow-motion')), true);
  assert.equal(motionFlagGiven(argv()), false);
  // A positional argument that merely looks like the flag must NOT authorise motion: a wrapper
  // doing `node control-e2e.js -- "$label"` would otherwise arm from data.
  assert.equal(motionFlagGiven(argv('--', '--allow-motion')), false,
    'a token after `--` is positional data, not authorisation');
  // Near-misses. `startsWith` would accept the first of these, which reads as a REFUSAL.
  assert.equal(motionFlagGiven(argv('--allow-motion=false')), false);
  assert.equal(motionFlagGiven(argv('--allow-motionx')), false);
  assert.equal(motionFlagGiven(argv('allow-motion')), false);
});

// ── Invariant 7, enforced locally ────────────────────────────────────────────

test('unverified critical parameters refuse motion even WITH the flag', () => {
  // The state in which commanding is least safe was the one the flag waved through: the
  // read-only checks would detect params.missing, record a failure, and arm anyway. Wrong
  // parameters are exactly what routes steering onto the throttle output.
  // A live link and a fresh autopilot heartbeat are checked FIRST, so every fixture below
  // supplies them except where it is the thing under test. Invariant 7 names both, and the
  // first version of this function checked neither — which meant the recorded MAVProxy wedge
  // (socket open, heartbeat stale, parameters still marked verified) passed it.
  const LIVE = { linkUp: true, autopilotHeartbeat: true, fcSupported: true };
  const OK_PARAMS = { missing: [], verified: [...EXPECTED_NAMES], mismatched: {} };
  const bad = [
    [undefined,                                                       /no telemetry frame/],
    [{ ...LIVE, linkUp: false, params: OK_PARAMS },                   /linkUp is false/],
    [{ ...LIVE, linkUp: undefined, params: OK_PARAMS },               /linkUp is/],
    [{ ...LIVE, autopilotHeartbeat: false, params: OK_PARAMS },       /no fresh autopilot heartbeat/],
    [{ ...LIVE, autopilotHeartbeat: undefined, params: OK_PARAMS },   /no fresh autopilot heartbeat/],
    [{ ...LIVE, fcSupported: false, params: OK_PARAMS },              /fcSupported is false/],
    [{ ...LIVE, params: null },                                       /no usable params block/],
    [{ ...LIVE, params: { missing: ['FRAME_CLASS'], verified: [], mismatched: {} } },
                                                                      /unverified critical parameters/],
    // ZERO verified is not "nothing missing": an empty expectation makes missing:[] trivially
    // true, and an earlier version returned ready with 0 parameters proven.
    [{ ...LIVE, params: { missing: [], verified: [], mismatched: {} } },
                                                                      /are not verified/],
    [{ ...LIVE, params: { missing: [], verified: ['FRAME_CLASS'], mismatched: {} } },
                                                                      /are not verified/],
    [{ ...LIVE, fcSupported: undefined, params: OK_PARAMS },           /fcSupported is/],
    [{ ...LIVE, params: { missing: [], verified: [...EXPECTED_NAMES], mismatched: 'x' } },
                                                                      /not an object/],
    // MISMATCHED is independent of MISSING: a parameter read back with the WRONG value is how
    // rover3 ran as a boat while read-back reported it verified.
    [{ ...LIVE, params: { missing: [], verified: ['FRAME_CLASS'],
                          mismatched: { FRAME_CLASS: { actual: 2, expected: 1 } } } },
                                                                      /mismatched critical parameters/],
  ];
  for (const [frame, why] of bad) {
    const r = hardwareReadyForMotion(frame);
    assert.equal(r.ready, false, `${JSON.stringify(frame)} must not be motion-ready`);
    assert.match(r.why, why, `wrong reason for ${JSON.stringify(frame)}: ${r.why}`);
  }
  const good = hardwareReadyForMotion({ ...LIVE, params: OK_PARAMS });
  assert.equal(good.ready, true, `a healthy frame must be ready, got: ${good.why}`);
  assert.match(good.why, new RegExp(`all ${EXPECTED_NAMES.length} expected`));
});

// ── The real script, against a stub that records what it was actually sent ───

// Serves just enough Engine.IO v4 polling for the script to reach the motion branch, and RECORDS
// EVERY REQUEST BODY. Without the recording, "no motion was commanded" rested on the absence of
// a log line — so moving the ARM POST above the branch while leaving `ok('arm sent')` inside it
// sent ARM and still printed every SKIP line, with the test green.
// `degradeStatusAfter` makes /status return `telemetry` merged with `degradeTo` from that read
// onward. Without it the stub answers identically every time, so the script's re-check before its
// second ARM can never disagree with its first decision — and dropping that re-check entirely
// leaves the suite green. Measured: that mutation survived until this option existed.
// `degradeUntil` makes the degradation TRANSIENT: reads in (degradeStatusAfter, degradeUntil]
// are degraded and later ones recover. Without a transient case the link-lost latch is
// untestable — a permanently degraded stub makes every section refuse on its own, so removing
// the latch changes nothing. Measured: that mutation survived until this existed.
function startStub({ telemetry, degradeStatusAfter = Infinity, degradeUntil = Infinity,
                     degradeTo = {}, stallStatusAfter = Infinity,
                     watchdogFires = true, stopWorks = true, fromclientWorks = true } = {}) {
  const https = require('node:https');
  const bodies = [];
  const pendingAcks = [];
  // MODEL THE SERVER'S COMMANDED STATE, rather than returning a constant. /status reports what
  // app.js currently commands: a `fromclient` sets it, the input watchdog returns it to neutral
  // after input_timeout_ms of silence, and `disarm` zeroes it. Returning a constant made the
  // script's checks unfalsifiable in both directions — a run could "observe" a watchdog that
  // was never armed. `watchdogFires` and `stopWorks` are the two negative controls.
  let cmdSteering = 0, cmdThrottle = 0;
  let lastCmdAt = 0;
  const INPUT_TIMEOUT_MS = 1000;
  const commanded = () => {
    if (watchdogFires && lastCmdAt && (Date.now() - lastCmdAt) > INPUT_TIMEOUT_MS) {
      return { steering: 0, throttle: 0 };
    }
    return { steering: cmdSteering, throttle: cmdThrottle };
  };
  let statusReads = 0;
  const server = https.createServer(
    { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CRT_PATH) },
    (rq, rs) => {
      let raw = '';
      rq.on('data', (c) => { raw += c; });
      rq.on('end', () => {
        if (raw) bodies.push(raw);
        // /status must answer as /status, not as an Engine.IO handshake — the script re-reads it
        // to re-check hardware readiness before its second ARM.
        if (rq.url.startsWith('/status')) {
          statusReads += 1;
          // Accept the request, send NOTHING, and never end it. A socket-inactivity timeout
          // cannot be relied on to fire here, which is the point: only an absolute deadline
          // ends this. Left dangling deliberately; the server is destroyed at test end.
          if (statusReads > stallStatusAfter) return;
          const degraded = statusReads > degradeStatusAfter && statusReads <= degradeUntil;
          const t = telemetry ? (degraded ? { ...telemetry, ...degradeTo } : telemetry) : null;
          rs.writeHead(200, { 'Content-Type': 'application/json' });
          const c = commanded();
          return rs.end(JSON.stringify({ status: 'OK', throttle: c.throttle,
                                         steering: c.steering, telemetry: t }));
        }
        if (rq.method === 'GET' && !/[?&]sid=/.test(rq.url)) {
          rs.writeHead(200, { 'Content-Type': 'text/plain' });
          return rs.end('0' + JSON.stringify({ sid: 'stubsid0000', upgrades: [],
                                               pingInterval: 25000, pingTimeout: 20000 }));
        }
        // ACK any event that asked for one. Without this the authorised-healthy run always
        // exits 1 because setDrivetrain times out, which made the clean-PASS path unreachable by
        // the entire suite — a red team showed process.exit(0) could be changed to exit(1) with
        // nothing failing. `42<ackId>[...]` is answered with `43<ackId>[...]`.
        if (rq.method === 'POST' && /^42/.test(raw) && raw.indexOf('[') > 0) {
          const [name, payload] = JSON.parse(raw.slice(raw.indexOf('[')));
          if (name === 'fromclient' && payload && fromclientWorks) {
            cmdSteering = payload.steering ?? 0;
            cmdThrottle = payload.throttle ?? 0;
            lastCmdAt = Date.now();
          }
          if (name === 'disarm' && stopWorks) { cmdSteering = 0; cmdThrottle = 0; lastCmdAt = 0; }
        }
        if (rq.method === 'POST' && /^42\d/.test(raw)) {
          const id = raw.slice(2, raw.indexOf('['));
          const [name, payload] = JSON.parse(raw.slice(raw.indexOf('[')));
          // Mirror the server's contract: reject a non-endpoint shift, apply shift: 1.
          const ok = name !== 'setDrivetrain' || (payload && payload.shift === 1);
          pendingAcks.push('43' + id + JSON.stringify([ok ? { ok: true, shift: 1 }
                                                          : { ok: false, error: 'invalid shift' }]));
        }
        rs.writeHead(200, { 'Content-Type': 'text/plain' });
        // Feed the initial events the script looks for, so it reaches the motion branch with a
        // telemetry frame we control.
        if (rq.method === 'GET' && telemetry) {
          const frames = ['42' + JSON.stringify(['streamConfig', {}]),
                          '42' + JSON.stringify(['telemetryConfig', { telemetryIntervalMs: 1000 }]),
                          '42' + JSON.stringify(['telemetry', telemetry])];
          while (pendingAcks.length) frames.push(pendingAcks.shift());
          return rs.end(frames.join('\x1e'));
        }
        rs.end('');
      });
    });
  return { server, bodies };
}

// DECODE what was sent, rather than substring-matching the raw bodies. A lexical scan for
// '"arm"' is defeated by JSON escaping: a real Engine.IO server splits on \x1e and JSON-decodes
// `42["arm"]` to the event name `arm`, invoking the ARM handler, while
// `body.includes('"arm"')` is false. A reviewer found exactly that evasion.
function eventsSent(bodies) {
  const names = [];
  for (const raw of bodies) {
    for (const packet of raw.split('\x1e')) {
      if (!packet.startsWith('4')) continue;              // Engine.IO MESSAGE
      // Socket.IO packet types: 2 EVENT, 3 ACK, 5 BINARY_EVENT, 6 BINARY_ACK.
      //
      // BINARY_EVENT is the one that mattered. A reviewer showed `40\x1e450-["arm"]` decodes on
      // a real server as a namespace connect followed by a ZERO-ATTACHMENT binary event, which
      // Socket.IO converts to an ordinary `arm` event — invoking the ARM handler. The previous
      // decoder matched only /^4[23]/, so that one-line mutation of the namespace-connect POST
      // could ARM a live rover while the absence assertion here stayed green.
      if (!/^4[2356]/.test(packet)) continue;
      const br = packet.indexOf('[');
      // A message packet with no payload array is not "no event" — it is one this decoder
      // cannot read, and treating it as absent is how the BINARY_EVENT evasion worked.
      if (br === -1) { names.push(`UNDECODABLE:${packet.slice(0, 24)}`); continue; }
      try {
        const arr = JSON.parse(packet.slice(br));
        if (Array.isArray(arr) && typeof arr[0] === 'string') names.push(arr[0]);
      } catch {
        // An undecodable message packet is not "no event" — it is an event this decoder cannot
        // read, and treating it as absent is exactly how the evasion above worked. Surface it
        // so an absence assertion cannot pass on a packet nobody understood.
        names.push(`UNDECODABLE:${packet.slice(0, 24)}`);
      }
    }
  }
  return names;
}

// Every event that changes vehicle state. setLight is included: it drives RC channel 6.
const STATE_CHANGING = ['arm', 'fromclient', 'setDrivetrain', 'disarm', 'setLight'];

// Runs the real script against the stub. MUST be async: execFileSync blocks this process's event
// loop, so the stub could never accept a connection and every child request failed — which looked
// exactly like "the script cannot get past its handshake" rather than a harness bug.
async function runScript(args, stubOpts = {}) {
  const { server, bodies } = startStub(stubOpts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  assert.ok(port > 0, 'the stub must be listening before the child is spawned');
  try {
    const result = await new Promise((resolve) => {
      execFile(process.execPath, [SCRIPT, ...args], {
        encoding: "utf8", timeout: 120000,
        env: { ...process.env, PICAR_E2E_PORT: String(port) },
      }, (err, out, errOut) => resolve({ err, stdout: (out || '') + (errOut || '') }));
    });
    // A timeout kill would otherwise let partial output satisfy every assertion — a hang read as
    // a pass, which is the trap this whole file exists to avoid.
    assert.notEqual(result.err && result.err.killed, true,
      `the script was KILLED on timeout rather than exiting; output so far:\n${result.stdout}`);
    return { ...result, bodies, code: result.err ? result.err.code : 0 };
  } finally {
    // A stalled /status leaves a live socket, and close() waits for it forever — the teardown
    // itself would hang, which reads as a pass.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

// Every name the driver actually expects. A fixture that verifies ONE parameter is not a
// healthy rover — and treating it as one is what let a zero-verified frame authorise motion.
const EXPECTED_NAMES = Object.keys(
  require('../pwm_mavproxy_servo.js').EXPECTED_CRITICAL_PARAMS);

const OK_TELEMETRY = { linkUp: true, autopilotHeartbeat: true, fcSupported: true,
                       battery: { voltageV: 7.9, currentA: 0.4, remainingPct: 77, pctSource: 'voltage' },
                       params: { missing: [], verified: [...EXPECTED_NAMES], mismatched: {} } };

test('certs for the stub must be present — this test may not silently skip', () => {
  // A self-skipping test guarding a P0 is protection that disappears the moment the tracked keys
  // are untracked (an open P0 of its own). If that lands, this fails loudly and whoever does it
  // has to provide a fixture instead of losing the coverage silently.
  assert.ok(fs.existsSync(KEY_PATH) && fs.existsSync(CRT_PATH),
    'certs/key.pem and certs/cert.pem are gone — replace the stub fixture rather than skipping ' +
    'the only test that reaches the real caller branch');
});

test('without the flag: the script runs, skips motion, and SENDS NO MOTION COMMAND', async () => {
  const r = await runScript([], { telemetry: OK_TELEMETRY });

  assert.match(r.stdout, /MOTION NOT AUTHORISED/, 'the gate did not run');
  assert.match(r.stdout, /== Arm and drive == SKIPPED/, 'the caller did not branch');
  assert.match(r.stdout, /== setLight == SKIPPED/, 'setLight is not read-only and must be gated');
  assert.match(r.stdout, /E2E INCOMPLETE/, 'an incomplete run must not report a pass');
  assert.equal(r.code, 4, 'an incomplete run must exit 4, not 0');

  // Decoded from the wire, not substring-matched.
  const sent = eventsSent(r.bodies);
  for (const event of STATE_CHANGING) {
    assert.ok(!sent.includes(event),
      `${event} was SENT without --allow-motion; decoded events: ${JSON.stringify(sent)}`);
  }
});

test('WITH the flag but unverified parameters: still no motion command, and it FAILS', async () => {
  // Invariant 7 end to end. Safe to pass --allow-motion here only because PICAR_E2E_PORT points
  // at the stub, which is asserted to be listening before the child starts.
  const r = await runScript(['--allow-motion'], {
    telemetry: { ...OK_TELEMETRY, params: { missing: ['FRAME_CLASS'], verified: [], mismatched: {} } },
  });

  assert.match(r.stdout, /REFUSING MOTION DESPITE --allow-motion/,
    'the flag overrode known-bad flight-controller state');
  assert.match(r.stdout, /unverified critical parameters/);
  assert.match(r.stdout, /== Arm and drive == SKIPPED/);
  // Known-bad hardware with the flag given is a FAILURE, not a deliberate incomplete run.
  // Without this, mutating `if (failed)` to `if (false)` reports exit 4 and passes.
  assert.equal(r.code, 1, 'refusing motion on unverified hardware must exit 1, not 4');

  const sent = eventsSent(r.bodies);
  for (const event of STATE_CHANGING) {
    assert.ok(!sent.includes(event),
      `${event} reached a vehicle with unverified parameters; decoded: ${JSON.stringify(sent)}`);
  }
});

test('a wedged link refuses motion even with verified parameters and the flag', async () => {
  // The MAVProxy wedge: the TCP socket stays open so linkUp is true, and previously-verified
  // parameters persist, while nothing reaches the flight controller. The previous readiness
  // check looked only at parameters and would have passed this.
  for (const [label, patch] of [
    ['no autopilot heartbeat', { autopilotHeartbeat: false }],
    ['link down',              { linkUp: false }],
    ['mismatched parameters',  { params: { missing: [], verified: [...EXPECTED_NAMES], mismatched: { FRAME_CLASS: { actual: 2, expected: 1 } } } }],
    ['zero verified parameters', { params: { missing: [], verified: [], mismatched: {} } }],
  ]) {
    const r = await runScript(['--allow-motion'], { telemetry: { ...OK_TELEMETRY, ...patch } });
    assert.match(r.stdout, /REFUSING MOTION DESPITE --allow-motion/, `${label} was allowed`);
    const sent = eventsSent(r.bodies);
    for (const event of STATE_CHANGING) {
      assert.ok(!sent.includes(event), `${label}: ${event} was sent`);
    }
  }
});

test('WITH the flag AND healthy hardware, the control checks DO run', async () => {
  // The authorised path. Without this, mutating the composite gate to
  // `motionAuthorised && hw.ready && false` leaves every other test green while making the
  // control checks unreachable on a healthy rover — validation that can never validate.
  // Safe: this drives the local stub, never a rover.
  const r = await runScript(['--allow-motion'], { telemetry: OK_TELEMETRY });

  assert.doesNotMatch(r.stdout, /== Arm and drive == SKIPPED/,
    'the motion section was skipped despite the flag and healthy hardware');
  assert.match(r.stdout, /THE WHEELS CAN TURN/, 'the authorisation warning must be shown');

  const sent = eventsSent(r.bodies);
  assert.ok(sent.includes('arm'), `arm was never sent; decoded: ${JSON.stringify(sent)}`);
  assert.ok(sent.includes('fromclient'), 'fromclient was never sent');
  assert.ok(sent.includes('setDrivetrain'), 'setDrivetrain was never sent');
  // EXIT 0 explicitly. A red team found the clean-PASS branch unreachable by the whole suite:
  // every code assertion was exit-4 or exit-1, and this test's own run could never reach 0
  // because the stub did not ack setDrivetrain. Changing process.exit(0) to exit(1) survived.
  assert.equal(r.code, 0,
    `an authorised, healthy, fully-exercised run must exit 0 (PASS); got ${r.code}\n${r.stdout}`);
  assert.match(r.stdout, /E2E PASSED/);
  assert.doesNotMatch(r.stdout, /E2E INCOMPLETE|E2E FAILED/);
});

test('a link that wedges MID-RUN refuses the second arm', async () => {
  // The gate is decided from ONE frame at connect, and the script then spends seconds arming,
  // driving and shifting. A snapshot that was healthy then can be stale by the second ARM — the
  // MAVProxy wedge leaves the socket open while nothing reaches the flight controller.
  //
  // /status read 1 is the battery gate's own read, so degrading after it makes the pre-second-arm
  // re-check see the wedge. Without this scenario the re-check is untestable: a stub that answers
  // identically every time can never disagree with itself, and deleting the re-check survives.
  // /status reads in order: 1 = the battery gate, 2 = the first ARM, 3 = the drivetrain,
  // 4 = the second ARM. Degrading after 3 lets the earlier sections run and wedges the link
  // only before the last one.
  const r = await runScript(['--allow-motion'], {
    telemetry: OK_TELEMETRY,
    degradeStatusAfter: 3,
    degradeTo: { autopilotHeartbeat: false },
  });

  assert.match(r.stdout, /REFUSING THE SECOND ARM/,
    'the second arm rode on the stale first decision');
  assert.match(r.stdout, /no fresh autopilot heartbeat/);
  // The FIRST arm legitimately happened — the link was healthy then. This is about the second.
  const sent = eventsSent(r.bodies);
  assert.ok(sent.includes('arm'), 'precondition: the first arm should have gone out');
  assert.equal(sent.filter((e) => e === 'arm').length, 1,
    `a second arm was sent after the link wedged; decoded: ${JSON.stringify(sent)}`);
  assert.equal(r.code, 1, 'a mid-run wedge is a failure, not an incomplete run');
});

test('a link that wedges BEFORE the first arm refuses it, and sends nothing', async () => {
  // The connect-time frame used to authorise the first ARM, twelve commands AND the real
  // setDrivetrain transaction; only the second ARM was rechecked. The gearbox shift is the most
  // consequential action in this script, so it must not ride the oldest evidence.
  const r = await runScript(['--allow-motion'], {
    telemetry: OK_TELEMETRY,
    degradeStatusAfter: 1,                    // wedge right after the battery gate's own read
    degradeTo: { autopilotHeartbeat: false },
  });
  assert.match(r.stdout, /REFUSING THE FIRST ARM/, 'the first arm rode a stale frame');
  const sent = eventsSent(r.bodies);
  for (const event of STATE_CHANGING) {
    assert.ok(!sent.includes(event),
      `${event} was sent after the link wedged; decoded: ${JSON.stringify(sent)}`);
  }
  assert.equal(r.code, 1, 'a wedge with the flag given is a failure');
});

test('a TRANSIENT wedge does not re-authorise later sections', async () => {
  // The link-lost latch. /status read 2 is the first ARM's check; degrading only that read
  // means the drivetrain check at read 3 sees a healthy frame again. Without the latch the
  // script would refuse the arm and then happily shift a real gearbox seconds later, on a link
  // that has just demonstrated it can drop. A recovered reading is not evidence the earlier
  // commands arrived.
  const r = await runScript(['--allow-motion'], {
    telemetry: OK_TELEMETRY,
    degradeStatusAfter: 1, degradeUntil: 2,        // only the first-arm check is wedged
    degradeTo: { autopilotHeartbeat: false },
  });
  assert.match(r.stdout, /REFUSING THE FIRST ARM/);
  assert.match(r.stdout, /already lost earlier this run/,
    'a later section re-authorised after a transient wedge');
  const sent = eventsSent(r.bodies);
  for (const event of STATE_CHANGING) {
    assert.ok(!sent.includes(event),
      `${event} was sent after a transient wedge; decoded: ${JSON.stringify(sent)}`);
  }
});

test('a BINARY_EVENT cannot smuggle an arm past the decoder', async () => {
  // 40\x1e450-["arm"] decodes on a real server as a namespace connect followed by a
  // zero-attachment BINARY_EVENT, which Socket.IO converts to an ordinary `arm` event. The
  // decoder previously matched only 42/43, so this evaded the absence assertion entirely.
  assert.ok(eventsSent(['40\x1e450-["arm"]']).includes('arm'),
    'a zero-attachment BINARY_EVENT must be decoded as an event');
  assert.ok(eventsSent(['42["fromclient",{}]']).includes('fromclient'));
  // And an undecodable message packet must not read as "no event".
  const odd = eventsSent(['42{not json']);
  assert.ok(odd.some((e) => e.startsWith('UNDECODABLE')),
    'an undecodable packet must be surfaced, not silently treated as absent');
});

test('requiring the script does not run the suite', () => {
  const mod = require('./on-target/control-e2e.js');
  assert.equal(typeof mod.assertSafeToCommand, 'function');
  assert.equal(typeof mod.motionFlagGiven, 'function');
});

test('a /status that accepts the request and never answers cannot hang the re-check', async () => {
  // The re-checks used a socket-INACTIVITY timeout only. A picar that accepts the connection and
  // then sends nothing produces no inactivity to time out on in the ways that matter, and the
  // run stalls before the first ARM — neither a refusal nor an authorisation, and no operator
  // watching a hung script can tell which. assertSafeToCommand already had an absolute deadline;
  // its own comment says so, and the per-section re-checks added later did not inherit it.
  // Stall from read 2 so the battery gate's own read (read 1) still succeeds and the run reaches
  // the section re-checks. Safe: the local stub, never a rover.
  const r = await runScript(['--allow-motion'],
    { telemetry: OK_TELEMETRY, stallStatusAfter: 1 });

  assert.match(r.stdout, /REFUSING THE FIRST ARM: could not re-read \/status/,
    `a never-answering /status must REFUSE, not hang; got:\n${r.stdout}`);
  assert.match(r.stdout, /deadline/,
    'the refusal must name the deadline, so the operator knows it was not a refusal on evidence');
  const sent = eventsSent(r.bodies);
  assert.ok(!sent.includes('arm'), `arm was sent despite a dead re-check; decoded: ${JSON.stringify(sent)}`);
  assert.equal(r.code, 1, 'a re-check that could not complete is a FAILURE, not a skip');
});

test('a link lost mid-run still sends the fail-safe stop', async () => {
  // The review finding this closes: linkLost skipped `disarm`, so a run that had already
  // ARMED and commanded steering 0.5 left that command standing and returned. `disarm` is
  // the server's neutral-then-DISARM primitive — the cleanup, not further actuation — and a
  // one-way RECEIVE failure fails the heartbeat check while outbound packets still work, so
  // the stop was being withheld in the case it was most likely to work and most needed.
  //
  // Degrade from status read 3: read 1 is the battery gate, read 2 authorises the FIRST ARM,
  // and read 3 is the drivetrain re-check — so this run arms, steers, and then loses the link.
  const r = await runScript(['--allow-motion'], {
    telemetry: OK_TELEMETRY,
    degradeStatusAfter: 2,
    degradeTo: { autopilotHeartbeat: false },
  });

  const sent = eventsSent(r.bodies);
  assert.ok(sent.includes('arm'), `precondition: this run must have armed; decoded: ${JSON.stringify(sent)}`);
  assert.match(r.stdout, /REFUSING THE DRIVETRAIN SECTION/, 'precondition: the link was lost mid-run');
  assert.ok(sent.includes('disarm'),
    `the fail-safe stop must be sent even after a link-health failure; decoded: ${JSON.stringify(sent)}`);
  assert.match(r.stdout, /sending the stop ANYWAY/);
  // And it must still gate FURTHER actuation.
  assert.match(r.stdout, /setLight == SKIPPED/);
});

test('an AUTHORISED run whose first-arm check refuses sends no pointless stop', async () => {
  // The negative control for the test above, and it has to enter the motion block to be
  // one: with no --allow-motion the whole block is skipped earlier, so that path never
  // reaches the stop and proves nothing about the guard. Wedging from status read 2 — the
  // FIRST ARM re-check — is the case where the run is authorised, enters the block, and
  // never arms. Without the guard this would DISARM a rover it never touched.
  const r = await runScript(['--allow-motion'], {
    telemetry: OK_TELEMETRY,
    degradeStatusAfter: 1,
    degradeTo: { autopilotHeartbeat: false },
  });

  const sent = eventsSent(r.bodies);
  assert.match(r.stdout, /REFUSING THE FIRST ARM/, 'precondition: it entered the block and refused');
  assert.ok(!sent.includes('arm'), `precondition: nothing armed; decoded: ${JSON.stringify(sent)}`);
  assert.ok(!sent.includes('disarm'),
    `a run that never armed must not send disarm; decoded: ${JSON.stringify(sent)}`);
  assert.match(r.stdout, /this run never armed/);
});

test('the watchdog check FAILS when the controls do not return to neutral', async () => {
  // This check used to call ok() unconditionally after sleeping — it proved the window
  // elapsed, not that anything happened. Once exit 0 became assertable evidence, that turned
  // a deleted watchdog into a validation PASS. CLAUDE.md records that main's input watchdog
  // can be deleted outright without failing a host test, so this is the only check on it.
  const r = await runScript(['--allow-motion'],
    { telemetry: OK_TELEMETRY, watchdogFires: false });

  assert.match(r.stdout, /watchdog did NOT neutralise/,
    `a rover still holding steering after the silence must FAIL; got:\n${r.stdout}`);
  assert.match(r.stdout, /steering 0\.25/);
  assert.equal(r.code, 1, 'and the run must fail, not pass');
  assert.doesNotMatch(r.stdout, /E2E PASSED/);
});

test('the watchdog check PASSES only on an observed return to neutral', async () => {
  const r = await runScript(['--allow-motion'], { telemetry: OK_TELEMETRY });
  assert.match(r.stdout, /watchdog returned the controls to neutral/);
  assert.equal(r.code, 0);
});

test('the run ends with a stop after the watchdog section re-arms', async () => {
  // The watchdog section re-arms and then goes silent by design, so without a final stop a
  // healthy run ends with the vehicle armed. Mutation found this: setting armedThisRun at
  // the SECOND arm was dead code, because nothing read it afterwards — the whole file stayed
  // green with it removed.
  const r = await runScript(['--allow-motion'], { telemetry: OK_TELEMETRY });
  const sent = eventsSent(r.bodies);
  const disarms = sent.filter((n) => n === 'disarm').length;
  assert.equal(disarms, 2,
    `one stop for the operator-stop check and one to leave the vehicle stopped; decoded: ${JSON.stringify(sent)}`);
  assert.match(r.stdout, /Final stop/);
  assert.match(r.stdout, /the stop was accepted/);
  // And it must NOT claim more than it can show. app.js zeroes its local steering BEFORE
  // attempting the write, so /status reading neutral is the server's desired state, not the
  // vehicle's — a reviewer's finding, and the claim was overstated until 2026-08-12.
  assert.match(r.stdout, /NOT proof the neutral packet reached the flight controller/);
  assert.doesNotMatch(r.stdout, /the vehicle was left stopped|vehicle stopped \(/,
    'the run must not assert a vehicle state it cannot observe');
  // The final stop must come AFTER the second arm, or it stops nothing.
  const order = sent.slice(sent.lastIndexOf('arm'));
  assert.ok(order.includes('disarm'),
    `the last arm must be followed by a stop; tail: ${JSON.stringify(order)}`);
});

test('the final stop FAILS the run when neutral cannot be confirmed', async () => {
  // A successful POST is not evidence — this repo's standing "a successful write() is not
  // proof of delivery" point. If /status still shows the controls off neutral after the
  // stop, the run must say so rather than print a reassuring line.
  const r = await runScript(['--allow-motion'],
    { telemetry: OK_TELEMETRY, watchdogFires: false, stopWorks: false });
  assert.match(r.stdout, /could NOT confirm the server stopped commanding motion/);
  assert.equal(r.code, 1);
});

test('a build that IGNORES fromclient cannot pass the watchdog check', async () => {
  // Codex's scenario, and the one the precondition exists for: the POST succeeds, the handler
  // does nothing, /status never leaves 0 — and the old check then reported that the watchdog
  // had returned the controls to neutral. A transition to zero is only evidence if something
  // was non-zero first, so with the handler gone this run must FAIL rather than pass a build
  // that has neither a motion handler nor a safety timer.
  const r = await runScript(['--allow-motion'],
    { telemetry: OK_TELEMETRY, fromclientWorks: false });

  assert.match(r.stdout, /watchdog precondition FAILED/,
    `an ignored steering command must fail the precondition; got:\n${r.stdout}`);
  assert.match(r.stdout, /steering reads 0, not the 0\.25 just commanded/);
  assert.equal(r.code, 1, 'and the run must fail');
  assert.doesNotMatch(r.stdout, /E2E PASSED/);
});
