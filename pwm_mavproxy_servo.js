// pwm_mavproxy_servo.js
// Sends RC_CHANNELS_OVERRIDE to MAVProxy over TCP
// Node connects as a TCP client to MAVProxy --out=tcpin:127.0.0.1:5760
// Sends MAVLink v1 commands and parses verified MAVLink v1/v2 responses

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
const PARAM_VALUE_CRC_EXTRA = 220;

// MAV_CMD values
const MAV_CMD_COMPONENT_ARM_DISARM = 400;
const MAV_CMD_DO_SET_MODE = 176;

// MAV_PARAM_TYPE values
const MAV_PARAM_TYPE_REAL32 = 9;

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
  FRAME_CLASS: 1,      // Rover (2 is Boat)
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
  FRAME_CLASS: 1,
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
    this.allowUnverifiedArm = config.mavproxy_allow_unverified_arm === true;
    this.armDelayMs = config.mavproxy_arm_delay_ms ?? 500;

    this.seq = 0;
    this.client = null;   // the connected MAVProxy client socket
    this.controlEnabled = false;
    this.pixhawkHeartbeatSeen = false;
    this.paramOverlayApplied = false;
    this.verifiedCriticalParams = new Set();
    this.paramVerificationFailures = new Map();
    this.armTimeout = null;

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
    this.channelNeutral = {
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
      // A process/MAVProxy restart must never inherit an armed controller.
      // Command neutral and DISARM before beginning the normal send loop.
      this.disarm();
      this.startHeartbeat();
      this.startLoop();
    });

    socket.on('data', (data) => {
      this.parseIncoming(data);
    });

    socket.on('error', (err) => {
      // ECONNREFUSED means mavproxy isn't ready yet — retry quietly
      if (err.code !== 'ECONNREFUSED') {
        console.error('MAVProxy connection error:', err.message);
      }
    });

    socket.on('close', () => {
      console.log('MAVProxy: connection closed, retrying in 2s…');
      this.controlEnabled = false;
      this.pixhawkHeartbeatSeen = false;
      this.paramOverlayApplied = false;
      this.verifiedCriticalParams.clear();
      this.paramVerificationFailures.clear();
      this.neutralizeMotion();
      this.rxBuf = Buffer.alloc(0);
      if (this.armTimeout) {
        clearTimeout(this.armTimeout);
        this.armTimeout = null;
      }
      this.client = null;
      if (this.interval) { clearInterval(this.interval); this.interval = null; }
      if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
      setTimeout(() => this._connect(), 2000);
    });
  }

  sendPacket(buf) {
    if (this.client && !this.client.destroyed) {
      try {
        this.client.write(buf);
      } catch (e) {
        console.error('TCP write error:', e.message);
      }
    }
  }

  scale(value, name = null) {
    const midpoint = (this.max_us + this.min_us) / 2;
    const outputHalfRange = (this.max_us - this.min_us) / 2;

    if (!this.legacyInputScale) {
      const normalized = this.clamp(value, -1, 1);
      if (name && Object.prototype.hasOwnProperty.call(this.channelNeutral, name)) {
        const neutral = this.channelNeutral[name];
        const range = normalized >= 0
          ? this.max_us - neutral
          : neutral - this.min_us;
        return Math.round(neutral + normalized * range);
      }
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

  setServoPWM(name, value) {
    const ch = this.channelMap[name];
    if (ch === undefined || !Number.isFinite(value)) return false;

    const isMotionChannel = name === 'throttle' || name === 'steering';
    const isNeutralInput = this.legacyInputScale
      ? Math.abs(value - this.pwm_neutral) < 1e-9
      : Math.abs(value) < 1e-9;

    if (isMotionChannel && !this.controlEnabled && !isNeutralInput) return false;

    const scaled = isMotionChannel && isNeutralInput
      ? this.channelNeutral[name]
      : this.scale(value, name);
    this.channels[ch] = this.clamp(scaled, this.min_us, this.max_us);
    return true;
  }

  neutralizeMotion() {
    this.channels[this.channelMap.throttle] = this.channelNeutral.throttle;
    this.channels[this.channelMap.steering] = this.channelNeutral.steering;
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

  // Lightweight MAVLink v1/v2 byte-stream parser. We only care about
  // HEARTBEAT (to know the FC is alive) and PARAM_VALUE (to verify safety
  // parameters). MAVProxy commonly forwards MAVLink 2 frames (0xFD), so
  // accepting only v1 would silently disable all verification.
  parseIncoming(data) {
    this.rxBuf = this.rxBuf ? Buffer.concat([this.rxBuf, data]) : Buffer.from(data);
    while (this.rxBuf.length >= 8) {
      const magic = this.rxBuf[0];
      if (magic !== 0xFE && magic !== 0xFD) {
        // Resync: drop one byte
        this.rxBuf = this.rxBuf.subarray(1);
        continue;
      }

      const payloadLen = this.rxBuf[1];
      const isV2 = magic === 0xFD;
      const headerLen = isV2 ? 10 : 6;
      if (this.rxBuf.length < headerLen + 2) return;

      const signatureLen = isV2 && (this.rxBuf[2] & 0x01) ? 13 : 0;
      const frameLen = headerLen + payloadLen + 2 + signatureLen;
      if (this.rxBuf.length < frameLen) return; // wait for more

      const msgId = isV2
        ? this.rxBuf[7] | (this.rxBuf[8] << 8) | (this.rxBuf[9] << 16)
        : this.rxBuf[5];
      const sysId = isV2 ? this.rxBuf[5] : this.rxBuf[3];
      const componentId = isV2 ? this.rxBuf[6] : this.rxBuf[4];
      const payload = this.rxBuf.subarray(headerLen, headerLen + payloadLen);

      const crcExtra = msgId === 0
        ? HEARTBEAT_CRC_EXTRA
        : (msgId === MAVLINK_MSG_ID_PARAM_VALUE ? PARAM_VALUE_CRC_EXTRA : null);
      if (crcExtra !== null) {
        const crcInputLength = headerLen - 1 + payloadLen;
        let expectedCrc = PWMMavproxy.crc16(
          this.rxBuf.subarray(1, headerLen + payloadLen),
          crcInputLength,
        );
        expectedCrc = PWMMavproxy.crcAccumulate(crcExtra, expectedCrc);
        const receivedCrc = this.rxBuf.readUInt16LE(headerLen + payloadLen);
        if (receivedCrc !== expectedCrc) {
          console.error(
            `MAVProxy: dropping MAVLink ${isV2 ? 2 : 1} message ${msgId} with invalid CRC`
          );
          this.rxBuf = this.rxBuf.subarray(frameLen);
          continue;
        }
      }

      this.handleMessage(msgId, payload, { sysId, componentId, mavlinkVersion: isV2 ? 2 : 1 });
      this.rxBuf = this.rxBuf.subarray(frameLen);
    }
  }

  handleMessage(msgId, payload, metadata = {}) {
    if (metadata.sysId !== undefined && metadata.sysId !== this.target_system) return;

    if (msgId === 0) {
      // HEARTBEAT
      // Ignore GCS/MAVProxy heartbeats; only an autopilot heartbeat proves the
      // flight controller is available. HEARTBEAT.autopilot is payload byte 5.
      if (payload.length < 9 || payload[5] === 8) return;
      if (!this.pixhawkHeartbeatSeen) {
        console.log(
          `MAVProxy: Received first Pixhawk heartbeat ` +
          `(sys=${metadata.sysId ?? '?'} MAVLink ${metadata.mavlinkVersion ?? '?'})`
        );
        this.pixhawkHeartbeatSeen = true;
        if (this.applyParamOverlayOnConnect && !this.paramOverlayApplied) {
          this.applyParamOverlay();
          this.paramOverlayApplied = true;
        }
      }
    } else if (msgId === MAVLINK_MSG_ID_PARAM_VALUE && payload.length >= 25) {
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
            `(e.g. steering will drive throttle). Check FRAME_CLASS=1 (Rover) ` +
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

  getSafetyStatus() {
    const missingParams = Object.keys(EXPECTED_CRITICAL_PARAMS)
      .filter(name => !this.verifiedCriticalParams.has(name));
    return {
      readyToArm: this.isSafetyReady(),
      heartbeatSeen: this.pixhawkHeartbeatSeen,
      controlEnabled: this.controlEnabled,
      missingParams,
      mismatchedParams: Object.fromEntries(this.paramVerificationFailures),
      unverifiedArmOverride: this.allowUnverifiedArm,
    };
  }

  isSafetyReady() {
    if (!this.client || this.client.destroyed || !this.pixhawkHeartbeatSeen) return false;
    if (this.allowUnverifiedArm) return true;
    return this.paramVerificationFailures.size === 0
      && Object.keys(EXPECTED_CRITICAL_PARAMS)
        .every(name => this.verifiedCriticalParams.has(name));
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
    if (!this.isSafetyReady()) {
      const status = this.getSafetyStatus();
      const detail = status.heartbeatSeen
        ? `unverified parameters: ${status.missingParams.join(', ') || 'mismatch detected'}`
        : 'no flight-controller heartbeat';
      const error = `Refusing to arm: ${detail}`;
      console.error(`MAVProxy: ${error}`);
      return { ok: false, error };
    }

    console.log('MAVProxy: Sending ARM + MANUAL mode...');
    this.neutralizeMotion();
    this.controlEnabled = false;
    // Set mode to MANUAL (mode number 0 for ArduRover MANUAL)
    // MANUAL mode = 0, but must include proper base mode flag
    this.sendPacket(this.buildCommandLong(MAV_CMD_DO_SET_MODE, 1, 0));
    // Arm: MAV_CMD_COMPONENT_ARM_DISARM param1=1 (arm), param2=21196 (force)
    if (this.armTimeout) clearTimeout(this.armTimeout);
    this.armTimeout = setTimeout(() => {
      this.armTimeout = null;
      this.sendPacket(this.buildCommandLong(MAV_CMD_COMPONENT_ARM_DISARM, 1, 21196));
      this.controlEnabled = true;
      console.log('MAVProxy: ARM command sent');
    }, this.armDelayMs);
    return { ok: true };
  }

  // Disarm the vehicle
  disarm() {
    console.log('MAVProxy: Sending DISARM...');
    if (this.armTimeout) {
      clearTimeout(this.armTimeout);
      this.armTimeout = null;
    }
    this.neutralizeMotion();
    this.controlEnabled = false;
    // Disarm: param1=0 (disarm), param2=21196 (force)
    this.sendPacket(this.buildCommandLong(MAV_CMD_COMPONENT_ARM_DISARM, 0, 21196));
    return { ok: true };
  }
}

PWMMavproxy.DEFAULT_PARAM_OVERLAY = DEFAULT_PARAM_OVERLAY;
PWMMavproxy.EXPECTED_CRITICAL_PARAMS = EXPECTED_CRITICAL_PARAMS;

module.exports = PWMMavproxy;
