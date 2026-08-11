'use strict';
// End-to-end drive of the real Socket.IO control surface, using only Node built-ins.
//
// Run ON the rover: node test/on-target/control-e2e.js
//
// The rover installs with `npm ci --omit=dev`, so socket.io-client is not available
// there. This speaks Engine.IO v4 over HTTP long-polling directly, which is enough to
// exercise every server handler the browser uses. It drives the same events socket.html
// emits: arm, fromclient, setDrivetrain, disarm — and then stops sending so the input
// watchdog fires on its own.
//
// SAFETY: ASSUME THE VEHICLE CAN MOVE. An earlier version of this header asserted
// "rover3 has no flight battery connected, so nothing can actuate" — that was false, a
// pack is installed, and a sibling probe commanded 60% reverse on the strength of it.
//
// This script therefore refuses to run at all if a battery is detected, unless the
// operator explicitly opts in. It commands steering and a drivetrain change, and holds
// throttle at ZERO throughout — but steering a live vehicle still moves the wheels, and
// the drivetrain step shifts a real gearbox.

const https = require('https');

const HOST = '127.0.0.1';
// Overridable ONLY so a host test can point this at a closed port and prove the entry point
// still executes. It is inert otherwise: this script is meant to run on the rover against its
// own picar. Do not use it to aim the script at another machine.
const PORT = Number(process.env.PICAR_E2E_PORT) || 8443;
const BASE = `/socket.io/?EIO=4&transport=polling`;

function req(method, path, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host: HOST, port: PORT, path, method,
      rejectUnauthorized: false,
      headers: body ? { 'Content-Type': 'text/plain;charset=UTF-8',
                        'Content-Length': Buffer.byteLength(body) } : {} },
      (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
        // A response that starts and never ends is not a settled promise. Without this the
        // safety gate below could hang forever waiting for /status, and a hang is NOT a
        // fail-closed result — it is neither a refusal nor an authorisation.
        res.on('aborted', () => reject(new Error('response aborted')));
      });
    r.on('error', reject);
    // Opt-in, because Engine.IO long-polling legitimately holds a GET open for ~25 s. Only
    // the one-shot requests that must not hang pass a timeout.
    if (opts.timeoutMs) {
      r.setTimeout(opts.timeoutMs, () => {
        r.destroy(new Error(`request timed out after ${opts.timeoutMs} ms`));
      });
    }
    if (body) r.write(body);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// Engine.IO packets arrive concatenated, separated by \x1e.
function parsePackets(raw) {
  return raw.split('\x1e').filter(Boolean);
}

const seen = [];   // every socket.io event the server sent us
const acks = {};   // ackId -> the server's reply to a request we made

function absorb(raw) {
  for (const p of parsePackets(raw)) {
    if (p.startsWith('42')) {
      // 42["name",payload] or 42<ackId>["name",payload]
      const br = p.indexOf('[');
      try {
        const [name, payload] = JSON.parse(p.slice(br));
        seen.push({ name, payload });
      } catch { /* non-JSON frame, ignore */ }
    } else if (p.startsWith('43')) {
      // 43<ackId>[result] — the reply to a request that supplied a callback. The
      // handlers return {ok:false,error:...} this way and log nothing, so without
      // reading acks a rejected request looks identical to one that never arrived.
      const br = p.indexOf('[');
      const id = p.slice(2, br);
      try { acks[id] = JSON.parse(p.slice(br))[0]; } catch { /* ignore */ }
    }
  }
}

let ackSeq = 0;
// Emit with an acknowledgement callback and wait for the server's reply.
async function emitWithAck(P, name, payload, waitMs = 1500) {
  const id = String(++ackSeq);
  await req('POST', P, `42${id}` + JSON.stringify([name, payload]));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && acks[id] === undefined) {
    absorb((await req('GET', P)).body);
  }
  return acks[id];
}

