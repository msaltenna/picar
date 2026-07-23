'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ClientControlLease = require('../client-control-safety');

test('a stopped or disconnected client cannot build control commands', () => {
  let now = 1000;
  const lease = new ClientControlLease(() => now);

  assert.equal(lease.envelope({ throttle: 1 }), null);

  lease.begin('session-a', 990);
  assert.deepEqual(lease.envelope({ throttle: 0.5 }), {
    throttle: 0.5,
    controlSession: 'session-a',
    seq: 0,
    sentAt: 1000,
    armAckAt: 990,
  });

  now = 1050;
  assert.equal(lease.envelope({ throttle: 0.25 }).seq, 1);

  lease.stop();
  assert.equal(lease.envelope({ throttle: 1 }), null);
  assert.equal(lease.stopped, true);
  assert.equal(lease.token, null);
});

test('a reconnect requires a new explicit control session', () => {
  const lease = new ClientControlLease(() => 2000);
  lease.begin('old-session', 2000);
  assert.ok(lease.envelope({ throttle: 1 }));

  lease.stop();
  assert.equal(lease.envelope({ throttle: 1 }), null);

  lease.begin('new-session', 2000);
  const command = lease.envelope({ throttle: 0 });
  assert.equal(command.controlSession, 'new-session');
  assert.equal(command.seq, 0);
});
