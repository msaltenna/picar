// pwm_mavproxy_servo.js
// Sends RC_CHANNELS_OVERRIDE to MAVProxy over TCP
// Node acts as TCP SERVER, MAVProxy connects as client with --out=tcp:127.0.0.1:5760
// Uses proper MAVLink v1 framing with CRC

const net = require('net');
const {
  overlayChainMs, clampOverlayReassert, clampOverlayAttempts,
  // The schedule below is driven by these, shared with the bound that depends on it.
  OVERLAY_WRITE_SPACING_MS, OVERLAY_SETTLE_MS, OVERLAY_READ_SPACING_MS,
  sanitizeParamOverlay,
} = require('./config-bounds');

const MAVLINK_MSG_ID_RC_CHANNELS_OVERRIDE = 70;
const RC_OVERRIDE_CRC_EXTRA = 124;
const HEARTBEAT_CRC_EXTRA = 50;
const MAVLINK_MSG_ID_COMMAND_LONG = 76;
const COMMAND_LONG_CRC_EXTRA = 152;
const MAVLINK_MSG_ID_PARAM_SET = 23;
const PARAM_SET_CRC_EXTRA = 168;
const MAVLINK_MSG_ID_PARAM_REQUEST_READ = 20;
const PARAM_REQUEST_READ_CRC_EXTRA = 214;
const MAVLINK_MSG_ID_PARAM_VALUE = 22;

// MAV_CMD values
const MAV_CMD_COMPONENT_ARM_DISARM = 400;
const MAV_CMD_DO_SET_MODE = 176;

// MAV_PARAM_TYPE values
const MAV_PARAM_TYPE_REAL32 = 9;

// Channels driving two-position mechanical actuators. Only the endpoints are
// valid positions for these; see setServoPWM.
const DISCRETE_CHANNELS = new Set(['shift', 'tlock_front', 'tlock_rear', 'light']);

// The light is in DISCRETE_CHANNELS for input validation, not for the mechanical
// reason the others are: it cannot jam at mid-travel. It is on/off, so a value
// between the endpoints is a caller bug rather than a valid dim level. If dimming
// is ever wanted, remove it from this set and give it a continuous range — do not
// widen the set's meaning.
const LIGHT_CHANNEL = 'light';

// ── Inbound messages we decode ───────────────────────────────────────────────
//
// CRC_EXTRA values and wire field orders were taken from pymavlink's own message
// definitions on the target, not from memory — the framing here is hand-rolled, so
// a wrong constant fails silently rather than loudly.
const MSG_HEARTBEAT    = 0;

// HEARTBEAT identity fields. MAV_AUTOPILOT_INVALID (8) is what a GCS sends, including
// this driver's own heartbeat. The other two are what the ArduRover parameter overlay
// assumes about the thing on the other end of the link and never checked.
const MAV_AUTOPILOT_INVALID       = 8;
const MAV_AUTOPILOT_ARDUPILOTMEGA = 3;
const MAV_TYPE_GROUND_ROVER       = 10;
const MSG_SYS_STATUS   = 1;    // battery voltage / current / remaining
const MSG_RADIO_STATUS = 109;  // SiK telemetry link quality
const MSG_POWER_STATUS = 125;  // board and servo rail voltages

const MSG_CRC_EXTRA = {
  [MSG_HEARTBEAT]:                    50,
  [MSG_SYS_STATUS]:                  124,
  [MSG_RADIO_STATUS]:                185,
  [MSG_POWER_STATUS]:                203,
  [MAVLINK_MSG_ID_PARAM_VALUE]:      220,
};

// Declared v1 payload lengths. v2 zero-trims trailing zero bytes, so these are
// what a payload must be zero-extended to before any field offset is valid.
const MSG_PAYLOAD_LEN = {
  [MSG_HEARTBEAT]:                     9,
  [MSG_SYS_STATUS]:                   31,
  [MSG_RADIO_STATUS]:                  9,
  [MSG_POWER_STATUS]:                  6,
  [MAVLINK_MSG_ID_PARAM_VALUE]:       25,
};

// Every decoded message needs BOTH a CRC_EXTRA and a declared payload length. A
// missing length would leave the payload un-extended, and a field read past its end
// throws ERR_OUT_OF_RANGE inside the socket data handler — a crash on the MAVLink
// receive path, not a dropped message. Fail at load instead.
for (const id of Object.keys(MSG_CRC_EXTRA)) {
  if (MSG_PAYLOAD_LEN[id] === undefined) {
    throw new Error(`pwm_mavproxy_servo: msgId ${id} has a CRC_EXTRA but no MSG_PAYLOAD_LEN`);
  }
}

// A desynchronised stream must not grow the receive buffer without limit. Note the
// parser's own progress guarantee already bounds this to ~280 bytes while
// synchronised (a payload length is one byte), so this is a backstop for a
// pathological stream rather than the primary bound.
const MAX_RX_BUFFER = 256 * 1024;

// Telemetry older than this is reported as stale rather than as a live reading. At
// the 4 Hz stream rate this is ~12 missed messages.
const TELEMETRY_STALE_MS = 3000;

// Minimal Pixhawk/ArduRover overlay for this car.
// Keep trims/endpoints in picar-config.json; only fix params that are out of line.
// These are pushed on every MAVProxy connect so a fresh/replacement flight
// controller (e.g. Pixhawk 6C mini) gets the right output mapping without
// needing to load mav.parm by hand.
// Which overlay entries may be written BEFORE the autopilot has identified itself.
//
// Only RC_OVERRIDE_TIME, and it stays here for the reason _connect gives at length: it is
// the flight controller's OWN stale-override failsafe, and until it lands ArduPilot sits on
// its 3.0 s default while picar is already streaming overrides at 20 Hz. Waiting on a
// heartbeat for that one is the fail-open this driver deliberately avoids.
//
// Everything else is output MAPPING and control FEEL. Being wrong for the ~1 s a heartbeat
// takes costs nothing, and pushing it blind is MEASURED harm, not a hypothetical: deploying
// main to rover1 on 2026-08-11 pushed all 13 names at a PX4 board. Nine were rejected, but
// RC3_DZ and RC3_TRIM exist in PX4's namespace TOO and were actually written — RC3_DZ went
// 10 -> 30, journal `PARAM_SET RC3_DZ=30` then `verified RC3_DZ=30`. So the read-back also
// confirmed two parameters on a flight controller the overlay was never written for.
//
// RC_OVERRIDE_TIME being FIRST in DEFAULT_PARAM_OVERLAY is load-bearing for this split, not
// incidental: the deferred chain re-issues the whole set from index 0, so the pre-identity
// write is re-scheduled at the same 0 ms offset rather than delayed by the tiering.
const PRE_IDENTITY_PARAMS = new Set(['RC_OVERRIDE_TIME']);

const DEFAULT_PARAM_OVERLAY = {
  // FIRST deliberately. applyParamOverlay spaces its writes 250 ms apart, and this
  // one is the flight controller's own stale-override failsafe — until it lands,
  // ArduPilot is on its 3.0 s default. As the seventh entry it went out ~1500 ms
  // after connect, which is 1500 ms of a 15x-too-long override window on a vehicle
  // that is already streaming overrides.
  RC_OVERRIDE_TIME: 0.2,
  SERVO1_FUNCTION: 26, // GroundSteering on RC1 (steering)
  SERVO2_FUNCTION: 1,  // RC passthrough: transmission on RC2
  SERVO3_FUNCTION: 70, // Throttle on RC3
  SERVO4_FUNCTION: 1,  // RC passthrough: front diff on RC4
  SERVO5_FUNCTION: 1,  // RC passthrough: rear diff on RC5
  SERVO6_FUNCTION: 1,  // RC passthrough: light module on RC6
  // ArduRover FRAME_CLASS: 0=Undefined, 1=Rover, 2=Boat, 3=BalanceBot. This pushed
  // 2 (Boat) while the comment claimed "Rover", and EXPECTED_CRITICAL_PARAMS below
  // expected 2 as well — so the read-back dutifully confirmed the wrong value and
  // reported the vehicle verified. A wrong expectation is worse than no expectation:
  // it converts the verification step into a rubber stamp.
  FRAME_CLASS: 1,      // Rover (must be set or steering/throttle outputs are wrong)
  // Throttle slew limit, %/s. ArduRover's default of 100 means neutral -> 60% takes
  // 600 ms, which the operator experienced as reverse not engaging: measured on rover3,
  // a hard reverse STEP sent with the browser bypassed still ramped
  // 1500 -> 1460 -> 1340 -> 1220 us over ~700 ms. 250 gives ~240 ms to 60%.
  //
  // This is a control-feel parameter, not a safety limit — the fail-safe path commands
  // NEUTRAL, and reaching neutral faster is strictly better. Note ATC_BRAKE=1 and
  // ATC_ACCEL_MAX=1.0 also shape this and are deliberately left alone: with ATC_BRAKE
  // set, a reverse command while still rolling forward is BRAKING, so reverse genuinely
  // will not engage until the vehicle has stopped. That is a separate decision.
  MOT_SLEWRATE: 250,
  // The browser's THROTTLE_DEADZONE (socket.html) is derived from these three: the
  // deadzone in microseconds over the trim-to-endpoint half-span. They were MEASURED off
  // rover3 and then hardcoded client-side, which made the derivation coincidental — a
  // replacement board at factory default, or a calibration leaving trim at 1512, would
  // silently put the client's escape value back INSIDE the deadzone and reintroduce the
  // defect with no read-back mismatch and no failing test. Pushing and verifying them is
  // what makes that fix durable rather than lucky.
  RC3_DZ: 30,
  RC3_TRIM: 1500,
  AHRS_GPS_USE: 0,     // no GPS installed
  GPS1_TYPE: 0         // no GPS installed
};

