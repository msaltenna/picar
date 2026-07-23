'use strict';

const crypto = require('crypto');

class ControlSafetyController {
  constructor(pwm, config = {}, options = {}) {
    this.pwm = pwm;
    this.neutral = config.control_neutral ?? 0;
    this.inputTimeoutMs = config.input_timeout_ms ?? 500;
    this.maxCommandAgeMs = config.max_command_age_ms ?? 500;
    this.maxFutureSkewMs = config.max_command_future_skew_ms ?? 100;
    this.maxControlRttMs = config.max_control_rtt_ms ?? (this.maxCommandAgeMs * 2);

    this.now = options.now || Date.now;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.makeToken = options.makeToken || (() => crypto.randomBytes(24).toString('hex'));
    this.log = options.log || console;
    this.onFailSafe = options.onFailSafe || (() => {});

    this.ownerSocketId = null;
    this.controlSession = null;
    this.armClientTime = null;
    this.armServerTime = null;
    this.clientClockOffsetMs = null;
    this.lastSequence = -1;
    this.watchdog = null;
    this.flightControllerArmed = false;
    this.throttle = this.neutral;
    this.steering = this.neutral;
    this.lastStopReason = 'startup';

    this._neutralize('startup');
  }

  getStatus() {
    return {
      armed: this.flightControllerArmed,
      controllerConnected: this.ownerSocketId !== null,
      throttle: this.throttle,
      steering: this.steering,
      lastStopReason: this.lastStopReason,
      flightController: typeof this.pwm.getSafetyStatus === 'function'
        ? this.pwm.getSafetyStatus()
        : null,
    };
  }

  arm(socketId, request = {}) {
    if (!socketId) return { ok: false, error: 'missing socket identity' };
    if (this.ownerSocketId !== null) {
      return {
        ok: false,
        error: this.ownerSocketId === socketId
          ? 'this controller already owns the active session'
          : 'another controller owns the active session',
      };
    }
    if (!Number.isFinite(request.clientTime)) {
      return { ok: false, error: 'missing client clock sample' };
    }

    this._neutralize('pre-arm');
    const flightControllerStatus = typeof this.pwm.getSafetyStatus === 'function'
      ? this.pwm.getSafetyStatus()
      : null;
    if (flightControllerStatus && flightControllerStatus.readyToArm === false) {
      return {
        ok: false,
        error: 'flight controller is not ready to arm',
        flightController: flightControllerStatus,
      };
    }

    const serverTime = this.now();
    this.ownerSocketId = socketId;
    this.controlSession = this.makeToken();
    this.armClientTime = request.clientTime;
    this.armServerTime = serverTime;
    this.clientClockOffsetMs = null;
    this.lastSequence = -1;
    this.flightControllerArmed = false;
    this.lastStopReason = null;
    this._scheduleWatchdog();

    this.log.log(`Control safety: session granted to ${socketId}`);
    return {
      ok: true,
      controlSession: this.controlSession,
      serverTime,
    };
  }

