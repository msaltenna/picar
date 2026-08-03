'use strict';

// Host-side regression tests for the drivetrain command path.
//
// These cover the defects behind the reported "gear change engages throttle and
// cannot be turned off": a drivetrain change with no interlock, unvalidated
// input reaching the servo channel, mid-travel gear positions, and a fail-safe
// whose neutral reached the wire AFTER the disarm.
//
// Design note: these assert on OBSERVED BEHAVIOR, not on source text. An earlier
// version of this file regex-matched socket.html and app.js, which meant the
// packet-ordering test compared substring positions in source and passed while
// the real wire order was reversed. Tests that cannot fail are worse than no
// tests, because they are cited as evidence. Everything here drives the real
// driver and decodes the real bytes it writes.

const test   = require('node:test');
const assert = require('node:assert/strict');

const PWMMavproxy = require('../pwm_mavproxy_servo.js');

const SHIFT_CH    = 1; // channels[1] -> RC channel 2
const THROTTLE_CH = 2; // channels[2] -> RC channel 3

const MSG_RC_OVERRIDE = 70;
const MSG_COMMAND_LONG = 76;
const MAV_CMD_COMPONENT_ARM_DISARM = 400;

// A driver with no network. `client` is a fake socket that records every buffer
// written, so we can assert on actual packet content and ORDER.
function driverWithRecorder({ connected = true } = {}) {
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  const writes = [];
  d.client = {
    destroyed: !connected,
    write(buf) {
      if (!connected) throw new Error('socket closed');
      writes.push(Buffer.from(buf));
    },
  };
  return { d, writes };
}

function msgIdOf(buf) {
  return buf[5]; // MAVLink v1: magic,len,seq,sysid,compid,msgid
}

function channelsOf(buf) {
  const ch = [];
  for (let i = 0; i < 8; i++) ch.push(buf.readUInt16LE(6 + i * 2));
  return ch;
}

// COMMAND_LONG payload: 7 floats, then command(uint16)
function commandOf(buf) {
  return buf.readUInt16LE(6 + 28);
}
function param1Of(buf) {
  return buf.readFloatLE(6);
}

function wireChannel(d, index) {
  return channelsOf(d.buildRCOverride())[index];
}

// ── Driver: only valid values reach a servo channel ───────────────────────────

test('legitimate gear commands are applied and scale to the endpoints', () => {
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  assert.equal(d.setServoPWM('shift', 1), true);
  assert.equal(wireChannel(d, SHIFT_CH), 2000);
  assert.equal(d.setServoPWM('shift', -1), true);
  assert.equal(wireChannel(d, SHIFT_CH), 1000);
});

test('malformed gear input is refused and leaves the channel untouched', () => {
  for (const value of ['abc', {}, [], null, NaN, Infinity, -Infinity, undefined]) {
    const d = new PWMMavproxy({ mavproxy_autostart: false });
    const before = wireChannel(d, SHIFT_CH);
    assert.equal(d.setServoPWM('shift', value), false,
      `should refuse ${JSON.stringify(value) ?? 'undefined'}`);
    assert.equal(wireChannel(d, SHIFT_CH), before);
  }
});

test('a drivetrain channel refuses every non-endpoint value, including 0', () => {
  // The whole point: a two-position actuator has no valid middle. 0 is called out
  // because it is what a zero-coerced or omitted field looks like, and because it
  // scales to exactly the 1500us mid-travel position that jams a shift fork.
  for (const name of ['shift', 'tlock_front', 'tlock_rear']) {
    for (const value of [0, 0.5, -0.5, 0.99, -1.5, 2]) {
      const d = new PWMMavproxy({ mavproxy_autostart: false });
      const before = wireChannel(d, d.channelMap[name]);
      assert.equal(d.setServoPWM(name, value), false,
        `${name} must refuse ${value}`);
      assert.equal(wireChannel(d, d.channelMap[name]), before,
        `${name} moved after refusing ${value}`);
    }
  }
});

