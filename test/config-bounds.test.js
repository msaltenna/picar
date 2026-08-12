'use strict';

// Bounds on config values the untracked overlay can reach.
//
// The upper bound matters as much as the lower one and is much less obvious: Node
// stores a setInterval delay in a 32-bit signed int, so Infinity or anything past
// 2^31-1 becomes **1 ms**. A value that reads as "poll very slowly" produces the
// fastest possible loop — the exact CPU churn the lower bound exists to prevent.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { clampTelemetryInterval, TELEMETRY_INTERVAL_MIN_MS, TELEMETRY_INTERVAL_MAX_MS }
  = require('../config-bounds.js');

test('a sane value passes through unchanged', () => {
  assert.equal(clampTelemetryInterval(1000), 1000);
  assert.equal(clampTelemetryInterval(250), 250);
  assert.equal(clampTelemetryInterval(60000), 60000);
});

test('too-fast values are raised to the floor', () => {
  for (const v of [1, 10, 249]) assert.equal(clampTelemetryInterval(v), TELEMETRY_INTERVAL_MIN_MS);
});

test('absent, zero and negative fall back to the default', () => {
  for (const v of [undefined, null, 0, -1, -99999, '']) {
    assert.equal(clampTelemetryInterval(v), 1000, `${JSON.stringify(v)} must default`);
  }
});

test('values Node would coerce to 1 ms are neutralised', () => {
  // The whole point. Verified empirically: setInterval(fn, Infinity) yields
  // _idleTimeout === 1, and so does 2**31.
  //
  // Two safe outcomes, and which one applies depends on the input rather than being
  // arbitrary: a FINITE but absurd value is clamped to the ceiling, while a
  // non-finite one is not a quantity at all and falls back to the default. An
  // earlier draft asserted the ceiling for both, which was just a guess.
  for (const v of [2 ** 31, 2 ** 31 + 1, 1e12, Number.MAX_SAFE_INTEGER]) {
    assert.equal(clampTelemetryInterval(v), TELEMETRY_INTERVAL_MAX_MS,
      `finite-but-absurd ${v} must clamp to the ceiling`);
  }
  assert.equal(clampTelemetryInterval(Infinity), 1000, 'Infinity is not a quantity');
  assert.equal(clampTelemetryInterval(-Infinity), 1000);
  assert.equal(clampTelemetryInterval(NaN), 1000);

  // What unites them: none may fit outside a 32-bit signed int.
  for (const v of [2 ** 31, Infinity, NaN, 1e12]) {
    assert.ok(clampTelemetryInterval(v) < 2 ** 31);
  }
});

test('the clamped result never produces a 1 ms timer', () => {
  // Assert the property that actually matters, against real timers.
  for (const v of [Infinity, 2 ** 31, 0, -5, 1, 'x']) {
    const t = setInterval(() => {}, clampTelemetryInterval(v));
    const actual = t._idleTimeout;
    clearInterval(t);
    assert.ok(actual >= TELEMETRY_INTERVAL_MIN_MS,
      `input ${v} produced a ${actual} ms timer`);
  }
});

test('a non-numeric string does not become a hot loop', () => {
  assert.equal(clampTelemetryInterval('abc'), 1000);
  assert.equal(clampTelemetryInterval({}), 1000);
  assert.equal(clampTelemetryInterval([]), 1000);
});

// ── Overlay reassert bounds ──────────────────────────────────────────────────
//
// The reason these exist: both settings were lower-bounded only, which is no bound
// at all for a value the untracked overlay can reach. `1e400` is VALID JSON that
// parses as Infinity, Node coerces the infinite timer to 1 ms, and with the attempt
// count also unbounded the result was a permanent 1 ms loop rebuilding the overlay
// chain and firing PARAM_SET roughly every millisecond — on the same event loop as
// the 20 Hz override stream and the fail-safe watchdog.

const { overlayChainMs, clampOverlayReassert, clampOverlayAttempts,
        OVERLAY_REASSERT_MAX_MS, OVERLAY_ATTEMPTS_MAX, sanitizeParamOverlay
} = require('../config-bounds.js');

