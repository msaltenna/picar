'use strict';

// Host-side tests for battery / power / radio telemetry decoding.
//
// The framing here is hand-rolled, so a wrong CRC_EXTRA or byte offset fails
// SILENTLY — it produces a plausible-looking number rather than an error. These
// tests therefore build real MAVLink frames byte by byte and push them through the
// real parser, including the v2 zero-trimming that made a naive fixed-offset read
// return current_battery as -25813 instead of 43 on live hardware.

const test   = require('node:test');
const assert = require('node:assert/strict');

const PWMMavproxy = require('../pwm_mavproxy_servo.js');

// Verified against pymavlink's own definitions on the target, not from memory.
const MSG = {
  HEARTBEAT:    { id: 0,   crc: 50,  len: 9  },
  SYS_STATUS:   { id: 1,   crc: 124, len: 31 },
  RADIO_STATUS: { id: 109, crc: 185, len: 9  },
  POWER_STATUS: { id: 125, crc: 203, len: 6  },
  PARAM_VALUE:  { id: 22,  crc: 220, len: 25 },
};

function driver(extra = {}) {
  return new PWMMavproxy({ mavproxy_autostart: false, ...extra });
}

// Build a MAVLink v1 frame with a correct CRC.
function frameV1(msg, payload) {
  const buf = Buffer.alloc(6 + payload.length + 2);
  buf[0] = 0xFE;
  buf[1] = payload.length;
  buf[2] = 0;     // seq
  buf[3] = 1;     // sysid (the autopilot)
  buf[4] = 1;     // compid
  buf[5] = msg.id;
  payload.copy(buf, 6);
  let crc = PWMMavproxy.crc16(buf.subarray(1, 6 + payload.length), 5 + payload.length);
  crc = PWMMavproxy.crcAccumulate(msg.crc, crc);
  buf.writeUInt16LE(crc, 6 + payload.length);
  return buf;
}

// Build a MAVLink v2 frame with a correct CRC. `trim` emulates the zero-trimming a
// real v2 sender performs on trailing zero bytes.
function frameV2(msg, payload, { trim = true, signed = false } = {}) {
  let p = Buffer.from(payload);
  if (trim) {
    let end = p.length;
    while (end > 1 && p[end - 1] === 0) end--;
    p = p.subarray(0, end);
  }
  const sigLen = signed ? 13 : 0;
  const buf = Buffer.alloc(10 + p.length + 2 + sigLen);
  buf[0] = 0xFD;
  buf[1] = p.length;
  buf[2] = signed ? 0x01 : 0x00;  // incompat flags
  buf[3] = 0;                     // compat flags
  buf[4] = 0;                     // seq
  buf[5] = 1;                     // sysid
  buf[6] = 1;                     // compid
  buf[7] = msg.id & 0xFF;
  buf[8] = (msg.id >> 8) & 0xFF;
  buf[9] = (msg.id >> 16) & 0xFF;
  p.copy(buf, 10);
  let crc = PWMMavproxy.crc16(buf.subarray(1, 10 + p.length), 9 + p.length);
  crc = PWMMavproxy.crcAccumulate(msg.crc, crc);
  buf.writeUInt16LE(crc, 10 + p.length);
  return buf;
}

function sysStatusPayload({ voltage_mV, current_cA, remaining }) {
  const p = Buffer.alloc(MSG.SYS_STATUS.len);
  p.writeUInt32LE(0x1234, 0);            // sensors present
  p.writeUInt32LE(0x1234, 4);            // enabled
  p.writeUInt32LE(0x1234, 8);            // health
  p.writeUInt16LE(50, 12);               // load
  p.writeUInt16LE(voltage_mV, 14);
  p.writeInt16LE(current_cA, 16);
  p.writeInt8(remaining, 30);
  return p;
}

function powerStatusPayload({ vcc_mV, vservo_mV, flags }) {
  const p = Buffer.alloc(MSG.POWER_STATUS.len);
  p.writeUInt16LE(vcc_mV, 0);
  p.writeUInt16LE(vservo_mV, 2);
  p.writeUInt16LE(flags, 4);
  return p;
}

function radioStatusPayload({ rxerrors, fixed, rssi, remrssi, txbuf, noise, remnoise }) {
  const p = Buffer.alloc(MSG.RADIO_STATUS.len);
  p.writeUInt16LE(rxerrors, 0);
  p.writeUInt16LE(fixed, 2);
  p.writeUInt8(rssi, 4);
  p.writeUInt8(remrssi, 5);
  p.writeUInt8(txbuf, 6);
  p.writeUInt8(noise, 7);
  p.writeUInt8(remnoise, 8);
  return p;
}

function heartbeatPayload({ autopilot = 3, base_mode = 0 } = {}) {
  const p = Buffer.alloc(MSG.HEARTBEAT.len);
  p.writeUInt32LE(0, 0);      // custom_mode
  // 10 is GROUND_ROVER. This said `11` with the comment "ground rover" — 11 is
  // SURFACE_BOAT, the same FRAME_CLASS=2 confusion that had rover3 genuinely running as a
  // boat until 2026-08-04. Harmless while nothing read MAV_TYPE; it stops being harmless
  // now that the driver identifies the vehicle from this field.
  p[4] = 10;                  // MAV_TYPE_GROUND_ROVER
  p[5] = autopilot;
  p[6] = base_mode;
  p[7] = 4;                   // system_status
  p[8] = 3;                   // mavlink_version
  return p;
}

// ── Battery decoding ─────────────────────────────────────────────────────────

test('battery is decoded from a v1 SYS_STATUS frame', () => {
  const d = driver();
  d.parseIncoming(frameV1(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 12600, current_cA: 350, remaining: 87 })));
  const t = d.getTelemetry();
  assert.equal(t.battery.voltageV, 12.6);
  assert.equal(t.battery.currentA, 3.5);
  assert.equal(t.battery.remainingPct, 87);
});

test('battery is decoded from a ZERO-TRIMMED v2 SYS_STATUS frame', () => {
  // The regression that matters. Real hardware sends a 31-byte SYS_STATUS as 17-18
  // bytes; reading fixed offsets without zero-extension gave current_battery as
  // -25813 instead of 43. These values reproduce that shape: remaining=0 trims the
  // tail away entirely.
  const d = driver();
  const payload = sysStatusPayload({ voltage_mV: 7178, current_cA: 43, remaining: 0 });
  const frame = frameV2(MSG.SYS_STATUS, payload, { trim: true });
  assert.ok(frame[1] < MSG.SYS_STATUS.len,
    `precondition: the frame must actually be trimmed (got ${frame[1]} of ${MSG.SYS_STATUS.len})`);

  d.parseIncoming(frame);
  const t = d.getTelemetry();
  assert.equal(t.battery.voltageV, 7.178);
  assert.equal(t.battery.currentA, 0.43, 'current must survive zero-trimming');
  assert.equal(t.battery.remainingPct, null, 'a trimmed-away remaining reads as unknown');
});

test('an unmeasured battery reads as unknown rather than as zero', () => {
  const d = driver();
  // 65535 = not measured (voltage), -1 = not measured (current and remaining).
  d.parseIncoming(frameV1(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 0xFFFF, current_cA: -1, remaining: -1 })));
  const t = d.getTelemetry();
  assert.equal(t.battery.voltageV, null);
  assert.equal(t.battery.currentA, null);
  assert.equal(t.battery.remainingPct, null);
});

