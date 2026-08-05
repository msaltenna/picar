'use strict';

// The throttle deadzone escape, and the flight controller's slew limit.
//
// Both exist because the operator reported reverse "doesn't happen immediately and
// requires steering first". Measured on rover3 rather than guessed — a hard reverse STEP
// sent with the browser bypassed entirely still ramped 1500 -> 1460 -> 1340 -> 1220 us
// over ~700 ms, which ruled out both the client ramp and app.js (whose throttle_ramp_up
// and throttle_ramp_down are both 0). The causes were in the flight controller's
// parameters and in one client constant:
//
//   RC3_DZ=30us        the FC ignores throttle inside its deadzone. The throttle span is
//                      500us per normalised unit, so 30us = 0.06 — and the first
//                      keyboard step was 0.05, INSIDE it. Two ticks (~100 ms) commanded
//                      literally nothing.
//   MOT_SLEWRATE=100   %/s, so neutral -> 60% took 600 ms more.
//   ATC_BRAKE=1        a reverse command while rolling forward is BRAKING, so reverse
//                      does not engage until stopped. Left alone deliberately; that is
//                      what made "steer first" appear to help — steering passes time at
//                      neutral, which lets the vehicle stop.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'socket.html'), 'utf8');

// Extract the real function out of socket.html and run it, as the other UI tests do.
function loadNextThrottle() {
  const at = html.indexOf('function nextThrottle(');
  assert.notEqual(at, -1, 'nextThrottle() not found in socket.html — renamed?');
  const end = html.indexOf('\n    }', at) + 6;
  const src = html.slice(at, end);
  // The constants it closes over live just above it; pull them in by name so the test
  // uses the SHIPPED values rather than copies that could drift.
  const dz = /const THROTTLE_DEADZONE\s*=\s*([0-9.]+)/.exec(html);
  const esc = /const THROTTLE_DZ_ESCAPE\s*=\s*([0-9.]+)/.exec(html);
  assert.ok(dz && esc, 'deadzone constants not found in socket.html');
  return {
    fn: new Function('current', 'direction', 'step',
      `const THROTTLE_DEADZONE = ${dz[1]}; const THROTTLE_DZ_ESCAPE = ${esc[1]};
       ${src}; return nextThrottle(current, direction, step);`),
    deadzone: Number(dz[1]),
    escape: Number(esc[1]),
  };
}

const STEP = 0.05;

test('the first throttle step clears the flight controller deadzone', () => {
  const { fn, deadzone, escape } = loadNextThrottle();
  // Forward from rest: must land OUTSIDE the deadzone on tick one, not inside it.
  const fwd = fn(0, 1, STEP);
  assert.ok(fwd > deadzone,
    `first forward step ${fwd} is inside the ${deadzone} deadzone — it commands nothing`);
  assert.equal(fwd, escape);

  // Reverse from rest: the case that was reported.
  const rev = fn(0, -1, STEP);
  assert.ok(rev < -deadzone,
    `first reverse step ${rev} is inside the deadzone — reverse commands nothing`);
  assert.equal(rev, -escape);
});

test('the escape is a crawl, not a launch', () => {
  // Escaping the deadzone must not become a way to jump to significant throttle. The
  // whole point is to leave the dead band and then ramp normally.
  const { fn, deadzone, escape } = loadNextThrottle();
  assert.ok(escape < 0.15, `escape ${escape} is too large to be a crawl`);
  assert.ok(escape > deadzone, 'and it must actually clear the deadzone');
  assert.ok(escape - deadzone >= 0.01, 'leave margin over the deadzone edge, not sit on it');
  assert.equal(fn(0, 1, STEP), escape, 'and it must not overshoot past the escape value');
});

test('escaping the deadzone never REDUCES the command', () => {
  // Inside the dead band the escape applies, but if the ordinary step already clears the
  // deadzone the larger value must win. Surviving mutation: returning the escape value
  // unconditionally, which at current=0.05 turns a press into 0.08 when the plain ramp
  // would give 0.10 — a keypress that makes the vehicle go SLOWER.
  const { fn, deadzone, escape } = loadNextThrottle();
  const justInside = 0.05;
  assert.ok(justInside < deadzone, 'precondition: inside the dead band');
  const stepped = justInside + STEP;
  assert.ok(stepped > escape, 'precondition: the plain step already clears the deadzone');
  assert.equal(Number(fn(justInside, 1, STEP).toFixed(4)), Number(stepped.toFixed(4)),
    'the plain step must win when it is larger than the escape');
  assert.equal(Number(fn(-justInside, -1, STEP).toFixed(4)), Number((-stepped).toFixed(4)));
});

