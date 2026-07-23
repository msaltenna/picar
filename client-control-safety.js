(function initClientControlSafety(root, factory) {
  const ClientControlLease = factory();
  if (typeof module === 'object' && module.exports) module.exports = ClientControlLease;
  if (root) root.ClientControlLease = ClientControlLease;
}(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  'use strict';

  return class ClientControlLease {
    constructor(now = Date.now) {
      this.now = now;
      this.stopped = true;
      this.token = null;
      this.sequence = 0;
      this.armAckAt = null;
    }

    begin(token, armAckAt) {
      if (!token) throw new Error('control session token is required');
      if (!Number.isFinite(armAckAt)) throw new Error('arm acknowledgement time is required');
      this.token = token;
      this.sequence = 0;
      this.armAckAt = armAckAt;
      this.stopped = false;
    }

    stop() {
      this.stopped = true;
      this.token = null;
      this.sequence = 0;
      this.armAckAt = null;
    }

    envelope(command) {
      if (this.stopped || !this.token) return null;
      return {
        ...command,
        controlSession: this.token,
        seq: this.sequence++,
        sentAt: this.now(),
        armAckAt: this.armAckAt,
      };
    }
  };
}));