test('remaining=0 is treated as unknown, not as a flat pack', () => {
  // ArduPilot reports 0 when BATT_CAPACITY is unset, which is indistinguishable
  // from empty. Reporting "0%" would raise a false low-battery alarm on every
  // rover whose capacity was never configured.
  const d = driver();
  d.parseIncoming(frameV1(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 12000, current_cA: 100, remaining: 0 })));
  assert.equal(d.getTelemetry().battery.remainingPct, null);
  assert.equal(d.getTelemetry().battery.voltageV, 12);
});

// ── Power and radio decoding ─────────────────────────────────────────────────

test('board and servo rail voltages are decoded, including a trimmed v2 frame', () => {
  const d = driver();
  // flags=37 with a 6-byte payload trims to 5 bytes on the wire; a naive read gave
  // 36901 instead of 37.
  d.parseIncoming(frameV2(MSG.POWER_STATUS,
    powerStatusPayload({ vcc_mV: 5162, vservo_mV: 6014, flags: 37 })));
  const t = d.getTelemetry();
  assert.equal(t.power.boardV, 5.162);
  assert.equal(t.power.servoV, 6.014);
  assert.equal(t.power.flags, 37);
});

test('radio status is decoded when a SiK radio is present', () => {
  const d = driver();
  d.parseIncoming(frameV1(MSG.RADIO_STATUS, radioStatusPayload({
    rxerrors: 12, fixed: 3, rssi: 190, remrssi: 185, txbuf: 100, noise: 40, remnoise: 42,
  })));
  const t = d.getTelemetry();
  assert.equal(t.radio.rssi, 190);
  assert.equal(t.radio.remRssi, 185);
  assert.equal(t.radio.noise, 40);
  assert.equal(t.radio.remNoise, 42);
  assert.equal(t.radio.rxErrors, 12);
});

test('radio is null when nothing sends RADIO_STATUS', () => {
  // The actual state of this platform: no SiK radio is fitted, so the UI must show
  // "--" rather than a fabricated signal level.
  const d = driver();
  d.parseIncoming(frameV1(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 12000, current_cA: 0, remaining: 50 })));
  assert.equal(d.getTelemetry().radio, null);
});

// ── Framing robustness ───────────────────────────────────────────────────────

test('a frame with a bad CRC is rejected and changes nothing', () => {
  const d = driver();
  const frame = frameV1(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 12600, current_cA: 350, remaining: 87 }));
  frame[frame.length - 1] ^= 0xFF;   // corrupt the CRC
  d.parseIncoming(frame);
  assert.equal(d.getTelemetry().battery, null,
    'a CRC failure must not be believed — this is the only defence against ' +
    'resyncing onto a payload byte and decoding garbage');
});

test('telemetry survives being fed one byte at a time', () => {
  const d = driver();
  const frame = frameV2(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 11100, current_cA: 250, remaining: 42 }));
  for (const b of frame) d.parseIncoming(Buffer.from([b]));
  assert.equal(d.getTelemetry().battery.voltageV, 11.1);
});

test('a signed v2 frame is framed correctly despite its 13-byte signature', () => {
  const d = driver();
  const first = frameV2(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 9000, current_cA: 100, remaining: 30 }), { signed: true });
  const second = frameV2(MSG.POWER_STATUS,
    powerStatusPayload({ vcc_mV: 5000, vservo_mV: 5500, flags: 1 }));
  // If the signature length were not accounted for, the second frame would be
  // mis-parsed because the first frame's length was computed short.
  d.parseIncoming(Buffer.concat([first, second]));
  assert.equal(d.getTelemetry().battery.voltageV, 9);
  assert.equal(d.getTelemetry().power.boardV, 5,
    'the frame after a signed one must still parse');
});

test('a v2 signature is SKIPPED, not parsed as frame data', () => {
  // The previous signed-frame test could not catch a parser that ignored the
  // 13-byte signature: it would mis-advance, resync byte-by-byte, and still find
  // the following frame, so the assertion passed either way.
  //
  // This plants a VALID v1 POWER_STATUS frame inside the signature. A v1 frame with
  // a 5-byte payload is exactly 6+5+2 = 13 bytes — precisely the signature length.
  // If the signature is correctly skipped, that planted frame is never parsed and
  // `power` stays null. If the signature length is ignored, the parser lands on it
  // and decodes the planted values.
  const planted = Buffer.alloc(13);
  planted[0] = 0xFE;
  planted[1] = 5;                 // payload length (POWER_STATUS declares 6)
  planted[2] = 0;                 // seq
  planted[3] = 1;                 // sysid
  planted[4] = 1;                 // compid
  planted[5] = MSG.POWER_STATUS.id;
  planted.writeUInt16LE(1111, 6); // Vcc  — distinctive
  planted.writeUInt16LE(2222, 8); // Vservo
  planted[10] = 0;                // first byte of flags; the second is trimmed
  let pcrc = PWMMavproxy.crc16(planted.subarray(1, 11), 10);
  pcrc = PWMMavproxy.crcAccumulate(MSG.POWER_STATUS.crc, pcrc);
  planted.writeUInt16LE(pcrc, 11);

  const signed = frameV2(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 9000, current_cA: 100, remaining: 30 }),
    { signed: true });
  // Overwrite the signature area with the planted frame.
  planted.copy(signed, signed.length - 13);

  const d = driver();
  d.parseIncoming(signed);

  assert.equal(d.getTelemetry().battery.voltageV, 9,
    'the signed frame itself must still decode');
  assert.equal(d.getTelemetry().power, null,
    'a frame planted in the signature must NOT be parsed — the signature is opaque');
});

test('garbage between frames does not prevent the next frame decoding', () => {
  const d = driver();
  // A false 0xFE claiming a SHORT length: enough bytes are present to CRC-check it,
  // it fails, and the parser resyncs one byte at a time onto the real frame. (A
  // false header claiming a LONG length legitimately makes the parser wait for more
  // data instead — bounded, since a payload length is one byte so a frame can never
  // exceed 280 bytes.)
  const junk = Buffer.from([0xFE, 0x02, 0x00, 0x01, 0x01, 0x00, 0xAA, 0xBB, 0xCC, 0xDD]);
  d.parseIncoming(Buffer.concat([junk, frameV2(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 14800, current_cA: 500, remaining: 77 }))]));
  assert.equal(d.getTelemetry().battery.voltageV, 14.8);
});

test('a false header claiming a long length does not lose the following frame', () => {
  // It waits, then resyncs once enough bytes arrive. Assert eventual recovery
  // rather than immediate decode.
  const d = driver();
  // 0x99 = 153, so this bogus header claims a 161-byte frame. The parser cannot
  // CRC-check it — and so cannot reject it — until that many bytes exist. That is
  // correct behaviour and bounded: a payload length is a single byte, so no frame
  // can exceed 10 + 255 + 2 + 13 = 280 bytes. Feed a realistic ongoing stream and
  // require that it recovers.
  const junk = Buffer.from([0xFE, 0x99, 0x12, 0xFD]);
  const frame = frameV2(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 11000, current_cA: 200, remaining: 60 }));
  d.parseIncoming(junk);
  for (let i = 0; i < 10; i++) d.parseIncoming(frame);
  assert.equal(d.getTelemetry().battery.voltageV, 11,
    'the parser must resync past a bogus length rather than wedging');
  assert.ok(d.rxBuf.length < 280 * 2,
    `leftover buffer ${d.rxBuf.length} suggests the parser is not draining`);
});

test('the receive buffer is bounded against a stream that never yields a frame', () => {
  const d = driver();
  const chunk = Buffer.alloc(64 * 1024, 0xFD);   // looks like v2 magic, never valid
  for (let i = 0; i < 10; i++) d.parseIncoming(chunk);
  assert.ok(d.rxBuf.length <= 256 * 1024,
    `rx buffer grew to ${d.rxBuf.length} — it must be bounded`);
});