// Critical values we expect after the overlay is applied.
// We read these back to detect a flight controller that silently rejected
// PARAM_SET (wrong firmware, params write-protected, wrong frame, etc.).
const EXPECTED_CRITICAL_PARAMS = {
  SERVO1_FUNCTION: 26,
  SERVO2_FUNCTION: 1,
  SERVO3_FUNCTION: 70,
  SERVO4_FUNCTION: 1,
  SERVO5_FUNCTION: 1,
  SERVO6_FUNCTION: 1,
  FRAME_CLASS: 1,
  RC_OVERRIDE_TIME: 0.2,
  // Verified by read-back like the rest: a throttle slew limit that silently failed to
  // apply would leave the operator with the sluggish response this change exists to fix,
  // and no indication of why.
  MOT_SLEWRATE: 250,
  // Verified because socket.html's deadzone constant is derived from them.
  RC3_DZ: 30,
  RC3_TRIM: 1500
};

const EXPECTED_FLOAT_TOLERANCE = {
  RC_OVERRIDE_TIME: 0.05
};

class PWMMavproxy {
  constructor(config) {
    this.min_us = config.pwm_min_us || 1000;
    this.max_us = config.pwm_max_us || 2000;
    this.neutral = Math.round((this.min_us + this.max_us) / 2);

    // Control inputs are normalized to [-1..1] by default.
    // Set mavproxy_legacy_input_scale=true only for old clients that send
    // raw PWM duty values (e.g. 0.105..0.175).
    this.legacyInputScale = config.mavproxy_legacy_input_scale === true;
    this.pwm_min = config.pwm_min ?? 0.105;
    this.pwm_max = config.pwm_max ?? 0.175;
    this.pwm_neutral = config.pwm_neutral ?? 0.14;

    this.host = config.mavproxy_host || '127.0.0.1';
    this.port = config.mavproxy_port || 5760;
    this.target_system = config.mavproxy_target_system || 1;
    this.target_component = config.mavproxy_target_component || 1;

    // Validated, not trusted: this key is reachable from untracked
    // picar-cfg.local.json, so a typo here silently disables the overlay that
    // corrects FRAME_CLASS. See sanitizeParamOverlay() for the two shapes that
    // did exactly that.
    const overlayCheck = sanitizeParamOverlay(config.mavproxy_param_overlay, DEFAULT_PARAM_OVERLAY);
    this.paramOverlay = overlayCheck.overlay;
    for (const bad of overlayCheck.rejected) {
      console.error(`MAVProxy: REJECTED mavproxy_param_overlay entry — ${bad}`);
    }
    if (overlayCheck.rejected.length && overlayCheck.usedFallback) {
      console.error('MAVProxy: falling back to the built-in critical-parameter overlay');
    }
    if (Object.keys(this.paramOverlay).length === 0) {
      console.error('MAVProxy: mavproxy_param_overlay is EMPTY — NO critical parameters ' +
                    'will be pushed, and every read-back will confirm whatever the flight ' +
                    'controller already holds');
    }

    this.applyParamOverlayOnConnect = config.mavproxy_apply_param_overlay !== false;
    // Loud on purpose. Turning this off leaves FRAME_CLASS and the SERVOn_FUNCTION
    // map at whatever is already flashed, and the only evidence used to be its
    // absence from the log.
    if (!this.applyParamOverlayOnConnect) {
      console.error('MAVProxy: mavproxy_apply_param_overlay=false — the critical-parameter ' +
                    'overlay is DISABLED; parameters will be neither written nor verified');
    }

    this.seq = 0;

    // ── Voltage-derived battery percentage ───────────────────────────────────
    //
    // The flight controller's own battery_remaining is only usable when it
    // coulomb-counts. On this vehicle it does not: BATT_CAPACITY=3300 and
    // BATT_MONITOR=4 are both set, yet 24169 BATTERY_STATUS frames carried
    // current_consumed = -1 (not measured) and battery_remaining = 0. So when a
    // pack range is configured we interpolate a percentage from voltage instead,
    // and always report which source was used.
    //
    // Validated as a pair, because a half-configured or inverted range would
    // produce a confidently wrong number on a display an operator trusts. Any
    // rejection disables the estimate rather than guessing a default: there is no
    // safe default for a pack whose chemistry and cell count we do not know.
    const emptyV = config.battery_empty_volts;
    const fullV  = config.battery_full_volts;
    this.batteryRange = null;
    // A HALF-configured range used to fall straight through this block in silence:
    // no range, no message, and — because app.js's startup guard only looked at
    // battery_empty_volts — no warning either. Setting just the first of the two is
    // the natural half-finished edit, and the result was a rover with no percentage,
    // no voltage threshold and no complaint about either.
    const halfSet = (emptyV === null || emptyV === undefined) !== (fullV === null || fullV === undefined);
    if (halfSet) {
      console.error('Battery percentage disabled: battery_empty_volts and battery_full_volts ' +
        `must BOTH be set (got ${JSON.stringify(emptyV)} / ${JSON.stringify(fullV)}). ` +
        'With no range and no batteryWarnVolts, a flat pack raises no warning at all.');
    }
    if (emptyV !== null && emptyV !== undefined && fullV !== null && fullV !== undefined) {
      if (!Number.isFinite(emptyV) || !Number.isFinite(fullV)) {
        console.error('Battery percentage disabled: battery_empty_volts / battery_full_volts ' +
          `must both be finite numbers (got ${JSON.stringify(emptyV)} / ${JSON.stringify(fullV)})`);
      } else if (emptyV < 0 || fullV <= emptyV) {
        console.error('Battery percentage disabled: need 0 <= battery_empty_volts < ' +
          `battery_full_volts (got ${emptyV} / ${fullV})`);
      } else {
        this.batteryRange = { emptyV, fullV };
        console.log(`Battery percentage from voltage: ${emptyV}V = 0%, ${fullV}V = 100%`);
      }
    }

    // A voltage estimate sags under throttle, so smooth it with a rolling MEDIAN
    // rather than a mean — a median ignores a brief current spike outright, where
    // a mean drags the whole reading down with it. Bounded by construction, and
    // clamped to a sane window: this array is written on every SYS_STATUS frame.
    const requestedSamples = config.battery_pct_median_samples;
    this.batteryPctSamples = Number.isFinite(requestedSamples)
      ? Math.max(1, Math.min(31, Math.round(requestedSamples)))
      : 5;
    this.batteryVoltHistory = [];

    // Handles for the param-overlay's timer chain, so it can be cancelled.
    this.overlayTimers = [];
    // Reassert-until-verified state. The window must exceed one full overlay
    // chain (9 writes at 250 ms plus the read-back window) or a reassert would
    // fire before the previous attempt could possibly have been confirmed.
    // null = accept RADIO_STATUS from any system (see the parser for why).
    this.radioSystem = Number.isFinite(config.mavproxy_radio_system)
      ? config.mavproxy_radio_system : null;
    this.overlayReassertTimer = null;
    this.overlayAttempts = 0;
    // Derived from the overlay's own schedule, then clamped at BOTH ends — see
    // config-bounds.js. A lower bound alone let 1e400 (valid JSON) become Infinity,
    // which Node turns into a 1 ms timer.
    const chainMs = overlayChainMs(
      Object.keys(this.paramOverlay || {}).length,
      Object.keys(EXPECTED_CRITICAL_PARAMS).length);
    this.overlayChainMs = chainMs;
    this.overlayReassertMs  = clampOverlayReassert(config.mavproxy_overlay_reassert_ms, chainMs);
    this.maxOverlayAttempts = clampOverlayAttempts(config.mavproxy_overlay_max_attempts);
    // How long to wait for the autopilot to identify itself before applying the
    // vehicle-configuration tier of the overlay anyway. Bounded hard: this is reachable
    // from the untracked per-rover overlay (invariant 8, still open), so the worst an
    // unreviewed value can do is move it inside 0.5-10 s. Two heartbeats at 1 Hz by
    // default. Expiry is NOT a refusal — a one-way return path must still get its output
    // mapping, or steering drives throttle.
    const graceMs = Number(config.mavproxy_identity_grace_ms);
    this.identityGraceMs = Number.isFinite(graceMs)
      ? Math.min(10000, Math.max(500, graceMs)) : 2000;
    this.identityGraceTimer  = null;
    this.deferredOverlayDone = false;

    // Latest decoded telemetry. Each entry carries its own `at` timestamp so a
    // reader can tell a live reading from a stale one — reporting a last-known
    // battery voltage as if it were current is worse than reporting nothing.
    this.telemetry = { battery: null, power: null, radio: null, heartbeat: null };
    // Initialised here as well as on connect: it was previously only assigned
    // inside _connect(), so before any connection it read `undefined` rather than
    // false, and `!seen` happened to work only by accident.
    this.pixhawkHeartbeatSeen = false;
    // Read-back results, kept rather than only logged: a log line cannot be
    // consumed by /status, by the fleet dashboard, or by a future arming gate.
    this.verifiedCriticalParams = new Set();
    this.paramVerificationFailures = new Map();
    // What the autopilot says it IS, from its HEARTBEAT, and null until one arrives.
    // Sticky across reconnects on purpose: the suppression below must survive the
    // 2 s reconnect loop, or every reconnect re-pushes a rover overlay at a copter.
    // Self-correcting — a heartbeat identifying an ArduRover clears it again.
    this.autopilotIdent   = null;
    this.firmwareMismatch = null;
    this.overlaySuppressed = false;
    this.heartbeatWatch = null;
    this.heartbeatTimeoutMs = config.mavproxy_heartbeat_timeout_ms ?? 10000;
    this.client = null;   // the connected MAVProxy client socket

    this.channels = new Uint16Array(8);
    // Initialize ALL channels to neutral so ArduPilot doesn't ignore them
    // (0 = "no override" in MAVLink, which causes channels to be skipped)
    this.channels[0] = config.steering_neutral_us ?? this.neutral;       // steering
    this.channels[1] = config.shift_default_us ?? this.max_us;           // shift (low gear - wiring reversed)
    this.channels[2] = config.throttle_neutral_us ?? this.neutral;       // throttle
    this.channels[3] = config.tlock_front_default_us ?? this.max_us;     // front t-lock (unlocked - wiring reversed)
    this.channels[4] = config.tlock_rear_default_us ?? this.min_us;      // rear t-lock (unlocked)
    // Light module on Pixhawk output 6. Starts OFF: a vehicle that boots with its
    // light already on tells the operator nothing about whether the control works,
    // and an output whose state is not commanded is an output nobody owns.
    this.channels[5] = config.light_off_us ?? this.min_us;               // light (off)
    this.channelMap = {
      throttle: 2,    // RC channel 3 (0-indexed)
      shift: 1,       // RC channel 2 (0-indexed)
      steering: 0,    // RC channel 1 (0-indexed)
      tlock_front: 3, // RC channel 4 (0-indexed)
      tlock_rear: 4,  // RC channel 5 (0-indexed)
      light: 5        // RC channel 6 (0-indexed) -> Pixhawk output 6
    };
    // Endpoint microseconds for the light. Separate from min_us/max_us so a module
    // that wants something other than the full PWM range can be trimmed without
    // touching the motion channels.
    this.lightOnUs  = config.light_on_us  ?? this.max_us;
    this.lightOffUs = config.light_off_us ?? this.min_us;

    // Remembered so a fail-safe can restore motion channels to the SAME values
    // the driver booted with, rather than recomputing a midpoint that may not
    // match this vehicle's configured trim.
    this.channelNeutralUs = {
      steering: this.channels[0],
      throttle: this.channels[2],
    };

    this.rate_hz = config.mavproxy_rate_hz || 20;
    this.interval = null;
    this.heartbeatInterval = null;

    console.log(`MAVProxy PWM driver: connecting to tcpin at ${this.host}:${this.port}, ` +
      `target sys=${this.target_system} comp=${this.target_component}, ${this.rate_hz}Hz`);
    console.log(
      `MAVProxy input scaling: ${this.legacyInputScale ? 'legacy PWM values' : 'normalized [-1..1]'} ` +
      `(neutral=${this.legacyInputScale ? this.pwm_neutral : 0})`
    );

    // Opening the MAVProxy socket in the constructor makes the driver impossible
    // to exercise on a host: the pending connection keeps the process alive and a
    // test runner hangs. Default is unchanged (connect), so this is inert in
    // production and only lets tests construct the driver without a link.
    if (config.mavproxy_autostart !== false) this.startServer();
  }

