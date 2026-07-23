'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PWMMavproxy = require('../pwm_mavproxy_servo');

function mavlink1Frame(msgId, payload, { sysId = 1, componentId = 1 } = {}) {
  const frame = Buffer.alloc(6 + payload.length + 2);
  frame[0] = 0xFE;
  frame[1] = payload.length;
  frame[2] = 1;
  frame[3] = sysId;
  frame[4] = componentId;
  frame[5] = msgId;
  payload.copy(frame, 6);
  const crcExtra = msgId === 0 ? 50 : (msgId === 22 ? 220 : null);
  if (crcExtra !== null) {
    let crc = PWMMavproxy.crc16(frame.subarray(1, 6 + payload.length), 5 + payload.length);
    crc = PWMMavproxy.crcAccumulate(crcExtra, crc);
    frame.writeUInt16LE(crc, 6 + payload.length);
  }
  return frame;
}

function mavlink2Frame(msgId, payload, { signed = false, sysId = 1, componentId = 1 } = {}) {
  const signatureLength = signed ? 13 : 0;
  const frame = Buffer.alloc(10 + payload.length + 2 + signatureLength);
  frame[0] = 0xFD;
  frame[1] = payload.length;
  frame[2] = signed ? 0x01 : 0;
  frame[4] = 1;
  frame[5] = sysId;
  frame[6] = componentId;
  frame[7] = msgId & 0xFF;
  frame[8] = (msgId >> 8) & 0xFF;
  frame[9] = (msgId >> 16) & 0xFF;
  payload.copy(frame, 10);
  const crcExtra = msgId === 0 ? 50 : (msgId === 22 ? 220 : null);
  if (crcExtra !== null) {
    let crc = PWMMavproxy.crc16(frame.subarray(1, 10 + payload.length), 9 + payload.length);
    crc = PWMMavproxy.crcAccumulate(crcExtra, crc);
    frame.writeUInt16LE(crc, 10 + payload.length);
  }
  return frame;
}

function heartbeatPayload(autopilot = 3) {
  const payload = Buffer.alloc(9);
  payload[4] = 10;       // MAV_TYPE_GROUND_ROVER
  payload[5] = autopilot;
  payload[7] = 4;        // MAV_STATE_ACTIVE
  payload[8] = 3;        // MAVLink version
  return payload;
}

function paramValuePayload(name, value) {
  const payload = Buffer.alloc(25);
  payload.writeFloatLE(value, 0);
  payload.writeUInt16LE(1, 4);
  payload.writeUInt16LE(0, 6);
  payload.write(name.slice(0, 16), 8, 'ascii');
  payload[24] = 9;
  return payload;
}

function makeDriver(config = {}) {
  const driver = new PWMMavproxy({
    mavproxy_autostart: false,
    mavproxy_apply_param_overlay: false,
    mavproxy_arm_delay_ms: 5,
    ...config,
  });
  driver.client = { destroyed: false };
  return driver;
}

test('the required frame class is Rover, not Boat', () => {
  assert.equal(PWMMavproxy.DEFAULT_PARAM_OVERLAY.FRAME_CLASS, 1);
  assert.equal(PWMMavproxy.EXPECTED_CRITICAL_PARAMS.FRAME_CLASS, 1);
});

test('MAVLink 1 heartbeat frames remain supported', () => {
  const driver = makeDriver();
  driver.parseIncoming(mavlink1Frame(0, heartbeatPayload()));
  assert.equal(driver.pixhawkHeartbeatSeen, true);
});

test('MAVLink 2 heartbeat and parameter frames satisfy the arm interlock', () => {
  const driver = makeDriver();
  const heartbeat = mavlink2Frame(0, heartbeatPayload());

  // Exercise stream fragmentation as it occurs over TCP.
  driver.parseIncoming(heartbeat.subarray(0, 6));
  assert.equal(driver.pixhawkHeartbeatSeen, false);
  driver.parseIncoming(heartbeat.subarray(6));
  assert.equal(driver.pixhawkHeartbeatSeen, true);
  assert.equal(driver.isSafetyReady(), false);

  for (const [name, value] of Object.entries(PWMMavproxy.EXPECTED_CRITICAL_PARAMS)) {
    driver.parseIncoming(mavlink2Frame(22, paramValuePayload(name, value)));
  }

  assert.equal(driver.isSafetyReady(), true);
  assert.deepEqual(driver.getSafetyStatus().missingParams, []);
});

test('GCS heartbeats do not masquerade as a flight controller', () => {
  const driver = makeDriver();
  driver.parseIncoming(mavlink2Frame(0, heartbeatPayload(8), { sysId: 255 }));
  assert.equal(driver.pixhawkHeartbeatSeen, false);
  assert.equal(driver.isSafetyReady(), false);
});

test('heartbeats from an unexpected MAVLink system are ignored', () => {
  const driver = makeDriver();
  driver.parseIncoming(mavlink2Frame(0, heartbeatPayload(), { sysId: 42 }));
  assert.equal(driver.pixhawkHeartbeatSeen, false);
});

test('corrupt MAVLink frames cannot satisfy safety verification', () => {
  const driver = makeDriver();
  const corrupt = mavlink2Frame(0, heartbeatPayload());
  corrupt[14] ^= 0x01;
  driver.parseIncoming(corrupt);
  assert.equal(driver.pixhawkHeartbeatSeen, false);
});

test('arming is refused until every critical parameter is verified', () => {
  const driver = makeDriver();
  driver.parseIncoming(mavlink2Frame(0, heartbeatPayload()));

  const result = driver.arm();
  assert.equal(result.ok, false);
  assert.match(result.error, /unverified parameters/);
  assert.equal(driver.controlEnabled, false);
});

test('disarm cancels a pending delayed arm command and neutralizes motion', async () => {
  const driver = makeDriver();
  const sent = [];
  driver.sendPacket = packet => sent.push(Buffer.from(packet));
  driver.parseIncoming(mavlink2Frame(0, heartbeatPayload()));
  for (const [name, value] of Object.entries(PWMMavproxy.EXPECTED_CRITICAL_PARAMS)) {
    driver.handleMessage(22, paramValuePayload(name, value));
  }

  assert.equal(driver.arm().ok, true);
  assert.equal(driver.setServoPWM('throttle', 0.8), false);
  driver.disarm();
  await new Promise(resolve => setTimeout(resolve, 15));

  const armCommands = sent.filter(packet => {
    if (packet[5] !== 76) return false;
    const command = packet.readUInt16LE(6 + 28);
    const param1 = packet.readFloatLE(6);
    return command === 400 && param1 === 1;
  });

  assert.equal(armCommands.length, 0);
  assert.equal(driver.channels[driver.channelMap.throttle], driver.channelNeutral.throttle);
  assert.equal(driver.controlEnabled, false);
});

test('motion remains neutral until the delayed ARM packet is sent', async () => {
  const driver = makeDriver();
  driver.sendPacket = () => {};
  driver.parseIncoming(mavlink2Frame(0, heartbeatPayload()));
  for (const [name, value] of Object.entries(PWMMavproxy.EXPECTED_CRITICAL_PARAMS)) {
    driver.handleMessage(22, paramValuePayload(name, value));
  }

  assert.equal(driver.arm().ok, true);
  assert.equal(driver.setServoPWM('throttle', 1), false);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(driver.setServoPWM('throttle', 1), true);
  driver.disarm();
});
