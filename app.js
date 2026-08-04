// app.js
const fs            = require('fs');
const https         = require('https');
const { Server }    = require('socket.io');
const url           = require('url');
const static        = require('node-static');
const path          = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const configPath = path.join(__dirname, 'picar-cfg.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath));
} catch (err) {
  console.error(`Failed to read config file at ${configPath}:`, err);
  process.exit(1);
}

// Per-rover overrides live in picar-cfg.local.json (untracked; written by
// install.sh). Keeping machine-specific values like rover_id out of version
// control means the tracked picar-cfg.json can be updated / git-pulled without
// clobbering each rover's identity. Keys here shallow-override the tracked ones.
const localConfigPath = path.join(__dirname, 'picar-cfg.local.json');
if (fs.existsSync(localConfigPath)) {
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(localConfigPath)));
    console.log(`Applied local overrides from ${localConfigPath}`);
  } catch (err) {
    console.error(`Failed to read local config at ${localConfigPath}:`, err);
    process.exit(1);
  }
}
console.log(`Rover ID: ${config.rover_id ?? 1}`);

const PWMDriver = require('./pwm_servo');
const pwm = PWMDriver(config);

const fleetClient = require('./fleetmgr-client');
fleetClient.start(config);

const file = new static.Server();
const options = {
  key:  fs.readFileSync('./certs/key.pem'),
  cert: fs.readFileSync('./certs/cert.pem'),
};

// ── Video stream server (port 8081) ───────────────────────────────────────────
// Stream modules attach their request/WebSocket handlers first (inside createStream),
// then a fallback listener handles everything else as the cert-acceptance page.
const streamServer = https.createServer(options);

const createStream = require('./streams');
const stream = createStream(config, streamServer);
console.log(`Stream codec: ${(config.stream_codec || 'h264').toLowerCase()}`);

// Fallback: cert-acceptance landing page for any request not handled by the stream module
streamServer.on('request', (req, res) => {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
  res.end(`<!DOCTYPE html><html><body style="background:#111;color:#0f0;font-family:sans-serif;\
display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
    <div style="text-align:center">
      <h2>Stream Server Ready</h2>
      <p>Certificate accepted. You can close this tab.</p>
      <script>
        if (window.opener) window.opener.postMessage('stream-cert-ok', '*');
        setTimeout(() => window.close(), 1500);
      </script>
    </div>
  </body></html>`);
});

streamServer.listen(8081, '0.0.0.0');
console.log(`Video stream server: https://<ip>:8081`);