// This script commands steering, arming and a drivetrain change, so it may only run with
// EXPLICIT authorisation. The battery is read for the RECORD, never for the DECISION.
//
// It used to decide. The rule was `voltageV > 3` means a pack is connected, refuse; anything
// else, `return` and command motion. The comment above it claimed the opposite — "Fails
// CLOSED ... 'I could not tell' must never read as 'it is safe'" — and the code did the exact
// reverse one line later.
//
// That inverted on real hardware. rover3's analog voltage sense is broken: /status reports
// voltageV 0.007 while currentA reports 0.54, which cannot both be true (BATT_MONITOR=4,
// BATT_VOLT_PIN=8, BATT_VOLT_MULT=18.18). 0.007 is not > 3, so the guard concluded "no pack"
// and OPENED the motion gate with no flag required — on a vehicle with a pack installed, armed
// continuously, whose flight controller refuses DISARM. A dead sensor read as a safety
// certificate. That is the same reasoning error as the 2026-08-05 throttle probe, which
// commanded -0.6 for 1.5 s three times on the strength of a false premise, only reached
// through a broken reading rather than a stale comment.
//
// So the decision is now the flag and nothing else, and CLAUDE.md says so directly:
// "Committed on-target scripts must refuse to command motion by default and require an
// explicit opt-in flag." A reading cannot authorise motion, because no reading can prove the
// vehicle is safe — an absent pack and a failed monitor are indistinguishable from here.
// Returns TRUE only if motion is authorised. It does NOT exit the process: the caller selects
// which sections run, so a routine run still performs every read-only check.
//
// An earlier version called process.exit(3) here and the caller discarded the return value. A
// reviewer showed that was the untouched-consumer shape again: every test injected a NON-FATAL
// exit, so the production fatal path was never exercised, and a plausible refactor to
// `process.exitCode = c` left all six tests green while an unflagged run armed the vehicle and
// exited zero. Making the decision the caller's branch means there is no seam to weaken.
// `--allow-motion` must be an EXACT argv token, and must not be honoured after the conventional
// `--` option terminator. process.argv.includes() satisfies neither: a wrapper invoking
// `node control-e2e.js -- "$label"` with a label that happens to be `--allow-motion` would
// authorise motion from positional data. Exported so the parsing is pinned by tests rather than
// assumed — a mutation to startsWith() would also accept `--allow-motion=false`.
function motionFlagGiven(argv) {
  const args = argv.slice(2);
  const end  = args.indexOf('--');
  const opts = end === -1 ? args : args.slice(0, end);
  return opts.includes('--allow-motion');
}

// An ABSOLUTE deadline, not a socket-inactivity timeout. `r.setTimeout` fires only after N ms of
// no traffic, so a /status response trickling one byte every 4 s postpones it forever and the
// gate hangs — neither a refusal nor an authorisation. Applied around the request the gate makes
// so an injected never-settling request still proves the deadline exists.
function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      // Deliberately NOT unref'd. An unref'd timer does not hold the event loop open, so when the
      // awaited promise never settles Node exits before the deadline can fire — which made a
      // whole test file report "not ok" with "fail 0" (the process leaving early), not a failure.
      // The timer is cleared by the .finally() above whenever the promise does settle.
      timer = setTimeout(() => reject(new Error(`${what} exceeded its ${ms} ms deadline`)), ms);
    }),
  ]);
}

