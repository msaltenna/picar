'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const socketHtml = fs.readFileSync(path.join(__dirname, '..', 'socket.html'), 'utf8');

test('touch cancellation resets motion and sends an immediate neutral command', () => {
  const handler = socketHtml.match(
    /const cancelTouch = \(e\) => \{([\s\S]*?)\n      \};/,
  );
  assert.ok(handler, 'touchcancel handler not found');
  assert.match(handler[1], /resetThumb\(\)/);
  assert.match(handler[1], /sendControlValues\(\{ reliable: true \}\)/);
  assert.doesNotMatch(handler[1], /preserved/);
});

test('disconnect cannot automatically resume the previous control session', () => {
  const handler = socketHtml.match(
    /socket\.on\('disconnect', \(\) => \{([\s\S]*?)\n    \}\);/,
  );
  assert.ok(handler, 'disconnect handler not found');
  assert.match(handler[1], /enterSafeStoppedState\('connection-lost', false\)/);
});

test('drivetrain changes require a stopped neutral state', () => {
  const interlock = socketHtml.match(
    /function requireNeutralForDrivetrainChange\(\) \{([\s\S]*?)\n    \}/,
  );
  assert.ok(interlock, 'drivetrain interlock not found');
  assert.match(interlock[1], /enterSafeStoppedState\('drivetrain-change'\)/);
  assert.match(interlock[1], /resetMotionInputs\(\)/);
});