  handleCommand(socketId, data) {
    if (socketId !== this.ownerSocketId) {
      return { ok: false, error: 'socket does not own the active session' };
    }
    if (!data || data.controlSession !== this.controlSession) {
      return { ok: false, error: 'invalid control session' };
    }
    if (!Number.isSafeInteger(data.seq) || data.seq <= this.lastSequence) {
      return { ok: false, error: 'replayed or out-of-order command' };
    }
    if (!Number.isFinite(data.sentAt)) {
      this._failSafe('command-without-timestamp');
      return { ok: false, error: 'missing command timestamp' };
    }

    if (this.clientClockOffsetMs === null) {
      if (!Number.isFinite(data.armAckAt)) {
        this._failSafe('missing-clock-handshake');
        return { ok: false, error: 'missing clock handshake' };
      }
      const handshakeRttMs = data.armAckAt - this.armClientTime;
      if (handshakeRttMs < 0 || handshakeRttMs > this.maxControlRttMs) {
        this._failSafe('control-link-too-slow');
        return { ok: false, error: 'control link latency exceeds safety limit', handshakeRttMs };
      }

      // NTP-style midpoint estimate. Unlike using server receive time minus
      // client send time, this does not hide the network latency itself.
      this.clientClockOffsetMs = this.armServerTime
        - ((this.armClientTime + data.armAckAt) / 2);
    }

    const estimatedServerSentAt = data.sentAt + this.clientClockOffsetMs;
    const commandAgeMs = this.now() - estimatedServerSentAt;
    if (commandAgeMs > this.maxCommandAgeMs || commandAgeMs < -this.maxFutureSkewMs) {
      this._failSafe('stale-command');
      return { ok: false, error: 'stale command', commandAgeMs };
    }

    const throttle = this._normalizedOrNeutral(data.throttle);
    const steering = this._normalizedOrNeutral(data.steering);

    if (!this.flightControllerArmed) {
      if (Math.abs(throttle - this.neutral) > 1e-9
          || Math.abs(steering - this.neutral) > 1e-9) {
        this._failSafe('non-neutral-first-command', true);
        return { ok: false, error: 'first command must be neutral' };
      }

      let armResult;
      try {
        armResult = typeof this.pwm.arm === 'function' ? this.pwm.arm() : { ok: true };
      } catch (err) {
        this.log.error('Control safety: arm failed:', err);
        this._failSafe('flight-controller-arm-failed', true);
        return { ok: false, error: 'flight controller arm command failed' };
      }
      if (armResult === false || (armResult && armResult.ok === false)) {
        this._failSafe('flight-controller-arm-refused', true);
        return {
          ok: false,
          error: armResult && armResult.error
            ? armResult.error
            : 'flight controller is not ready to arm',
        };
      }
      this.flightControllerArmed = true;
    }

    this.lastSequence = data.seq;
    this.throttle = throttle;
    this.steering = steering;

    this.pwm.setServoPWM('throttle', throttle);
    this.pwm.setServoPWM('steering', steering);
    this._setOptionalChannel('shift', data.shift);
    this._setOptionalChannel('tlock_front', data.tlock_front);
    this._setOptionalChannel('tlock_rear', data.tlock_rear);
    this._scheduleWatchdog();

    return { ok: true };
  }

  disarm(socketId, request = {}) {
    if (this.ownerSocketId === null) return { ok: true };
    if (socketId !== this.ownerSocketId) {
      return { ok: false, error: 'socket does not own the active session' };
    }
    if (request.controlSession !== this.controlSession) {
      return { ok: false, error: 'invalid control session' };
    }
    this._failSafe('operator-disarm');
    return { ok: true };
  }

  disconnect(socketId) {
    if (socketId === this.ownerSocketId) this._failSafe('controller-disconnect');
  }

  shutdown() {
    this._failSafe('server-shutdown', true);
  }

  _normalizedOrNeutral(value) {
    return Number.isFinite(value)
      ? Math.max(-1, Math.min(1, value))
      : this.neutral;
  }

  _setOptionalChannel(name, value) {
    if (!Number.isFinite(value)) return;
    this.pwm.setServoPWM(name, Math.max(-1, Math.min(1, value)));
  }

  _scheduleWatchdog() {
    if (this.watchdog) this.clearTimer(this.watchdog);
    this.watchdog = this.setTimer(
      () => this._failSafe('input-timeout'),
      this.inputTimeoutMs,
    );
  }

  _neutralize(reason) {
    this.throttle = this.neutral;
    this.steering = this.neutral;
    this.lastStopReason = reason;
    this.pwm.setServoPWM('throttle', this.neutral);
    this.pwm.setServoPWM('steering', this.neutral);
  }

  _failSafe(reason, forceDisarm = false) {
    if (this.watchdog) {
      this.clearTimer(this.watchdog);
      this.watchdog = null;
    }

    const stoppedSocketId = this.ownerSocketId;
    const hadOwner = stoppedSocketId !== null;
    this._neutralize(reason);

    if ((hadOwner || forceDisarm) && typeof this.pwm.disarm === 'function') {
      try {
        this.pwm.disarm();
      } catch (err) {
        this.log.error('Control safety: disarm failed:', err);
      }
    }

    this.ownerSocketId = null;
    this.controlSession = null;
    this.armClientTime = null;
    this.armServerTime = null;
    this.clientClockOffsetMs = null;
    this.lastSequence = -1;
    this.flightControllerArmed = false;
    if (hadOwner) this.onFailSafe({ reason, socketId: stoppedSocketId });
    this.log.error(`### FAIL-SAFE STOP (${reason})`);
  }
}

module.exports = ControlSafetyController;
