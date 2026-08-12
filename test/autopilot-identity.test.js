'use strict';

// Host-side tests for autopilot identification and overlay suppression.
//
// The defect these cover: the ArduRover parameter overlay — FRAME_CLASS=1, RCMAP_*,
// RC_OVERRIDE_TIME — was pushed at whatever answered on :5760. HEARTBEAT's MAV_TYPE
// (payload[4]) was never read anywhere in the driver, and MAV_AUTOPILOT (payload[5]) was
// tested only for "not 8, so not a GCS". rover1 was measured running PX4 and reporting a
// QUADROTOR MAV_TYPE while this driver pushed the rover overlay at it.
//
// Frames are built byte by byte with real CRCs and pushed through the real parser, for
// the reason telemetry.test.js gives: a tampered frame with a stale CRC is rejected by
// the parser for the WRONG reason, and CLAUDE.md records that exact evasion being caught
// in review here.

const test   = require('node:test');
const assert = require('node:assert/strict');

const PWMMavproxy = require('../pwm_mavproxy_servo.js');

const HEARTBEAT = { id: 0, crc: 50, len: 9 };

// The values under test, spelled out rather than inlined as magic numbers.
const ARDUPILOTMEGA = 3;
const PX4           = 12;
const GROUND_ROVER  = 10;
const SURFACE_BOAT  = 11;   // what FRAME_CLASS=2 made rover3 report until 2026-08-04
const QUADROTOR     = 2;    // what rover1 reports today
const GCS           = 8;    // MAV_AUTOPILOT_INVALID — our own heartbeat

function driver(extra = {}) {
  return new PWMMavproxy({ mavproxy_autostart: false, ...extra });
}

function frameV1(msg, payload, { sysid = 1, compid = 1 } = {}) {
  const buf = Buffer.alloc(6 + payload.length + 2);
  buf[0] = 0xFE;
  buf[1] = payload.length;
  buf[2] = 0;
  buf[3] = sysid;
  buf[4] = compid;
  buf[5] = msg.id;
  payload.copy(buf, 6);
  let crc = PWMMavproxy.crc16(buf.subarray(1, 6 + payload.length), 5 + payload.length);
  crc = PWMMavproxy.crcAccumulate(msg.crc, crc);
  buf.writeUInt16LE(crc, 6 + payload.length);
  return buf;
}

// NOTE the default type. An earlier fixture in telemetry.test.js used 11 with the comment
// "type: ground rover" — 11 is SURFACE_BOAT, which is the same FRAME_CLASS=2 confusion
// CLAUDE.md records rover3 actually running. Defaulting to a wrong value here would make
// every test in this file assert against a mismatch it did not intend.
function heartbeat({ autopilot = ARDUPILOTMEGA, type = GROUND_ROVER, base_mode = 0 } = {}) {
  const p = Buffer.alloc(HEARTBEAT.len);
  p.writeUInt32LE(0, 0);
  p[4] = type;
  p[5] = autopilot;
  p[6] = base_mode;
  p[7] = 4;
  p[8] = 3;
  return p;
}

// Capture console.error/log around a call. The warning IS the deliverable for an
// operator here, so an assertion that only checks internal state would pass on a
// silently suppressed overlay — which looks to the operator like a working rover.
// Same as `capturing`, but returns the callback's value rather than the captured text.
function capturingReturn(fn) {
  const origErr = console.error, origLog = console.log;
  console.error = () => {}; console.log = () => {};
  try { return fn(); } finally { console.error = origErr; console.log = origLog; }
}

function capturing(fn) {
  const lines = [];
  const origErr = console.error, origLog = console.log;
  console.error = (...a) => lines.push(a.join(' '));
  console.log   = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.error = origErr; console.log = origLog; }
  return lines.join('\n');
}

// ── Identification ───────────────────────────────────────────────────────────

