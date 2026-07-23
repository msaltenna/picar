'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ControlSafetyController = require('../control-safety');

class FakeClock {
  constructor(now = 10_000) {
    this.now = now;
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimeout(fn, delay) {
    const id = this.nextId++;
    this.timers.set(id, { due: this.now + delay, fn });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  advance(ms) {
    const target = this.now + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      this.now = due[1].due;
      this.timers.delete(due[0]);
      due[1].fn();
    }
    this.now = target;
  }
}

class FakePWM {
  constructor() {
    this.values = {};
    this.calls = [];
    this.armResult = { ok: true };
    this.safetyStatus = { readyToArm: true };
  }

  setServoPWM(name, value) {
    this.values[name] = value;
    this.calls.push(['set', name, value]);
  }

  arm() {
    this.calls.push(['arm']);
    return this.armResult;
  }

  disarm() {
    this.calls.push(['disarm']);
    return { ok: true };
  }

  getSafetyStatus() {
    return this.safetyStatus;
  }
}

function makeController(config = {}) {
  const clock = new FakeClock();
  const pwm = new FakePWM();
  const messages = [];
  const control = new ControlSafetyController(
    pwm,
    {
      input_timeout_ms: 1000,
      max_command_age_ms: 500,
      max_command_future_skew_ms: 100,
      max_control_rtt_ms: 1000,
      ...config,
    },
    {
      now: () => clock.now,
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: id => clock.clearTimeout(id),
      makeToken: () => 'test-session',
      log: {
        log: message => messages.push(message),
        error: message => messages.push(message),
      },
    },
  );
  return { clock, pwm, control, messages };
}

function validCommand(clock, overrides = {}) {
  return {
    controlSession: 'test-session',
    seq: 1,
    sentAt: clock.now,
    armAckAt: clock.now,
    throttle: 0.75,
    steering: -0.25,
    shift: -1,
    ...overrides,
  };
}

function neutralCommand(clock, overrides = {}) {
  return validCommand(clock, {
    seq: 0,
    throttle: 0,
    steering: 0,
    ...overrides,
  });
}

function activateSession(clock, control) {
  const arm = control.arm('owner', { clientTime: clock.now });
  assert.equal(arm.ok, true);
  const first = control.handleCommand('owner', neutralCommand(clock));
  assert.equal(first.ok, true);
}

test('only the owning socket can send fresh commands', () => {
  const { clock, pwm, control } = makeController();
  const arm = control.arm('owner', { clientTime: clock.now });
  assert.equal(arm.ok, true);

  assert.equal(control.handleCommand('intruder', validCommand(clock)).ok, false);
  assert.equal(pwm.values.throttle, 0);

  assert.equal(control.handleCommand('owner', neutralCommand(clock)).ok, true);
  assert.equal(control.handleCommand('owner', validCommand(clock)).ok, true);
  assert.equal(pwm.values.throttle, 0.75);
  assert.equal(pwm.values.steering, -0.25);
  assert.equal(pwm.values.shift, -1);
});

test('a reliable neutral command immediately clears a forward command', () => {
  const { clock, pwm, control } = makeController();
  activateSession(clock, control);
  assert.equal(control.handleCommand('owner', validCommand(clock)).ok, true);
  assert.equal(pwm.values.throttle, 0.75);

  const neutral = neutralCommand(clock, { seq: 2 });
  assert.equal(control.handleCommand('owner', neutral).ok, true);
  assert.equal(pwm.values.throttle, 0);
  assert.equal(control.getStatus().armed, true);
});

test('a second controller cannot take ownership', () => {
  const { clock, control } = makeController();
  assert.equal(control.arm('owner', { clientTime: clock.now }).ok, true);
  const second = control.arm('other', { clientTime: clock.now });
  assert.equal(second.ok, false);
  assert.match(second.error, /another controller/);
});

test('stale commands immediately neutralize, disarm, and release ownership', () => {
  const { clock, pwm, control } = makeController();
  control.arm('owner', { clientTime: clock.now });
  const sentAt = clock.now;
  clock.advance(600);

  const result = control.handleCommand(
    'owner',
    neutralCommand(clock, { sentAt }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'stale command');
  assert.equal(pwm.values.throttle, 0);
  assert.equal(control.getStatus().armed, false);
  assert.ok(pwm.calls.some(call => call[0] === 'disarm'));
});

test('an excessive arm handshake RTT is rejected before motion is accepted', () => {
  const { clock, pwm, control } = makeController();
  const armClientTime = clock.now;
  control.arm('owner', { clientTime: armClientTime });

  const result = control.handleCommand(
    'owner',
    validCommand(clock, {
      seq: 0,
      throttle: 0,
      steering: 0,
      armAckAt: armClientTime + 1001,
      sentAt: armClientTime + 1001,
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, 'control link latency exceeds safety limit');
  assert.equal(pwm.values.throttle, 0);
  assert.equal(control.getStatus().lastStopReason, 'control-link-too-slow');
});

test('replayed commands do not refresh the watchdog', () => {
  const { clock, pwm, control } = makeController();
  activateSession(clock, control);
  assert.equal(control.handleCommand('owner', validCommand(clock)).ok, true);

  clock.advance(500);
  assert.equal(
    control.handleCommand('owner', validCommand(clock)).error,
    'replayed or out-of-order command',
  );
  clock.advance(501);

  assert.equal(pwm.values.throttle, 0);
  assert.equal(control.getStatus().lastStopReason, 'input-timeout');
  assert.equal(control.getStatus().armed, false);
});

test('owner disconnect triggers an immediate fail-safe stop', () => {
  const { clock, pwm, control } = makeController();
  let failSafeEvent = null;
  control.onFailSafe = event => { failSafeEvent = event; };
  activateSession(clock, control);
  control.handleCommand('owner', validCommand(clock));
  control.disconnect('owner');

  assert.equal(pwm.values.throttle, 0);
  assert.equal(pwm.values.steering, 0);
  assert.equal(control.getStatus().armed, false);
  assert.equal(control.getStatus().lastStopReason, 'controller-disconnect');
  assert.deepEqual(failSafeEvent, {
    reason: 'controller-disconnect',
    socketId: 'owner',
  });
});

test('flight-controller readiness failures prevent lease creation', () => {
  const { clock, pwm, control } = makeController();
  pwm.safetyStatus = { readyToArm: false, missingParams: ['FRAME_CLASS'] };

  const result = control.arm('owner', { clientTime: clock.now });
  assert.equal(result.ok, false);
  assert.match(result.error, /not ready/);
  assert.equal(control.getStatus().armed, false);
});

test('an arm command refusal releases the pending lease', () => {
  const { clock, pwm, control } = makeController();
  pwm.armResult = { ok: false, error: 'arm denied' };
  assert.equal(control.arm('owner', { clientTime: clock.now }).ok, true);

  const result = control.handleCommand('owner', neutralCommand(clock));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'arm denied');
  assert.equal(control.getStatus().controllerConnected, false);
  assert.equal(control.getStatus().armed, false);
});

test('server shutdown sends DISARM even without an active browser lease', () => {
  const { pwm, control } = makeController();
  control.shutdown();
  assert.ok(pwm.calls.some(call => call[0] === 'disarm'));
  assert.equal(pwm.values.throttle, 0);
});