// ── Heartbeat attribution ────────────────────────────────────────────────────

test('a GCS heartbeat does not count as the flight controller', () => {
  // MAV_AUTOPILOT_INVALID (8) is what this driver's own heartbeat carries.
  // Accepting it would mean announcing a flight controller because we heard
  // ourselves — and it gates the parameter overlay.
  const d = driver({ mavproxy_apply_param_overlay: false });
  d.parseIncoming(frameV1(MSG.HEARTBEAT, heartbeatPayload({ autopilot: 8 })));
  assert.equal(d.pixhawkHeartbeatSeen, false);
  assert.equal(d.getTelemetry().autopilotHeartbeat, false);
});

test('an autopilot heartbeat is accepted and its armed bit read', () => {
  const d = driver({ mavproxy_apply_param_overlay: false });
  d.parseIncoming(frameV1(MSG.HEARTBEAT,
    heartbeatPayload({ autopilot: 3, base_mode: 0x80 })));
  assert.equal(d.pixhawkHeartbeatSeen, true);
  const t = d.getTelemetry();
  assert.equal(t.autopilotHeartbeat, true);
  assert.equal(d.telemetry.heartbeat.armed, true, 'SAFETY_ARMED bit must be decoded');
});

// ── Staleness ────────────────────────────────────────────────────────────────

test('telemetry older than the staleness window is reported as absent', () => {
  const d = driver();
  d.parseIncoming(frameV1(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 12600, current_cA: 350, remaining: 87 })));
  assert.ok(d.getTelemetry().battery, 'precondition: fresh reading present');

  // Backdate the reading past the window.
  d.telemetry.battery.at -= 10_000;
  assert.equal(d.getTelemetry().battery, null,
    'a stale reading must not be presented as live');
});

test('a fresh reading carries its age so a consumer can judge it', () => {
  const d = driver();
  d.parseIncoming(frameV1(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 12600, current_cA: 350, remaining: 87 })));
  const t = d.getTelemetry();
  assert.equal(typeof t.battery.ageMs, 'number');
  assert.ok(t.battery.ageMs >= 0 && t.battery.ageMs < 3000);
  assert.equal(t.battery.at, undefined, 'the raw timestamp should not leak out');
});

test('a link drop clears telemetry rather than freezing the last reading', () => {
  const d = driver();
  d.parseIncoming(frameV1(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 12600, current_cA: 350, remaining: 87 })));
  assert.ok(d.getTelemetry().battery);
  // Emulate the close handler's reset.
  d.telemetry = { battery: null, power: null, radio: null, heartbeat: null };
  assert.equal(d.getTelemetry().battery, null);
});

test('linkUp reflects whether the MAVProxy socket is actually usable', () => {
  const d = driver();
  assert.equal(d.getTelemetry().linkUp, false, 'no socket means no link');
  d.client = { destroyed: false, write() {} };
  assert.equal(d.getTelemetry().linkUp, true);
  d.client.destroyed = true;
  assert.equal(d.getTelemetry().linkUp, false);
});

// ── Gaps found by adversarial review: seven mutations survived the first suite ──

test('a zero voltage reads as unknown, not as a flat pack', () => {
  // ArduPilot sends voltage_battery=0 when BATT_MONITOR is unset. Reporting "0.0V"
  // is indistinguishable from a dead pack on the operator's display and would
  // permanently latch any batteryWarnVolts alarm.
  const d = driver();
  d.parseIncoming(frameV1(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 0, current_cA: 0, remaining: 0 })));
  assert.equal(d.getTelemetry().battery.voltageV, null);
});

test('a heartbeat from the wrong system is not accepted as our autopilot', () => {
  // Gates the parameter overlay, which writes RC_OVERRIDE_TIME — the flight
  // controller's own stale-override failsafe.
  const d = driver({ mavproxy_apply_param_overlay: false, mavproxy_target_system: 1 });
  const frame = frameV1(MSG.HEARTBEAT, heartbeatPayload({ autopilot: 3 }));
  frame[3] = 42;                                    // a different sysid
  let crc = PWMMavproxy.crc16(frame.subarray(1, 6 + MSG.HEARTBEAT.len), 5 + MSG.HEARTBEAT.len);
  crc = PWMMavproxy.crcAccumulate(MSG.HEARTBEAT.crc, crc);
  frame.writeUInt16LE(crc, 6 + MSG.HEARTBEAT.len);  // re-CRC so only sysid differs
  d.parseIncoming(frame);
  assert.equal(d.pixhawkHeartbeatSeen, false, 'sysId filter must reject a foreign autopilot');
});

test('a stale heartbeat stops counting as a live autopilot', () => {
  const d = driver({ mavproxy_apply_param_overlay: false });
  d.parseIncoming(frameV1(MSG.HEARTBEAT, heartbeatPayload({ autopilot: 3 })));
  assert.equal(d.getTelemetry().autopilotHeartbeat, true);
  d.telemetry.heartbeat.at -= 10_000;
  assert.equal(d.getTelemetry().autopilotHeartbeat, false,
    'freshness must be applied to the heartbeat, not just recorded');
});

test('awaitingAutopilot flags a live link with no identified flight controller', () => {
  // This is the condition under which the parameter overlay has NOT been applied.
  const d = driver({ mavproxy_apply_param_overlay: false });
  d.client = { destroyed: false, write() {} };
  assert.equal(d.getTelemetry().awaitingAutopilot, true);
  d.parseIncoming(frameV1(MSG.HEARTBEAT, heartbeatPayload({ autopilot: 3 })));
  assert.equal(d.getTelemetry().awaitingAutopilot, false);
});

test('RADIO_STATUS survives v2 zero-trimming', () => {
  // remnoise=0 trims the tail; without zero-extension the last field read throws.
  const d = driver();
  d.parseIncoming(frameV2(MSG.RADIO_STATUS, radioStatusPayload({
    rxerrors: 0, fixed: 0, rssi: 200, remrssi: 195, txbuf: 0, noise: 0, remnoise: 0,
  })));
  const t = d.getTelemetry();
  assert.equal(t.radio.rssi, 200);
  assert.equal(t.radio.remRssi, 195);
  assert.equal(t.radio.remNoise, 0, 'a trimmed-away field must read as zero, not throw');
});

// PARAM_VALUE is the whole reason the v2 rewrite exists — proving read-back works is
// a P0 in TASKS.md — and it had no test at all.
function paramValuePayload(name, value, type = 9) {
  const p = Buffer.alloc(MSG.PARAM_VALUE.len);
  p.writeFloatLE(value, 0);
  p.writeUInt16LE(1, 4);        // param_count
  p.writeUInt16LE(0, 6);        // param_index
  Buffer.from(name, 'ascii').copy(p, 8, 0, Math.min(16, name.length));
  p.writeUInt8(type, 24);
  return p;
}

test('PARAM_VALUE read-back verifies a critical parameter', () => {
  const d = driver();
  d.parseIncoming(frameV2(MSG.PARAM_VALUE, paramValuePayload('SERVO1_FUNCTION', 26)));
  assert.ok(d.verifiedCriticalParams.has('SERVO1_FUNCTION'),
    'a matching read-back must mark the parameter verified');
  assert.equal(d.paramVerificationFailures.size, 0);
});