test('a refused gear command never lands mid-travel', () => {
  // Assert the channel HELD its previous position, not merely that it is not
  // 1500. The constructor default is shift_default_us (2000), so a bare
  // `notEqual(…, 1500)` was already satisfied before the refused call ran and
  // would pass even if setServoPWM moved the fork anywhere else.
  for (const value of [[], null, 0, 0.5, 'abc']) {
    const d = new PWMMavproxy({ mavproxy_autostart: false });
    d.setServoPWM('shift', -1);                       // a real, valid endpoint
    const held = wireChannel(d, SHIFT_CH);
    assert.equal(held, 1000, 'precondition: the fork is at a known endpoint');

    assert.equal(d.setServoPWM('shift', value), false);
    assert.equal(wireChannel(d, SHIFT_CH), held,
      `the fork moved after refusing ${JSON.stringify(value) ?? 'undefined'}`);
    assert.notEqual(wireChannel(d, SHIFT_CH), 1500, 'and it is certainly not mid-travel');
  }
});

test('a refused command never produces the 65535 ignore sentinel', () => {
  // 0 in the buffer becomes 65535 on the wire, telling ArduPilot to stop
  // refreshing the override so it lapses. A rejection must not do that.
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  assert.equal(d.setServoPWM('shift', 'abc'), false);
  assert.notEqual(wireChannel(d, SHIFT_CH), 65535);
  assert.notEqual(d.channels[SHIFT_CH], 0);
});

test('throttle and steering remain continuous, unlike the drivetrain channels', () => {
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  assert.equal(d.setServoPWM('throttle', 0), true, 'neutral throttle must be valid');
  assert.equal(d.setServoPWM('throttle', 0.37), true);
  assert.equal(d.setServoPWM('steering', -0.2), true);
});

test('setServoPWM reports applied/dropped rather than returning undefined', () => {
  // Assert the VALUES, not just the type. `typeof … === 'boolean'` is satisfied
  // by a setter that unconditionally returns false — which would report every
  // legitimate command as dropped and still pass.
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  assert.equal(d.setServoPWM('shift', 1), true,       'an applied command reports true');
  assert.equal(d.setServoPWM('throttle', 0.4), true,  'a continuous command reports true');
  assert.equal(d.setServoPWM('shift', 'x'), false,    'a dropped command reports false');
  assert.equal(d.setServoPWM('nonexistent', 1), false, 'an unknown channel reports false');
});

// ── Fail-safe ORDER on the wire, not in call order ───────────────────────────

test('neutralizeAndDisarm puts a neutral RC override on the wire BEFORE the disarm', () => {
  const { d, writes } = driverWithRecorder();
  d.setServoPWM('throttle', 0.8);           // vehicle is driving
  assert.equal(wireChannel(d, THROTTLE_CH), 1900);

  writes.length = 0;
  const result = d.neutralizeAndDisarm();
  assert.equal(result.neutralSent, true);
  assert.equal(result.disarmSent, true);

  const ids = writes.map(msgIdOf);
  const firstOverride = ids.indexOf(MSG_RC_OVERRIDE);
  const firstCommand  = ids.indexOf(MSG_COMMAND_LONG);

  assert.notEqual(firstOverride, -1, 'no RC_CHANNELS_OVERRIDE packet was sent');
  assert.notEqual(firstCommand, -1, 'no COMMAND_LONG packet was sent');
  assert.ok(firstOverride < firstCommand,
    `RC override must be on the wire before DISARM (override at ${firstOverride}, command at ${firstCommand})`);

  // and that first override must actually carry neutral throttle
  assert.equal(channelsOf(writes[firstOverride])[THROTTLE_CH],
    d.channelNeutralUs.throttle);

  // and the COMMAND_LONG must really be a disarm
  assert.equal(commandOf(writes[firstCommand]), MAV_CMD_COMPONENT_ARM_DISARM);
  assert.equal(param1Of(writes[firstCommand]), 0, 'param1=0 means disarm');
});

test('neutralizeAndDisarm reports failure when the link is down', () => {
  const { d } = driverWithRecorder({ connected: false });
  const result = d.neutralizeAndDisarm();
  assert.equal(result.neutralSent, false,
    'a fail-safe that could not transmit must not claim success');
});