  startServer() {
    this._connect();
  }

  _connect() {
    if (this.client) return;
    const socket = net.createConnection({ host: this.host, port: this.port }, () => {
      console.log(`MAVProxy: connected to tcpin server at ${this.host}:${this.port}`);
      this.client = socket;
      this.pixhawkHeartbeatSeen = false;
      this.paramOverlayApplied = false;
      this.startHeartbeat();

      // A reconnect must never inherit an armed vehicle. ArduPilot arm state
      // survives a picar restart, a crash, and a companion-computer reboot — this
      // flight controller has been observed sitting armed with no operator
      // connected. So put neutral and DISARM on the link BEFORE starting the
      // override stream, and make the operator re-arm deliberately.
      this.neutralizeAndDisarm();
      this.startLoop();

      // The safety overlay is applied on CONNECT, not on the first autopilot
      // heartbeat.
      //
      // Gating it behind the heartbeat was FAIL-OPEN. The overlay writes
      // RC_OVERRIDE_TIME=0.2 — the flight controller's own stale-override
      // failsafe — and outbound ARM and RC overrides work whether or not we can
      // hear the autopilot. So a one-way return-path failure (wrong sysId, broken
      // framing, a receive path that never delivers) left the vehicle drivable
      // while ArduPilot silently kept its 3.0 s default: a 15x longer window in
      // which a stale override persists. Nothing recovered from that — the
      // watchdog below only logs, and app.js does not gate arming on it.
      //
      // Transmission does not depend on hearing anything, so neither does this.
      // The genuine heartbeat is still required, but for VERIFICATION — read-back
      // and reporting — which is what hearing the autopilot can actually prove.
      // The pre-identity tier goes out immediately, for the fail-open reason above. The
      // rest waits for the autopilot to say what it is — bounded, see startIdentityGrace.
      // The reassert watch starts with the DEFERRED chain, not here: its floor is derived
      // from the chain length, so arming it up to identityGraceMs early would let the
      // first check fire mid-chain, find params missing, and cancel the writes still in
      // flight — the never-completing loop clampOverlayReassert's comment describes.
      if (this.applyParamOverlayOnConnect) {
        this.applyParamOverlay({ tier: 'preIdentity' });
        this.startIdentityGrace();
      }

      // Still warn when the autopilot never identifies itself: the overlay has now
      // been SENT, but nothing has confirmed it was accepted, so every read-back
      // and every `verified` entry is missing rather than passing.
      if (this.heartbeatWatch) clearTimeout(this.heartbeatWatch);
      this.heartbeatWatch = setTimeout(() => {
        this.heartbeatWatch = null;
        if (!this.pixhawkHeartbeatSeen) {
          console.error(
            `MAVProxy: WARNING no autopilot heartbeat from sys=${this.target_system} ` +
            `after ${this.heartbeatTimeoutMs} ms although the TCP link is up. ` +
            `The parameter overlay was transmitted but NOTHING has confirmed it — ` +
            `treat every critical parameter as unverified. Check SYSID_THISMAV and ` +
            `mavproxy_target_system.`);
        }
      }, this.heartbeatTimeoutMs);
    });

    socket.on('data', (data) => {
      // A malformed frame must never take down the receive path. Without this a
      // single out-of-range field read would throw out of the socket handler.
      try {
        this.parseIncoming(data);
      } catch (e) {
        console.error('MAVProxy: parse error, resyncing:', e.message);
        this.rxBuf = Buffer.alloc(0);
      }
    });

    socket.on('error', (err) => {
      // ECONNREFUSED means mavproxy isn't ready yet — retry quietly
      if (err.code !== 'ECONNREFUSED') {
        console.error('MAVProxy connection error:', err.message);
      }
    });

    socket.on('close', () => {
      console.log('MAVProxy: connection closed, retrying in 2s…');
      // Drop telemetry: with the link down these values are no longer facts.
      this.telemetry = { battery: null, power: null, radio: null, heartbeat: null };
      // The smoothing window must go with them. Keeping it meant five stale 8.4 V
      // samples could outvote a fresh 6.0 V reading after a reconnect — measured as
      // "6.0 V, ~100%" — which does not merely look wrong, it CLEARS the
      // low-battery warning for up to the full window.
      this.batteryVoltHistory = [];
      // Cancel any in-flight overlay: its remaining PARAM_SETs would write to a
      // dead socket, and on reconnect a fresh chain starts anyway.
      this.clearOverlayTimers();
      if (this.overlayReassertTimer) {
        clearTimeout(this.overlayReassertTimer);
        this.overlayReassertTimer = null;
      }
      // Per-connection, unlike overlaySuppressed: a new link may be a different flight
      // controller, so the next connect re-runs the tiering from the start.
      if (this.identityGraceTimer) {
        clearTimeout(this.identityGraceTimer);
        this.identityGraceTimer = null;
      }
      this.deferredOverlayDone = false;
      this.paramOverlayApplied = false;
      this.verifiedCriticalParams.clear();
      this.paramVerificationFailures.clear();
      if (this.heartbeatWatch) { clearTimeout(this.heartbeatWatch); this.heartbeatWatch = null; }
      this.client = null;
      if (this.interval) { clearInterval(this.interval); this.interval = null; }
      if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
      setTimeout(() => this._connect(), 2000);
    });
  }

  // Returns true only if the bytes were handed to the socket. A fail-safe that
  // cannot report a failed write is indistinguishable from one that worked.
  sendPacket(buf) {
    if (!this.client || this.client.destroyed) return false;
    try {
      this.client.write(buf);
      return true;
    } catch (e) {
      console.error('TCP write error:', e.message);
      return false;
    }
  }

  // Fail-safe ordering is a property of the WIRE, not of call order.
  //
  // setServoPWM only mutates the channel buffer — it transmits nothing, and the
  // value does not leave until the next 20 Hz tick. So "set neutral, then
  // disarm()" actually puts DISARM on the link FIRST and neutral up to 50 ms
  // later, which is the reverse of the intent. Socket.IO event ordering on the
  // client does not help; the reordering happens here, below it.
  //
  // This transmits an explicit neutral RC_CHANNELS_OVERRIDE packet and only then
  // the DISARM, on the same socket, in that order. Both results are reported so
  // a caller can tell a real fail-safe from a silently failed one.
  neutralizeAndDisarm() {
    this.channels[this.channelMap.throttle] = this.channelNeutralUs.throttle;
    this.channels[this.channelMap.steering] = this.channelNeutralUs.steering;
    const neutralSent = this.sendPacket(this.buildRCOverride());
    // Propagate the real result. An earlier version used `disarmed !== false`,
    // which reported success when disarm() returned undefined — exactly the
    // silent-failure pattern this is meant to eliminate.
    const disarmSent = this.disarm() === true;
    return { neutralSent, disarmSent };
  }