test('PARAM_VALUE read-back detects a mismatched critical parameter', () => {
  const d = driver();
  d.parseIncoming(frameV2(MSG.PARAM_VALUE, paramValuePayload('SERVO3_FUNCTION', 999)));
  assert.equal(d.verifiedCriticalParams.has('SERVO3_FUNCTION'), false);
  assert.ok(d.paramVerificationFailures.has('SERVO3_FUNCTION'),
    'a wrong value must be recorded as a failure, not silently ignored');
  assert.equal(d.paramVerificationFailures.get('SERVO3_FUNCTION').actual, 999);
});

test('PARAM_VALUE tolerates a float parameter within tolerance', () => {
  const d = driver();
  d.parseIncoming(frameV2(MSG.PARAM_VALUE, paramValuePayload('RC_OVERRIDE_TIME', 0.2)));
  assert.ok(d.verifiedCriticalParams.has('RC_OVERRIDE_TIME'));
});

test('a PARAM_VALUE with a corrupt CRC is not believed', () => {
  const d = driver();
  const frame = frameV2(MSG.PARAM_VALUE, paramValuePayload('SERVO1_FUNCTION', 26));
  frame[frame.length - 1] ^= 0xFF;
  d.parseIncoming(frame);
  assert.equal(d.verifiedCriticalParams.has('SERVO1_FUNCTION'), false);
});

test('the socket close handler itself clears telemetry', async () => {
  // The previous version of this test hand-wrote the reset instead of invoking the
  // handler, so deleting the reset from the driver left the suite green.
  const d = driver();
  d.parseIncoming(frameV1(MSG.SYS_STATUS,
    sysStatusPayload({ voltage_mV: 12600, current_cA: 350, remaining: 87 })));
  assert.ok(d.getTelemetry().battery, 'precondition: a reading is present');

  // Drive the real close path: _connect wires it, so build a socket-like object and
  // let the driver attach its handlers to it.
  const handlers = {};
  const fakeSocket = {
    destroyed: false,
    on(evt, fn) { handlers[evt] = fn; },
    write() {}, kill() {},
  };
  const net = require('net');
  const realCreate = net.createConnection;
  // Defer: _connect assigns `const socket` AFTER createConnection returns, so a
  // synchronous callback hits the temporal dead zone.
  net.createConnection = (_opts, onConnect) => { setImmediate(onConnect); return fakeSocket; };
  try {
    const d2 = new PWMMavproxy({ mavproxy_autostart: false });
    d2.startServer();
    await new Promise((r) => setImmediate(r));   // let the connect callback run
    d2.parseIncoming(frameV1(MSG.SYS_STATUS,
      sysStatusPayload({ voltage_mV: 12600, current_cA: 350, remaining: 87 })));
    assert.ok(d2.getTelemetry().battery, 'precondition: reading present before close');
    // The close handler schedules a reconnect 2 s later; neuter it so the test
    // runner is not held open by a real TCP retry loop.
    d2._connect = () => {};
    handlers.close();
    assert.equal(d2.telemetry.battery, null,
      'the close handler must clear telemetry, not leave a frozen reading');
    if (d2.interval) clearInterval(d2.interval);
    if (d2.heartbeatInterval) clearInterval(d2.heartbeatInterval);
    if (d2.heartbeatWatch) clearTimeout(d2.heartbeatWatch);
  } finally {
    net.createConnection = realCreate;
  }
});

// ── The overlay must be applied on CONNECT, not gated behind the heartbeat ────
//
// This is the invariant-6 fail-open a Codex review found, and the test that was
// missing. Gating applyParamOverlay() behind a genuine autopilot heartbeat meant
// that if the RETURN path failed — wrong sysId, broken framing, a receive path
// that never delivers — RC_OVERRIDE_TIME=0.2 was never transmitted, while
// outbound ARM and RC overrides kept working. ArduPilot silently kept its 3.0 s
// default: a 15x longer window in which a stale override persists, on a vehicle
// that was still drivable. Nothing recovered from it; the watchdog only logs.
//
// The earlier heartbeat tests all pass `mavproxy_apply_param_overlay: false`, so
// none of them could ever have caught this. Mutation confirmed it: deleting the
// applyParamOverlay() call left the whole suite green.

function withFakeConnect(run) {
  const handlers = {};
  const writes = [];
  const fakeSocket = {
    destroyed: false,
    on(evt, fn) { handlers[evt] = fn; },
    write(b) { writes.push(Buffer.from(b)); return true; },
  };
  const net = require('net');
  const realCreate = net.createConnection;
  net.createConnection = (_opts, onConnect) => { setImmediate(onConnect); return fakeSocket; };
  return { handlers, writes, restore: () => { net.createConnection = realCreate; } };
}

function stopTimers(d) {
  if (d.interval)          { clearInterval(d.interval);          d.interval = null; }
  if (d.heartbeatInterval) { clearInterval(d.heartbeatInterval); d.heartbeatInterval = null; }
  if (d.heartbeatWatch)    { clearTimeout(d.heartbeatWatch);     d.heartbeatWatch = null; }
  if (d.armTimeout)        { clearTimeout(d.armTimeout);         d.armTimeout = null; }
  d._connect = () => {};                       // neuter the close-handler retry
  d.client = { destroyed: true, write: () => false };
}

test('connecting applies the parameter overlay without waiting for a heartbeat', async () => {
  const h = withFakeConnect();
  let d;
  try {
    d = new PWMMavproxy({ mavproxy_autostart: false });
    let overlayCalls = 0;
    d.applyParamOverlay = () => { overlayCalls += 1; };
    d.startServer();
    await new Promise((r) => setImmediate(r));

    assert.equal(overlayCalls, 1,
      'the overlay must be applied on connect — gating it on the heartbeat was fail-open');
    assert.equal(d.pixhawkHeartbeatSeen, false,
      'and it must NOT have required an autopilot heartbeat first');
  } finally {
    // Unconditional. With this after the assertions, a failing mutant leaked the
    // driver's 20 Hz interval and `node --test` HUNG instead of reporting the
    // failure — which reads exactly like a pass.
    if (d) stopTimers(d);
    h.restore();
  }
});

test('the overlay is applied even when no autopilot heartbeat ever arrives', async () => {
  // The failure this exists to prevent: a one-way return path. We transmit fine and
  // hear nothing back, so RC_OVERRIDE_TIME must still reach the wire.
  //
  // applyParamOverlay() spaces its PARAM_SETs 250 ms apart and then schedules
  // read-backs, so the real chain runs for ~3 s AND its timers are untracked (a
  // known P1). Waiting for it made this test slow and leaked handles into the
  // runner. So run the chain synchronously by swapping setTimeout for an immediate
  // executor: deterministic, fast, and nothing survives the test.
  const h = withFakeConnect();
  const realSetTimeout = global.setTimeout;
  let d;
  try {
    d = new PWMMavproxy({ mavproxy_autostart: false });
    const params = [];
    d.buildParamSet = (name, value) => { params.push([name, value]); return Buffer.alloc(0); };
    d.buildParamRequestRead = () => Buffer.alloc(0);
    d.sendPacket = () => true;

    global.setTimeout = (fn) => { fn(); return { unref() {} }; };
    d.applyParamOverlay();
    global.setTimeout = realSetTimeout;

    const names = params.map(([n]) => n);
    assert.ok(names.includes('RC_OVERRIDE_TIME'),
      `RC_OVERRIDE_TIME must be transmitted with no heartbeat at all (sent: ${names.join(',')})`);
    assert.equal(params.find(([n]) => n === 'RC_OVERRIDE_TIME')[1], 0.2,
      'and it must carry 0.2, not the flight controller default of 3.0');
    assert.equal(d.pixhawkHeartbeatSeen, false, 'with no autopilot heartbeat received');
  } finally {
    global.setTimeout = realSetTimeout;
    if (d) stopTimers(d);
    h.restore();
  }
});

