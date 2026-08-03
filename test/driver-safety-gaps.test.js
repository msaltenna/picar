'use strict';

// Driver-safety coverage for gaps that a mutation pass on 2026-08-03 proved the
// existing suite does not close. Every test here was written against a specific
// surviving mutant and verified to fail when that mutant is applied — a test
// that passes either way is worse than no test, because it gets cited as
// evidence.
//
// The gaps:
//
//   1. setServoPWM's Number.isFinite guards were only ever exercised through the
//      'shift' channel. The raw guard at pwm_mavproxy_servo.js:243 runs FIRST,
//      but the DISCRETE_CHANNELS endpoint check at :251 is a fallback that also
//      rejects every non-endpoint value — so deleting the guard left the shift
//      tests green. A continuous channel has no such fallback: it then stores
//      NaN, which a Uint16Array coerces to 0, and which buildRCOverride:346 maps
//      to the 65535 "ignore this channel" sentinel. That is the opposite of
//      neutral — it tells ArduPilot to let the override lapse.
//
//   2. Nothing invoked _connect(), and nothing drove the 'close' handler. The
//      old reconnect test hand-wrote the sequence it claimed to verify in its own
//      body, including the `this.client = null` that production does, so both
//      could be deleted with the suite still green.

const test   = require('node:test');
const assert = require('node:assert/strict');
const net    = require('net');
const { EventEmitter } = require('events');

const PWMMavproxy = require('../pwm_mavproxy_servo.js');

const THROTTLE_CH = 2;
const STEERING_CH = 0;

const MSG_RC_OVERRIDE  = 70;
const MSG_COMMAND_LONG = 76;
const MAV_CMD_COMPONENT_ARM_DISARM = 400;

const IGNORE_SENTINEL = 65535;

// The close handler's retry is a bare setTimeout(…, 2000) that nothing tracks,
// so a test that drives 'close' cannot cancel it.
const CLOSE_RETRY_MS = 2000;

function msgIdOf(buf)  { return buf[5]; }
function param1Of(buf) { return buf.readFloatLE(6); }
function commandOf(buf){ return buf.readUInt16LE(6 + 28); }
function channelsOf(buf) {
  const ch = [];
  for (let i = 0; i < 8; i++) ch.push(buf.readUInt16LE(6 + i * 2));
  return ch;
}
function wireChannel(d, index) {
  return channelsOf(d.buildRCOverride())[index];
}
function disarmsIn(writes) {
  return writes.filter((b) =>
    msgIdOf(b) === MSG_COMMAND_LONG && commandOf(b) === MAV_CMD_COMPONENT_ARM_DISARM);
}

// ── Gap 1: the continuous channels ───────────────────────────────────────────

for (const channel of ['throttle', 'steering']) {
  const index = channel === 'throttle' ? THROTTLE_CH : STEERING_CH;

  test(`${channel} refuses non-finite input — the guard the shift tests could not reach`, () => {
    for (const value of ['abc', '', {}, [], null, undefined, NaN, Infinity, -Infinity]) {
      const d = new PWMMavproxy({ mavproxy_autostart: false });
      const before = wireChannel(d, index);

      assert.equal(d.setServoPWM(channel, value), false,
        `${channel} must refuse ${JSON.stringify(value) ?? 'undefined'}`);
      assert.equal(wireChannel(d, index), before,
        `${channel} moved after refusing ${JSON.stringify(value) ?? 'undefined'}`);
    }
  });

  test(`a refused ${channel} command never releases the override via the 65535 sentinel`, () => {
    // This is the assertion that actually kills the mutant. Without the guards,
    // scale() returns NaN, the Uint16Array stores 0, and buildRCOverride emits
    // 65535 — telling the flight controller to stop honouring this channel
    // instead of holding it where the operator left it.
    const d = new PWMMavproxy({ mavproxy_autostart: false });

    d.setServoPWM(channel, 0.5);                 // a real command first
    const applied = wireChannel(d, index);
    assert.notEqual(applied, IGNORE_SENTINEL);

    assert.equal(d.setServoPWM(channel, 'abc'), false);
    assert.notEqual(d.channels[index], 0,
      'the channel buffer must not hold 0, which becomes the ignore sentinel');
    assert.equal(wireChannel(d, index), applied,
      'a refused command must leave the previous value on the wire, not 65535');
  });
}

