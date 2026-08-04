'use strict';

// Light module on Pixhawk output 6, driven by RC channel 6 passthrough.
//
// The safety-relevant properties are all about what the light must NOT do: it must
// not disturb a motion channel, must not be movable by the continuous control
// stream, and must not be reset by a fail-safe (an operator who has just lost
// control wants the vehicle to stay visible).

const test   = require('node:test');
const assert = require('node:assert/strict');

const PWMMavproxy = require('../pwm_mavproxy_servo.js');

const LIGHT_CH    = 5;   // RC channel 6, 0-indexed
const THROTTLE_CH = 2;
const STEERING_CH = 0;
const IGNORE_SENTINEL = 65535;

const driver = (extra = {}) => new PWMMavproxy({ mavproxy_autostart: false, ...extra });
const wire = (d, i) => d.buildRCOverride().readUInt16LE(6 + i * 2);

test('the light starts OFF and is actually commanded, not left unset', () => {
  // 0 in the buffer becomes the 65535 "ignore this channel" sentinel, which would
  // leave output 6 owned by nobody rather than explicitly off.
  const d = driver();
  assert.equal(wire(d, LIGHT_CH), 1000, 'default is the off endpoint');
  assert.notEqual(wire(d, LIGHT_CH), IGNORE_SENTINEL);
  assert.equal(d.lightIsOn(), false);
});

test('setLight toggles between the configured endpoints', () => {
  const d = driver();
  assert.equal(d.setLight(true), true);
  assert.equal(wire(d, LIGHT_CH), 2000);
  assert.equal(d.lightIsOn(), true);

  assert.equal(d.setLight(false), true);
  assert.equal(wire(d, LIGHT_CH), 1000);
  assert.equal(d.lightIsOn(), false);
});

test('the light endpoints are independently configurable', () => {
  // A module that wants a narrower range must be trimmable without touching the
  // motion channels' PWM range.
  const d = driver({ light_on_us: 1800, light_off_us: 1200 });
  d.setLight(true);
  assert.equal(wire(d, LIGHT_CH), 1800);
  d.setLight(false);
  assert.equal(wire(d, LIGHT_CH), 1200);
  assert.equal(wire(d, THROTTLE_CH), 1500, 'motion neutral is unaffected');
});

test('setLight refuses anything that is not a boolean', () => {
  for (const bad of ['on', 1, 0, null, undefined, {}, [], NaN]) {
    const d = driver();
    assert.equal(d.setLight(bad), false, `must refuse ${JSON.stringify(bad) ?? 'undefined'}`);
    assert.equal(wire(d, LIGHT_CH), 1000, 'and must not move the output');
  }
});

test('the light is on/off only — no mid-travel dim level', () => {
  // It is in DISCRETE_CHANNELS for input validation. If dimming is ever wanted this
  // test should be deliberately changed, not quietly deleted.
  const d = driver();
  for (const v of [0, 0.5, -0.5, 2, 1.5]) {
    assert.equal(d.setServoPWM('light', v), false, `must refuse ${v}`);
  }
  assert.equal(wire(d, LIGHT_CH), 1000);
});

test('switching the light never disturbs throttle or steering', () => {
  const d = driver();
  d.setServoPWM('throttle', 0.6);
  d.setServoPWM('steering', -0.3);
  const t = wire(d, THROTTLE_CH);
  const s = wire(d, STEERING_CH);

  d.setLight(true);
  d.setLight(false);
  d.setLight(true);
  assert.equal(wire(d, THROTTLE_CH), t, 'throttle must be untouched');
  assert.equal(wire(d, STEERING_CH), s, 'steering must be untouched');
});

test('a fail-safe leaves the light alone', () => {
  // Deliberate: neutralizeAndDisarm centres the motion channels and disarms. It must
  // not switch the light off, because an operator who has just lost control wants
  // the vehicle to remain visible.
  const d = driver();
  d.client = { destroyed: false, write() {} };
  d.setLight(true);
  d.setServoPWM('throttle', 1);

  const result = d.neutralizeAndDisarm();
  assert.equal(result.neutralSent, true);
  assert.equal(wire(d, THROTTLE_CH), d.channelNeutralUs.throttle, 'throttle neutralised');
  assert.equal(wire(d, LIGHT_CH), 2000, 'the light must STAY ON through a fail-safe');
  assert.equal(d.lightIsOn(), true);
});

test('the param overlay makes the Pixhawk pass RC6 through to output 6', () => {
  // Without SERVO6_FUNCTION the flight controller ignores the channel entirely and
  // the light never responds, however correct the override stream is.
  const d = driver();
  assert.equal(d.paramOverlay.SERVO6_FUNCTION, 1,
    'output 6 must be set to RC passthrough');
});

test('the light channel does not collide with any drivetrain channel', () => {
  const d = driver();
  const used = Object.entries(d.channelMap);
  const indices = used.map(([, i]) => i);
  assert.equal(new Set(indices).size, indices.length,
    `two names share a channel index: ${JSON.stringify(d.channelMap)}`);
  assert.equal(d.channelMap.light, LIGHT_CH);
});