async function assertSafeToCommand(allowMotion, deps = {}) {
  const request = deps.req || req;
  const say     = deps.log || ((m) => console.log(m));

  // Reported, not consulted. A throw, a timeout, a non-200 or a nonsense value must not be able
  // to change the outcome — which is why every path here only ever produces a STRING.
  let reading = 'absent from /status';
  try {
    // 5 s absolute, so a picar that accepts the connection and then answers slowly — or never —
    // cannot hang the gate. The per-request timeoutMs stays as socket-level defence in depth.
    const res = await withDeadline(
      request('GET', '/status', null, { timeoutMs: 5000 }), 5000, 'GET /status');
    if (res.status !== 200) {
      // A 503 carrying stale-but-valid JSON is not a current battery record.
      reading = `unavailable (HTTP ${res.status})`;
    } else {
      const parsed = JSON.parse(res.body);
      const b = parsed.telemetry && parsed.telemetry.battery;
      if (b) {
        reading = `${b.voltageV} V, ${b.currentA} A, ${b.remainingPct}% (${b.pctSource})`;
        // Same 3.0-30.0 V window telemetry.sh uses at its own plausibility check. Both bounds
        // matter: a mis-scaled 40 V reading is as untrustworthy as 0.007. `typeof` is checked
        // because `"7.905"` as a string violates the telemetry schema and would otherwise be
        // coerced into looking plausible.
        const v = b.voltageV;
        const plausible = typeof v === 'number' && Number.isFinite(v) && v > 3 && v < 30;
        if (!plausible) {
          reading += ' — IMPLAUSIBLE, the monitor is untrustworthy; this proves nothing about ' +
                     'the pack in either direction';
        }
      }
    }
  } catch (err) {
    reading = `unavailable (${err.message})`;
  }

  if (allowMotion) {
    say('WARNING: --allow-motion was given, so this script WILL arm the vehicle and command');
    say('  steering and a drivetrain change. THE WHEELS CAN TURN.');
    say(`  battery: ${reading}`);
    say('  This flight controller refuses DISARM, so an independent physical stop — supports,');
    say('  or drive power isolated — is the only thing that will stop it.\n');
    return true;
  }

  say('MOTION NOT AUTHORISED: --allow-motion was not given, so the arm, steering, drivetrain');
  say('  and watchdog checks are SKIPPED BY DESIGN. Every read-only check still runs.');
  say(`  battery: ${reading}`);
  say('  This is not a failure. A routine validation run is not supposed to command motion.');
  say('  Re-run with --allow-motion ONLY with an operator present and the vehicle physically');
  say('  safe to drive. Do not decide that from the battery reading above.\n');
  return false;
}