test('the chain duration matches the overlay schedule it is derived from', () => {
  // writes 250 ms apart, 500 ms settle, read-backs 150 ms apart. With the default
  // 9-entry overlay and 7 critical params a review measured the final read at
  // 3650 ms — this must agree, or the floor below is wrong.
  assert.equal(overlayChainMs(9, 7), 3650);
  assert.equal(overlayChainMs(0, 0), 500, 'an empty overlay is just the settle');
  assert.ok(overlayChainMs(20, 7) > overlayChainMs(9, 7), 'a larger overlay takes longer');
});

test('reassert never fires before a full chain could have been confirmed', () => {
  // The old fixed 3000 ms floor was SHORTER than the 3650 ms chain, so a reassert
  // cancelled the very read-backs that would have confirmed the previous attempt.
  const chain = overlayChainMs(9, 7);
  for (const v of [undefined, null, 0, -5, 1, 3000, 3649, 'x', {}]) {
    const got = clampOverlayReassert(v, chain);
    assert.ok(got > chain, `${JSON.stringify(v)} gave ${got}, which is inside the ${chain} ms chain`);
  }
});

test('a JSON-reachable infinity cannot become a 1 ms timer', () => {
  // 1e400 is the case that matters: it is legal JSON, so it can arrive through
  // picar-cfg.local.json with no review.
  const chain = overlayChainMs(9, 7);
  for (const v of [Infinity, -Infinity, NaN, 1e400, 2 ** 31, 2 ** 31 + 1, 1e12]) {
    const got = clampOverlayReassert(v, chain);
    assert.ok(Number.isFinite(got), `${v} produced a non-finite delay`);
    assert.ok(got > chain && got <= OVERLAY_REASSERT_MAX_MS, `${v} -> ${got}`);
    const t = setInterval(() => {}, got);
    const actual = t._idleTimeout;
    clearInterval(t);
    assert.ok(actual > 1000, `${v} produced a ${actual} ms timer`);
  }
});

test('a sane explicit reassert value is respected', () => {
  const chain = overlayChainMs(9, 7);
  assert.equal(clampOverlayReassert(20000, chain), 20000);
  assert.equal(clampOverlayReassert(60000, chain), 60000);
});

test('attempts are a small finite integer, always', () => {
  assert.equal(clampOverlayAttempts(undefined), 4);
  assert.equal(clampOverlayAttempts(1), 1);
  assert.equal(clampOverlayAttempts(4), 4);
  for (const v of [Infinity, 1e400, NaN, 'x', {}, 0, -3]) {
    const got = clampOverlayAttempts(v);
    assert.ok(Number.isInteger(got) && got >= 1 && got <= OVERLAY_ATTEMPTS_MAX,
      `${JSON.stringify(v)} -> ${got}`);
  }
  assert.equal(clampOverlayAttempts(9999), OVERLAY_ATTEMPTS_MAX, 'an absurd count is capped');
});

test('the driver actually uses these bounds, not its own arithmetic', () => {
  // Pinning the WIRING, not the helper. An inline lower-bound-only clamp is exactly
  // what survived mutation last round.
  const PWMMavproxy = require('../pwm_mavproxy_servo.js');
  const d = new PWMMavproxy({
    mavproxy_autostart: false,
    mavproxy_overlay_reassert_ms: 1e400,      // JSON-reachable Infinity
    mavproxy_overlay_max_attempts: 1e400,
  });
  assert.ok(Number.isFinite(d.overlayReassertMs), 'reassert delay must be finite');
  assert.ok(d.overlayReassertMs > d.overlayChainMs,
    `reassert ${d.overlayReassertMs} must exceed the ${d.overlayChainMs} ms chain`);
  assert.ok(Number.isInteger(d.maxOverlayAttempts) && d.maxOverlayAttempts <= OVERLAY_ATTEMPTS_MAX,
    `attempts must be a small finite integer, got ${d.maxOverlayAttempts}`);
});

test('the ceiling never drops below the floor, however large the chain', () => {
  // The defect a review found in the first version of this clamp: a flat 60 s cap
  // applied AFTER the floor meant that once the chain exceeded 60 s — reachable with
  // a large custom mavproxy_param_overlay, which the untracked config can set with no
  // review — every FINITE configured value collapsed to 60 000 ms, back INSIDE the
  // chain, so each reassert cancelled the writes and read-backs still in flight and
  // no attempt ever completed.
  //
  // The inversion was the giveaway: an ABSENT value was safe, because it returns the
  // uncapped floor, while an explicit and perfectly sane 5000 was broken. Any test
  // that only exercises the default 9-entry overlay cannot see this — the previous
  // one didn't, which is why the mutation survived.
  for (const entries of [235, 300, 1000]) {
    const chain = overlayChainMs(entries, 7);
    assert.ok(chain > OVERLAY_REASSERT_MAX_MS,
      `precondition: ${entries} entries must exceed the cap (chain ${chain})`);
    for (const cfg of [5000, 60000, 1, undefined, Infinity, 1e400]) {
      const got = clampOverlayReassert(cfg, chain);
      assert.ok(got > chain,
        `${entries} entries, cfg ${cfg}: got ${got}, inside the ${chain} ms chain`);
      assert.ok(Number.isFinite(got), `${cfg} produced a non-finite delay`);
    }
  }
});