  scale(value) {
    const midpoint = (this.max_us + this.min_us) / 2;
    const outputHalfRange = (this.max_us - this.min_us) / 2;

    if (!this.legacyInputScale) {
      const normalized = this.clamp(value, -1, 1);
      return Math.round(midpoint + outputHalfRange * normalized);
    }

    const inputHalfRange = Math.max(
      Math.abs(this.pwm_neutral - this.pwm_min),
      Math.abs(this.pwm_max - this.pwm_neutral)
    );

    if (inputHalfRange <= 0) return midpoint;

    const normalized = (value - this.pwm_neutral) / inputHalfRange;
    return Math.round(midpoint + outputHalfRange * normalized);
  }

  // Returns true when the channel buffer was updated, false when the command was
  // refused. A silent refusal on the motion path is not acceptable: the caller
  // must be able to tell "applied" from "dropped".
  //
  // Note this only mutates the channel buffer — it transmits nothing. The value
  // goes out on the next RC_CHANNELS_OVERRIDE tick.
  // Convenience wrapper: the light is on/off, so callers should not have to know
  // that -1 means off. Returns applied/dropped like setServoPWM.
  setLight(on) {
    if (typeof on !== 'boolean') return false;
    return this.setServoPWM(LIGHT_CHANNEL, on ? 1 : -1);
  }

  lightIsOn() {
    return this.channels[this.channelMap[LIGHT_CHANNEL]] === this.lightOnUs;
  }

  setServoPWM(name, value) {
    const ch = this.channelMap[name];
    if (ch === undefined) return false;

    // Validate the RAW input, not just the scaled result. `[]` and `null` both
    // coerce to 0 and would scale to a perfectly finite mid-travel value, so
    // checking only the output would let a malformed field move a mechanical
    // actuator to the middle of its range. Don't trust the caller to have
    // filtered: this is the last gate before the channel buffer.
    if (!Number.isFinite(value)) return false;

    // Drivetrain channels drive two-position mechanical actuators — a gear
    // selector and diff locks. There is no such thing as "half a gear": any
    // value between the endpoints parks the shift fork between gears, which
    // grinds or jams the transmission. So these accept ONLY the endpoints,
    // unlike throttle and steering which are genuinely continuous. Note this
    // rejects 0, which is what a missing or zero-coerced field looks like.
    if (DISCRETE_CHANNELS.has(name) && value !== 1 && value !== -1) return false;

    // scale() is arithmetic, so a non-numeric input yields NaN. A Uint16Array
    // silently stores NaN as 0, and buildRCOverride maps 0 to the 65535
    // "ignore this field" sentinel — so an unvalidated value would quietly
    // release the channel's override instead of setting it. Reject it here so
    // the buffer can never hold a value nobody asked for.
    // The light has its own endpoint pair so it can be trimmed independently of the
    // motion channels' PWM range.
    if (name === LIGHT_CHANNEL) {
      this.channels[ch] = value === 1 ? this.lightOnUs : this.lightOffUs;
      return true;
    }

    const scaled = this.scale(value);
    if (!Number.isFinite(scaled)) return false;

    this.channels[ch] = this.clamp(scaled, this.min_us, this.max_us);
    return true;
  }

  clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    const sendHB = () => this.sendPacket(this.buildHeartbeat());
    sendHB();
    this.heartbeatInterval = setInterval(sendHB, 1000);
  }

  buildHeartbeat() {
    const payloadLen = 9;
    const buf = Buffer.alloc(6 + payloadLen + 2);

    let i = 0;
    buf[i++] = 0xFE;
    buf[i++] = payloadLen;
    buf[i++] = this.seq & 0xFF; this.seq++;
    buf[i++] = 255;          // sysid (GCS)
    buf[i++] = 0;            // compid
    buf[i++] = 0;            // msg id (HEARTBEAT)

    buf.writeUInt32LE(0, i); i += 4; // custom_mode
    buf[i++] = 6;            // MAV_TYPE_GCS
    buf[i++] = 8;            // MAV_AUTOPILOT_INVALID
    buf[i++] = 0;            // base_mode
    buf[i++] = 4;            // MAV_STATE_ACTIVE
    buf[i++] = 3;            // mavlink_version

    let crc = PWMMavproxy.crc16(buf.subarray(1, 6 + payloadLen), 5 + payloadLen);
    crc = PWMMavproxy.crcAccumulate(HEARTBEAT_CRC_EXTRA, crc);
    buf.writeUInt16LE(crc, 6 + payloadLen);
    return buf;
  }

  startLoop() {
    if (this.interval) clearInterval(this.interval);
    const period = 1000 / this.rate_hz;
    let logCount = 0;
    this.interval = setInterval(() => {
      this.sendPacket(this.buildRCOverride());
      logCount++;
      if (logCount % (this.rate_hz * 5) === 1) {
        console.log(`RC Override: ch1=${this.channels[0]} ch2=${this.channels[1]} ch3=${this.channels[2]} (client=${!!this.client})`);
      }
    }, period);
  }

  static crc16(buf, len) {
    let crc = 0xFFFF;
    for (let i = 0; i < len; i++) {
      let tmp = buf[i] ^ (crc & 0xFF);
      tmp ^= (tmp << 4) & 0xFF;
      crc = (crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4);
      crc &= 0xFFFF;
    }
    return crc;
  }

  static crcAccumulate(byte, crc) {
    let tmp = byte ^ (crc & 0xFF);
    tmp ^= (tmp << 4) & 0xFF;
    crc = (crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4);
    return crc & 0xFFFF;
  }

  buildRCOverride() {
    const payloadLen = 18;
    const buf = Buffer.alloc(6 + payloadLen + 2);

    let i = 0;
    buf[i++] = 0xFE;
    buf[i++] = payloadLen;
    buf[i++] = this.seq & 0xFF; this.seq++;
    buf[i++] = 255;
    buf[i++] = 0;
    buf[i++] = MAVLINK_MSG_ID_RC_CHANNELS_OVERRIDE;

    for (let c = 0; c < 8; c++) {
      const v = this.channels[c];
      buf.writeUInt16LE(v === 0 ? 65535 : v, i);
      i += 2;
    }
    buf[i++] = this.target_system;
    buf[i++] = this.target_component;

    let crc = PWMMavproxy.crc16(buf.subarray(1, 6 + payloadLen), 5 + payloadLen);
    crc = PWMMavproxy.crcAccumulate(RC_OVERRIDE_CRC_EXTRA, crc);
    buf.writeUInt16LE(crc, 6 + payloadLen);
    return buf;
  }

  buildParamSet(name, value) {
    const payloadLen = 23;
    const buf = Buffer.alloc(6 + payloadLen + 2);

    let i = 0;
    buf[i++] = 0xFE;
    buf[i++] = payloadLen;
    buf[i++] = this.seq & 0xFF; this.seq++;
    buf[i++] = 255; // sysid (GCS)
    buf[i++] = 0;   // compid
    buf[i++] = MAVLINK_MSG_ID_PARAM_SET;

    // PARAM_SET payload wire order:
    // param_value(float32), target_system(uint8), target_component(uint8), param_id(char[16]), param_type(uint8)
    buf.writeFloatLE(value, i); i += 4;
    buf[i++] = this.target_system;
    buf[i++] = this.target_component;

    const paramName = Buffer.alloc(16, 0);
    paramName.write(String(name).slice(0, 16), 0, 'ascii');
    paramName.copy(buf, i); i += 16;

    buf[i++] = MAV_PARAM_TYPE_REAL32;

    let crc = PWMMavproxy.crc16(buf.subarray(1, 6 + payloadLen), 5 + payloadLen);
    crc = PWMMavproxy.crcAccumulate(PARAM_SET_CRC_EXTRA, crc);
    buf.writeUInt16LE(crc, 6 + payloadLen);
    return buf;
  }

  // Decide whether this autopilot is the one the overlay is written for, and stop
  // writing at it when it is not.
  //
  // EXPECTED_CRITICAL_PARAMS and paramOverlay are ArduRover-specific. Pushing them at
  // something else is not merely useless: on ArduCopter FRAME_CLASS is the airframe
  // selector and 1 means Quad, so this driver would silently reconfigure a hexacopter's
  // frame. On PX4 the names do not exist, so every read-back comes back missing and the
  // operator is told to "check FRAME_CLASS=1 (Rover)" about firmware that has no such
  // parameter. rover1 was measured on 2026-08-11 running PX4 and reporting a QUADROTOR
  // MAV_TYPE while this driver pushed the rover overlay at it, unremarked.
  //
  // This CANNOT gate the first push on connect, and deliberately does not try. Gating
  // the overlay on hearing a heartbeat is the fail-open documented at length in
  // _connect: RC_OVERRIDE_TIME=0.2 is the flight controller's own stale-override
  // failsafe, outbound writes work whether or not the return path does, and a one-way
  // link would leave the vehicle drivable on ArduPilot's 3.0 s default. Identification
  // arrives ~1 s after connect at the earliest, so what it can do is stop every
  // subsequent write — the reassert chain and every later reconnect — and make sure
  // nothing reads as verified against a vehicle we have misidentified.
  noteAutopilotIdentity(autopilot, type) {
    const same = this.autopilotIdent
      && this.autopilotIdent.autopilot === autopilot
      && this.autopilotIdent.type === type;
    if (same) return;      // heartbeats arrive at 1 Hz forever; act only on a CHANGE
    this.autopilotIdent = { autopilot, type };

    const why = [];
    if (autopilot !== MAV_AUTOPILOT_ARDUPILOTMEGA) {
      why.push(`MAV_AUTOPILOT=${autopilot} (expected ${MAV_AUTOPILOT_ARDUPILOTMEGA} ` +
               `ARDUPILOTMEGA)`);
    }
    if (type !== MAV_TYPE_GROUND_ROVER) {
      why.push(`MAV_TYPE=${type} (expected ${MAV_TYPE_GROUND_ROVER} GROUND_ROVER)`);
    }
    this.firmwareMismatch = why.length ? why.join('; ') : null;

    if (!this.firmwareMismatch) {
      // A previously misidentified link that now identifies correctly — a swapped or
      // reflashed board — must be able to recover without a process restart.
      if (this.overlaySuppressed) {
        console.log('MAVProxy: autopilot now identifies as ArduPilot / GROUND_ROVER — ' +
          'the parameter overlay is no longer suppressed');
        this.overlaySuppressed = false;
      }
      // Identified as the vehicle the overlay is written for: release the tier that was
      // held back. This is the normal path on a healthy rover, and it is what makes the
      // blind configuration write disappear rather than merely happen less often.
      this.applyDeferredOverlay();
      return;
    }

    this.overlaySuppressed = true;
    // Without this the grace timer still fires and applies the very tier just refused.
    if (this.identityGraceTimer) {
      clearTimeout(this.identityGraceTimer);
      this.identityGraceTimer = null;
    }
    this.clearOverlayTimers();          // the in-flight chain's remaining PARAM_SETs
    if (this.overlayReassertTimer) {
      clearTimeout(this.overlayReassertTimer);
      this.overlayReassertTimer = null;
    }
    // Nothing may read as verified against a vehicle we have misidentified. Read-back
    // proves a parameter's value; it does not prove the parameter means here what
    // EXPECTED_CRITICAL_PARAMS assumes it means.
    this.verifiedCriticalParams.clear();
    this.paramOverlayApplied = false;
    console.error(
      `MAVProxy: WARNING this autopilot is NOT an ArduRover: ${this.firmwareMismatch}. ` +
      `The ArduRover parameter overlay has been SUPPRESSED — the first push on connect ` +
      `had already been sent before this heartbeat arrived, so treat this flight ` +
      `controller's parameters as MODIFIED and check them. Every critical parameter is ` +
      `now reported unverified.`);
  }

  applyParamOverlay({ tier = 'full' } = {}) {
    const all = Object.entries(this.paramOverlay || {});
    // The pre-identity tier reads back only what it wrote. Requesting the whole critical
    // set here would record mismatches for parameters not yet pushed, so the status bar
    // would show real-looking failures for the length of the grace window.
    const entries = tier === 'preIdentity'
      ? all.filter(([name]) => PRE_IDENTITY_PARAMS.has(name)) : all;
    const readBack = tier === 'preIdentity'
      ? Object.keys(EXPECTED_CRITICAL_PARAMS).filter((n) => PRE_IDENTITY_PARAMS.has(n))
      : Object.keys(EXPECTED_CRITICAL_PARAMS);
    if (entries.length === 0) return;
    // Checked HERE rather than only at the call sites. There are three — connect, the
    // reassert chain, and the sysId-change path — and CLAUDE.md names "a correct rule
    // with an untouched consumer" as this repo's dominant defect shape.
    if (this.overlaySuppressed) {
      console.error('MAVProxy: REFUSING to apply the ArduRover parameter overlay — ' +
        `${this.firmwareMismatch}`);
      return;
    }

    // Deliberately NOT clearing verifiedCriticalParams here. It is cleared on close
    // (:416), which is the event that genuinely invalidates it — a new link means a
    // possibly different flight controller. Clearing on every reassert instead made
    // params.verified empty for the ~4 s each chain takes, so the status bar flipped
    // 'FC: ok' -> 'FC: 8 param unverified' -> 'FC: ok' up to four times per connect.
    // Churn on the one indicator this branch added specifically to be trusted teaches
    // an operator to ignore it.
    //
    // Not clearing is also the fail-CLOSED direction for paramVerificationFailures: a
    // recorded mismatch persists until a read-back actually contradicts it, so a
    // reassert whose reads are all lost leaves the warning up rather than clearing it.
    console.log(tier === 'preIdentity'
      ? `MAVProxy: Applying the pre-identity param overlay (${entries.length} of ${all.length}) ` +
        '— the rest waits for the autopilot to identify itself...'
      : 'MAVProxy: Applying minimal Pixhawk param overlay...');

    // Every timer is tracked and cleared on the next overlay or on close. The
    // overlay now runs on EVERY connect rather than once per first-heartbeat, so
    // reconnect churn would otherwise stack overlapping PARAM_SET chains that
    // nothing could cancel.
    this.clearOverlayTimers();
    entries.forEach(([name, value], index) => {
      this.overlayTimers.push(setTimeout(() => {
        console.log(`MAVProxy: PARAM_SET ${name}=${value}`);
        // Report a write that never left. Silently ignoring it meant the overlay
        // could claim to have been applied while nothing reached the link.
        if (!this.sendPacket(this.buildParamSet(name, value))) {
          console.error(`MAVProxy: WARNING PARAM_SET ${name}=${value} was NOT written — ` +
            `the link went down mid-overlay. Treat every critical parameter as unverified.`);
        }
      }, index * OVERLAY_WRITE_SPACING_MS));
    });

    // After all writes, read back critical params and warn loudly if
    // anything doesn't match. This catches the "steering also drives
    // throttle" class of failure on a fresh board.
    const writeWindowMs = entries.length * OVERLAY_WRITE_SPACING_MS + OVERLAY_SETTLE_MS;
    readBack.forEach((name, index) => {
      this.overlayTimers.push(setTimeout(() => {
        this.sendPacket(this.buildParamRequestRead(name));
      }, writeWindowMs + index * OVERLAY_READ_SPACING_MS));
    });
  }

  // Bounded wait for the autopilot to identify itself, after which the configuration tier
  // is applied ANYWAY.
  //
  // Expiry is deliberately not a refusal. A return path that never delivers is the case
  // _connect's fail-open argument is about, and SERVOn_FUNCTION left at a replacement
  // board's defaults means steering drives throttle — a hazard in its own right. So the
  // choice on expiry is between two bad outcomes, and this keeps today's: push, and say
  // loudly that it went to an unidentified flight controller.
  startIdentityGrace() {
    if (this.identityGraceTimer) clearTimeout(this.identityGraceTimer);
    this.identityGraceTimer = setTimeout(() => {
      this.identityGraceTimer = null;
      // Only a REFUSAL stops this. Note there is ONE apply path, not one per branch: an
      // earlier draft returned early whenever the autopilot had been identified, which was
      // both a hole (identification arriving on an already-destroyed socket skipped the
      // apply, and then so did this) and untestable — no test could reach the skip, so
      // mutation could not kill it. The branch below decides only what to WARN.
      if (this.overlaySuppressed) return;
      if (!this.autopilotIdent) {
        console.error(
          `MAVProxy: WARNING no autopilot heartbeat within ${this.identityGraceMs} ms — ` +
          `applying the ArduRover configuration overlay to an UNIDENTIFIED flight ` +
          `controller. If this board is not an ArduRover, parameters shared with its ` +
          `firmware's namespace WILL be overwritten. Check SYSID_THISMAV and ` +
          `mavproxy_target_system.`);
      }
      this.applyDeferredOverlay();
    }, this.identityGraceMs);
  }

  // Apply the configuration tier exactly once per connection, and only then start the
  // reassert chain — its interval floor is derived from the chain length, so it must not
  // be armed before the chain it is checking has started.
  applyDeferredOverlay() {
    if (this.deferredOverlayDone) return;
    this.deferredOverlayDone = true;
    if (this.identityGraceTimer) {
      clearTimeout(this.identityGraceTimer);
      this.identityGraceTimer = null;
    }
    this.applyParamOverlay();
    this.startOverlayReassertWatch();
  }

  // Cancel any in-flight overlay. Bounded and idempotent.
  clearOverlayTimers() {
    for (const t of this.overlayTimers) clearTimeout(t);
    this.overlayTimers = [];
  }

  // Keep reasserting the overlay until read-back CONFIRMS every critical parameter.
  //
  // A TCP connection to MAVProxy is not proof that its /dev/ttyACM0 master is
  // usable, and sendPacket() only proves bytes reached the local socket. So the
  // first attempt can be lost in its entirety — RC_OVERRIDE_TIME included — while
  // arming and the override stream carry on regardless. Applying on connect removed
  // the heartbeat dependency but not this: nothing retried a lost overlay, and the
  // later heartbeat deliberately does not.
  //
  // Bounded: it stops on success, after maxOverlayAttempts, or on close. Each attempt
  // cancels the previous chain, so attempts cannot overlap.
  startOverlayReassertWatch() {
    this.overlayAttempts = 1;
    const check = () => {
      this.overlayReassertTimer = null;
      if (!this.client || this.client.destroyed) return;      // close handler owns this
      // A suppressed overlay can never be confirmed by read-back, so the chain would run
      // to maxOverlayAttempts logging a reassert it is not performing.
      if (this.overlaySuppressed) {
        console.error('MAVProxy: abandoning the overlay reassert chain — ' +
          `${this.firmwareMismatch}`);
        return;
      }
      const missing = Object.keys(EXPECTED_CRITICAL_PARAMS)
        .filter((n) => !this.verifiedCriticalParams.has(n));
      if (missing.length === 0) {
        this.paramOverlayApplied = true;                      // only NOW is it true
        console.log('MAVProxy: parameter overlay confirmed by read-back');
        return;
      }
      if (this.overlayAttempts >= this.maxOverlayAttempts) {
        console.error(
          `MAVProxy: WARNING gave up reasserting the parameter overlay after ` +
          `${this.overlayAttempts} attempts. Still unconfirmed: ${missing.join(', ')}. ` +
          `RC_OVERRIDE_TIME may be at the flight controller's 3.0 s default — treat ` +
          `every critical parameter as unverified.`);
        return;
      }
      this.overlayAttempts += 1;
      console.error(`MAVProxy: overlay unconfirmed (${missing.join(', ')}) — ` +
        `reasserting, attempt ${this.overlayAttempts}/${this.maxOverlayAttempts}`);
      this.applyParamOverlay();
      this.overlayReassertTimer = setTimeout(check, this.overlayReassertMs);
    };
    if (this.overlayReassertTimer) clearTimeout(this.overlayReassertTimer);
    this.overlayReassertTimer = setTimeout(check, this.overlayReassertMs);
  }

  // Build MAVLink v1 PARAM_REQUEST_READ (msg id 20)
  // Payload: target_system(uint8), target_component(uint8), param_id(char[16]), param_index(int16) = 20 bytes
  // Wire order: param_index(int16), target_system(uint8), target_component(uint8), param_id(char[16])
  buildParamRequestRead(name) {
    const payloadLen = 20;
    const buf = Buffer.alloc(6 + payloadLen + 2);

    let i = 0;
    buf[i++] = 0xFE;
    buf[i++] = payloadLen;
    buf[i++] = this.seq & 0xFF; this.seq++;
    buf[i++] = 255;
    buf[i++] = 0;
    buf[i++] = MAVLINK_MSG_ID_PARAM_REQUEST_READ;

    buf.writeInt16LE(-1, i); i += 2; // -1 = look up by name
    buf[i++] = this.target_system;
    buf[i++] = this.target_component;

    const paramName = Buffer.alloc(16, 0);
    paramName.write(String(name).slice(0, 16), 0, 'ascii');
    paramName.copy(buf, i); i += 16;

    let crc = PWMMavproxy.crc16(buf.subarray(1, 6 + payloadLen), 5 + payloadLen);
    crc = PWMMavproxy.crcAccumulate(PARAM_REQUEST_READ_CRC_EXTRA, crc);
    buf.writeUInt16LE(crc, 6 + payloadLen);
    return buf;
  }

  // MAVLink v1/v2 byte-stream parser.
  //
  // v2 (0xFD) is not optional: MAVProxy on this platform forwards v2 EXCLUSIVELY.
  // Measured on rover3 — 1028 v2 frames and zero v1 frames in 12 s. A v1-only
  // parser therefore receives nothing it can parse, and because the previous
  // version also did no CRC check, it would resync onto a chance 0xFE byte inside
  // a v2 payload, misread the following bytes as a header, and occasionally
  // announce a "Pixhawk heartbeat" from pure garbage. Every frame we DECODE is now
  // CRC-verified and attributed to the configured target system before it is
  // believed. Messages we do not decode cannot be CRC-verified — we have no
  // CRC_EXTRA for them — so their declared length is only trusted when the byte
  // past it looks like another frame start.
  parseIncoming(data) {
    this.rxBuf = this.rxBuf ? Buffer.concat([this.rxBuf, data]) : Buffer.from(data);
    // Bound the buffer: a desynchronised stream that never yields a valid frame
    // would otherwise grow it without limit.
    if (this.rxBuf.length > MAX_RX_BUFFER) {
      console.error(`MAVProxy: rx buffer exceeded ${MAX_RX_BUFFER} bytes — resyncing`);
      // Discard entirely: keeping a tail would leave us mid-frame, which is a
      // guaranteed desync and silently eats the next valid frame.
      this.rxBuf = Buffer.alloc(0);
    }

    while (this.rxBuf.length >= 8) {
      const magic = this.rxBuf[0];
      if (magic !== 0xFE && magic !== 0xFD) {
        this.rxBuf = this.rxBuf.subarray(1);   // resync
        continue;
      }

      const isV2       = magic === 0xFD;
      const headerLen  = isV2 ? 10 : 6;
      const payloadLen = this.rxBuf[1];
      if (this.rxBuf.length < headerLen + 2) return;   // need the header first

      // MAVLink requires a receiver to DISCARD any frame carrying an
      // incompatibility flag it does not understand, because such a flag can
      // change the framing itself — decoding anyway means decoding a layout we do
      // not know. Only bit 0 (signed) is understood here. Previously every other
      // bit was ignored, so a CRC-valid HEARTBEAT with incompat_flags=0x02 was
      // accepted as the autopilot.
      const incompat = isV2 ? this.rxBuf[2] : 0;
      if (incompat & ~0x01) {
        this.rxBuf = this.rxBuf.subarray(1);
        continue;
      }

      // Bit 0 = signed, which appends a 13-byte signature.
      const signatureLen = (incompat & 0x01) ? 13 : 0;
      const frameLen = headerLen + payloadLen + 2 + signatureLen;
      if (this.rxBuf.length < frameLen) return;        // wait for the rest

      const msgId = isV2
        ? this.rxBuf[7] | (this.rxBuf[8] << 8) | (this.rxBuf[9] << 16)
        : this.rxBuf[5];
      const sysId  = isV2 ? this.rxBuf[5] : this.rxBuf[3];
      const compId = isV2 ? this.rxBuf[6] : this.rxBuf[4];

      const crcExtra = MSG_CRC_EXTRA[msgId];

      if (crcExtra === undefined) {
        // A message we do not decode. We have no CRC_EXTRA for it, so we CANNOT
        // verify it — which means we must not blindly trust its declared length
        // either. Skipping `frameLen` unverified let a corrupted length consume the
        // valid frame that followed it, and it is why the earlier claim that
        // "every frame is CRC-verified" was not accurate.
        //
        // Only accept the declared length when the byte just past it actually
        // looks like the start of another frame (or the buffer ends there).
        // Otherwise treat this as garbage and resync a single byte.
        // We hold no CRC_EXTRA for this message, so we cannot verify it — and
        // therefore cannot trust its declared LENGTH either. Two earlier attempts to
        // salvage the length were both lossy: skipping it wholesale let a corrupted
        // length eat the next valid frame, and corroborating it with a lookahead
        // still failed, because the following frame's own magic byte corroborates a
        // false length just as well as a true one.
        //
        // So advance a single byte and rescan. The cost is scanning the bytes of
        // messages we do not decode — at 4 Hz over ~14 message types that is a few
        // thousand comparisons a second, which is nothing — and in exchange a frame
        // we cannot verify can never consume one we can.
        this.rxBuf = this.rxBuf.subarray(1);
        continue;
      }

      let expected = PWMMavproxy.crc16(
        this.rxBuf.subarray(1, headerLen + payloadLen),
        headerLen - 1 + payloadLen,
      );
      expected = PWMMavproxy.crcAccumulate(crcExtra, expected);
      if (this.rxBuf.readUInt16LE(headerLen + payloadLen) !== expected) {
        // Almost always a false resync onto a payload byte, not corruption, so
        // do not log per frame — that would be a log flood on a v2 stream.
        this.rxBuf = this.rxBuf.subarray(1);
        continue;
      }

      // v1 payload lengths are FIXED. Only v2 zero-trims, so a short v1 payload is
      // malformed rather than truncated, and padding it would invent field values
      // out of nothing — a CRC-valid 6-byte v1 HEARTBEAT was padded, accepted, and
      // triggered the parameter overlay before this check existed.
      if (!isV2 && payloadLen !== MSG_PAYLOAD_LEN[msgId]) {
        this.rxBuf = this.rxBuf.subarray(1);
        continue;
      }

      // Attribute EVERY decoded message to the configured target, not just
      // HEARTBEAT. sysId was captured but only the heartbeat handler checked it, so
      // SYS_STATUS, POWER_STATUS and especially PARAM_VALUE accepted data from any
      // system sharing the link — meaning a foreign vehicle could supply battery
      // readings or populate verifiedCriticalParams for our target. That matters
      // more now the overlay is applied on connect and the heartbeat exists to
      // VERIFY it: unattributed read-backs make the verification meaningless.
      // RADIO_STATUS is exempt: it describes the LINK and is emitted by the radio
      // itself, not the autopilot. SiK firmware sends it with source system 51
      // (ASCII '3'), so a blanket target-system gate silently drops the very radio
      // telemetry this driver exists to report — a regression introduced by the
      // first version of this gate and caught only by review, because rover3 has
      // no SiK radio fitted to notice.
      //
      // Everything else we decode is autopilot state, so it must come from the
      // configured system AND component. compId was previously not checked at all:
      // a CRC-valid PARAM_VALUE from sysId 1 / compId 99 added entries to
      // verifiedCriticalParams, which would make the verification the overlay
      // depends on trivially forgeable by anything else on the link.
      const isRadio = msgId === MSG_RADIO_STATUS;
      if (isRadio) {
        // RADIO_STATUS comes from the RADIO, not the autopilot — SiK emits source
        // system 51 (ASCII '3'), so gating it on target_system silently drops the
        // radio telemetry this driver exists to report.
        //
        // The default accepts any source because a SiK's sysId varies with firmware
        // and configuration, and there is no way to know it in advance. That IS a
        // hole: anything able to inject on this link can spoof the displayed link
        // quality and suppress the Wi-Fi fallback. It is bounded by the fact that
        // radio telemetry is display-only — it feeds no status bit, no arming
        // decision and no control path — and it is closable by setting
        // mavproxy_radio_system once the fitted radio's sysId is known.
        if (this.radioSystem !== null && sysId !== this.radioSystem) {
          this.rxBuf = this.rxBuf.subarray(frameLen);
          continue;
        }
      } else if (sysId !== this.target_system || compId !== this.target_component) {
        this.rxBuf = this.rxBuf.subarray(frameLen);
        continue;
      }

      // v2 zero-trims trailing zero bytes, so a 31-byte SYS_STATUS can arrive as
      // 17. Reading fields at fixed offsets from a truncated payload yields
      // garbage — measured: current_battery read as -25813 instead of 43, and
      // POWER_STATUS.flags as 36901 instead of 37. Zero-extend to the declared
      // length so every offset is valid and absent trailing fields read as 0.
      const payload = PWMMavproxy.zeroExtend(
        this.rxBuf.subarray(headerLen, headerLen + payloadLen),
        MSG_PAYLOAD_LEN[msgId],
      );
      this.handleMessage(msgId, payload, { sysId, compId, mavlinkVersion: isV2 ? 2 : 1 });

      this.rxBuf = this.rxBuf.subarray(frameLen);
    }
  }

  // Record a voltage reading and return the median of the recent window, or null
  // if there is nothing usable. Kept separate from the mapping so the smoothing is
  // testable on its own — a smoothing bug that only shows up through the
  // percentage is hard to attribute.
  smoothedBatteryVolts(voltageV, now = Date.now()) {
    if (!Number.isFinite(voltageV)) return null;

    // Discard the window when the stream has been INTERRUPTED, not just when the
    // socket closed. Clearing on close alone missed the case that matters most: a
    // Pixhawk reboot or a paused SYS_STATUS stream leaves MAVProxy connected, so
    // five stale 8.4 V samples outvoted a fresh 6.0 V reading and reported ~100% —
    // which does not merely look wrong, it CLEARS the low-battery warning.
    const last = this.batteryVoltHistory.length
      ? this.batteryVoltHistory[this.batteryVoltHistory.length - 1].at
      : null;
    if (last !== null && (now - last) > TELEMETRY_STALE_MS) {
      this.batteryVoltHistory = [];
    }

    this.batteryVoltHistory.push({ v: voltageV, at: now });
    // Bound the window. This runs on every SYS_STATUS frame (~4 Hz, indefinitely),
    // so an unbounded history is a slow leak on a process that must stay up for
    // days.
    while (this.batteryVoltHistory.length > this.batteryPctSamples) {
      this.batteryVoltHistory.shift();
    }
    const sorted = this.batteryVoltHistory.map((e) => e.v).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  // Linear interpolation between the configured empty and full voltages, clamped
  // to 0..100. Deliberately NOT a chemistry curve: a curve implies knowledge of
  // the pack we do not have, and a wrong curve is more misleading than an honest
  // straight line between two numbers the operator supplied.
  batteryPctFromVolts(voltageV) {
    if (!this.batteryRange || !Number.isFinite(voltageV)) return null;
    const { emptyV, fullV } = this.batteryRange;
    const pct = ((voltageV - emptyV) / (fullV - emptyV)) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  // Pad a zero-trimmed v2 payload back to its declared length.
  static zeroExtend(payload, expectedLen) {
    if (payload.length >= expectedLen) return payload;
    const out = Buffer.alloc(expectedLen);
    payload.copy(out);
    return out;
  }

  handleMessage(msgId, payload, metadata = {}) {
    if (msgId === MSG_SYS_STATUS) {
      // Wire order: sensors_present/enabled/health (3x uint32), load(uint16),
      // voltage_battery(uint16, mV), current_battery(int16, cA), drop_rate_comm,
      // errors_comm, errors_count1..4 (uint16), battery_remaining(int8, %).
      const voltage_mV  = payload.readUInt16LE(14);
      const current_cA  = payload.readInt16LE(16);
      const remaining   = payload.readInt8(30);
      // 65535 means "not measured" per the spec. 0 means the same thing in
      // practice: ArduPilot sends 0 when BATT_MONITOR is unset. Reporting that as
      // "0.0 V" would be indistinguishable from a dead pack on the operator's
      // display, and would permanently latch any batteryWarnVolts alarm.
      const voltageV = (voltage_mV === 0 || voltage_mV === 0xFFFF) ? null : voltage_mV / 1000;

      // -1 means not measured; ArduPilot also reports 0 when it is not
      // coulomb-counting, which is indistinguishable from a genuinely flat pack.
      // Treat both as unknown.
      // A signed byte carries 1..127, but only 1..100 is a valid percentage. 127
      // was being labelled 'flightcontroller' and rendered as 127%, which also
      // cleared the low-battery warning.
      const fcPct = (remaining > 0 && remaining <= 100) ? remaining : null;

      // Fall back to a voltage estimate only when the flight controller has
      // nothing usable, so a vehicle that DOES coulomb-count keeps its more
      // accurate reading. pctSource tells the operator which they are looking at:
      // an estimate sags under load and must not be presented as a fuel gauge.
      const smoothedV    = voltageV === null ? null : this.smoothedBatteryVolts(voltageV);
      const estimatedPct = fcPct === null ? this.batteryPctFromVolts(smoothedV) : null;

      this.telemetry.battery = {
        voltageV,
        currentA:   current_cA === -1 ? null : current_cA / 100,
        remainingPct: fcPct !== null ? fcPct : estimatedPct,
        // 'flightcontroller' = coulomb-counted and trustworthy.
        // 'voltage'          = interpolated from the configured pack range, smoothed.
        // null               = no percentage available at all.
        pctSource: fcPct !== null ? 'flightcontroller' : (estimatedPct !== null ? 'voltage' : null),
        at: Date.now(),
      };
      return;
    }

    if (msgId === MSG_POWER_STATUS) {
      // Wire order: Vcc(uint16, mV), Vservo(uint16, mV), flags(uint16).
      this.telemetry.power = {
        boardV: payload.readUInt16LE(0) / 1000,
        servoV: payload.readUInt16LE(2) / 1000,
        flags:  payload.readUInt16LE(4),
        at: Date.now(),
      };
      return;
    }

    if (msgId === MSG_RADIO_STATUS) {
      // Wire order: rxerrors(uint16), fixed(uint16), rssi, remrssi, txbuf, noise,
      // remnoise (uint8). SiK reports rssi/noise in raw radio units, not dBm.
      // UINT8_MAX means "invalid / not measured" for these fields, so reporting 255
      // renders as a plausible-looking link quality when there is no measurement at
      // all — and it also suppressed the Wi-Fi fallback, which IS measured.
      const rssiOrNull = (v) => (v === 255 ? null : v);
      const rssi    = rssiOrNull(payload.readUInt8(4));
      const remRssi = rssiOrNull(payload.readUInt8(5));
      // If neither end reports a signal level, this frame carries no link
      // measurement. Keeping a non-null radio object made the UI select it purely by
      // truthiness and render "Radio: null/null", which SUPPRESSED the Wi-Fi
      // fallback — the one link quality that is actually measured here.
      if (rssi === null && remRssi === null) { this.telemetry.radio = null; return; }
      this.telemetry.radio = {
        rssi,
        remRssi,
        noise:    rssiOrNull(payload.readUInt8(7)),
        remNoise: rssiOrNull(payload.readUInt8(8)),
        rxErrors: payload.readUInt16LE(0),
        fixed:    payload.readUInt16LE(2),
        txbuf:    payload.readUInt8(6),
        at: Date.now(),
      };
      return;
    }

    if (msgId === MSG_HEARTBEAT) {
      // HEARTBEAT payload: custom_mode(uint32), type, autopilot, base_mode,
      // system_status, mavlink_version.
      //
      // Only an AUTOPILOT heartbeat proves the flight controller is there.
      // MAV_AUTOPILOT_INVALID (8) is what a GCS sends — including this driver's
      // own heartbeat — so accepting it would mean announcing a flight controller
      // because we heard ourselves.
      if (payload[5] === MAV_AUTOPILOT_INVALID) return;
      if (metadata.sysId !== undefined && metadata.sysId !== this.target_system) return;
      this.telemetry.heartbeat = { at: Date.now(), armed: (payload[6] & 0x80) !== 0 };
      // payload[4] (MAV_TYPE) had never been read anywhere in this driver, and
      // payload[5] was only tested for "not a GCS". They are the only evidence on the
      // link of WHAT the overlay is being written to — see noteAutopilotIdentity.
      this.noteAutopilotIdentity(payload[5], payload[4]);
      if (!this.pixhawkHeartbeatSeen) {
        console.log('MAVProxy: Received first Pixhawk heartbeat ' +
          `(sys=${metadata.sysId ?? '?'} MAVLink ${metadata.mavlinkVersion ?? '?'})`);
        this.pixhawkHeartbeatSeen = true;
      }
      // Deliberately does NOT trigger the parameter overlay — that happens on
      // connect (see _connect). Making the overlay depend on hearing the autopilot
      // was fail-open: a return path that never delivers left RC_OVERRIDE_TIME at
      // the flight controller's 3.0 s default while the vehicle stayed drivable.
      return;
    }

    if (msgId === MAVLINK_MSG_ID_PARAM_VALUE && payload.length >= 25) {
      // PARAM_VALUE wire order: param_value(float32), param_count(uint16),
      // param_index(uint16), param_id(char[16]), param_type(uint8)
      const value = payload.readFloatLE(0);
      const nameRaw = payload.subarray(8, 24).toString('ascii');
      const name = nameRaw.replace(/\0.*$/, '').trim();
      if (Object.prototype.hasOwnProperty.call(EXPECTED_CRITICAL_PARAMS, name)) {
        const expected = EXPECTED_CRITICAL_PARAMS[name];

        let actual = value;
        let matches = false;

        if (Object.prototype.hasOwnProperty.call(EXPECTED_FLOAT_TOLERANCE, name)) {
          const tolerance = EXPECTED_FLOAT_TOLERANCE[name];
          matches = Math.abs(actual - expected) <= tolerance;
          actual = Number(actual.toFixed(3));
        } else {
          actual = Math.round(actual);
          matches = actual === expected;
        }

        if (!matches) {
          this.verifiedCriticalParams.delete(name);
          this.paramVerificationFailures.set(name, { actual, expected });
          console.error(
            `MAVProxy: WARNING ${name}=${actual} on flight controller ` +
            `but expected ${expected}. Outputs will be miswired ` +
            `(e.g. steering will drive throttle). ` +
            // Two corrections to this advice. It told the operator to check FRAME_CLASS
            // on firmware that may have no such parameter — say what was actually
            // measured instead. And "power-cycle" was wrong even on ArduRover: the
            // FRAME_CLASS change on 2026-08-04 was observed taking effect live, with the
            // HEARTBEAT MAV_TYPE moving 11 SURFACE_BOAT -> 10 GROUND_ROVER and no reboot.
            (this.firmwareMismatch
              ? `This autopilot is not an ArduRover (${this.firmwareMismatch}), so this ` +
                `parameter may not exist or may not mean what is expected here.`
              : `Check FRAME_CLASS=1 (Rover) and that the firmware is ArduRover.`)
          );
        } else {
          this.paramVerificationFailures.delete(name);
          this.verifiedCriticalParams.add(name);
          console.log(`MAVProxy: verified ${name}=${actual}`);
        }
      }
    }
  }

  // Build MAVLink v1 COMMAND_LONG (msg id 76)
  // Payload: param1-7 (7x float32) + command(uint16) + target_system(uint8) + target_component(uint8) + confirmation(uint8) = 33 bytes
  buildCommandLong(command, param1 = 0, param2 = 0, param3 = 0, param4 = 0, param5 = 0, param6 = 0, param7 = 0) {
    const payloadLen = 33;
    const buf = Buffer.alloc(6 + payloadLen + 2);

    let i = 0;
    buf[i++] = 0xFE;
    buf[i++] = payloadLen;
    buf[i++] = this.seq & 0xFF; this.seq++;
    buf[i++] = 255;  // sysid (GCS)
    buf[i++] = 0;    // compid
    buf[i++] = MAVLINK_MSG_ID_COMMAND_LONG;

    // Payload (wire order: floats first, then uint16, then uint8s)
    buf.writeFloatLE(param1, i); i += 4;
    buf.writeFloatLE(param2, i); i += 4;
    buf.writeFloatLE(param3, i); i += 4;
    buf.writeFloatLE(param4, i); i += 4;
    buf.writeFloatLE(param5, i); i += 4;
    buf.writeFloatLE(param6, i); i += 4;
    buf.writeFloatLE(param7, i); i += 4;
    buf.writeUInt16LE(command, i); i += 2;
    buf[i++] = this.target_system;
    buf[i++] = this.target_component;
    buf[i++] = 0; // confirmation

    let crc = PWMMavproxy.crc16(buf.subarray(1, 6 + payloadLen), 5 + payloadLen);
    crc = PWMMavproxy.crcAccumulate(COMMAND_LONG_CRC_EXTRA, crc);
    buf.writeUInt16LE(crc, 6 + payloadLen);
    return buf;
  }

  // Arm the vehicle and set MANUAL mode
  arm() {
    console.log('MAVProxy: Sending ARM + MANUAL mode...');
    // Set mode to MANUAL (mode number 0 for ArduRover MANUAL)
    // MANUAL mode = 0, but must include proper base mode flag
    this.sendPacket(this.buildCommandLong(MAV_CMD_DO_SET_MODE, 1, 0));

    // The ARM itself is deferred so the mode change lands first. The handle is
    // TRACKED: an untracked timer here meant a disarm could not cancel a pending
    // arm, so a fail-safe would send DISARM and then the vehicle would re-arm
    // itself a moment later with no operator action at all.
    if (this.armTimeout) clearTimeout(this.armTimeout);
    this.armTimeout = setTimeout(() => {
      this.armTimeout = null;
      // Arm: MAV_CMD_COMPONENT_ARM_DISARM param1=1 (arm), param2=21196 (force)
      this.sendPacket(this.buildCommandLong(MAV_CMD_COMPONENT_ARM_DISARM, 1, 21196));
      console.log('MAVProxy: ARM command sent');
    }, this.armDelayMs);
    return true;
  }

  // Latest telemetry, with staleness resolved so callers cannot accidentally
  // present a last-known value as a live one. `radio` is null on this platform
  // unless a SiK telemetry radio is fitted — nothing emits RADIO_STATUS otherwise
  // (verified: zero RADIO_STATUS frames in 656,375 logged messages on rover3).
  getTelemetry() {
    const now = Date.now();
    const fresh = (entry) => entry && (now - entry.at) <= TELEMETRY_STALE_MS;
    const out = {
      battery: fresh(this.telemetry.battery) ? { ...this.telemetry.battery } : null,
      power:   fresh(this.telemetry.power)   ? { ...this.telemetry.power }   : null,
      radio:   fresh(this.telemetry.radio)   ? { ...this.telemetry.radio }   : null,
      linkUp:  !!(this.client && !this.client.destroyed),
      // Coerced: `fresh()` short-circuits to null on a missing entry, and a
      // consumer checking this field deserves a boolean, not null-vs-false.
      autopilotHeartbeat: !!fresh(this.telemetry.heartbeat),
      // True when we are connected but have never identified the autopilot. It does NOT
      // mean the overlay is unapplied — the overlay is pushed on connect, before this
      // can be known (see noteAutopilotIdentity). The comment here said the opposite
      // until 2026-08-12, describing behaviour removed when the overlay moved off the
      // heartbeat.
      awaitingAutopilot: !!(this.client && !this.client.destroyed && !this.pixhawkHeartbeatSeen),
      // What the autopilot says it is, and whether that matches what the overlay is
      // written for. Surfaced so /status can show a misidentified flight controller
      // rather than leaving it in the journal.
      firmware: {
        autopilot: this.autopilotIdent ? this.autopilotIdent.autopilot : null,
        type:      this.autopilotIdent ? this.autopilotIdent.type : null,
        mismatch:  this.firmwareMismatch,
        overlaySuppressed: this.overlaySuppressed,
      },
      params: {
        verified: [...this.verifiedCriticalParams].sort(),
        missing: Object.keys(EXPECTED_CRITICAL_PARAMS)
          .filter((n) => !this.verifiedCriticalParams.has(n)).sort(),
        mismatched: Object.fromEntries(this.paramVerificationFailures),
      },
    };
    for (const key of ['battery', 'power', 'radio']) {
      if (out[key]) { out[key].ageMs = now - out[key].at; delete out[key].at; }
    }
    return out;
  }

  // Disarm the vehicle. Returns whether the DISARM packet reached the socket, so
  // callers can distinguish a real disarm from a silently failed one.
  disarm() {
    console.log('MAVProxy: Sending DISARM...');
    // Cancel any pending arm first, or it would fire after this disarm.
    if (this.armTimeout) {
      clearTimeout(this.armTimeout);
      this.armTimeout = null;
      console.log('MAVProxy: cancelled a pending ARM');
    }
    // Disarm: param1=0 (disarm), param2=21196 (force)
    return this.sendPacket(this.buildCommandLong(MAV_CMD_COMPONENT_ARM_DISARM, 0, 21196));
  }
}

module.exports = PWMMavproxy;
// Exported so tests can read the REAL list rather than transcribing it. A test that
// hard-coded a fallback copy was silently always using the copy, because
// require(...).EXPECTED_CRITICAL_PARAMS on a module-scoped const is undefined — and
// the copy had drifted to a different tree's contents.
module.exports.EXPECTED_CRITICAL_PARAMS = EXPECTED_CRITICAL_PARAMS;
module.exports.DEFAULT_PARAM_OVERLAY = DEFAULT_PARAM_OVERLAY;
// Exported for the load-time consistency check's own test. Every decoded message
// needs BOTH a CRC_EXTRA and a declared payload length; the throw above enforces it
// at load, and nothing proved the throw fires.
module.exports.MSG_CRC_EXTRA = MSG_CRC_EXTRA;
module.exports.MSG_PAYLOAD_LEN = MSG_PAYLOAD_LEN;