test('the heartbeat releases the deferred overlay EXACTLY once, not once per second', async () => {
  // This test's assertion changed on 2026-08-12 and the change is deliberate. It used to
  // require that a heartbeat never applied the overlay at all — the design where the
  // heartbeat was for VERIFICATION only. The overlay is now tiered: RC_OVERRIDE_TIME goes
  // out on connect for the fail-open reason _connect documents, and the CONFIGURATION tier
  // waits to learn what the autopilot is, because pushing it blind overwrote RC3_DZ on
  // rover1's PX4 board (10 -> 30, measured).
  //
  // What has NOT changed is the reason the old assertion existed: overlapping PARAM_SET
  // chains. That reason is now MORE load-bearing, not less — heartbeats arrive at 1 Hz
  // forever, so an unguarded release would clear the in-flight timers and restart the
  // chain every second, and the overlay would never complete on any rover. That is what
  // the loop below is for.
  const h = withFakeConnect();
  let d;
  try {
    d = new PWMMavproxy({ mavproxy_autostart: false });
    const tiers = [];
    d.applyParamOverlay = (opts) => { tiers.push((opts && opts.tier) || 'full'); };
    d.startOverlayReassertWatch = () => {};
    d.startServer();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(tiers, ['preIdentity'],
      'connect must apply the pre-identity tier and nothing else');

    const hb = () => d.parseIncoming(frameV1(MSG.HEARTBEAT,
      heartbeatPayload({ autopilot: 3, base_mode: 129 })));

    hb();
    assert.equal(d.pixhawkHeartbeatSeen, true, 'the heartbeat is still recognised');
    assert.deepEqual(tiers, ['preIdentity', 'full'],
      'the first autopilot heartbeat releases the configuration tier');

    for (let i = 0; i < 20; i++) hb();
    assert.deepEqual(tiers, ['preIdentity', 'full'],
      'twenty more heartbeats must not restart the chain — at 1 Hz that never completes');
    // Honest note on WHAT stops the repeat here: noteAutopilotIdentity returns early when
    // the identity is unchanged, so this loop does not exercise applyDeferredOverlay's own
    // idempotence guard. Deleting that guard survived this test. The next test covers it.
  } finally {
    if (d) stopTimers(d);
    h.restore();
  }
});

test('a heartbeat arriving AFTER the grace window does not restart the chain', async () => {
  // The case the loop above cannot reach, and the one the idempotence guard exists for: a
  // slow or late autopilot. Grace expires and applies the tier unidentified; the heartbeat
  // then arrives and identifies a genuine ArduRover, which is a CHANGE of identity, so the
  // early-return in noteAutopilotIdentity does not apply. Without the guard the whole
  // PARAM_SET chain is cancelled and restarted, mid-flight.
  const h = withFakeConnect();
  let d;
  try {
    d = new PWMMavproxy({ mavproxy_autostart: false, mavproxy_identity_grace_ms: 500 });
    const tiers = [];
    d.applyParamOverlay = (opts) => { tiers.push((opts && opts.tier) || 'full'); };
    d.startOverlayReassertWatch = () => {};
    d.startServer();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(tiers, ['preIdentity'], 'precondition: grace expired and REFUSED');

    d.parseIncoming(frameV1(MSG.HEARTBEAT, heartbeatPayload({ autopilot: 3, base_mode: 129 })));
    assert.equal(d.pixhawkHeartbeatSeen, true, 'the late heartbeat is recognised');
    assert.deepEqual(tiers, ['preIdentity', 'full'],
      'and a LATE identification still releases the tier the timeout withheld');
    d.parseIncoming(frameV1(MSG.HEARTBEAT, heartbeatPayload({ autopilot: 3, base_mode: 129 })));
    assert.deepEqual(tiers, ['preIdentity', 'full'],
      'but only once — at 1 Hz an unguarded release never completes a chain');
  } finally {
    if (d) stopTimers(d);
    h.restore();
  }
});

test('with NO heartbeat at all, the configuration tier is REFUSED, not written blind', async () => {
  // This test asserted the opposite until 2026-08-12 and two reviewers overturned it. Applying
  // the tier on timeout meant the protection vanished in exactly the degraded case it was
  // built for — a missing or slow heartbeat — recreating the measured rover1 corruption after
  // 2 s. A timeout is not evidence of an ArduRover.
  //
  // The cost is real and is accepted deliberately: a genuine ArduRover with a dead RETURN path
  // never gets its output mapping. See the comment at the refusal for why that trade is taken.
  const h = withFakeConnect();
  let d;
  try {
    d = new PWMMavproxy({ mavproxy_autostart: false, mavproxy_identity_grace_ms: 500 });
    const tiers = [];
    const warnings = [];
    const origErr = console.error;
    console.error = (...a) => warnings.push(a.join(' '));
    d.applyParamOverlay = (opts) => { tiers.push((opts && opts.tier) || 'full'); };
    d._restoreErr = () => { console.error = origErr; };
    let watchArmed = 0;
    d.startOverlayReassertWatch = () => { watchArmed += 1; };
    d.startServer();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(tiers, ['preIdentity']);
    assert.equal(d.identityGraceMs, 500, 'precondition: the grace window is the one set');

    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(tiers, ['preIdentity'],
      'the configuration tier must NOT be written to an unidentified flight controller');
    assert.equal(watchArmed, 0, 'and no reassert chain is started for writes never made');
    assert.equal(d.pixhawkHeartbeatSeen, false, 'with no autopilot heartbeat received');
    assert.match(warnings.join('\n'), /REFUSING the ArduRover configuration overlay/);
    assert.equal(d.getTelemetry().firmware.identityTimedOut, true,
      'and /status must distinguish "never identified" from "identified and refused"');
  } finally {
    if (d && d._restoreErr) d._restoreErr();
    if (d) stopTimers(d);
    h.restore();
  }
});

test('RC_OVERRIDE_TIME still goes out when identification times out', async () => {
  // The half that must NOT change with the refusal above. RC_OVERRIDE_TIME is the flight
  // controller's own stale-override failsafe; withholding it because nothing identified the
  // board would leave ArduPilot on its 3.0 s default while picar streams overrides at 20 Hz.
  const h = withFakeConnect();
  let d;
  try {
    d = new PWMMavproxy({ mavproxy_autostart: false, mavproxy_identity_grace_ms: 500 });
    const tiers = [];
    d.applyParamOverlay = (opts) => { tiers.push((opts && opts.tier) || 'full'); };
    d.startOverlayReassertWatch = () => {};
    d.startServer();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(tiers, ['preIdentity'],
      'the pre-identity tier must still go out, timeout or not');
  } finally {
    if (d) stopTimers(d);
    h.restore();
  }
});

test('the grace window is bounded however the untracked overlay sets it', () => {
  // Invariant 8 is still open: picar-cfg.local.json can set any key with no review. This
  // one delays a safety-relevant write, so its range is clamped rather than trusted.
  const mk = (v) => new PWMMavproxy({ mavproxy_autostart: false, mavproxy_identity_grace_ms: v });
  assert.equal(mk(0).identityGraceMs, 500, 'zero must not mean "never wait" by accident');
  assert.equal(mk(-1).identityGraceMs, 500);
  assert.equal(mk(1e9).identityGraceMs, 10000, 'nor may it defer the mapping indefinitely');
  assert.equal(mk('nonsense').identityGraceMs, 2000, 'a non-numeric value falls back to the default');
  assert.equal(mk(undefined).identityGraceMs, 2000);
  assert.equal(mk(1500).identityGraceMs, 1500, 'a sane value is honoured');
});