test('an ArduPilot GROUND_ROVER heartbeat is identified and NOT flagged', () => {
  const d = driver();
  capturing(() => d.parseIncoming(frameV1(HEARTBEAT, heartbeat())));
  const f = d.getTelemetry().firmware;
  assert.equal(f.autopilot, ARDUPILOTMEGA);
  assert.equal(f.type, GROUND_ROVER);
  assert.equal(f.mismatch, null);
  assert.equal(f.overlaySuppressed, false);
});

test('MAV_TYPE is read at payload[4], not inferred', () => {
  // payload[4] was never read by the driver at all. A test asserting only on
  // `mismatch` would pass with the field hardwired, so pin the decoded value itself
  // against a type that is neither the expected one nor the autopilot field's value.
  const d = driver();
  capturing(() => d.parseIncoming(frameV1(HEARTBEAT, heartbeat({ type: SURFACE_BOAT }))));
  assert.equal(d.getTelemetry().firmware.type, SURFACE_BOAT);
});

test('a PX4 QUADROTOR heartbeat — what rover1 actually sends — is flagged on BOTH fields', () => {
  const d = driver();
  const out = capturing(() =>
    d.parseIncoming(frameV1(HEARTBEAT, heartbeat({ autopilot: PX4, type: QUADROTOR }))));
  const f = d.getTelemetry().firmware;
  assert.match(f.mismatch, /MAV_AUTOPILOT=12/);
  assert.match(f.mismatch, /MAV_TYPE=2/);
  assert.equal(f.overlaySuppressed, true);
  assert.match(out, /NOT an ArduRover/);
});

test('ArduPilot running the WRONG vehicle type is still flagged', () => {
  // The dangerous case, and the one an autopilot-only check misses: on ArduCopter
  // FRAME_CLASS is the airframe selector and 1 means Quad, so pushing this overlay at a
  // hexacopter silently reconfigures its frame. MAV_AUTOPILOT is 3 either way.
  const d = driver();
  capturing(() =>
    d.parseIncoming(frameV1(HEARTBEAT, heartbeat({ autopilot: ARDUPILOTMEGA, type: QUADROTOR }))));
  const f = d.getTelemetry().firmware;
  assert.equal(f.overlaySuppressed, true);
  assert.match(f.mismatch, /MAV_TYPE=2/);
  assert.doesNotMatch(f.mismatch, /MAV_AUTOPILOT/,
    'the autopilot field matched, so it must not be reported as a mismatch');
});

test('SURFACE_BOAT does NOT suppress — it is the case the overlay exists to repair', () => {
  // THIS TEST ASSERTED THE OPPOSITE and was wrong; a reviewer caught it. An ArduRover with
  // FRAME_CLASS=2 reports MAV_TYPE=11, which is exactly what rover3 genuinely ran until
  // 2026-08-04, and `FRAME_CLASS: 1` in the overlay is the repair. Suppressing on it meant a
  // normal early heartbeat cancelled the chain before FRAME_CLASS was written, and the
  // sticky flag blocked every later reconnect — the rover left permanently a boat by the
  // code added to protect it. Pinning a defect in a test is the failure mode CLAUDE.md
  // lists, and this file had done it.
  const d = driver();
  const out = capturing(() => d.parseIncoming(frameV1(HEARTBEAT, heartbeat({ type: SURFACE_BOAT }))));
  const f = d.getTelemetry().firmware;
  assert.equal(f.overlaySuppressed, false, 'the repair must not be suppressed');
  assert.equal(f.mismatch, null);
  assert.equal(f.type, SURFACE_BOAT, 'and the type is still reported honestly');
  assert.match(out, /Applying the overlay AS THE REPAIR/,
    'and the operator is told why a boat is on the link');
});

