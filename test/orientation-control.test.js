'use strict';

// Device-orientation (tilt) control.
//
// The defect this file exists for: `throttleValue = (45 - event.beta) / 50` with
// `event.beta === null` evaluates to 45/50 = **0.9**, because null coerces to 0 in
// arithmetic. Every desktop browser fires `deviceorientation` without a real beta
// reading, so selecting tilt control on such a device commanded 90% FORWARD THROTTLE
// with no user input at all — and rover3 has a flight battery installed.
//
// TASKS.md recorded this entry as a hand-tremor risk. The null path needs no tremor and
// is an order of magnitude worse, so both are covered here: the absent-reading case and
// the dead band.
//
// Both the RULE and its CONSUMER are tested. An adversarial review of the sibling
// throttle work found the rule tested and the call site not, and reverting the call site
// left the whole suite green — so the handler itself is driven below.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'socket.html'), 'utf8');

function grab(name, kind = 'function') {
  const at = html.indexOf(`${kind} ${name}(`);
  assert.notEqual(at, -1, `${name} not found in socket.html — renamed?`);
  return html.slice(at, html.indexOf('\n    }', at) + 6);
}

function constants() {
  const src = [];
  for (const n of ['ORIENTATION_NEUTRAL_BETA', 'ORIENTATION_BETA_SPAN',
                   'ORIENTATION_GAMMA_SPAN', 'ORIENTATION_THROTTLE_DZ']) {
    const m = new RegExp(`const ${n}\\s*=\\s*([0-9.]+)`).exec(html);
    assert.ok(m, `${n} not found in socket.html`);
    src.push(`const ${n} = ${m[1]};`);
  }
  return src.join('\n');
}

function loadRule() {
  return new Function('beta', 'gamma',
    `${constants()}\n${grab('orientationToControls')}\nreturn orientationToControls(beta, gamma);`);
}

// Drive the REAL handler, with the page's mutable control state declared in the
// generated scope so the assignments are observable.
function runHandler(event, { stopped = false } = {}) {
  return new Function('event', 'stopped', `
    let throttleValue = 999, steeringValue = 999;
    const applyCurve = (v) => v;              // identity: this test is not about the curve
    let orientationWarned = false;
    const warnings = [];
    const console = { warn: (m) => warnings.push(m) };
    ${constants()}
    ${grab('orientationToControls')}
    ${grab('handleOrientation')}
    handleOrientation(event);
    return { throttleValue, steeringValue, warnings };
  `)(event, stopped);
}

// ── The absent-reading case: the actual hazard ───────────────────────────────

test('an absent orientation reading commands NEUTRAL, not 0.9 throttle', () => {
  const rule = loadRule();
  for (const beta of [null, undefined, NaN, 'x', {}]) {
    const c = rule(beta, 10);
    assert.equal(c.throttle, 0,
      `beta=${JSON.stringify(beta) ?? 'undefined'} must command neutral — the old code ` +
      'computed (45 - null)/50 = 0.9, i.e. 90% forward with no input');
    assert.equal(c.steering, 0, 'steering must also fail to neutral');
    assert.equal(c.valid, false);
  }
  // gamma absent must not be ignored just because beta is fine.
  for (const gamma of [null, undefined, NaN]) {
    const c = rule(10, gamma);
    assert.equal(c.throttle, 0, 'an unusable gamma must not leave throttle live');
    assert.equal(c.steering, 0);
  }
});

test('the real handler holds neutral on an absent reading, and says so once', () => {
  // The consumer, not just the rule. A desktop browser fires this event repeatedly.
  const r = runHandler({ beta: null, gamma: null });
  assert.equal(r.throttleValue, 0, 'the handler must assign neutral throttle');
  assert.equal(r.steeringValue, 0);
  assert.equal(r.warnings.length, 1, 'exactly one warning, not one per event');
  assert.match(r.warnings[0], /no usable beta/i);
});

test('the handler assigns a real tilt through to the control values', () => {
  // And it must still WORK — "fails to neutral" is satisfied by a handler that always
  // commands neutral, which would be useless rather than safe.
  const r = runHandler({ beta: 0, gamma: 25 });
  assert.equal(r.throttleValue, 0.9, 'beta 0 is 45 degrees from neutral: full-ish forward');
  assert.equal(r.steeringValue, 1, 'gamma at the span limit is full steering');
});

// ── The dead band: the tracked hand-tremor P0 ───────────────────────────────

test('small tilts inside the dead band command nothing', () => {
  const rule = loadRule();
  const m = /const ORIENTATION_THROTTLE_DZ\s*=\s*([0-9.]+)/.exec(html);
  const dz = Number(m[1]);
  const span = Number(/const ORIENTATION_BETA_SPAN\s*=\s*([0-9.]+)/.exec(html)[1]);
  const neutral = Number(/const ORIENTATION_NEUTRAL_BETA\s*=\s*([0-9.]+)/.exec(html)[1]);

  // A device held within the dead band of neutral must command exactly zero.
  for (const offsetDeg of [0, 0.5, 1, 2, dz * span * 0.9]) {
    for (const sign of [1, -1]) {
      const c = rule(neutral + sign * offsetDeg, 0);
      assert.equal(c.throttle, 0,
        `${offsetDeg.toFixed(2)} degrees from neutral must not command throttle`);
    }
  }
  // And just outside it must command something, or the dead band has swallowed the axis.
  const outside = rule(neutral - (dz * span + 2), 0);
  assert.ok(outside.throttle > 0, `beyond the dead band must command throttle, got ${outside.throttle}`);
});

test('the dead band is small enough to be a dead band, not a mode', () => {
  const dz = Number(/const ORIENTATION_THROTTLE_DZ\s*=\s*([0-9.]+)/.exec(html)[1]);
  assert.ok(dz > 0, 'a zero dead band is the tracked hand-tremor defect');
  assert.ok(dz <= 0.10,
    `a dead band of ${dz} costs the operator too much of the throttle range`);
});

test('throttle and steering stay clamped to the normalised range', () => {
  const rule = loadRule();
  for (const beta of [-180, -90, 200, 1e6]) {
    const c = rule(beta, 0);
    assert.ok(c.throttle >= -1 && c.throttle <= 1, `throttle out of range for beta=${beta}`);
  }
  for (const gamma of [-180, 90, 1e6]) {
    const c = rule(45, gamma);
    assert.ok(c.steering >= -1 && c.steering <= 1, `steering out of range for gamma=${gamma}`);
  }
});