test('a non-finite PWM range is refused even when the commanded value is valid', () => {
  // This is what the post-scale guard is for, and the only way to distinguish it
  // from the raw-input guard: scale() is arithmetic over min_us/max_us, so a
  // corrupt RANGE makes it return NaN for a perfectly well-formed command.
  //
  // Only values that survive `config.pwm_max_us || 2000` reach the arithmetic.
  // NaN is falsy so it is replaced by the default and is harmless. Note a JSON
  // config cannot express Infinity — the reachable-in-practice cases are the
  // truthy non-numerics.
  for (const bad of [{ pwm_min_us: 'x' }, { pwm_max_us: 'x' }, { pwm_max_us: {} },
                     { pwm_max_us: Infinity }, { pwm_min_us: -Infinity }]) {
    const d = new PWMMavproxy({ mavproxy_autostart: false, ...bad });
    assert.equal(d.setServoPWM('throttle', 0.5), false,
      `a valid command must be refused when the range is ${JSON.stringify(bad)}`);
  }

  // And the benign half of the contract: a falsy-but-invalid range falls back to
  // the defaults, so ordinary commands still work.
  for (const bad of [{ pwm_max_us: NaN }, { pwm_min_us: NaN }]) {
    const d = new PWMMavproxy({ mavproxy_autostart: false, ...bad });
    assert.equal(d.min_us, 1000);
    assert.equal(d.max_us, 2000);
    assert.equal(d.setServoPWM('throttle', 0.5), true);
  }
});

test('a non-finite command cannot make the neutral packet itself lapse', () => {
  // The fail-safe consequence of gap 1: if a bad value zeroed the buffer, the
  // "neutral" override a fail-safe transmits would carry 65535 for that channel,
  // so the vehicle would be disarmed with its override released rather than
  // explicitly centred.
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  const writes = [];
  d.client = { destroyed: false, write(b) { writes.push(Buffer.from(b)); } };

  d.setServoPWM('throttle', 'abc');
  d.setServoPWM('steering', {});
  const result = d.neutralizeAndDisarm();
  assert.equal(result.neutralSent, true);

  const override = writes.find((b) => msgIdOf(b) === MSG_RC_OVERRIDE);
  assert.notEqual(override, undefined, 'a neutral override must have been sent');
  const ch = channelsOf(override);
  assert.equal(ch[THROTTLE_CH], d.channelNeutralUs.throttle);
  assert.equal(ch[STEERING_CH], d.channelNeutralUs.steering);
  assert.notEqual(ch[THROTTLE_CH], IGNORE_SENTINEL);
  assert.notEqual(ch[STEERING_CH], IGNORE_SENTINEL);
});

test('sendPacket refuses a destroyed socket rather than relying on write() to throw', () => {
  // The existing coverage used a fake whose write() throws when disconnected, so
  // the try/catch returned false and the explicit `client.destroyed` guard could
  // be deleted with the suite still green. This pins the guard itself: a socket
  // that reports destroyed must be refused even if write() would happily accept
  // the bytes. On a real net.Socket the two agree, but a fail-safe must not
  // depend on an exception it did not ask for.
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  let accepted = 0;
  d.client = { destroyed: true, write() { accepted += 1; return true; } };

  assert.equal(d.sendPacket(Buffer.from([1, 2, 3])), false,
    'a destroyed socket must be reported as a failed write');
  assert.equal(accepted, 0, 'and nothing should have been handed to it');

  // The same guard covers a missing client.
  d.client = null;
  assert.equal(d.sendPacket(Buffer.from([1, 2, 3])), false);

  // And a healthy socket still reports success, so this is not a constant.
  d.client = { destroyed: false, write() { accepted += 1; return true; } };
  assert.equal(d.sendPacket(Buffer.from([1, 2, 3])), true);
  assert.equal(accepted, 1);
});