test('the boat repair still applies the configuration tier', () => {
  // The consumer half. Reporting the boat while withholding FRAME_CLASS would be the same
  // defect with better logging.
  const d = driver();
  const applied = [];
  d.applyParamOverlay = (opts) => applied.push((opts && opts.tier) || 'full');
  d.startOverlayReassertWatch = () => {};
  capturing(() => d.parseIncoming(frameV1(HEARTBEAT, heartbeat({ type: SURFACE_BOAT }))));
  assert.deepEqual(applied, ['full'],
    'FRAME_CLASS=1 must actually be written, or the rover stays a boat');
});

test('an ArduPilot vehicle that is NOT a rover is still suppressed', () => {
  // The other side of widening the accepted set. ArduCopter reports QUADROTOR/HEXAROTOR,
  // ArduPlane FIXED_WING, ArduSub SUBMARINE — none of which is in ARDUROVER_TYPES — and on
  // those firmwares FRAME_CLASS selects an AIRFRAME, so writing 1 reconfigures a hexacopter
  // as a quad. Widening to "any ArduPilot" would be the failure this guards.
  for (const t of [QUADROTOR, 13 /* HEXAROTOR */, 1 /* FIXED_WING */, 12 /* SUBMARINE */]) {
    const d = driver();
    capturing(() => d.parseIncoming(frameV1(HEARTBEAT, heartbeat({ type: t }))));
    assert.equal(d.getTelemetry().firmware.overlaySuppressed, true,
      `MAV_TYPE=${t} is not a rover and must suppress the overlay`);
  }
});

test('our OWN heartbeat cannot identify the autopilot', () => {
  // The driver emits MAV_AUTOPILOT_INVALID at 1 Hz. Identifying off it would record
  // autopilot=8 as a mismatch and suppress the overlay on every rover.
  const d = driver();
  capturing(() => d.parseIncoming(frameV1(HEARTBEAT, heartbeat({ autopilot: GCS }))));
  const f = d.getTelemetry().firmware;
  assert.equal(f.autopilot, null, 'a GCS heartbeat must not be recorded as the autopilot');
  assert.equal(f.overlaySuppressed, false);
});

test('a wrong-sysId frame is dropped by the PARSER before it can identify anything', () => {
  const d = driver({ mavproxy_target_system: 1 });
  capturing(() => d.parseIncoming(
    frameV1(HEARTBEAT, heartbeat({ autopilot: PX4, type: QUADROTOR }), { sysid: 42 })));
  const f = d.getTelemetry().firmware;
  assert.equal(f.autopilot, null);
  assert.equal(f.overlaySuppressed, false,
    'anything on the link could otherwise suppress the safety overlay by spoofing a heartbeat');
});

test('the HANDLER checks sysId itself, and identifies only after that check', () => {
  // This goes through handleMessage rather than parseIncoming DELIBERATELY. The parser
  // already drops a wrong-sysId frame, so a parseIncoming test passes no matter where the
  // identification sits inside the handler — measured: moving the identify call above the
  // handler's own sysId guard survived the entire suite. That is the "never reaches the
  // branch the test names" vacuity CLAUDE.md lists. The handler's guard is defence in
  // depth for every other caller of handleMessage, so test it at its own level.
  const d = driver({ mavproxy_target_system: 1 });
  capturing(() => d.handleMessage(0, heartbeat({ autopilot: PX4, type: QUADROTOR }),
    { sysId: 42, compId: 1, mavlinkVersion: 1 }));
  assert.equal(d.getTelemetry().firmware.autopilot, null,
    'the handler identified the autopilot from a frame it had just rejected');
  assert.equal(d.overlaySuppressed, false);

  // Negative control: the same call with the RIGHT sysId must identify, or the assertion
  // above would hold with identification removed altogether.
  capturing(() => d.handleMessage(0, heartbeat({ autopilot: PX4, type: QUADROTOR }),
    { sysId: 1, compId: 1, mavlinkVersion: 1 }));
  assert.equal(d.getTelemetry().firmware.autopilot, PX4);
  assert.equal(d.overlaySuppressed, true);
});

