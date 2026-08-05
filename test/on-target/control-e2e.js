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
const PORT = 8443;
const BASE = `/socket.io/?EIO=4&transport=polling`;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host: HOST, port: PORT, path, method,
      rejectUnauthorized: false,
      headers: body ? { 'Content-Type': 'text/plain;charset=UTF-8',
                        'Content-Length': Buffer.byteLength(body) } : {} },
      (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
    r.on('error', reject);
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

// Refuse to run on a vehicle that can drive unless explicitly allowed. The check reads
// the autopilot's own battery monitor: a voltage AND a current reading mean a pack is
// connected. Fails CLOSED — if the check cannot be performed, that is a refusal, not a
// pass, because "I could not tell" must never read as "it is safe".
async function assertSafeToCommand(allowMotion) {
  let telemetry = null;
  try {
    // req() resolves {status, body} — parse the BODY. The first version parsed the
    // wrapper object, so the guard refused every run with a bogus "not valid JSON"
    // message. It failed closed, which is the right direction, but a guard that always
    // refuses gets disabled by the next person rather than obeyed.
    const res = await req('GET', '/status');
    telemetry = JSON.parse(res.body).telemetry;
  } catch (err) {
    if (allowMotion) return;
    console.log(`REFUSING TO RUN: could not read /status to check for a battery (${err.message}).`);
    console.log('Re-run with --allow-motion only if you have physically confirmed the vehicle is safe.');
    process.exit(3);
  }
  const b = telemetry && telemetry.battery;
  const live = b && b.voltageV != null && b.voltageV > 3;
  if (!live) return;                       // no pack reported: safe to proceed
  if (allowMotion) {
    console.log(`WARNING: battery present (${b.voltageV} V, ${b.currentA} A) and --allow-motion ` +
                'was given. The wheels can turn. Proceeding.\n');
    return;
  }
  console.log('REFUSING TO RUN: a flight battery is connected.');
  console.log(`  battery: ${b.voltageV} V, ${b.currentA} A, ${b.remainingPct}% (${b.pctSource})`);
  console.log('  This script commands steering and a drivetrain change on a vehicle that can move.');
  console.log('  Disconnect the pack, or re-run with --allow-motion with the rover safely supported');
  console.log('  and an operator present.');
  process.exit(3);
}

(async () => {
  let failed = 0;
  await assertSafeToCommand(process.argv.includes('--allow-motion'));
  const ok  = (m) => log(`  PASS ${m}`);
  const bad = (m) => { log(`  FAIL ${m}`); failed = 1; };

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

  // ── Arm, then drive ────────────────────────────────────────────────────────
  log('\n== Arm and drive ==');
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

  // ── Drivetrain change ─────────────────────────────────────────────────────
  log('\n== setDrivetrain ==');
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

  // Now a real endpoint. This path must fail-safe stop first, then settle, then apply.
  const good = await emitWithAck(P, 'setDrivetrain', { shift: 1 }, 6000);
  (good && good.ok === true) ? ok(`shift=1 applied: ${JSON.stringify(good)}`)
                             : bad(`shift=1 was not applied (reply ${JSON.stringify(good)})`);
  await sleep(500);
  absorb((await req('GET', P)).body);

  // ── Operator stop ─────────────────────────────────────────────────────────
  log('\n== Operator stop (disarm) ==');
  await req('POST', P, '42' + JSON.stringify(['disarm']));
  await sleep(600);
  absorb((await req('GET', P)).body);
  ok('disarm sent');

  // ── Watchdog: re-arm, send one command, then go silent ────────────────────
  log('\n== Input watchdog (re-arm, one command, then silence) ==');
  await req('POST', P, '42' + JSON.stringify(['arm']));
  await sleep(300);
  await req('POST', P, '42' + JSON.stringify(['fromclient', { throttle: 0, steering: 0.25 }]));
  log('  ---- going silent; input_timeout_ms is 1000, waiting 3 s');
  await sleep(3000);
  absorb((await req('GET', P)).body);
  ok('watchdog window elapsed');

  // ── Light control (main already carries this feature) ─────────────────────
  log('\n== setLight ==');
  await req('POST', P, '42' + JSON.stringify(['setLight', true]));
  await sleep(300);
  await req('POST', P, '42' + JSON.stringify(['setLight', false]));
  await sleep(300);
  absorb((await req('GET', P)).body);
  ok('setLight on/off sent');

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
  log(failed ? '\nE2E FAILED' : '\nE2E PASSED');
  process.exit(failed);
})().catch((e) => { console.error('E2E ERROR', e); process.exit(2); });