// Exported so the motion gate can be driven by a host test. `npm test` runs only
// test/*.test.js, so this file is never executed as a unit test — but requiring it must still
// not run the suite, or a host test importing the guard would arm a rover as a side effect.
// That exact hazard was live for two commits on the telemetry branch (see HANDOFF.md).
// Invariant 7, enforced locally. The observed telemetry decides whether the flight controller is
// in a state worth commanding: every critical parameter verified, the driver reporting flight-
// controller support, and telemetry actually arriving.
//
// Without this, --allow-motion overrode known-bad hardware state: the read-only checks would
// detect params.missing=["FRAME_CLASS"] or fcSupported:false, record a FAILURE, and then arm
// anyway. Wrong parameters are precisely what routes steering onto the throttle output, so the
// one state in which commanding is least safe was the one the flag waved through.
//
// Production does NOT gate arming this way (that is the open invariant-7 P0). This script can at
// least refuse to be the thing that arms a misconfigured vehicle.
function hardwareReadyForMotion(telemetryFrame, expectedNames) {
  if (!telemetryFrame) return { ready: false, why: 'no telemetry frame was received' };
  const t = telemetryFrame;
  const p = t.params;

  // The EXPECTED INVENTORY, not just an empty missing[]. An earlier version treated
  // `missing: []` as positive proof, so a frame carrying
  // `{missing: [], verified: [], mismatched: {}}` returned ready with ZERO parameters
  // verified — "nothing is missing" is trivially true of an empty expectation. A stale
  // service, a schema change, or an emptied EXPECTED_CRITICAL_PARAMS would then authorise
  // commands without ever proving the output mapping that stops steering driving throttle.
  // The names come from the driver itself so the two cannot drift.
  const want = Array.isArray(expectedNames) && expectedNames.length
    ? expectedNames
    : Object.keys(require('../../pwm_mavproxy_servo.js').EXPECTED_CRITICAL_PARAMS);

  // A LIVE LINK AND A FRESH AUTOPILOT HEARTBEAT, checked first. Invariant 7 names both, and an
  // earlier version of this function checked neither — it looked only at parameters, so the
  // recorded MAVProxy wedge would have passed it: the TCP socket stays open (linkUp true) and
  // previously-verified parameters persist, while nothing is reaching the flight controller.
  // `--allow-motion` would then queue force-ARM, steering and drivetrain packets into a dead
  // link, and if MAVProxy resumed they would arrive at a continuously-armed rover.
  if (t.linkUp !== true) {
    return { ready: false, why: `linkUp is ${JSON.stringify(t.linkUp)} — no link to MAVProxy` };
  }
  if (t.autopilotHeartbeat !== true) {
    return { ready: false, why: 'no fresh autopilot heartbeat — the link may be wedged even ' +
                               'though the socket is open' };
  }
  // `!== true`, not `=== false`: an absent field must not read as supported.
  if (t.fcSupported !== true) {
    return { ready: false, why: `fcSupported is ${JSON.stringify(t.fcSupported)}, not true` };
  }
  if (!p || !Array.isArray(p.missing) || !Array.isArray(p.verified)) {
    return { ready: false, why: 'telemetry carries no usable params block' };
  }
  if (p.missing.length) {
    return { ready: false, why: `unverified critical parameters: ${JSON.stringify(p.missing)}` };
  }
  // MISMATCHED is independent of MISSING: a parameter can be read back with the WRONG value,
  // which is how rover3 ran as a boat while read-back reported it verified. A non-object here
  // is refused rather than skipped — `Object.keys("x")` is truthy-length nonsense.
  const mm = p.mismatched;
  if (mm === undefined || mm === null || typeof mm !== 'object' || Array.isArray(mm)) {
    return { ready: false, why: `params.mismatched is ${JSON.stringify(mm)}, not an object` };
  }
  if (Object.keys(mm).length) {
    return { ready: false, why: `mismatched critical parameters: ${JSON.stringify(mm)}` };
  }
  // EVERY expected name must actually appear in verified.
  const absent = want.filter((n) => !p.verified.includes(n));
  if (absent.length) {
    return { ready: false,
             why: `${absent.length} of ${want.length} expected parameters are not verified: ` +
                  JSON.stringify(absent) };
  }
  return { ready: true,
           why: `all ${want.length} expected critical parameters verified, link up` };
}

module.exports = { assertSafeToCommand, motionFlagGiven, withDeadline, hardwareReadyForMotion };