test('the floor is tied to the schedule the driver actually SCHEDULES', () => {
  // The previous version of this test grepped the driver's source for the shared
  // constant names — and `src.includes('OVERLAY_WRITE_SPACING_MS')` is satisfied by the
  // IMPORT line whether or not the schedule uses it. A review proved the consequence:
  // replacing the constant with a literal at both use sites left all 173 tests green
  // while 6 of 7 read-backs were cancelled by every reassert. The constants were owned
  // in one place; their USE was unpinned, which is the same transcription defect one
  // level up.
  //
  // So measure the real thing: instrument setTimeout, run applyParamOverlay, and take
  // the largest delay it actually schedules. That is the chain, by definition, and it
  // cannot be faked by a rename or a literal.
  const PWMMavproxy = require('../pwm_mavproxy_servo.js');
  const d = new PWMMavproxy({ mavproxy_autostart: false });
  d.buildParamSet = () => Buffer.alloc(0);
  d.buildParamRequestRead = () => Buffer.alloc(0);
  d.sendPacket = () => true;

  const delays = [];
  const realSetTimeout = global.setTimeout;
  try {
    global.setTimeout = (fn, ms) => { delays.push(ms); return { unref() {} }; };
    d.applyParamOverlay();
  } finally {
    global.setTimeout = realSetTimeout;
  }
  d.clearOverlayTimers();

  assert.ok(delays.length > 0, 'applyParamOverlay must schedule work');
  const lastScheduled = Math.max(...delays);
  const entries = Object.keys(d.paramOverlay).length;
  const reads   = Object.keys(PWMMavproxy.EXPECTED_CRITICAL_PARAMS).length;

  assert.equal(overlayChainMs(entries, reads), lastScheduled,
    `overlayChainMs(${entries}, ${reads}) says ${overlayChainMs(entries, reads)} ms but the ` +
    `driver actually schedules its last work at ${lastScheduled} ms — the bound is ` +
    'computed from something other than the real schedule');

  assert.ok(d.overlayReassertMs > lastScheduled,
    `the reassert fires at ${d.overlayReassertMs} ms, before the chain's last work at ` +
    `${lastScheduled} ms, so it cancels the read-backs that would confirm the attempt`);
});

// ── Parameter-overlay shape validation (F4) ──────────────────────────────────

test('a non-object param overlay falls back instead of silently pushing nothing', () => {
  // `[]` is truthy, so `config.mavproxy_param_overlay || DEFAULT` accepted it and
  // Object.entries([]) is empty: the overlay pushed NOTHING, FRAME_CLASS was never
  // corrected, and every read-back "verified" whatever the FC already held.
  for (const bad of [[], 'FRAME_CLASS=1', 42, true]) {
    const r = sanitizeParamOverlay(bad, { FRAME_CLASS: 1 }, []);
    assert.equal(r.invalidShape, true, `${JSON.stringify(bad)} must not be accepted`);
    assert.deepEqual(r.overlay, { FRAME_CLASS: 1 });
    assert.equal(r.rejected.length, 1, 'and it must be reported, not dropped silently');
  }
});

test('a non-numeric overlay value is dropped rather than reaching writeFloatLE', () => {
  // An unhandled throw inside the overlay's setTimeout is an uncaught exception in
  // a timer, which takes the process down — while the vehicle may be armed.
  //
  // TUNABLE is allowlisted here so the non-numeric path is what is under test rather than
  // the allowlist; the four bad values must be rejected for being non-numeric.
  const r = sanitizeParamOverlay(
    { TUNABLE: 1, SERVO1_FUNCTION: 'seventy', SERVO3_FUNCTION: null, BAD: NaN, ALSO: Infinity },
    { FRAME_CLASS: 99 }, ['TUNABLE', 'SERVO1_FUNCTION', 'SERVO3_FUNCTION', 'BAD', 'ALSO']);
  assert.deepEqual(r.overlay, { FRAME_CLASS: 99, TUNABLE: 1 }, 'only finite numbers survive');
  assert.equal(r.invalidShape, false, 'a partially valid object is not a whole-overlay failure');
  assert.equal(r.rejected.length, 4);
  assert.ok(r.rejected.some((m) => m.includes('SERVO1_FUNCTION')), r.rejected.join('; '));
});

