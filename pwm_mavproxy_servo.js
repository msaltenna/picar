// pwm_mavproxy_servo.js
// Sends RC_CHANNELS_OVERRIDE to MAVProxy over TCP
// Node acts as TCP SERVER, MAVProxy connects as client with --out=tcp:127.0.0.1:5760
// Uses proper MAVLink v1 framing with CRC

const net = require('net');

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
const DISCRETE_CHANNELS = new Set(['shift', 'tlock_front', 'tlock_rear']);

// ── Inbound messages we decode ───────────────────────────────────────────────
//
// CRC_EXTRA values and wire field orders were taken from pymavlink's own message
// definitions on the target, not from memory — the framing here is hand-rolled, so
// a wrong constant fails silently rather than loudly.
const MSG_HEARTBEAT    = 0;
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
const DEFAULT_PARAM_OVERLAY = {
  SERVO1_FUNCTION: 26, // GroundSteering on RC1 (steering)
  SERVO2_FUNCTION: 1,  // RC passthrough: transmission on RC2
  SERVO3_FUNCTION: 70, // Throttle on RC3
  SERVO4_FUNCTION: 1,  // RC passthrough: front diff on RC4
  SERVO5_FUNCTION: 1,  // RC passthrough: rear diff on RC5
  FRAME_CLASS: 2,      // Rover (must be set or steering/throttle outputs are wrong)
  RC_OVERRIDE_TIME: 0.2, // release stale overrides quickly if packets stop
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
  FRAME_CLASS: 2,
  RC_OVERRIDE_TIME: 0.2
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

    this.paramOverlay = config.mavproxy_param_overlay || DEFAULT_PARAM_OVERLAY;
    this.applyParamOverlayOnConnect = config.mavproxy_apply_param_overlay !== false;

    this.seq = 0;
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
    this.channelMap = {
      throttle: 2,    // RC channel 3 (0-indexed)
      shift: 1,       // RC channel 2 (0-indexed)
      steering: 0,    // RC channel 1 (0-indexed)
      tlock_front: 3, // RC channel 4 (0-indexed)
      tlock_rear: 4   // RC channel 5 (0-indexed)
    };

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

      // The parameter overlay — which writes RC_OVERRIDE_TIME, the flight
      // controller's own stale-override failsafe — is gated behind a genuine
      // autopilot heartbeat. That gate is correct, but a silent failure to meet it
      // would leave ArduPilot's 3.0 s default standing instead of 0.2 s, a 15x
      // longer window in which stale overrides persist. So say so, loudly, rather
      // than letting the journal simply go quiet.
      if (this.heartbeatWatch) clearTimeout(this.heartbeatWatch);
      this.heartbeatWatch = setTimeout(() => {
        this.heartbeatWatch = null;
        if (!this.pixhawkHeartbeatSeen) {
          console.error(
            `MAVProxy: WARNING no autopilot heartbeat from sys=${this.target_system} ` +
            `after ${this.heartbeatTimeoutMs} ms although the TCP link is up. ` +
            `The parameter overlay has NOT been applied, so RC_OVERRIDE_TIME is ` +
            `whatever the flight controller already had. Check SYSID_THISMAV and ` +
            `mavproxy_target_system.`);
        }
      }, this.heartbeatTimeoutMs);

      // A reconnect must never inherit an armed vehicle. ArduPilot arm state
      // survives a picar restart, a crash, and a companion-computer reboot — this
      // flight controller has been observed sitting armed with no operator
      // connected. So put neutral and DISARM on the link BEFORE starting the
      // override stream, and make the operator re-arm deliberately.
      this.neutralizeAndDisarm();
      this.startLoop();
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

  applyParamOverlay() {
    const entries = Object.entries(this.paramOverlay || {});
    if (entries.length === 0) return;

    this.verifiedCriticalParams.clear();
    this.paramVerificationFailures.clear();
    console.log('MAVProxy: Applying minimal Pixhawk param overlay...');

    entries.forEach(([name, value], index) => {
      setTimeout(() => {
        console.log(`MAVProxy: PARAM_SET ${name}=${value}`);
        this.sendPacket(this.buildParamSet(name, value));
      }, index * 250);
    });

    // After all writes, read back critical params and warn loudly if
    // anything doesn't match. This catches the "steering also drives
    // throttle" class of failure on a fresh board.
    const writeWindowMs = entries.length * 250 + 500;
    Object.keys(EXPECTED_CRITICAL_PARAMS).forEach((name, index) => {
      setTimeout(() => {
        this.sendPacket(this.buildParamRequestRead(name));
      }, writeWindowMs + index * 150);
    });
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
  // announce a "Pixhawk heartbeat" from pure garbage. Every frame is now CRC-
  // verified before it is believed.
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

      // v2 incompat flag bit 0 = signed, which appends a 13-byte signature.
      const signatureLen = isV2 && (this.rxBuf[2] & 0x01) ? 13 : 0;
      const frameLen = headerLen + payloadLen + 2 + signatureLen;
      if (this.rxBuf.length < frameLen) return;        // wait for the rest

      const msgId = isV2
        ? this.rxBuf[7] | (this.rxBuf[8] << 8) | (this.rxBuf[9] << 16)
        : this.rxBuf[5];
      const sysId = isV2 ? this.rxBuf[5] : this.rxBuf[3];

      const crcExtra = MSG_CRC_EXTRA[msgId];
      if (crcExtra !== undefined) {
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
        // v2 zero-trims trailing zero bytes, so a 31-byte SYS_STATUS can arrive as
        // 17. Reading fields at fixed offsets from a truncated payload yields
        // garbage — measured: current_battery read as -25813 instead of 43, and
        // POWER_STATUS.flags as 36901 instead of 37. Zero-extend to the declared
        // length so every offset is valid and absent trailing fields read as 0.
        const payload = PWMMavproxy.zeroExtend(
          this.rxBuf.subarray(headerLen, headerLen + payloadLen),
          MSG_PAYLOAD_LEN[msgId] ?? payloadLen,
        );
        this.handleMessage(msgId, payload, { sysId, mavlinkVersion: isV2 ? 2 : 1 });
      }

      this.rxBuf = this.rxBuf.subarray(frameLen);
    }
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
      this.telemetry.battery = {
        // 65535 means "not measured" per the spec. 0 means the same thing in
        // practice: ArduPilot sends 0 when BATT_MONITOR is unset. Reporting that as
        // "0.0 V" would be indistinguishable from a dead pack on the operator's
        // display, and would permanently latch any batteryWarnVolts alarm.
        voltageV:   (voltage_mV === 0 || voltage_mV === 0xFFFF) ? null : voltage_mV / 1000,
        currentA:   current_cA === -1 ? null : current_cA / 100,
        // -1 means not measured; ArduPilot also reports 0 when BATT_CAPACITY is
        // unset, which is indistinguishable from a genuinely flat pack, so treat
        // both as unknown and let voltage be the trustworthy signal.
        remainingPct: remaining > 0 ? remaining : null,
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
      this.telemetry.radio = {
        rssi:     payload.readUInt8(4),
        remRssi:  payload.readUInt8(5),
        noise:    payload.readUInt8(7),
        remNoise: payload.readUInt8(8),
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
      if (payload[5] === 8) return;
      if (metadata.sysId !== undefined && metadata.sysId !== this.target_system) return;
      this.telemetry.heartbeat = { at: Date.now(), armed: (payload[6] & 0x80) !== 0 };
      if (!this.pixhawkHeartbeatSeen) {
        console.log('MAVProxy: Received first Pixhawk heartbeat ' +
          `(sys=${metadata.sysId ?? '?'} MAVLink ${metadata.mavlinkVersion ?? '?'})`);
        this.pixhawkHeartbeatSeen = true;
        if (this.applyParamOverlayOnConnect && !this.paramOverlayApplied) {
          this.applyParamOverlay();
          this.paramOverlayApplied = true;
        }
      }
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
            `(e.g. steering will drive throttle). Check FRAME_CLASS=2 (Rover) ` +
            `and that the firmware is ArduRover, then power-cycle.`
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
      // True when we are connected but have never identified the autopilot, which
      // means the parameter overlay has not been applied.
      awaitingAutopilot: !!(this.client && !this.client.destroyed && !this.pixhawkHeartbeatSeen),
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