test('a reconnect discards the voltage smoothing window', async () => {
  // Stale samples survived a reconnect, so an old high reading could outvote a
  // fresh low one: five 8.4 V samples then a reconnect and a real 6.0 V reading
  // reported "6.0 V, ~100%". That does not merely look wrong — it CLEARS the
  // low-battery warning for up to the whole window.
  const h = withFakeConnect();
  let d;
  try {
    d = new PWMMavproxy({
      mavproxy_autostart: false,
      battery_empty_volts: 6.0,
      battery_full_volts: 8.4,
      battery_pct_median_samples: 5,
    });
    d.applyParamOverlay = () => {};
    d.startServer();
    await new Promise((r) => setImmediate(r));

    for (let i = 0; i < 5; i++) {
      d.parseIncoming(frameV1(MSG.SYS_STATUS,
        sysStatusPayload({ voltage_mV: 8400, current_cA: 45, remaining: 0 })));
    }
    assert.equal(d.telemetry.battery.remainingPct, 100, 'precondition: reads full');

    d._connect = () => {};
    h.handlers.close();
    assert.deepEqual(d.batteryVoltHistory, [],
      'the smoothing window must be discarded with the rest of the telemetry');

    // A fresh low reading after the reconnect must read low immediately.
    d.parseIncoming(frameV1(MSG.SYS_STATUS,
      sysStatusPayload({ voltage_mV: 6000, current_cA: 45, remaining: 0 })));
    assert.equal(d.telemetry.battery.remainingPct, 0,
      'a fresh 6.0 V reading must not be masked by pre-reconnect samples');
  } finally {
    if (d) stopTimers(d);
    h.restore();
  }
});

test('RC_OVERRIDE_TIME is the FIRST parameter written, not the seventh', () => {
  // It is the flight controller's own stale-override failsafe: until it lands,
  // ArduPilot is on its 3.0 s default while picar is already streaming overrides.
  // As the seventh entry it went out ~1500 ms after connect (250 ms spacing), so
  // ordering here is a safety property, not cosmetics.
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  const names = Object.keys(d.paramOverlay);
  assert.equal(names[0], 'RC_OVERRIDE_TIME',
    `RC_OVERRIDE_TIME must be written first (order: ${names.join(',')})`);
  assert.equal(d.paramOverlay.RC_OVERRIDE_TIME, 0.2);
});

test('a reconnect cancels an in-flight overlay instead of stacking chains', () => {
  // The overlay now runs on every connect, so without cancellation reconnect churn
  // stacks overlapping PARAM_SET chains that nothing can stop.
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  d.sendPacket = () => true;
  d.applyParamOverlay();
  const first = d.overlayTimers.length;
  assert.ok(first > 0, 'the overlay must schedule tracked timers');

  d.applyParamOverlay();
  assert.equal(d.overlayTimers.length, first,
    're-applying must cancel the previous chain, not add to it');

  d.clearOverlayTimers();
  assert.deepEqual(d.overlayTimers, [], 'and they must be cancellable');
});

test('a PARAM_SET that could not be written is reported, not silently dropped', () => {
  // paramOverlayApplied becomes true before any write executes, so a link that dies
  // mid-overlay must at least say so — otherwise the overlay claims to have been
  // applied while nothing reached the flight controller.
  const realSetTimeout = global.setTimeout;
  const errs = [];
  const realError = console.error;
  try {
    const d = new PWMMavproxy({ mavproxy_autostart: false });
    d.sendPacket = () => false;                 // link down
    d.buildParamSet = () => Buffer.alloc(0);
    d.buildParamRequestRead = () => Buffer.alloc(0);
    console.error = (m) => errs.push(String(m));
    global.setTimeout = (fn) => { fn(); return { unref() {} }; };
    d.applyParamOverlay();
  } finally {
    global.setTimeout = realSetTimeout;
    console.error = realError;
  }
  assert.ok(errs.some((e) => e.includes('was NOT written')),
    `a failed PARAM_SET must be reported (saw: ${errs.length} errors)`);
});

// ── The overlay is reasserted until read-back confirms it ─────────────────────

test('the overlay is reasserted when read-back does not confirm it', async () => {
  // A TCP connection to MAVProxy is not proof its serial master is usable, and
  // sendPacket only proves bytes reached the local socket — so the first overlay can
  // be lost in its entirety, RC_OVERRIDE_TIME included, while arming and the override
  // stream carry on. Nothing retried it.
  const h = withFakeConnect();
  let d;
  try {
    d = new PWMMavproxy({
      mavproxy_autostart: false,
      mavproxy_overlay_reassert_ms: 3000,   // clamped floor
      mavproxy_overlay_max_attempts: 3,
    });
    let attempts = 0;
    d.applyParamOverlay = () => { attempts += 1; };
    d.startServer();
    await new Promise((r) => setImmediate(r));
    assert.equal(attempts, 1, 'the pre-identity tier happens on connect');
    // Assert the WIRING, not just the mechanism — calling startOverlayReassertWatch() by
    // hand below would pass even if nothing armed it, which is exactly how the first
    // version of this test was vacuous and mutation proved it.
    //
    // The watch is armed by the DEFERRED chain rather than by _connect as of 2026-08-12.
    // It must not be armed earlier: its interval floor is derived from the chain length,
    // so arming it up to identityGraceMs before the chain starts lets the first check fire
    // mid-chain, find params missing, and cancel the writes still in flight.
    assert.equal(d.overlayReassertTimer, null,
      'the watch must not be armed before the chain it checks has started');
    d.parseIncoming(frameV1(MSG.HEARTBEAT, heartbeatPayload({ autopilot: 3, base_mode: 129 })));
    assert.equal(attempts, 2, 'identification releases the configuration tier');
    assert.notEqual(d.overlayReassertTimer, null,
      'and arms the reassert watch, or a lost overlay is never retried');

    // Nothing verified: the watch must fire another attempt.
    d.overlayReassertMs = 1;
    d.startOverlayReassertWatch();
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(attempts >= 2, `an unconfirmed overlay must be reasserted (attempts=${attempts})`);
    assert.equal(d.paramOverlayApplied, false,
      'and it must NOT be marked applied while still unconfirmed');
  } finally {
    if (d) { if (d.overlayReassertTimer) clearTimeout(d.overlayReassertTimer); stopTimers(d); }
    h.restore();
  }
});

test('reasserting stops once read-back confirms every critical parameter', async () => {
  const h = withFakeConnect();
  let d;
  try {
    d = new PWMMavproxy({ mavproxy_autostart: false });
    let attempts = 0;
    d.applyParamOverlay = () => { attempts += 1; };
    d.startServer();
    await new Promise((r) => setImmediate(r));

    // Mark everything verified, as a successful read-back would.
    // Read the REAL list. This used to be `EXPECTED_CRITICAL_PARAMS || {}` with a
    // hand-transcribed fallback, and because the constant was module-scoped and not
    // exported, the require() was ALWAYS undefined and the fallback ALWAYS ran. It
    // happened to match, so the test passed for the wrong reason and would have gone
    // on passing after the real list changed. The constant is exported now, and this
    // asserts the export rather than tolerating its absence.
    const expected = require('../pwm_mavproxy_servo.js').EXPECTED_CRITICAL_PARAMS;
    assert.ok(expected && Object.keys(expected).length > 0,
      'EXPECTED_CRITICAL_PARAMS must be exported for this test to mean anything');
    for (const n of Object.keys(expected)) d.verifiedCriticalParams.add(n);
    const before = attempts;
    d.overlayReassertMs = 1;
    d.startOverlayReassertWatch();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(attempts, before, 'a confirmed overlay must not be reasserted');
    assert.equal(d.paramOverlayApplied, true, 'and only now is it marked applied');
  } finally {
    if (d) { if (d.overlayReassertTimer) clearTimeout(d.overlayReassertTimer); stopTimers(d); }
    h.restore();
  }
});