test('a name longer than the 16-char MAVLink param_id is refused, not truncated', () => {
  // The alias bypass. buildParamSet() does String(name).slice(0, 16), and
  // "RC_OVERRIDE_TIME" is EXACTLY 16 characters — so "RC_OVERRIDE_TIMEX" is a different
  // JavaScript key that becomes the SAME parameter on the wire. Any name-based allowlist or
  // guard compares the untruncated key and waves it through, after which the FC receives
  // RC_OVERRIDE_TIME=3: the stale-override expiry 15x longer than the 0.2 this overlay owns,
  // on an armed vehicle whose own failsafes are disabled.
  const builtIn = { RC_OVERRIDE_TIME: 0.2 };
  const r = sanitizeParamOverlay({ RC_OVERRIDE_TIMEX: 3 }, builtIn, ['RC_OVERRIDE_TIMEX']);
  assert.equal(r.overlay.RC_OVERRIDE_TIME, 0.2,
    'a 17-char alias reached the wire as RC_OVERRIDE_TIME');
  assert.ok(!('RC_OVERRIDE_TIMEX' in r.overlay));
  assert.equal(r.rejected.length, 1);
  assert.ok(r.rejected[0].includes('longer than 16'), r.rejected[0]);
});

test('a numeric string is rejected, not coerced — and the built-in value survives it', () => {
  // Coercing would hide a real config error and there is no upside: the tracked
  // config uses numbers, so a string only ever arrives from a hand-edited overlay.
  //
  // This assertion CHANGED with the merge fix, deliberately. It used to require
  // `r.overlay` to be `{}` — i.e. it pinned the behaviour where one bad entry took the
  // whole built-in set down with it. Rejecting the entry and KEEPING the built-in value
  // is the point; an empty overlay is the failure mode, not the expected result.
  // ALLOWLISTED here on purpose, so the coercion rule is what is under test. A reviewer showed
  // that without it the entry is refused for being off-allowlist and the assertions hold even if
  // numeric strings ARE coerced — the test could not fail for the reason it names.
  const r = sanitizeParamOverlay({ FRAME_CLASS: '1' }, { FRAME_CLASS: 1 }, ['FRAME_CLASS']);
  assert.deepEqual(r.overlay, { FRAME_CLASS: 1 },
    'the rejected string must leave the built-in FRAME_CLASS in place, not erase it');
  assert.equal(r.rejected.length, 1, 'and the string must be reported as rejected');
  assert.ok(r.rejected[0].includes('"1"'), `the report must quote the bad value: ${r.rejected[0]}`);
  assert.deepEqual(r.applied, [], 'nothing was applied');
});

test('a partial overlay ADDS to the built-in set and can never subtract from it', () => {
  // The defect this fix exists for. sanitizeParamOverlay built `const overlay = {}` and
  // populated it only from the caller's value, so one key in untracked
  // picar-cfg.local.json silently discarded every other critical parameter. On main's real
  // table that is 12 WRITES dropped of 13: all six SERVOn_FUNCTION, MOT_SLEWRATE, RC3_DZ,
  // RC3_TRIM, RC_OVERRIDE_TIME, AHRS_GPS_USE, GPS1_TYPE.
  //
  // What read-back could REPORT is a smaller number, and an earlier revision of this comment
  // conflated the two. EXPECTED_CRITICAL_PARAMS holds 11 names, and AHRS_GPS_USE and GPS1_TYPE
  // are not among them — they are pushed and never read back at all. So with FRAME_CLASS
  // retained, at most 10 of the 11 verified entries could be reported missing, and those two
  // losses are INVISIBLE to read-back entirely. Because nothing gates arming on verification,
  // even what it does report is a log line, not a refusal.
  const builtIn = { FRAME_CLASS: 1, SERVO3_FUNCTION: 70, MOT_SLEWRATE: 250 };
  const r = sanitizeParamOverlay({ SOME_TUNABLE: 7 }, builtIn, ['SOME_TUNABLE']);
  assert.equal(r.overlay.SERVO3_FUNCTION, 70, 'a one-key overlay must not drop SERVO3_FUNCTION');
  assert.equal(r.overlay.MOT_SLEWRATE, 250);
  assert.equal(r.overlay.FRAME_CLASS, 1);
  assert.equal(r.overlay.SOME_TUNABLE, 7, 'an allowlisted name must still be able to add');
  assert.deepEqual(r.applied, ['SOME_TUNABLE']);
  assert.equal(r.rejected.length, 0);
});

