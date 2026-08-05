'use strict';

// Flight-controller throttle parameters pushed by the param overlay.
//
// Separated from the client-side throttle work so the two are independently revertible:
// one is a browser ramp constant, the other changes what is written to a real flight
// controller on a vehicle with a battery installed. If the slew rate proves too
// aggressive it must be revertible without also reverting the deadzone escape.

const test   = require('node:test');
const assert = require('node:assert/strict');

test('MOT_SLEWRATE is pushed and verified by read-back', () => {
  // ArduRover's default is 100 %/s. Measured consequence on rover3: ~700 ms for a
  // reverse step to reach its commanded output. A slew limit that silently failed to
  // apply would leave exactly the sluggishness this change exists to remove, with no
  // indication why — so it is in the verified set, not just the pushed set.
  const PWMMavproxy = require('../pwm_mavproxy_servo.js');
  assert.equal(PWMMavproxy.DEFAULT_PARAM_OVERLAY.MOT_SLEWRATE, 250);
  assert.equal(PWMMavproxy.EXPECTED_CRITICAL_PARAMS.MOT_SLEWRATE, 250,
    'an unverified slew limit is how this defect stayed invisible');
});

test('a faster slew limit cannot slow the fail-safe', () => {
  // The reasoning that makes this safe to raise: the fail-safe commands NEUTRAL, and a
  // higher slew rate reaches neutral SOONER. This pins the direction of the change so a
  // future edit cannot quietly turn it into a limit that delays neutral.
  const PWMMavproxy = require('../pwm_mavproxy_servo.js');
  const rate = PWMMavproxy.DEFAULT_PARAM_OVERLAY.MOT_SLEWRATE;
  // 0 DISABLES slew limiting in ArduRover — the fastest possible return to neutral, and
  // therefore acceptable by this test's own criterion. An earlier version of this
  // assertion rejected 0 while its message claimed 0 was "slower than default", which had
  // the reasoning exactly backwards and would have misled the next editor.
  assert.ok(rate === 0 || rate >= 100,
    `MOT_SLEWRATE=${rate} is a FINITE rate slower than ArduRover's default of 100 %/s, ` +
    'which would delay how fast the throttle can return to neutral on a fail-safe stop. ' +
    '0 is allowed: it disables limiting entirely.');
  assert.ok(rate <= 1000, `MOT_SLEWRATE=${rate} is implausible`);
});


test('the FC deadzone the browser mirrors is pushed and verified', () => {
  // socket.html derives THROTTLE_DEADZONE from RC3_DZ over the trim-to-endpoint half
  // span. Those were measured off rover3 and then hardcoded in the browser, which made
  // the derivation coincidental: a replacement board at factory default, or a
  // calibration leaving trim at 1512, would silently put the escape value back inside the
  // deadzone — reintroducing the defect with no read-back mismatch and no failing test.
  const PWMMavproxy = require('../pwm_mavproxy_servo.js');
  assert.equal(PWMMavproxy.DEFAULT_PARAM_OVERLAY.RC3_DZ, 30);
  assert.equal(PWMMavproxy.EXPECTED_CRITICAL_PARAMS.RC3_DZ, 30);
  assert.equal(PWMMavproxy.DEFAULT_PARAM_OVERLAY.RC3_TRIM, 1500);
  assert.equal(PWMMavproxy.EXPECTED_CRITICAL_PARAMS.RC3_TRIM, 1500);
});

test('the browser deadzone constant matches the pushed FC parameters', () => {
  // The derivation itself, asserted rather than left in a comment. If either side moves
  // without the other, this fails — which is the whole point of pushing RC3_DZ.
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'socket.html'), 'utf8');
  const clientDz = Number(/THROTTLE_DEADZONE\s*=\s*([0-9.]+)/.exec(html)[1]);
  const escape   = Number(/THROTTLE_DZ_ESCAPE\s*=\s*([0-9.]+)/.exec(html)[1]);
  const P = require('../pwm_mavproxy_servo.js');
  const dzUs   = P.DEFAULT_PARAM_OVERLAY.RC3_DZ;
  const trim   = P.DEFAULT_PARAM_OVERLAY.RC3_TRIM;
  const halfSpan = 2000 - trim;                  // RC3_MAX - RC3_TRIM
  const expected = dzUs / halfSpan;
  assert.equal(clientDz, expected,
    `the browser uses ${clientDz} but RC3_DZ=${dzUs} over a ${halfSpan}us half-span is ${expected}`);
  assert.ok(escape > clientDz, 'the escape must clear the deadzone');
});