test('a close cancels the overlay timer chain', async () => {
  // Removing clearOverlayTimers() from the close handler previously survived the
  // whole suite: the test named "a reconnect cancels..." only called
  // applyParamOverlay twice and then cancelled by hand.
  const h = withFakeConnect();
  let d;
  try {
    d = new PWMMavproxy({ mavproxy_autostart: false });
    d.sendPacket = () => true;
    d.startServer();
    await new Promise((r) => setImmediate(r));
    assert.ok(d.overlayTimers.length > 0, 'precondition: a chain is in flight');

    d._connect = () => {};
    h.handlers.close();
    assert.deepEqual(d.overlayTimers, [],
      'the close handler must cancel the overlay chain, not leave it writing to a dead socket');
    assert.equal(d.overlayReassertTimer, null, 'and the reassert watch too');
    assert.equal(d.paramOverlayApplied, false, 'and it is no longer considered applied');
  } finally {
    if (d) stopTimers(d);
    h.restore();
  }
});

test('an all-invalid RADIO_STATUS reports NO radio, so the Wi-Fi fallback shows', () => {
  // UINT8_MAX means "invalid" for these fields. Mapping them to null was not enough:
  // the radio OBJECT stayed non-null, socket.html selects it by truthiness, and the
  // bar rendered "Radio: null/null rem null" — which suppressed the Wi-Fi link
  // quality, the one measurement that is actually real on this vehicle.
  const d = driver({ mavproxy_apply_param_overlay: false });
  d.parseIncoming(frameV1(MSG.RADIO_STATUS, radioStatusPayload({
    rssi: 255, remrssi: 255, noise: 255, remnoise: 255, rxerrors: 0, fixed: 0, txbuf: 100,
  })));
  assert.equal(d.getTelemetry().radio, null,
    'a frame with no usable signal level must not present itself as a radio link');
});

test('a partially valid RADIO_STATUS is still reported, with the invalid fields null', () => {
  // Must not throw the baby out: a real SiK frame with a valid rssi but an
  // unmeasured noise floor is still a genuine link report.
  const d = driver({ mavproxy_apply_param_overlay: false });
  d.parseIncoming(frameV1(MSG.RADIO_STATUS, radioStatusPayload({
    rssi: 180, remrssi: 255, noise: 255, remnoise: 40, rxerrors: 2, fixed: 1, txbuf: 95,
  })));
  const r = d.getTelemetry().radio;
  assert.notEqual(r, null, 'a usable rssi means a usable link report');
  assert.equal(r.rssi, 180);
  assert.equal(r.remRssi, null, '255 remrssi is unknown');
  assert.equal(r.noise, null);
  assert.equal(r.remNoise, 40);
});

// ── The two guards round 7 found uncovered ───────────────────────────────────

// frameV1 hardcodes sysId 1 (the autopilot). The radio does not use sysId 1.
function frameV1From(msg, payload, sysId, compId = 1) {
  const buf = frameV1(msg, payload);
  buf[3] = sysId;
  buf[4] = compId;
  // Reseal: changing a header byte invalidates the CRC, and a frame the parser
  // rejects for a bad checksum would pass this test for entirely the wrong reason.
  // That exact mistake was made four times on this branch.
  let crc = PWMMavproxy.crc16(buf.subarray(1, 6 + payload.length), 5 + payload.length);
  crc = PWMMavproxy.crcAccumulate(msg.crc, crc);
  buf.writeUInt16LE(crc, 6 + payload.length);
  return buf;
}

test('mavproxy_radio_system closes the RADIO_STATUS spoofing hole', () => {
  // Surviving mutation: replace the source gate with `if (false)`. No test set
  // mavproxy_radio_system, so the configurable half of a documented spoofing hole
  // was entirely unverified — the config key could have been inert.
  const pinned = driver({ mavproxy_radio_system: 51 });
  pinned.parseIncoming(frameV1From(MSG.RADIO_STATUS,
    radioStatusPayload({ rssi: 180, remrssi: 170, noise: 30, remnoise: 25 }), 51));
  assert.ok(pinned.getTelemetry().radio, 'the configured radio sysId must be accepted');
  assert.equal(pinned.getTelemetry().radio.rssi, 180);

  const spoofed = driver({ mavproxy_radio_system: 51 });
  spoofed.parseIncoming(frameV1From(MSG.RADIO_STATUS,
    radioStatusPayload({ rssi: 10, remrssi: 10, noise: 200, remnoise: 200 }), 77));
  assert.equal(spoofed.getTelemetry().radio, null,
    'a CRC-valid RADIO_STATUS from any other sysId must be dropped once the radio ' +
    'sysId is pinned — otherwise anything on the link can fake link quality and ' +
    'suppress the Wi-Fi fallback');
});

test('an unpinned radio sysId still accepts the fitted radio', () => {
  // The documented default, asserted so the hole cannot be closed by accident and
  // silently break radio telemetry on a rover that has not set the key. SiK emits
  // source system 51 (ASCII '3'), which is not the autopilot's sysId.
  const d = driver();
  d.parseIncoming(frameV1From(MSG.RADIO_STATUS,
    radioStatusPayload({ rssi: 180, remrssi: 170, noise: 30, remnoise: 25 }), 51));
  assert.ok(d.getTelemetry().radio, 'gating on target_system would drop all SiK telemetry');
});

test('every decoded message declares both a CRC_EXTRA and a payload length', () => {
  // Surviving mutation: delete the load-time consistency check. Its own comment says
  // the consequence is "a crash on the MAVLink receive path" — a field read past the
  // end of an un-extended payload throws ERR_OUT_OF_RANGE inside the socket data
  // handler, which is a process-level failure while the vehicle can move, not a
  // dropped message. Nothing proved the check fires.
  const { MSG_CRC_EXTRA, MSG_PAYLOAD_LEN } = PWMMavproxy;
  assert.ok(MSG_CRC_EXTRA && Object.keys(MSG_CRC_EXTRA).length > 0, 'tables must be exported');
  for (const id of Object.keys(MSG_CRC_EXTRA)) {
    assert.notEqual(MSG_PAYLOAD_LEN[id], undefined,
      `msgId ${id} has a CRC_EXTRA but no MSG_PAYLOAD_LEN, so its payload is never ` +
      'zero-extended and a field read past its end crashes the receive path');
  }
});

test('a maximally zero-trimmed frame of every known type never throws', () => {
  // The property the load-time check protects, asserted directly. A real v2 sender
  // trims trailing zero bytes, so a message whose fields are all zero arrives with a
  // 1-byte payload; every handler must survive that.
  for (const [name, msg] of Object.entries(MSG)) {
    const d = driver();
    assert.doesNotThrow(() => d.parseIncoming(frameV2(msg, Buffer.alloc(msg.len))),
      `${name} (msgId ${msg.id}) threw on a fully zero-trimmed payload`);
  }
});