test('an empty overlay object yields the built-in set, not nothing', () => {
  // `{}` is the shape a hand-edit most easily leaves behind, and it used to mean
  // "push no critical parameters at all".
  const builtIn = { FRAME_CLASS: 1, SERVO3_FUNCTION: 70 };
  const r = sanitizeParamOverlay({}, builtIn, []);
  assert.deepEqual(r.overlay, builtIn);
});

test('nothing outside the allowlist can be overridden from untracked config', () => {
  // Safety invariant 8, and the reason this is an ALLOWLIST. The first version of this fix
  // blacklisted EXPECTED_CRITICAL_PARAMS, which let through every name outside that table —
  // including RCMAP_THROTTLE, which decides which channel IS the throttle, and the two GPS
  // parameters the overlay pushes but does not verify. FRAME_CLASS=2 is Boat, which is what
  // rover3 actually ran for months while read-back reported it verified.
  const builtIn = { FRAME_CLASS: 1, SERVO3_FUNCTION: 70, RC3_TRIM: 1500 };
  const r = sanitizeParamOverlay(
    { FRAME_CLASS: 2, SERVO3_FUNCTION: 1, RCMAP_THROTTLE: 1, RC3_TRIM: 1200 }, builtIn, []);

  assert.equal(r.overlay.FRAME_CLASS, 1, 'FRAME_CLASS=2 (Boat) must be refused');
  assert.equal(r.overlay.SERVO3_FUNCTION, 70, 'remapping the throttle output must be refused');
  assert.equal(r.overlay.RC3_TRIM, 1500, 'moving throttle neutral must be refused');
  assert.ok(!('RCMAP_THROTTLE' in r.overlay),
    'RCMAP_THROTTLE is outside the built-in table and must still be refused');
  assert.equal(r.rejected.length, 4, 'every refusal must be REPORTED, not silent');
  assert.deepEqual(r.applied, []);
});

test('restating a built-in value is refused too, so ownership stays unambiguous', () => {
  // Accepting an identical restatement looks harmless and is not. The local file then appears
  // to own the parameter; when a later reviewed branch changes the built-in, that same entry
  // starts being refused while the rover runs the NEW value and the file still declares the
  // old one. Refusing on sight exposes the illegal ownership when the file is introduced.
  const r = sanitizeParamOverlay({ FRAME_CLASS: 1 }, { FRAME_CLASS: 1 }, []);
  assert.equal(r.overlay.FRAME_CLASS, 1, 'the built-in value still stands');
  assert.equal(r.rejected.length, 1, 'but the attempt to own it is reported');
});

test('a parameter the built-in overlay does not own cannot be introduced', () => {
  // Otherwise untracked config could start pushing a safety parameter with no branch or
  // review — ownership of safety configuration arriving from outside a diff.
  const r = sanitizeParamOverlay({ FS_THR_ENABLE: 1 }, { FRAME_CLASS: 1 }, []);
  assert.ok(!('FS_THR_ENABLE' in r.overlay), 'it must not reach the overlay');
  assert.equal(r.rejected.length, 1);
  assert.ok(r.rejected[0].includes('may not be introduced'), r.rejected[0]);
});

test('the shipped allowlist is empty, and that is a deliberate decision', () => {
  // If someone adds a name here, this test fails and they must say why in the diff — which
  // is the whole governance point. Every parameter the overlay pushes is output mapping,
  // failsafe timing or throttle calibration; none is safety-neutral.
  const { OVERRIDABLE_PARAMS } = require('../config-bounds.js');
  assert.equal(OVERRIDABLE_PARAMS.size, 0,
    'a name was added to OVERRIDABLE_PARAMS — justify it here and in the commit body');
});