test('a fail-safe on a destroyed socket reports failure, not success', () => {
  // The consequence that matters: neutralizeAndDisarm must not claim
  // {neutralSent: true, disarmSent: true} when the link is gone, because app.js
  // gates a drivetrain change on exactly that result.
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  d.client = { destroyed: true, write() { return true; } };

  const result = d.neutralizeAndDisarm();
  assert.equal(result.neutralSent, false, 'a neutral that never left must not report sent');
  assert.equal(result.disarmSent, false, 'a disarm that never left must not report sent');
});

// ── Gap 2: the real connect / close / reconnect lifecycle ────────────────────
//
// Drive the actual _connect() and the actual 'close' handler against fake
// sockets, so the production code does its own work rather than the test doing
// it on production's behalf.
//
// Two fidelity requirements learned the hard way:
//
//   * The connect callback must be DEFERRED. _connect() does
//     `const socket = net.createConnection(opts, () => { … this.client = socket })`,
//     so an inline callback hits the temporal dead zone on `socket` and throws
//     ReferenceError. A real net.Socket fires 'connect' on a later tick.
//
//   * The deferred callback must settle its promise even when it THROWS.
//     Otherwise `await settle()` hangs for ever, the cleanup below never runs,
//     and the suite hangs instead of failing — which looks exactly like a pass.
//
// Each createConnection call gets a FRESH socket, as the real module does; the
// write log is shared so packet order across a reconnect stays observable.

async function withFakeSocket(d, run) {
  const realCreateConnection = net.createConnection;
  const writes    = [];
  const sockets   = [];
  const connected = [];

  net.createConnection = (_opts, onConnect) => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.write = (buf) => { writes.push(Buffer.from(buf)); return true; };
    sockets.push(socket);
    if (typeof onConnect === 'function') {
      connected.push(new Promise((resolve, reject) => setImmediate(() => {
        try { onConnect(); resolve(); } catch (err) { reject(err); }
      })));
    }
    return socket;
  };

  const settle = () => Promise.all(connected.splice(0));
  try {
    return await run({ sockets, writes, settle });
  } finally {
    net.createConnection = realCreateConnection;
    // Unconditional, and in the helper rather than the tests, so a failing
    // assertion cannot leak the 20 Hz interval and hang `node --test`.
    if (d.interval)          { clearInterval(d.interval);          d.interval = null; }
    if (d.heartbeatInterval) { clearInterval(d.heartbeatInterval); d.heartbeatInterval = null; }
    if (d.armTimeout)        { clearTimeout(d.armTimeout);         d.armTimeout = null; }

    // Neutralise any retry the close handler scheduled but we did not wait for.
    // That timer is a bare setTimeout(…, 2000) which nothing tracks, so it cannot
    // be cancelled — and if it fires after the line above has restored the real
    // net module it opens a GENUINE socket to 127.0.0.1:5760, whose ECONNREFUSED
    // triggers another close, another retry, and an endless loop that hangs the
    // runner. Parking a truthy client here makes _connect()'s `if (this.client)
    // return` guard swallow the escaped retry instead.
    //
    // This bit us for real: with the close handler's interval-clearing mutated
    // away, the resulting assertion failure escaped a retry and the run hung
    // rather than reporting the failure.
    d.client = { destroyed: true, write: () => false };
  }
}