test('the normal ramp is untouched once moving', () => {
  const { fn, escape } = loadNextThrottle();
  // Past the escape point, every step is the plain increment — the escape must not
  // repeatedly re-apply and stall the ramp at 0.08.
  assert.equal(fn(escape, 1, STEP).toFixed(2), (escape + STEP).toFixed(2));
  assert.equal(fn(0.5, 1, STEP), 0.55);
  assert.equal(fn(-0.5, -1, STEP), -0.55);
});

test('throttle is clamped to the normalised range', () => {
  const { fn } = loadNextThrottle();
  assert.equal(fn(0.98, 1, STEP), 1);
  assert.equal(fn(-0.98, -1, STEP), -1);
  assert.equal(fn(1, 1, STEP), 1);
});

test('releasing the throttle key snaps to neutral in ONE tick', () => {
  // Previously this decayed one step per tick — a full second from full forward. The
  // earlier version of this test looped "until v === 0", which passes for a gradual decay
  // and for a snap alike, so it could not tell the two apart. It now asserts the tick
  // count, which is the property that matters.
  //
  // Why it matters twice over: the ESC gates forward -> reverse on seeing a clean neutral,
  // and a slow decay meant pressing reverse during it never presented one. And releasing
  // throttle should stop commanding drive immediately on a vehicle with a pack installed.
  const { fn } = loadNextThrottle();
  for (const from of [1, 0.6, 0.05, -0.05, -0.6, -1]) {
    assert.equal(fn(from, 0, STEP), 0,
      `releasing at ${from} must command neutral immediately, not decay towards it`);
  }
});

test('release is immediate from every reachable throttle value', () => {
  // Swept rather than spot-checked: a decay implementation passes at small magnitudes
  // (where one step already reaches 0) and fails only at large ones, so testing 0.05
  // alone would not distinguish them.
  const { fn } = loadNextThrottle();
  for (let v = -1; v <= 1.0001; v += 0.05) {
    const from = Math.round(v * 1000) / 1000;
    assert.equal(fn(from, 0, STEP), 0, `release at ${from} must be immediate`);
  }
});

test('steering-style gradual decay is NOT what throttle does', () => {
  // Guards the distinction explicitly. Steering self-centres gradually and should; the
  // throttle release must not, because an ESC gate depends on reaching neutral promptly.
  const { fn } = loadNextThrottle();
  assert.notEqual(fn(1, 0, STEP), 1 - STEP,
    'a one-step decay from full throttle is the defect this replaced');
});

test('reversing direction crosses zero without sticking at the escape value', () => {
  // Holding S while rolling forward: the direction is negative but current is positive
  // and outside the deadzone, so this must be a normal decrement, not a jump to -0.08.
  const { fn, escape } = loadNextThrottle();
  assert.equal(fn(0.5, -1, STEP), 0.45, 'must decrement normally, not snap to -escape');
  assert.equal(fn(0.10, -1, STEP), 0.05);
  // Once inside the deadzone heading negative, the escape applies.
  assert.equal(fn(0.05, -1, STEP), -escape);
});

// ── The CONSUMER, not just the rule ──────────────────────────────────────────
//
// An adversarial review reverted the three call-site lines that used nextThrottle() —
// removing both the deadzone escape and the snap-to-neutral from the only path that runs
// them — and all 248 tests stayed green. Every test above exercises nextThrottle
// directly, so none of them could tell. These drive the real keyboardTick and the real
// startKeyboardLoop instead.