test('the driver actually applies the sanitizer to its own overlay config', () => {
  // The consumer, not just the helper — this branch's recurring defect is a
  // correct rule with an untouched caller.
  const PWMMavproxy = require('../pwm_mavproxy_servo.js');
  const d = new PWMMavproxy({ mavproxy_autostart: false, mavproxy_param_overlay: [] });
  assert.notDeepEqual(d.paramOverlay, [], 'an array overlay reached the driver intact');
  assert.ok(Object.keys(d.paramOverlay).length > 0,
    'the driver kept an empty overlay, so it would push no critical params at all');

  const d2 = new PWMMavproxy({ mavproxy_autostart: false,
    mavproxy_param_overlay: { FRAME_CLASS: 1, JUNK: 'x' } });
  // This assertion CHANGED with the merge fix, and the old one is worth recording because
  // CLAUDE.md names its shape: it read
  //     assert.deepEqual(d2.paramOverlay, { FRAME_CLASS: 1 });
  // which ASSERTED THE DEFECT OUTRIGHT, PINNING IT — it required the driver's effective
  // overlay to be exactly one parameter. Any correct fix had to change it.
  assert.ok(!('JUNK' in d2.paramOverlay), 'a non-numeric entry must still be dropped');
  assert.equal(d2.paramOverlay.FRAME_CLASS, 1);
  for (const name of Object.keys(PWMMavproxy.DEFAULT_PARAM_OVERLAY)) {
    assert.ok(name in d2.paramOverlay,
      `${name} was dropped from the effective overlay by a one-key local override`);
  }
});

test('the driver refuses a local override of EVERY parameter it pushes, on the real path', () => {
  // The consumer, not the helper. A sanitizer that CAN protect while its caller does not ask
  // it to is exactly the "correct rule with an untouched consumer" shape CLAUDE.md names.
  //
  // This loops over every built-in name rather than checking one. An earlier version asserted
  // only FRAME_CLASS, and a reviewer killed it: mutating the driver to pass ['FRAME_CLASS']
  // left the suite green while every other parameter — including SERVO3_FUNCTION, the throttle
  // output mapping — became overridable from untracked config.
  const PWMMavproxy = require('../pwm_mavproxy_servo.js');
  const builtIn = PWMMavproxy.DEFAULT_PARAM_OVERLAY;

  for (const [name, good] of Object.entries(builtIn)) {
    const bad = good + 1;                     // any different finite value
    const d = new PWMMavproxy({ mavproxy_autostart: false,
      mavproxy_param_overlay: { [name]: bad } });
    assert.equal(d.paramOverlay[name], good,
      `untracked config overrode ${name} to ${bad} and the driver accepted it`);
    // ...and it must not have taken the rest of the set down with it.
    for (const other of Object.keys(builtIn)) {
      assert.ok(other in d.paramOverlay,
        `overriding ${name} dropped ${other} from the effective overlay`);
    }
  }
});

test('the driver keeps the SANITIZER result, not its own copy of the defaults', () => {
  // A latent defect that no straightforward test can see. With OVERRIDABLE_PARAMS empty, the
  // sanitizer's output is always exactly {...DEFAULT_PARAM_OVERLAY}, so replacing
  // `this.paramOverlay = overlayCheck.overlay` with a fresh clone of the defaults is
  // behaviourally IDENTICAL today — and silently wrong the moment the allowlist gains a name.
  // A reviewer found that mutation surviving.
  //
  // So this test temporarily allowlists a probe name to make the two distinguishable. It
  // mutates the exported Set and restores it in a finally, which is the only seam available
  // without letting untracked config choose its own allowlist — the very thing being prevented.
  const { OVERRIDABLE_PARAMS } = require('../config-bounds.js');
  const PWMMavproxy = require('../pwm_mavproxy_servo.js');
  const PROBE = 'ZZ_PROBE';
  assert.ok(!OVERRIDABLE_PARAMS.has(PROBE), 'precondition: the probe is not already allowed');

  OVERRIDABLE_PARAMS.add(PROBE);
  try {
    const d = new PWMMavproxy({ mavproxy_autostart: false,
      mavproxy_param_overlay: { [PROBE]: 5 } });
    assert.equal(d.paramOverlay[PROBE], 5,
      'the driver discarded the sanitizer result and used its own copy of the defaults');
    assert.equal(d.paramOverlay.FRAME_CLASS, PWMMavproxy.DEFAULT_PARAM_OVERLAY.FRAME_CLASS,
      'and the built-in set must still be merged underneath');
  } finally {
    OVERRIDABLE_PARAMS.delete(PROBE);
  }
  assert.ok(!OVERRIDABLE_PARAMS.has(PROBE), 'the probe must not leak into other tests');
});