// ── Web UI + control server (port 8443) ───────────────────────────────────────
const appServer = https.createServer(options, (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'OK',
      throttle: old_throttle,
      steering: old_steering,
      telemetry: currentTelemetry(),
    }));
  } else if (parsed.pathname === '/manifest.json') {
    const roverId = config.rover_id ?? 1;
    const manifest = {
      name:             `PiCar Rover ${roverId}`,
      short_name:       `Rover ${roverId}`,
      start_url:        '/socket.html',
      display:          'fullscreen',
      orientation:      'landscape',
      background_color: '#000000',
      theme_color:      '#000000',
      icons: [
        { src: `/icons/rover${roverId}-192.png`, sizes: '192x192', type: 'image/png' },
        { src: `/icons/rover${roverId}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    };
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(JSON.stringify(manifest));
  } else {
    file.serve(req, res);
  }
});

const io = new Server(appServer);
appServer.listen(8443, '0.0.0.0');
console.log('Pi Car web server: https://<ip>:8443/socket.html');

const control_neutral  = config.control_neutral  ?? 0;
const input_timeout_ms = config.input_timeout_ms ?? 500;

let old_throttle      = control_neutral;
let old_steering      = control_neutral;
let smoothed_throttle = control_neutral;

// How long to wait after neutral+DISARM before moving a drivetrain actuator, so a
// coasting vehicle has slowed. Not a confirmed stop — see the setDrivetrain
// handler for why a timer is the honest substitute on this hardware.
const drivetrain_settle_ms = config.drivetrain_settle_ms ?? 1000;
// True while a drivetrain change is between its disarm and its actuation. Arming
// is refused in that window.
let drivetrainBusy = false;
let logcount = 0;
let lastAction = null;

const throttle_ramp_up   = 0;
const throttle_ramp_down = 0;


// ── Telemetry: battery, board power, radio link ───────────────────────────────
//
// Battery and board power come from the flight controller over MAVLink
// (SYS_STATUS / POWER_STATUS). "Radio" has two possible sources and they are not
// interchangeable:
//   - RADIO_STATUS from a SiK telemetry radio. Absent on this platform unless one
//     is fitted; the driver reports null rather than inventing a value.
//   - The Wi-Fi link carrying the control connection, read from the kernel. This
//     is the link that actually matters for teleoperation here, so it is reported
//     separately and never conflated with the MAVLink radio.
// The publish loop lives in telemetry-loop.js so its WIRING is testable, not just
// its parts. app.js binds both HTTPS ports and the MAVProxy socket at require time,
// so nothing declared here is reachable from a host test — and a round-7 review
// proved what that costs: four mutations to this loop's body (clearing the Fleet
// Manager battery bit, bypassing the interval clamp, making the /proc read
// synchronous, deleting the broadcast) all left the suite green.
//
// telemetry_interval_ms is clamped at BOTH ends inside the loop. The key is
// reachable through the untracked picar-cfg.local.json overlay, so a rover-local 0
// or a typo would otherwise become setInterval(fn, 1) — measured at ~10% of a core
// from the /proc read alone — and 1e400 is valid JSON that Node coerces to 1 ms.
const { startTelemetryLoop } = require('./telemetry-loop');

const batteryWarnLevel      = config.batteryWarnLevel ?? 20;
const batteryWarnVolts      = config.batteryWarnVolts ?? null;
// Fail closed when the battery monitor reports nothing usable. Set false only
// on a vehicle that genuinely has no battery monitor, where a permanent warning
// would be noise rather than information.
const batteryWarnOnNoReading = config.batteryWarnOnNoReading !== false;

// A voltage with no threshold to compare it against cannot ever raise a warning:
// the percentage branch has no percentage, the voltage branch has no threshold, and
// the fail-closed branch requires the voltage to be missing too. Silence here reads
// as "pack healthy" when it means "nothing is watching the pack", so say so once,
// loudly, at startup.
if (batteryWarnVolts === null && config.battery_empty_volts == null) {
  console.error('picar: no batteryWarnVolts and no battery_empty_volts/battery_full_volts — ' +
                'a flight controller that reports voltage but no usable percentage (the ' +
                'default on this fleet) can NEVER raise a battery warning. Set ' +
                'batteryWarnVolts for this pack.');
}

const telemetryLoop = startTelemetryLoop({
  getFcTelemetry: () => (typeof pwm.getTelemetry === 'function' ? pwm.getTelemetry() : {}),
  fleetClient,
  emit:     (event, payload) => io.emit(event, payload),
  readWifi: (path, enc) => fs.promises.readFile(path, enc),
  config,
  batteryWarnCfg: {
    warnLevel:       batteryWarnLevel,
    warnVolts:       batteryWarnVolts,
    warnOnNoReading: batteryWarnOnNoReading,
  },
});
const currentTelemetry = telemetryLoop.current;

io.on('connection', (socket) => {
  console.log('Control client connected');

  // Push stream config so the client sets up the right decoder
  socket.emit('streamConfig', stream.getStreamConfig());
  socket.emit('telemetryConfig', { batteryWarnLevel, batteryWarnVolts, batteryWarnOnNoReading,
    // The UI derives its staleness window from this rather than hard-coding one,
    // so a deliberately slow rover does not blank its own status bar.
    telemetryIntervalMs: telemetryLoop.intervalMs });
  socket.emit('telemetry', currentTelemetry());
  if (typeof pwm.lightIsOn === 'function') socket.emit('lightState', { on: pwm.lightIsOn() });

  socket.on('arm', () => {
    // Refuse to arm while a drivetrain change is settling. Otherwise an arm
    // arriving mid-transaction re-energises the motor while the gear actuator is
    // still moving — the exact condition this whole path exists to prevent.
    if (drivetrainBusy) {
      console.error('Refusing ARM: a drivetrain change is in progress');
      socket.emit('controlStopped', { reason: 'drivetrain-change-in-progress' });
      return;
    }
    console.log('ARM');
    if (typeof pwm.arm === 'function') pwm.arm();
  });

  // Operator stop. Goes through the fail-safe primitive so neutral is on the wire
  // before the DISARM; calling pwm.disarm() directly transmitted DISARM first and
  // left neutral waiting for the next periodic tick.
  socket.on('disarm', () => { failSafeStop('operator stop'); });

  // ── Drivetrain changes are a server-side operation, not a control field ─────
  //
  // A gear or diff-lock change moves a mechanical actuator against the
  // drivetrain, so it must never happen while the vehicle can drive. Enforcing
  // that in the browser is not enough: this control plane is unauthenticated, so
  // any client — or a second browser tab racing the first — could previously
  // send {throttle: 1, shift: -1} in one packet and shift at full throttle. The
  // gate therefore lives here, where it cannot be bypassed, and the drivetrain
  // fields have been removed from the ordinary 'fromclient' stream entirely.
  //
  // The sequence is unconditional. We do NOT trust any client's belief about
  // whether the vehicle is stopped, and we do not trust our own: the flight
  // controller can be armed from a previous session, across a picar restart, or
  // by another socket. So every drivetrain change re-asserts neutral and disarm
  // on the wire first, in that order, and only then moves the actuator.
  socket.on('setDrivetrain', (request, acknowledge) => {
    const reply = (result) => {
      if (typeof acknowledge === 'function') acknowledge(result);
      return result;
    };
    if (!request || typeof request !== 'object') {
      return reply({ ok: false, error: 'malformed drivetrain request' });
    }

    const requested = {};
    for (const name of ['shift', 'tlock_front', 'tlock_rear']) {
      const value = request[name];
      if (value === undefined) continue;
      // Two-position actuators: only the endpoints are valid positions. Anything
      // else — including 0, which is what a zero-coerced or missing field looks
      // like — would command a half-engaged gear.
      if (value !== 1 && value !== -1) {
        return reply({ ok: false, error: `${name} must be exactly 1 or -1` });
      }
      requested[name] = value;
    }
    const names = Object.keys(requested);
    if (names.length === 0) {
      return reply({ ok: false, error: 'no drivetrain channel requested' });
    }

    if (drivetrainBusy) {
      return reply({ ok: false, error: 'a drivetrain change is already in progress' });
    }

    const failSafe = failSafeStop('drivetrain change requested');
    if (!failSafe.neutralSent || !failSafe.disarmSent) {
      // The link is down, so nothing was guaranteed to reach the vehicle. Refuse
      // to move the actuator rather than moving it on an unknown-state vehicle.
      console.error('Refusing drivetrain change: neutral/disarm did not reach the link');
      return reply({ ok: false, error: 'flight controller link unavailable', failSafe });
    }

    // Neutral and DISARM are on the wire, but a rover that was moving is still
    // coasting. Shifting a mechanical gearbox against a turning driveline is what
    // grinds it, so wait before actuating.
    //
    // This is a fixed dwell, not a confirmed stop: there is no wheel encoder and
    // GPS is disabled on this vehicle (AHRS_GPS_USE=0), so zero speed cannot
    // actually be verified. A conservative timer is the honest substitute, and the
    // limitation is recorded in TASKS.md.
    drivetrainBusy = true;
    // Tell every connected controller — not just the requester — since the whole
    // vehicle just disarmed and any other tab must stop believing it is armed.
    io.emit('controlStopped', { reason: 'drivetrain-change' });
    setTimeout(() => {
      const applied = {};
      for (const name of names) {
        applied[name] = pwm.setServoPWM(name, requested[name]);
        if (!applied[name]) console.error(`Driver refused ${name}=${requested[name]}`);
      }
      drivetrainBusy = false;
      console.log(`Drivetrain change applied after ${drivetrain_settle_ms} ms settle: ` +
        `${JSON.stringify(requested)}`);
      reply({ ok: Object.values(applied).every(Boolean), applied });
    }, drivetrain_settle_ms);
  });

  // ── Light module on Pixhawk output 6 ────────────────────────────────────────
  //
  // Deliberately its OWN event, not a field on the continuous 'fromclient' stream.
  // The drivetrain fields were removed from that stream because a single packet
  // could combine motion with an actuator change; the same reasoning applies here,
  // and it also means a light toggle cannot be replayed 20 times a second.
  //
  // It does NOT go through the drivetrain neutral+disarm transaction. A light is not
  // a mechanical actuator working against the driveline — there is nothing to jam,
  // nothing to shift under load — so forcing a disarm to turn a light on would make
  // the vehicle less usable for no safety gain. It is also deliberately NOT touched
  // by failSafeStop: an operator who has just lost control wants the vehicle to stay
  // visible, so a fail-safe leaves the light exactly as it was.
  socket.on('setLight', (on, acknowledge) => {
    const reply = (result) => {
      if (typeof acknowledge === 'function') acknowledge(result);
      return result;
    };
    if (typeof on !== 'boolean') {
      return reply({ ok: false, error: 'light state must be true or false' });
    }
    if (typeof pwm.setLight !== 'function') {
      // A GPIO driver has no light channel. Say so rather than reporting success.
      return reply({ ok: false, error: 'this driver has no light channel' });
    }
    const applied = pwm.setLight(on);
    if (!applied) return reply({ ok: false, error: 'driver refused the light command' });
    console.log(`Light: ${on ? 'ON' : 'OFF'}`);
    // Tell every client, so a second tab does not show a stale button.
    io.emit('lightState', { on });
    return reply({ ok: true, on });
  });

  socket.on('setVideoParams', (params) => {
    console.log('setVideoParams:', params);
    stream.setParams(params);
    // Re-broadcast updated config to all connected clients
    setTimeout(() => io.emit('streamConfig', stream.getStreamConfig()), 600);
  });

  socket.on('fromclient', (data) => {
    logcount++;
    const throttleCmd = Number.isFinite(data.throttle)
      ? Math.max(-1, Math.min(1, data.throttle)) : control_neutral;
    const steeringCmd = Number.isFinite(data.steering)
      ? Math.max(-1, Math.min(1, data.steering)) : control_neutral;

    old_throttle = throttleCmd;
    old_steering = steeringCmd;

    if (throttle_ramp_up && throttleCmd > smoothed_throttle)
      smoothed_throttle = Math.min(throttleCmd, smoothed_throttle + throttle_ramp_up);
    else if (throttle_ramp_down && throttleCmd < smoothed_throttle)
      smoothed_throttle = Math.max(throttleCmd, smoothed_throttle - throttle_ramp_down);
    else
      smoothed_throttle = throttleCmd;

    if (logcount === 10) logcount = 0;

    pwm.setServoPWM('throttle', smoothed_throttle);
    pwm.setServoPWM('steering', steeringCmd);
    // data.shift / data.tlock_* are deliberately IGNORED here. Accepting them on
    // the continuous control stream is what let {throttle: 1, shift: -1} shift the
    // gearbox at full throttle, and it let an unvalidated field park the actuator
    // at mid-travel or release its override via the 65535 sentinel. Drivetrain
    // changes now go through the 'setDrivetrain' event above, which forces neutral
    // and disarm on the wire first. Any client still putting them here simply has
    // no effect, which is the safe direction to fail.

    clearTimeout(lastAction);
    lastAction = setTimeout(() => {
      // Route through the primitive so neutral reaches the wire BEFORE the
      // disarm. Setting the channel buffer alone left the vehicle armed with the
      // neutral value merely queued for the next 20 Hz tick.
      failSafeStop(`no input for ${input_timeout_ms} ms`);
    }, input_timeout_ms);
  });
});

// Single entry point for every fail-safe stop, so the neutral-then-DISARM wire
// order holds on all of them rather than only where someone remembered it.
function failSafeStop(reason) {
  smoothed_throttle = control_neutral;
  old_throttle      = control_neutral;
  old_steering      = control_neutral;
  const result = typeof pwm.neutralizeAndDisarm === 'function'
    ? pwm.neutralizeAndDisarm()
    : { neutralSent: false, disarmSent: false };
  console.error(`### FAIL-SAFE STOP (${reason}) ` +
    `neutral=${result.neutralSent} disarm=${result.disarmSent}`);
  return result;
}

process.on('SIGINT', () => {
  failSafeStop('process shutdown');
  stream.stop();
  console.log('\nShutting down');
  // Give the neutral + DISARM packets a moment to flush before the process dies.
  setTimeout(() => process.exit(), 100);
});
