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
  return new Function('beta', 'gamma', 'neutralSeen',
    `${constants()}\n${grab('orientationToControls')}\n` +
    'return orientationToControls(beta, gamma, neutralSeen);');
}
// Most tests want the post-neutral-capture behaviour; pass neutralSeen=true so they are
// not all silently testing the latched-off case.
function loadRuleArmed() {
  const f = loadRule();
  return (beta, gamma) => f(beta, gamma, true);
}

// Drive the REAL handler, with the page's mutable control state declared in the
// generated scope so the assignments are observable.
function runHandler(event, { stopped = false, mode = 'orientation', neutralSeen = true,
                             times = 1 } = {}) {
  // `orientationWarned` and `orientationNeutralSeen` are GRABBED from the page, not
  // re-declared here. A review deleted the page's `orientationWarned` declaration and the
  // suite stayed green, because this scope was supplying it — while in a browser the warn
  // block throws ReferenceError before the neutral assignment.
  const decls = [];
  for (const name of ['orientationWarned', 'orientationNeutralSeen']) {
    const m = new RegExp(`let ${name}\\s*=\\s*[^;]+;`).exec(html);
    assert.ok(m, `page declaration for ${name} not found in socket.html`);
    decls.push(m[0]);
  }
  return new Function('event', 'stopped', 'controlMode', 'seed', 'times', `
    let throttleValue = 999, steeringValue = 999;
    const applyCurve = (v) => v;              // identity: this test is not about the curve
    ${decls.join('\n')}
    orientationNeutralSeen = seed;
    const warnings = [];
    const console = { warn: (m) => warnings.push(m) };
    ${constants()}
    ${grab('orientationToControls')}
    ${grab('handleOrientation')}
    for (let i = 0; i < times; i++) handleOrientation(event);
    return { throttleValue, steeringValue, warnings, neutralSeen: orientationNeutralSeen };
  `)(event, stopped, mode, neutralSeen, times);
}

// ── The absent-reading case: the actual hazard ───────────────────────────────

test('an absent orientation reading commands NEUTRAL, not 0.9 throttle', () => {
  const rule = loadRuleArmed();
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
  const rule = loadRuleArmed();
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
  const rule = loadRuleArmed();
  for (const beta of [-180, -90, 200, 1e6]) {
    const c = rule(beta, 0);
    assert.ok(c.throttle >= -1 && c.throttle <= 1, `throttle out of range for beta=${beta}`);
  }
  for (const gamma of [-180, 90, 1e6]) {
    const c = rule(45, gamma);
    assert.ok(c.steering >= -1 && c.steering <= 1, `steering out of range for gamma=${gamma}`);
  }
});

// ── Neutral capture: the hazard the first fix left open ──────────────────────

test('throttle stays at zero until the device has been seen at rest', () => {
  // The first version of this fix removed the null route to 0.9 and left the DESIGN
  // route: beta=0 is a phone lying flat, and (45-0)/50 = +0.9. Setting the phone down and
  // pressing Start commanded 90% forward throttle within one 50 ms send tick, with a
  // working sensor and no operator input. Found by review after the fix had shipped.
  const rule = loadRule();

  // Not yet seen at rest: a flat phone must command NOTHING.
  const cold = rule(0, 0, false);
  assert.equal(cold.throttle, 0,
    'a tilted device must not command throttle before it has been observed at rest');
  assert.equal(cold.neutralSeen, false, 'and it must not latch on a tilted reading');

  // A reading inside the dead band arms it...
  const atRest = rule(45, 0, false);
  assert.equal(atRest.throttle, 0);
  assert.equal(atRest.neutralSeen, true, 'a reading at rest must satisfy the latch');

  // ...and only then does tilt command throttle.
  assert.equal(rule(0, 0, true).throttle, 0.9, 'once armed, tilt must work normally');
});

test('the handler holds throttle until neutral capture, then releases it', () => {
  // Through the real handler, which is what actually runs.
  const cold = runHandler({ beta: 0, gamma: 0 }, { neutralSeen: false });
  assert.equal(cold.throttleValue, 0, 'flat phone before neutral capture must be neutral');

  const armed = runHandler({ beta: 0, gamma: 0 }, { neutralSeen: true });
  assert.equal(armed.throttleValue, 0.9);
});

test('steering is NOT latched — it commands no drive', () => {
  const rule = loadRule();
  assert.equal(rule(0, 25, false).steering, 1,
    'locking steering out would surprise an operator straightening the wheels');
});

// ── Guards that were provably deletable ──────────────────────────────────────

test('the handler does nothing while stopped', () => {
  // Surviving mutation: delete `if (stopped) return;`. Tilt events then pre-load the
  // channel buffer while disarmed — the client-side half of invariant 3.
  const r = runHandler({ beta: 0, gamma: 0 }, { stopped: true });
  assert.equal(r.throttleValue, 999, 'throttle must be left untouched entirely');
  assert.equal(r.steeringValue, 999);
});

test('the handler does nothing in another control mode', () => {
  // Surviving mutation: no controlMode check. There is a real race —
  // requestOrientationPermission adds the listener from an async .then, so switching to
  // joystick while the iOS prompt is open attaches the tilt handler AFTER the switch.
  const r = runHandler({ beta: 0, gamma: 0 }, { mode: 'joystick' });
  assert.equal(r.throttleValue, 999, 'tilt must not command throttle in joystick mode');
});

test('reverse tilt commands reverse throttle', () => {
  // Surviving mutation: `Math.abs(thr) < DZ` -> `thr < DZ`, which deletes the ENTIRE
  // reverse half of the axis because every negative value is below +0.06. No test
  // asserted a negative throttle, so it passed.
  const rule = loadRuleArmed();
  assert.equal(rule(95, 0).throttle, -1,   'beta 95 is full reverse');
  assert.equal(rule(70, 0).throttle, -0.5);
  assert.equal(Number(rule(60, 0).throttle.toFixed(2)), -0.3);
  assert.ok(rule(50, 0).throttle < 0, 'just past the dead band must be negative, not zero');
});

test('the unusable-sensor warning fires once across many events, not per event', () => {
  // Surviving mutation: `if (!orientationWarned)` -> `if (true)`. The old test called the
  // handler ONCE, so once-ever and once-per-event were indistinguishable.
  const r = runHandler({ beta: null, gamma: null }, { times: 5 });
  assert.equal(r.warnings.length, 1,
    `five events must produce one warning, got ${r.warnings.length}`);
  assert.equal(r.throttleValue, 0, 'and every one of them must hold neutral');
});

test('stopping clears the neutral latch, so re-arming requires rest again', () => {
  // Surviving mutation: the latch reset used to live in toggleStop, which no test can
  // reach, so deleting it left the suite green. Consequence: Stop then Start with the
  // phone still tilted commands throttle immediately, defeating the whole latch.
  const r = runHandler({ beta: 0, gamma: 0 }, { stopped: true, neutralSeen: true });
  assert.equal(r.neutralSeen, false, 'a stopped handler must clear the latch');
  assert.equal(r.throttleValue, 999, 'and still touch nothing');
});