test('the effective overlay is transmitted in full, with the right VALUES', async () => {
  // The DOWNSTREAM consumer. Mutations survived earlier versions of this branch because nothing
  // checked transmission: replacing `this.paramOverlay = overlayCheck.overlay` with a fresh clone
  // of DEFAULT_PARAM_OVERLAY, and making applyParamOverlay() iterate DEFAULT_PARAM_OVERLAY.
  //
  // A reviewer then showed a NARROWER mutation also survived, because the previous version of this
  // test used a two-key fixture and only compared NAMES:
  //     if (name === 'SERVO3_FUNCTION') return;      // skip one parameter
  //     ...or send SERVO3_FUNCTION with value 26 instead of 70
  // Either leaves the throttle output unmapped or mapped to GroundSteering on a replacement board
  // while read-back reports a mismatch that gates nothing. So this now drives the REAL built-in
  // table and asserts every name AND every value that reached the wire.
  const PWMMavproxy = require('../pwm_mavproxy_servo.js');
  const { overlayChainMs } = require('../config-bounds.js');
  const d = new PWMMavproxy({ mavproxy_autostart: false });

  // Validate the WHOLE FRAME, not just two fields. A reviewer showed the previous version
  // accepted protocol-invalid and wrongly-ordered PARAM_SET packets: it read offsets out of any
  // buffer whose byte 5 was 23, so a frame with a broken CRC, a wrong declared length, or the
  // entries emitted in the wrong order all passed. On this platform the order is load-bearing —
  // RC_OVERRIDE_TIME is deliberately FIRST because until it lands ArduPilot sits on its 3.0 s
  // default while picar is already streaming overrides.
  const sent = new Map();
  const order = [];
  const badFrames = [];
  let lastSeq = null;
  const bad = (m) => badFrames.push(m);
  d.sendPacket = (buf) => {
    if (buf[0] !== 0xFE) { bad(`magic 0x${buf[0].toString(16)}`); return true; }
    const payloadLen = buf[1];
    const msgId = buf[5];
    if (msgId !== 23) return true;                       // not a PARAM_SET
    if (payloadLen !== 23) bad(`PARAM_SET declared length ${payloadLen}, expected 23`);
    if (buf.length !== 6 + payloadLen + 2) {
      bad(`frame is ${buf.length} bytes, expected ${6 + payloadLen + 2}`);
    }
    // Reseal and compare: a frame the flight controller would discard is not a frame that was
    // "sent", and nothing here would otherwise notice a corrupt one.
    let crc = PWMMavproxy.crc16(buf.subarray(1, 6 + payloadLen), 5 + payloadLen);
    crc = PWMMavproxy.crcAccumulate(168, crc);           // PARAM_SET CRC_EXTRA
    if (crc !== buf.readUInt16LE(6 + payloadLen)) bad('PARAM_SET CRC mismatch');
    // ADDRESSING, TYPE and SEQUENCE. A cross-family red team found four mutations surviving a
    // version of this hook that checked only magic/length/CRC/name/value/order — every one of
    // them produces a frame that is structurally perfect and correctly sealed, so the CRC reseal
    // above cannot catch them: it reseals over whatever bytes are present.
    if (buf[10] !== 1) bad(`target_system is ${buf[10]}, expected 1 — addressed to the wrong vehicle`);
    if (buf[11] !== 1) bad(`target_component is ${buf[11]}, expected 1`);
    // param_type at payload offset 22, i.e. buffer offset 28. PX4 and ArduPilot BOTH interpret
    // the param_value union according to this byte, so a wrong type silently reinterprets the
    // float's bits as an integer — the value arrives, wrong, with nothing rejecting it.
    if (buf[28] !== 9) bad(`param_type is ${buf[28]}, expected 9 (MAV_PARAM_TYPE_REAL32)`);
    // Sequence must advance, or a receiver's duplicate/gap detection sees one repeated frame.
    if (lastSeq !== null && buf[2] === lastSeq) bad(`seq did not advance (stuck at ${buf[2]})`);
    lastSeq = buf[2];

    const name = buf.subarray(12, 28).toString('ascii').replace(/\0+$/, '');
    sent.set(name, buf.readFloatLE(6));
    order.push(name);
    return true;
  };

  const expected = { ...PWMMavproxy.DEFAULT_PARAM_OVERLAY, ZZ_PROBE: 5 };
  d.paramOverlay = expected;                       // ZZ_PROBE is NOT in the built-in table
  d.applyParamOverlay();

  // Drain the write chain deterministically. overlayChainMs takes COUNTS, not the object — an
  // earlier version passed the object, which coerced to 0 and produced an accidental 500 ms wait
  // while writes continued for seconds. Awaiting rather than asserting inside a setTimeout also
  // means a failed assertion REJECTS instead of leaving the promise pending: that version could
  // report HANG instead of a failure under mutation, which is the trap this repo keeps hitting.
  const criticalCount = Object.keys(PWMMavproxy.EXPECTED_CRITICAL_PARAMS).length;
  await new Promise((r) => setTimeout(r, overlayChainMs(Object.keys(expected).length, criticalCount) + 200));
  d.clearOverlayTimers();
  if (d.overlayReassertTimer) clearTimeout(d.overlayReassertTimer);

  assert.deepEqual(badFrames, [],
    `malformed PARAM_SET frames were accepted: ${badFrames.join('; ')}`);
  for (const [name, value] of Object.entries(expected)) {
    assert.ok(sent.has(name),
      `${name} was in the effective overlay but never transmitted; sent: ${[...sent.keys()].join(', ')}`);
    assert.ok(Math.abs(sent.get(name) - value) < 1e-6,
      `${name} was transmitted as ${sent.get(name)}, expected ${value}`);
  }
  assert.equal(sent.size, Object.keys(expected).length,
    `exactly the effective overlay must be sent; got ${[...sent.keys()].join(', ')}`);

  // ORDER, not just membership. RC_OVERRIDE_TIME first is a safety decision with its own
  // comment in the driver; writes are spaced 250 ms apart, so demoting it to seventh puts the
  // flight controller on a 3.0 s stale-override window for ~1500 ms after every connect while
  // picar is already streaming overrides.
  assert.deepEqual(order, Object.keys(expected),
    `PARAM_SETs were transmitted out of order.\n  expected: ${Object.keys(expected).join(', ')}` +
    `\n  actual:   ${order.join(', ')}`);
  assert.equal(order[0], 'RC_OVERRIDE_TIME',
    'RC_OVERRIDE_TIME must be written FIRST — until it lands the FC is on its 3.0 s default');
});