test('the warning is emitted ONCE per identity, not on every 1 Hz heartbeat', () => {
  const d = driver();
  const out = capturing(() => {
    for (let i = 0; i < 5; i++) {
      d.parseIncoming(frameV1(HEARTBEAT, heartbeat({ autopilot: PX4, type: QUADROTOR })));
    }
  });
  assert.equal(out.split('NOT an ArduRover').length - 1, 1,
    'a warning repeated at 1 Hz forever is a warning an operator filters out');
});

// ── Suppression actually reaches the consumer ────────────────────────────────

test('applyParamOverlay REFUSES once the autopilot is misidentified', () => {
  // The rule and its consumer. CLAUDE.md names "a correct rule with an untouched
  // consumer" as this repo's dominant defect shape, and three times on one branch the
  // call site was where the defect lived. So drive the real method and prove no
  // PARAM_SET is produced, rather than asserting on the flag.
  const d = driver();
  const sent = [];
  d.sendPacket = (buf) => { sent.push(buf); return true; };

  capturing(() => d.parseIncoming(
    frameV1(HEARTBEAT, heartbeat({ autopilot: PX4, type: QUADROTOR }))));
  const out = capturing(() => d.applyParamOverlay());

  assert.match(out, /REFUSING to apply the ArduRover parameter overlay/);
  assert.equal(d.overlayTimers.length, 0,
    'no PARAM_SET or PARAM_REQUEST_READ timer may be scheduled');
  assert.equal(sent.length, 0);
});

test('applyParamOverlay still applies on a correctly identified ArduRover', () => {
  // The negative control. Without it, "suppressed" could be hardwired true and every
  // test above would still pass while no rover ever received its overlay — including
  // RC_OVERRIDE_TIME=0.2, the flight controller's own stale-override failsafe.
  const d = driver();
  capturing(() => d.parseIncoming(frameV1(HEARTBEAT, heartbeat())));
  const out = capturing(() => d.applyParamOverlay());
  assert.match(out, /Applying minimal Pixhawk param overlay/);
  assert.ok(d.overlayTimers.length > 0, 'the overlay must still be scheduled');
  d.clearOverlayTimers();   // or node --test hangs on the leaked timers, and a hang reads as a pass
});

test('identification cancels an ALREADY IN-FLIGHT overlay chain', () => {
  // The push on connect is deliberately not gated on the heartbeat — that is the
  // fail-open documented in _connect. So the writes are already spaced 250 ms apart when
  // identification arrives ~1 s later, and the remaining ones must be cancelled.
  const d = driver();
  capturing(() => d.applyParamOverlay());
  assert.ok(d.overlayTimers.length > 0, 'precondition: a chain is in flight');
  capturing(() => d.parseIncoming(
    frameV1(HEARTBEAT, heartbeat({ autopilot: PX4, type: QUADROTOR }))));
  assert.equal(d.overlayTimers.length, 0, 'the remaining PARAM_SETs must be cancelled');
});

test('nothing reads as verified once the autopilot is misidentified', () => {
  // Read-back proves a parameter's VALUE. It does not prove the parameter means here
  // what EXPECTED_CRITICAL_PARAMS assumes, so a verified list against a misidentified
  // vehicle is the rubber stamp CLAUDE.md describes.
  const d = driver();
  d.verifiedCriticalParams.add('RC_OVERRIDE_TIME');
  d.paramOverlayApplied = true;
  capturing(() => d.parseIncoming(
    frameV1(HEARTBEAT, heartbeat({ autopilot: PX4, type: QUADROTOR }))));
  assert.deepEqual(d.getTelemetry().params.verified, []);
  assert.equal(d.paramOverlayApplied, false);
});