test('sendPacket reports whether the bytes were actually written', () => {
  const up = driverWithRecorder({ connected: true });
  assert.equal(up.d.sendPacket(Buffer.from([1, 2, 3])), true);
  const down = driverWithRecorder({ connected: false });
  assert.equal(down.d.sendPacket(Buffer.from([1, 2, 3])), false);
});

test('the neutral packet restores the configured trim, not a recomputed midpoint', () => {
  // A vehicle whose neutral is not the arithmetic midpoint must still be
  // neutralised to ITS neutral.
  const d = new PWMMavproxy({
    mavproxy_autostart: false,
    throttle_neutral_us: 1480,
    steering_neutral_us: 1520,
  });
  d.client = { destroyed: false, write() {} };
  d.setServoPWM('throttle', 1);
  d.neutralizeAndDisarm();
  assert.equal(d.channels[THROTTLE_CH], 1480);
  assert.equal(d.channels[d.channelMap.steering], 1520);
});

// ── Pending-arm cancellation and honest failure reporting ────────────────────

test('a disarm cancels a pending arm instead of letting it fire afterwards', () => {
  const { d, writes } = driverWithRecorder();
  d.armDelayMs = 20;
  d.arm();
  writes.length = 0;
  d.disarm();
  assert.equal(d.armTimeout, null, 'the pending arm timer must be cleared');

  return new Promise((resolve) => setTimeout(() => {
    const arms = writes
      .filter((b) => msgIdOf(b) === MSG_COMMAND_LONG)
      .filter((b) => commandOf(b) === MAV_CMD_COMPONENT_ARM_DISARM)
      .filter((b) => param1Of(b) === 1);
    assert.equal(arms.length, 0,
      'an ARM packet was transmitted after a disarm — the vehicle re-armed itself');
    resolve();
  }, 60));
});

test('disarm reports failure when the write fails, and neutralizeAndDisarm propagates it', () => {
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  // Neutral write succeeds, DISARM write fails: the partial-failure case.
  let calls = 0;
  d.client = {
    destroyed: false,
    write() { calls += 1; if (calls > 1) throw new Error('write failed'); },
  };
  const result = d.neutralizeAndDisarm();
  assert.equal(result.neutralSent, true);
  assert.equal(result.disarmSent, false,
    'a failed DISARM write must not be reported as sent');
});

test('disarm reports whether the DISARM actually reached the socket', () => {
  // Assert both directions. The previous version checked only
  // `typeof d.disarm() === 'boolean'`, which a stub returning a constant
  // satisfies — so it pinned the type while leaving the property invariant 10
  // cares about (does the value reflect reality?) unverified.
  const up = driverWithRecorder({ connected: true });
  assert.equal(up.d.disarm(), true, 'a delivered DISARM reports true');

  const down = driverWithRecorder({ connected: false });
  assert.equal(down.d.disarm(), false,
    'a DISARM that could not be written must not be reported as sent');
});

// ── Reconnect must not inherit an armed vehicle ──────────────────────────────

test('connecting neutralizes and disarms before streaming overrides', () => {
  // Simulates the connect callback's ordering without opening a real socket.
  const { d, writes } = driverWithRecorder();
  d.setServoPWM('throttle', 1);          // stale non-neutral buffer, as after a crash
  writes.length = 0;

  d.neutralizeAndDisarm();               // what _connect() now does first
  d.startLoop();                         // then the periodic stream
  d.stopLoopForTest = () => clearInterval(d.interval);
  d.stopLoopForTest();

  const ids = writes.map(msgIdOf);
  const firstOverride = ids.indexOf(MSG_RC_OVERRIDE);
  const firstCommand  = ids.indexOf(MSG_COMMAND_LONG);
  assert.ok(firstOverride < firstCommand, 'neutral must precede DISARM on connect');
  assert.equal(channelsOf(writes[firstOverride])[THROTTLE_CH], d.channelNeutralUs.throttle,
    'the first packet after connect must carry neutral throttle');
});