function loadKeyboard() {
  const grab = (name) => {
    const at = html.indexOf(`function ${name}(`);
    assert.notEqual(at, -1, `${name}() not found in socket.html — renamed?`);
    return html.slice(at, html.indexOf('\n    }', at) + 6);
  };
  const num = (n) => {
    // Not anchored on `const`: KEY_THROTTLE_STEP and KEY_STEERING_STEP share one
    // declaration (`const A = 0.05, B = 0.15;`), so requiring the keyword found only the
    // first of the pair.
    const m = new RegExp(`\\b${n}\\s*=\\s*([0-9.]+)`).exec(html);
    assert.ok(m, `${n} not found in socket.html`);
    return m[1];
  };
  const prelude = `
    const KEY_THROTTLE_STEP = ${num('KEY_THROTTLE_STEP')};
    const KEY_STEERING_STEP = ${num('KEY_STEERING_STEP')};
    const KEY_TICK_MS       = ${num('KEY_TICK_MS')};
    const THROTTLE_DEADZONE  = ${num('THROTTLE_DEADZONE')};
    const THROTTLE_DZ_ESCAPE = ${num('THROTTLE_DZ_ESCAPE')};
  `;
  return (keys, { throttle = 0, steering = 0, stopped = false, mode = 'keyboard', ticks = 1 } = {}) =>
    new Function('keysDown', 'startThrottle', 'startSteering', 'stopped', 'controlMode', 'ticks', `
      ${prelude}
      let throttleValue = startThrottle, steeringValue = startSteering;
      let keyboardInterval = null;
      ${grab('nextThrottle')}
      ${grab('nextSteering')}
      ${grab('keyboardTick')}
      ${grab('startKeyboardLoop')}
      let scheduled = null, scheduledMs = null;
      startKeyboardLoop((fn, ms) => { scheduled = fn; scheduledMs = ms; return 1; });
      if (typeof scheduled !== 'function') return { error: 'no callback scheduled' };
      for (let i = 0; i < ticks; i++) scheduled();
      return { throttleValue, steeringValue, scheduledMs };
    `)(keys, throttle, steering, stopped, mode, ticks);
}

test('the keyboard loop schedules a tick that applies the deadzone escape', () => {
  // Surviving mutation: revert the call site to the old inline ramp. This is the test
  // that catches it, because it invokes whatever startKeyboardLoop actually scheduled.
  const run = loadKeyboard();
  const r = run({ KeyS: true });
  assert.equal(r.error, undefined, r.error);
  assert.ok(r.scheduledMs <= 50, `tick interval must be <= 50 ms, got ${r.scheduledMs}`);
  assert.equal(r.throttleValue, -0.08,
    'one tick of held reverse from rest must clear the FC deadzone, not land inside it');
});

test('the scheduled tick snaps to neutral when no throttle key is held', () => {
  const run = loadKeyboard();
  const r = run({}, { throttle: 0.85 });
  assert.equal(r.throttleValue, 0, 'release must reach neutral in the first tick');
});

test('the scheduled tick ramps normally once moving', () => {
  const run = loadKeyboard();
  const r = run({ KeyW: true }, { throttle: 0.5 });
  assert.equal(Number(r.throttleValue.toFixed(2)), 0.55);
});

test('arrow keys drive the same path as WASD', () => {
  const run = loadKeyboard();
  assert.equal(run({ ArrowDown: true }).throttleValue, -0.08);
  assert.equal(run({ ArrowUp: true }).throttleValue, 0.08);
  assert.equal(run({ ArrowLeft: true }).steeringValue, -0.15);
  assert.equal(run({ ArrowRight: true }).steeringValue, 0.15);
});

test('the tick does nothing while stopped or in another control mode', () => {
  // The guard that keeps a stopped client from commanding anything.
  const run = loadKeyboard();
  assert.equal(run({ KeyW: true }, { throttle: 0, stopped: true }).throttleValue, 0);
  assert.equal(run({ KeyW: true }, { throttle: 0, mode: 'joystick' }).throttleValue, 0);
});

test('steering still self-centres gradually, unlike throttle', () => {
  // The asymmetry is deliberate. If a future edit snaps steering too, the wheels jerk
  // straight on key release.
  const run = loadKeyboard();
  const r = run({}, { steering: 0.6 });
  assert.equal(Number(r.steeringValue.toFixed(2)), 0.45,
    'steering must decay one step, not snap');
  const r2 = run({}, { steering: 0.6, ticks: 4 });
  assert.equal(Number(r2.steeringValue.toFixed(2)), 0);
});

test('held reverse reaches full scale over the expected number of ticks', () => {
  // End-to-end through the real tick: escape, then the ordinary ramp.
  const run = loadKeyboard();
  const r = run({ KeyS: true }, { ticks: 20 });
  assert.equal(r.throttleValue, -1, `20 ticks of held reverse must reach -1, got ${r.throttleValue}`);
});