test('the reassert chain abandons itself rather than looping on a refusal', async () => {
  // applyParamOverlay refusing is not enough: the chain re-checks read-back, finds
  // everything missing forever, and logs "reasserting, attempt N/M" for a reassert it is
  // not performing — which reads in the journal as a rover that is trying.
  //
  // The chain's callback is a closure with no handle, so it is driven by its REAL timer
  // rather than called directly — a test that invokes a method the driver does not have
  // asserts nothing, and a first draft of this test did exactly that. overlayReassertMs
  // is overwritten after construction on purpose: clampOverlayReassert floors it above
  // 1 s, and waiting that long per case is not worth it.
  const d = driver();
  d.client = { destroyed: false };
  d.sendPacket = () => true;
  d.overlayReassertMs = 5;

  capturing(() => d.parseIncoming(
    frameV1(HEARTBEAT, heartbeat({ autopilot: PX4, type: QUADROTOR }))));

  const lines = [];
  const origErr = console.error, origLog = console.log;
  console.error = (...a) => lines.push(a.join(' '));
  console.log   = (...a) => lines.push(a.join(' '));
  try {
    d.startOverlayReassertWatch();
    // Long enough for several attempts had the chain kept going at 5 ms.
    await new Promise((r) => setTimeout(r, 120));
  } finally { console.error = origErr; console.log = origLog; }
  const out = lines.join('\n');

  assert.match(out, /abandoning the overlay reassert chain/);
  assert.doesNotMatch(out, /reasserting, attempt/,
    'the chain announced a reassert it was refusing to perform');
  assert.equal(d.overlayReassertTimer, null, 'no further attempt may be armed');
  assert.equal(d.overlayTimers.length, 0);
  d.clearOverlayTimers();
  d.client = null;
});

test('the reassert chain DOES run on a correctly identified ArduRover', async () => {
  // The negative control for the test above. Without it, `overlaySuppressed` could be
  // hardwired true — or the abandon branch made unconditional — and the chain that
  // exists to recover a LOST overlay would never run on any rover, silently.
  const d = driver();
  d.client = { destroyed: false };
  d.sendPacket = () => true;
  d.overlayReassertMs = 5;

  capturing(() => d.parseIncoming(frameV1(HEARTBEAT, heartbeat())));

  const lines = [];
  const origErr = console.error, origLog = console.log;
  console.error = (...a) => lines.push(a.join(' '));
  console.log   = (...a) => lines.push(a.join(' '));
  try {
    d.startOverlayReassertWatch();
    await new Promise((r) => setTimeout(r, 120));
  } finally { console.error = origErr; console.log = origLog; }
  const out = lines.join('\n');

  assert.match(out, /reasserting, attempt/, 'nothing was verified, so it must reassert');
  assert.doesNotMatch(out, /abandoning/);
  if (d.overlayReassertTimer) clearTimeout(d.overlayReassertTimer);
  d.clearOverlayTimers();
  d.client = null;
});

// ── Recovery ─────────────────────────────────────────────────────────────────

test('a reflashed or swapped board recovers by RE-RUNNING the overlay, not just unflagging', () => {
  // A reviewer's finding, and the worst kind: the log said "no longer suppressed" while
  // nothing was re-applied. The suppression had CANCELLED the in-flight chain and the
  // reassert timer, so clearing the flag left the board unconfigured with a reassuring
  // message — and arming is gated on nothing, so it could still be driven.
  const d = driver();
  const applied = [];
  d.applyParamOverlay = (opts) => applied.push((opts && opts.tier) || 'full');
  let watchArmed = 0;
  d.startOverlayReassertWatch = () => { watchArmed += 1; };

  capturing(() => d.parseIncoming(
    frameV1(HEARTBEAT, heartbeat({ autopilot: PX4, type: QUADROTOR }))));
  assert.equal(d.getTelemetry().firmware.overlaySuppressed, true, 'precondition');
  assert.deepEqual(applied, [], 'precondition: nothing was applied while suppressed');
  // Simulate the tier having been marked done before the mismatch, which is the state that
  // made clearing the flag insufficient.
  d.deferredOverlayDone = true;

  const out = capturing(() => d.parseIncoming(frameV1(HEARTBEAT, heartbeat())));
  assert.equal(d.getTelemetry().firmware.overlaySuppressed, false);
  assert.equal(d.getTelemetry().firmware.mismatch, null);
  assert.match(out, /no longer suppressed/);
  assert.deepEqual(applied, ['full'],
    'recovery must re-run the configuration tier that the suppression cancelled');
  assert.equal(watchArmed, 1, 'and re-arm the verification watch it also cancelled');
});