test('_connect() puts neutral then DISARM on the wire before the override stream starts', async () => {
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  d.setServoPWM('throttle', 1);          // stale full throttle, as after a crash

  await withFakeSocket(d, async ({ writes, settle }) => {
    d._connect();
    await settle();

    const ids = writes.map(msgIdOf);
    const firstOverride = ids.indexOf(MSG_RC_OVERRIDE);
    const firstCommand  = ids.indexOf(MSG_COMMAND_LONG);

    assert.notEqual(firstOverride, -1,
      '_connect() must transmit an RC_CHANNELS_OVERRIDE — a reconnect that skips it inherits an armed vehicle');
    assert.notEqual(firstCommand, -1, '_connect() must transmit a COMMAND_LONG');
    assert.ok(firstOverride < firstCommand,
      `neutral must precede DISARM on the wire (override at ${firstOverride}, command at ${firstCommand})`);

    assert.equal(channelsOf(writes[firstOverride])[THROTTLE_CH], d.channelNeutralUs.throttle,
      'the first packet after connect must carry neutral throttle, not the stale value');
    assert.equal(commandOf(writes[firstCommand]), MAV_CMD_COMPONENT_ARM_DISARM);
    assert.equal(param1Of(writes[firstCommand]), 0, 'param1=0 means disarm');
  });
});

test('_connect() leaves the periodic override loop running', async () => {
  // The disarm must not come at the cost of the 20 Hz stream: ArduPilot lapses
  // an override that stops being refreshed (RC_OVERRIDE_TIME=0.2).
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  await withFakeSocket(d, async ({ settle }) => {
    d._connect();
    await settle();
    assert.notEqual(d.interval, null, 'the override loop must be started');
    assert.notEqual(d.heartbeatInterval, null, 'the heartbeat must be started');
    assert.notEqual(d.client, null, 'the client socket must be recorded');
  });
});

test("the 'close' handler releases the client and stops both timers", async () => {
  // Drive the REAL close handler. Asserting `d.client === null` here is what
  // kills a mutant that deletes that assignment: without it, _connect()'s
  // `if (this.client) return` guard makes every future reconnect a no-op and the
  // rover never re-establishes the link — while the suite stays green.
  const d = new PWMMavproxy({ mavproxy_autostart: false });

  await withFakeSocket(d, async ({ sockets, settle }) => {
    d._connect();
    await settle();
    assert.notEqual(d.client, null, 'precondition: connected');
    assert.notEqual(d.interval, null, 'precondition: streaming');

    sockets[0].emit('close');

    assert.equal(d.client, null,
      'close must clear the client, or _connect() early-returns for ever and the link never comes back');
    assert.equal(d.interval, null, 'close must stop the override loop');
    assert.equal(d.heartbeatInterval, null, 'close must stop the heartbeat');

    // The handler schedules its retry on an untracked setTimeout, so it cannot be
    // cancelled. Let it fire here, while the stub is still installed — if it
    // landed after this helper restored the real net module it would open a
    // genuine socket to 127.0.0.1:5760 and retry-loop for ever.
    await new Promise((r) => setTimeout(r, CLOSE_RETRY_MS + 250));
    await settle();
  });
});

test('the automatic retry after a close re-asserts neutral then DISARM', async () => {
  const d = new PWMMavproxy({ mavproxy_autostart: false });

  await withFakeSocket(d, async ({ sockets, writes, settle }) => {
    d._connect();
    await settle();
    assert.equal(disarmsIn(writes).length >= 1, true, 'the first connect must disarm');

    sockets[0].emit('close');
    writes.length = 0;

    await new Promise((r) => setTimeout(r, CLOSE_RETRY_MS + 250));
    await settle();

    assert.equal(sockets.length, 2, 'the close handler must have opened a second connection');
    assert.notEqual(d.client, null, 'the retry must leave the driver connected');

    const ids = writes.map(msgIdOf);
    const firstOverride = ids.indexOf(MSG_RC_OVERRIDE);
    const firstCommand  = ids.indexOf(MSG_COMMAND_LONG);
    assert.equal(disarmsIn(writes).length >= 1, true,
      'each reconnect must re-assert DISARM — ArduPilot arm state survives the link dropping');
    assert.ok(firstOverride !== -1 && firstOverride < firstCommand,
      'and neutral must still reach the wire before the DISARM on the reconnect path');
  });
});