test('a reassert does not blank the already-verified parameter list', () => {
  // The status bar flipped 'FC: ok' -> 'FC: 8 param unverified' -> 'FC: ok' up to four
  // times per connect, because applyParamOverlay() cleared verifiedCriticalParams on
  // entry and each chain takes ~4 s to re-confirm. Churn on the one indicator this
  // branch added to be trusted teaches an operator to ignore it. Verification state is
  // invalidated by a CLOSE (a possibly different flight controller), not by a retry.
  const d = driver();
  d.sendPacket = () => true;
  for (const n of Object.keys(PWMMavproxy.EXPECTED_CRITICAL_PARAMS)) {
    d.verifiedCriticalParams.add(n);
  }
  assert.deepEqual(d.getTelemetry().params.missing, [], 'precondition: all verified');

  d.applyParamOverlay();
  d.clearOverlayTimers();
  assert.deepEqual(d.getTelemetry().params.missing, [],
    'a reassert must not report every critical parameter as unverified again');
});

test('a recorded mismatch survives a reassert until read-back contradicts it', () => {
  // The fail-CLOSED direction: if a reassert's read-backs are all lost, the warning
  // must stay up rather than being cleared by the attempt itself.
  const d = driver();
  d.sendPacket = () => true;
  d.paramVerificationFailures.set('FRAME_CLASS', { actual: 2, expected: 1 });
  d.applyParamOverlay();
  d.clearOverlayTimers();
  assert.ok(d.getTelemetry().params.mismatched.FRAME_CLASS,
    'a retry must not clear the evidence of a mismatch it has not yet disproved');
});

test('a half-configured pack range is reported, not silently ignored', () => {
  // Setting only battery_empty_volts is the natural half-finished edit for the config
  // comment that reads "Examples: 2S LiPo 6.0/8.4". It fell straight through the
  // range-validation block: no range, no message — and app.js's startup guard only
  // checked battery_empty_volts, so it was suppressed too. The result was a rover
  // with no percentage, no voltage threshold, and no complaint about either, where a
  // deeply over-discharged pack raises nothing at all.
  const captured = [];
  const realError = console.error;
  console.error = (...a) => captured.push(a.join(' '));
  let d1, d2, d3;
  try {
    d1 = driver({ battery_empty_volts: 6.0 });                            // full missing
    d2 = driver({ battery_full_volts: 8.4 });                             // empty missing
    d3 = driver({ battery_empty_volts: 6.0, battery_full_volts: 8.4 });   // complete
  } finally {
    console.error = realError;
  }
  assert.equal(d1.batteryRange, null, 'a half range must not enable the estimate');
  assert.equal(d2.batteryRange, null);
  assert.deepEqual(d3.batteryRange, { emptyV: 6.0, fullV: 8.4 },
    'and a complete range must still work');

  const halfMsgs = captured.filter((m) => /must BOTH be set/.test(m));
  assert.equal(halfMsgs.length, 2,
    `both half-configured drivers must complain (got ${captured.length} messages: ` +
    `${JSON.stringify(captured)})`);
});

test('getTelemetry declares the driver IS a flight controller', () => {
  // The motion gate in test/on-target/control-e2e.js refuses unless `fcSupported === true`.
  // The field was never emitted here, so on a real rover it was undefined and the gate
  // refused every time — `--allow-motion` could not authorise motion on hardware, and the
  // mandatory on-target pass was unobtainable. The host tests hid it by constructing
  // telemetry with the field set. Found by an adversarial review, not by the suite.
  const d = driver();
  assert.equal(d.getTelemetry().fcSupported, true);
});

test('telemetry-loop forwards fcSupported instead of manufacturing it', () => {
  // The other half of the same contract. If the wrapper defaulted the field, a future
  // driver with getTelemetry but no MAVLink would be reported as a flight controller.
  const { buildTelemetryWiring } = require('../telemetry-loop.js');
  const withFc = buildTelemetryWiring({
    pwm: { getTelemetry: () => ({ fcSupported: true, linkUp: true }) },
    io: { emit() {} }, fs: { promises: {} },
  });
  assert.equal(withFc.getFcTelemetry().fcSupported, true);

  const gpio = buildTelemetryWiring({ pwm: {}, io: { emit() {} }, fs: { promises: {} } });
  assert.equal(gpio.getFcTelemetry().fcSupported, false,
    'a driver with no telemetry at all must report false, not absent');

  const odd = buildTelemetryWiring({
    pwm: { getTelemetry: () => ({ linkUp: true }) },
    io: { emit() {} }, fs: { promises: {} },
  });
  assert.equal(odd.getFcTelemetry().fcSupported, undefined,
    'and an unknown driver must stay undefined so the motion gate refuses it');
});

test('a stale autopilot identity does not survive into the next connection', async () => {
  // autopilotIdent persisted across the 2 s reconnect loop, so a prior ArduRover identity
  // suppressed the unidentified-controller warning while a REPLACEMENT board — the exact
  // scenario the overlay exists for — was treated as already identified.
  //
  // This drives the REAL close handler through withFakeConnect. A first version assigned
  // `d.autopilotIdent = null` by hand to stand in for it, which asserted the assignment
  // rather than the code, and deleting the reset survived it.
  const h = withFakeConnect();
  let d;
  try {
    d = new PWMMavproxy({ mavproxy_autostart: false });
    d.applyParamOverlay = () => {};
    d.startOverlayReassertWatch = () => {};
    d.startServer();
    await new Promise((r) => setImmediate(r));

    d.parseIncoming(frameV1(MSG.HEARTBEAT, heartbeatPayload({ autopilot: 3, base_mode: 129 })));
    assert.equal(d.getTelemetry().firmware.autopilot, 3, 'precondition: identified');

    d._connect = () => {};          // do not actually reconnect
    h.handlers.close();

    assert.equal(d.autopilotIdent, null,
      'identity is per-connection evidence and must not carry into the next link');
    assert.equal(d.identityTimedOut, false, 'and the timeout flag resets with it');
    assert.equal(d.deferredOverlayDone, false, 'so the next connection re-runs the tiering');
  } finally {
    if (d) stopTimers(d);
    h.restore();
  }
});

test('RADIO_STATUS yields SNR for both ends of the SiK link', () => {
  // rssi and noise were both parsed and neither was ever turned into the ratio that actually
  // predicts whether the link holds.
  const d = driver();
  const p = Buffer.alloc(MSG.RADIO_STATUS.len);
  p.writeUInt16LE(0, 0); p.writeUInt16LE(0, 2);
  p[4] = 190;  // rssi
  p[5] = 180;  // remrssi
  p[6] = 0;    // txbuf
  p[7] = 40;   // noise
  p[8] = 35;   // remnoise
  d.parseIncoming(frameV1(MSG.RADIO_STATUS, p));
  const r = d.getTelemetry().radio;
  assert.equal(r.snrRaw, 150, 'rssi - noise');
  assert.equal(r.remSnrRaw, 145, 'remrssi - remnoise');
});

test('an invalid noise reading yields null SNR rather than a wrong one', () => {
  // 255 is SiK's "no reading" sentinel. Treating it as a value would report a hugely negative
  // SNR on a link that is merely not reporting its noise floor.
  const d = driver();
  const p = Buffer.alloc(MSG.RADIO_STATUS.len);
  p.writeUInt16LE(0, 0); p.writeUInt16LE(0, 2);
  p[4] = 190; p[5] = 180; p[6] = 0; p[7] = 255; p[8] = 255;
  d.parseIncoming(frameV1(MSG.RADIO_STATUS, p));
  const r = d.getTelemetry().radio;
  assert.equal(r.snrRaw, null);
  assert.equal(r.remSnrRaw, null);
  assert.equal(r.rssi, 190, 'while the rssi it did report survives');
});