test('the mismatch survives the reconnect loop', () => {
  // The driver reconnects every 2 s. If suppression were cleared on close, every
  // reconnect would re-push the rover overlay at the same copter — the fix would hold
  // for one connection and then undo itself, indefinitely.
  const d = driver();
  capturing(() => d.parseIncoming(
    frameV1(HEARTBEAT, heartbeat({ autopilot: PX4, type: QUADROTOR }))));
  // What the close handler does to verification state, without opening a real socket.
  d.paramOverlayApplied = false;
  d.verifiedCriticalParams.clear();
  d.paramVerificationFailures.clear();
  assert.equal(d.overlaySuppressed, true,
    'suppression must not be part of the per-connection state the close handler resets');
  const out = capturing(() => d.applyParamOverlay());
  assert.match(out, /REFUSING/);
});

// ── The two tiers ────────────────────────────────────────────────────────────

// Run an overlay chain synchronously: applyParamOverlay spaces writes 250 ms apart and
// then schedules read-backs, so the real chain takes ~3 s and would leak handles into the
// runner. Swapping setTimeout for an immediate executor is the pattern telemetry.test.js
// already uses for this.
function runChainSync(d, opts) {
  const writes = [], reads = [];
  d.buildParamSet = (name, value) => { writes.push([name, value]); return Buffer.alloc(0); };
  d.buildParamRequestRead = (name) => { reads.push(name); return Buffer.alloc(0); };
  d.sendPacket = () => true;
  const real = global.setTimeout;
  global.setTimeout = (fn) => { fn(); return { unref() {} }; };
  try { d.applyParamOverlay(opts); } finally { global.setTimeout = real; }
  d.clearOverlayTimers();
  return { writes, reads };
}

test('the pre-identity tier writes ONLY the flight controller failsafe', () => {
  const d = driver();
  const { writes } = capturingReturn(() => runChainSync(d, { tier: 'preIdentity' }));
  assert.deepEqual(writes, [['RC_OVERRIDE_TIME', 0.2]],
    'the configuration tier must not reach an unidentified flight controller');
});

test('the pre-identity tier reads back ONLY what it wrote', () => {
  // Requesting the whole critical set would record mismatches for parameters not yet
  // pushed, so /status would show real-looking verification failures for the length of the
  // grace window — on a healthy rover, every connect. An operator taught that the FC
  // indicator flickers stops reading it.
  const d = driver();
  const { reads } = capturingReturn(() => runChainSync(d, { tier: 'preIdentity' }));
  assert.deepEqual(reads, ['RC_OVERRIDE_TIME'],
    `only the parameter actually written may be read back (requested: ${reads.join(',')})`);
});

test('the full tier writes and reads back everything', () => {
  // The negative control for both tests above: with the tier hardwired to preIdentity, or
  // the filters inverted, no rover would ever receive its output mapping.
  const d = driver();
  const { writes, reads } = capturingReturn(() => runChainSync(d, {}));
  const names = writes.map(([n]) => n);
  assert.equal(names[0], 'RC_OVERRIDE_TIME', 'still first — the tiering must not reorder it');
  assert.ok(names.includes('SERVO3_FUNCTION') && names.includes('FRAME_CLASS'),
    `the configuration tier must go out in full (sent: ${names.join(',')})`);
  assert.ok(reads.length > 1, 'and the whole critical set is read back');
});