// ── The overlay and the expectation must agree, and must say Rover ────────────

test('every verified expectation matches what the overlay actually pushes', () => {
  // The read-back exists to catch a flight controller that silently rejected
  // PARAM_SET. If EXPECTED_CRITICAL_PARAMS disagrees with DEFAULT_PARAM_OVERLAY the
  // check inverts: it reports a correctly-applied parameter as a mismatch, or —
  // what actually happened — both tables agree on a WRONG value and the read-back
  // rubber-stamps it.
  const PWMMavproxy = require('../pwm_mavproxy_servo.js');
  const overlay  = PWMMavproxy.DEFAULT_PARAM_OVERLAY;
  const expected = PWMMavproxy.EXPECTED_CRITICAL_PARAMS;
  for (const [name, want] of Object.entries(expected)) {
    assert.ok(name in overlay,
      `${name} is verified but never pushed — the read-back can only ever confirm ` +
      'whatever the flight controller already held');
    assert.equal(overlay[name], want,
      `${name}: the overlay pushes ${overlay[name]} but the read-back expects ${want}`);
  }
});

test('FRAME_CLASS is 1 (Rover), not 2 (Boat)', () => {
  // ArduRover FRAME_CLASS: 0=Undefined, 1=Rover, 2=Boat, 3=BalanceBot. The vehicle
  // profile is ArduRover. Pushing 2 configured every rover as a boat, and because
  // the expectation was also 2, telemetry reported params verified and the status
  // bar read 'FC: ok' throughout.
  const PWMMavproxy = require('../pwm_mavproxy_servo.js');
  assert.equal(PWMMavproxy.DEFAULT_PARAM_OVERLAY.FRAME_CLASS, 1);
  assert.equal(PWMMavproxy.EXPECTED_CRITICAL_PARAMS.FRAME_CLASS, 1);
});