if (require.main === module) (async () => {
  let failed = 0;
  let skipped = 0;
  // The decision is BRANCHED ON, not discarded. Deleting this assignment, or ignoring it, makes
  // the motion sections unreachable rather than unguarded — the failure direction that is safe.
  const motionAuthorised = await assertSafeToCommand(motionFlagGiven(process.argv));
  const ok  = (m) => log(`  PASS ${m}`);
  const bad = (m) => { log(`  FAIL ${m}`); failed = 1; };
  const skip = (m) => { log(`  SKIP ${m}`); skipped++; };

  // ── Handshake ──────────────────────────────────────────────────────────────
  log('\n== Socket.IO handshake ==');
  const hs = await req('GET', BASE);
  if (hs.status !== 200) return bad(`handshake HTTP ${hs.status}`), process.exit(1);
  const open = parsePackets(hs.body).find((p) => p.startsWith('0'));
  const sid = JSON.parse(open.slice(1)).sid;
  ok(`handshake, sid=${sid.slice(0, 8)}…`);
  const P = `${BASE}&sid=${encodeURIComponent(sid)}`;

  await req('POST', P, '40');                      // connect to the default namespace
  absorb((await req('GET', P)).body);
  ok('namespace connected');

  // The server pushes these to a joining socket. They are the initial UI state.
  const got = (n) => seen.find((e) => e.name === n);
  for (const n of ['streamConfig', 'telemetryConfig', 'telemetry']) {
    got(n) ? ok(`received ${n} on connect`) : bad(`no ${n} on connect`);
  }

  const tcfg = got('telemetryConfig');
  if (tcfg) {
    log(`  ---- telemetryConfig: ${JSON.stringify(tcfg.payload)}`);
    if (Number.isFinite(tcfg.payload.telemetryIntervalMs)) {
      ok(`telemetryIntervalMs published (${tcfg.payload.telemetryIntervalMs} ms) — the UI ` +
         'derives its staleness window from this');
    } else {
      bad('telemetryConfig has no telemetryIntervalMs; the UI would use its 3 s floor');
    }
  }

  const t0 = got('telemetry');
  if (t0) {
    const p = t0.payload;
    log(`  ---- telemetry: linkUp=${p.linkUp} hb=${p.autopilotHeartbeat} ` +
        `batt=${p.battery && p.battery.voltageV}V pct=${p.battery && p.battery.remainingPct}` +
        `(${p.battery && p.battery.pctSource}) board=${p.power && p.power.boardV}V ` +
        `servo=${p.power && p.power.servoV}V wifi=${p.wifi && p.wifi.qualityPct}%`);
    if (p.params && Array.isArray(p.params.missing)) {
      p.params.missing.length === 0
        ? ok(`params.missing empty, ${p.params.verified.length} verified — the FC indicator ` +
             'will render FC: ok')
        : bad(`params.missing=${JSON.stringify(p.params.missing)}`);
    } else bad('telemetry carries no params block');
    if (p.fcSupported === false) bad('mavproxy driver reported fcSupported:false');
  }

  // ── Motion sections. Need BOTH the operator's flag AND a verified flight controller ──
  //
  // Re-read /status immediately before EVERY state-changing section, not once at connect. The
  // connect-time frame authorised the first ARM, twelve commands and the real setDrivetrain
  // transaction, and only the second ARM was rechecked — so the most consequential action, the
  // one that shifts a real gearbox, rode the oldest evidence. The recorded MAVProxy wedge leaves
  // Socket.IO responsive and TCP writes succeeding while nothing reaches the flight controller,
  // so a frame seconds old is not evidence of anything now. Per-section rather than per-command:
  // the bursts are bounded, and per-command HTTP latency would change what is being measured.
  let linkLost = false;
  const stillReady = async (label) => {
    if (!motionAuthorised) return false;
    // Once a re-check has failed, STAY refused. Re-polling a wedged link section by section
    // could let a transient recovery re-authorise actuation mid-run, and the sections after a
    // failure (the drivetrain probes, disarm, setLight) were still reaching the wire.
    if (linkLost) { log(`  REFUSING ${label}: the link was already lost earlier this run`); return false; }
    try {
      const fresh = JSON.parse((await req('GET', '/status', null, { timeoutMs: 5000 })).body);
      const r = hardwareReadyForMotion(fresh.telemetry);
      if (!r.ready) {
        log(`\n  REFUSING ${label}: ${r.why}`);
        failed = 1; linkLost = true;
      }
      return r.ready;
    } catch (e) {
      log(`\n  REFUSING ${label}: could not re-read /status (${e.message})`);
      failed = 1; linkLost = true;
      return false;
    }
  };

  const hw = hardwareReadyForMotion(t0 && t0.payload);
  const mayCommandMotion = motionAuthorised && hw.ready;
  if (motionAuthorised && !hw.ready) {
    log(`\n  REFUSING MOTION DESPITE --allow-motion: ${hw.why}.`);
    log('  Commanding a vehicle whose critical parameters are unverified is how steering ends');
    log('  up driving the throttle output. Fix the flight-controller state first.');
    failed = 1;
  }
  if (!mayCommandMotion) {
    log('\n== Arm and drive == SKIPPED (motion not authorised)');
    skip('arm / 12 fromclient commands');
    log('== setDrivetrain == SKIPPED (motion not authorised)');
    skip('setDrivetrain validation and shift=1');
    log('== Operator stop (disarm) == SKIPPED (motion not authorised)');
    skip('disarm');
    log('== Input watchdog == SKIPPED (motion not authorised)');
    skip('input watchdog expiry');
  } else {
  // ── Arm, then drive ────────────────────────────────────────────────────────
  log('\n== Arm and drive ==');
  if (!await stillReady('THE FIRST ARM')) {
    skip('arm / 12 fromclient commands (hardware no longer ready)');
  } else {
  await req('POST', P, '42' + JSON.stringify(['arm']));
  await sleep(400);
  absorb((await req('GET', P)).body);
  ok('arm sent');

  // Throttle stays at 0 throughout. Not because the vehicle cannot move — it can — but
  // because proving the command path never requires commanding drive.
  for (let i = 0; i < 12; i++) {
    await req('POST', P, '42' + JSON.stringify(['fromclient',
      { throttle: 0, steering: i < 4 ? 0 : 0.5 }]));
    await sleep(80);
  }
  ok('12 fromclient commands sent (throttle 0, steering 0 -> 0.5)');
  }   // end first-arm readiness re-check

  // ── Drivetrain change ─────────────────────────────────────────────────────
  log('\n== setDrivetrain ==');
  if (!await stillReady('THE DRIVETRAIN SECTION')) {
    skip('setDrivetrain validation and shift=1 (hardware no longer ready)');
  } else {
  // A two-position actuator has no valid middle. 0 is called out because it is what a
  // zero-coerced or omitted field looks like, and it scales to the 1500us mid-travel
  // position that jams a shift fork.
  for (const badValue of ['low', 0, 0.5, null]) {
    const r = await emitWithAck(P, 'setDrivetrain', { shift: badValue });
    if (r && r.ok === false) ok(`shift=${JSON.stringify(badValue)} rejected: ${r.error}`);
    else bad(`shift=${JSON.stringify(badValue)} was NOT rejected (reply ${JSON.stringify(r)})`);
  }
  const empty = await emitWithAck(P, 'setDrivetrain', {});
  (empty && empty.ok === false) ? ok(`empty request rejected: ${empty.error}`)
                                : bad(`empty request not rejected (${JSON.stringify(empty)})`);

  // Now a real endpoint — this SHIFTS A REAL GEARBOX. Note a client-side precheck cannot close
  // the race against the 1 s settle dwell; only the server handler revalidating heartbeat
  // freshness immediately before actuating would, and that is production work tracked separately.
  const good = await emitWithAck(P, 'setDrivetrain', { shift: 1 }, 6000);
  (good && good.ok === true) ? ok(`shift=1 applied: ${JSON.stringify(good)}`)
                             : bad(`shift=1 was not applied (reply ${JSON.stringify(good)})`);
  await sleep(500);
  absorb((await req('GET', P)).body);
  }   // end drivetrain section readiness re-check

  // ── Operator stop ─────────────────────────────────────────────────────────
  log('\n== Operator stop (disarm) ==');
  if (linkLost) {
    skip('disarm (the link was lost earlier this run)');
  } else {
  await req('POST', P, '42' + JSON.stringify(['disarm']));
  await sleep(600);
  absorb((await req('GET', P)).body);
  ok('disarm sent');
  }

  // ── Watchdog: re-arm, send one command, then go silent ────────────────────
  // RE-CHECK before arming a second time. The gate above was decided from ONE telemetry frame
  // captured at connect, and this script has since spent seconds arming, driving and shifting.
  // A snapshot that was healthy then can be stale now — the link can wedge mid-run with the
  // socket still open — so a second ARM must not ride on the first decision.
  log('\n== Input watchdog (re-arm, one command, then silence) ==');
  if (!await stillReady('THE SECOND ARM')) {
    skip('input watchdog expiry (hardware no longer ready)');
  } else {
  await req('POST', P, '42' + JSON.stringify(['arm']));
  await sleep(300);
  await req('POST', P, '42' + JSON.stringify(['fromclient', { throttle: 0, steering: 0.25 }]));
  log('  ---- going silent; input_timeout_ms is 1000, waiting 3 s');
  await sleep(3000);
  absorb((await req('GET', P)).body);
  // NOTE: this only proves the window elapsed. It does NOT prove the watchdog fired — `ok()` is
  // an unconditional print. Asserting that STEERING returns to 0 via GET /status is the fix,
  // and it is tracked separately in TASKS.md rather than bundled into this branch.
  ok('watchdog window elapsed');
  }   // end second-arm readiness re-check
  } // end motion sections

  // ── Light control (main already carries this feature) ─────────────────────
  // GATED, though it commands no motion. An earlier version ran this unconditionally and called
  // the result "read-only" — it is not: it drives RC channel 6 and leaves the light OFF, so a
  // routine validation on a rover working in darkness would switch its lamp off and report
  // nothing amiss. A check that changes vehicle state is not read-only whatever it changes.
  if (!mayCommandMotion || linkLost) {
    log('\n== setLight == SKIPPED (changes vehicle state; not authorised or link lost)');
    skip('setLight on/off');
  } else {
  log('\n== setLight ==');
  await req('POST', P, '42' + JSON.stringify(['setLight', true]));
  await sleep(300);
  await req('POST', P, '42' + JSON.stringify(['setLight', false]));
  await sleep(300);
  absorb((await req('GET', P)).body);
  ok('setLight on/off sent');
  }

  // ── Telemetry keeps flowing on a live socket ──────────────────────────────
  log('\n== Telemetry broadcast on a live socket ==');
  const before = seen.filter((e) => e.name === 'telemetry').length;
  await sleep(2500);
  absorb((await req('GET', P)).body);
  const after = seen.filter((e) => e.name === 'telemetry').length;
  after > before
    ? ok(`telemetry frames kept arriving (${before} -> ${after})`)
    : bad(`no new telemetry frames in 2.5 s (${before} -> ${after}) — the publish loop is not broadcasting`);

  // Compare two frames to prove the readings are live, not a repeated snapshot.
  const frames = seen.filter((e) => e.name === 'telemetry').map((e) => e.payload);
  if (frames.length >= 2) {
    const a = frames[0].battery, b = frames[frames.length - 1].battery;
    if (a && b && a.ageMs !== undefined && b.ageMs !== undefined) {
      ok(`battery ageMs differs across frames (${a.ageMs} vs ${b.ageMs}) — live, not a snapshot`);
    }
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  log('\n== Disconnect ==');
  await req('POST', P, '41');   // socket.io namespace disconnect
  ok('disconnect sent');

  log('\n== Events received, by type ==');
  const counts = {};
  for (const e of seen) counts[e.name] = (counts[e.name] || 0) + 1;
  for (const [k, v] of Object.entries(counts).sort((x, y) => y[1] - x[1])) {
    log(`  ${k} x${v}`);
  }
  // THREE outcomes, not two, and the middle one must not be mistakable for either.
  //
  // A bare "E2E PASSED" after skipping the motion sections is the exact defect 3e9103e fixed on
  // another runner: reporting success for checks that never ran. But labelling it FAILED is also
  // wrong — nothing failed, and a permanent failure invites someone to add --allow-motion to
  // package.json and normalise commanding motion during routine validation.
  //
  // So an incomplete run says INCOMPLETE and exits 4. It cannot satisfy a validation gate looking
  // for a pass, and it cannot be read as a defect either. Exit 0 is reserved for a run that
  // actually exercised the control path.
  const INCOMPLETE = 4;
  if (failed) {
    log('\nE2E FAILED');
    process.exit(1);
  } else if (skipped) {
    log(`\nE2E INCOMPLETE — ${skipped} check group(s) SKIPPED because motion was not ` +
        'authorised. The read-only checks above passed. This run proves NOTHING about arm, ' +
        'steering, drivetrain, the input watchdog or the light, and must not be recorded as an ' +
        'on-target validation pass.');
    process.exit(INCOMPLETE);
  } else {
    log('\nE2E PASSED');
    process.exit(0);
  }
})().catch((e) => { console.error('E2E ERROR', e); process.exit(2); });
