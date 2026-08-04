'use strict';

// The telemetry publish loop, extracted from app.js so that its WIRING is testable
// and not merely its parts.
//
// This is the third extraction on this branch and the reason for it is worth
// stating, because the first two did not go far enough. `battery-warning.js` made
// the battery rule testable and `config-bounds.js` made the interval bound
// testable — and then app.js called both from an unreachable module (it binds two
// HTTPS ports and the MAVProxy socket at require time), so every call site stayed
// unverified. A round-7 review proved the consequence: four separate mutations to
// this loop's body left the entire suite green.
//
//   fleetClient.setStatusBit(0, batteryTrouble(...)) -> setStatusBit(0, false)
//       The Fleet Manager battery-trouble bit is permanently clear. The dashboard
//       never flags a bad pack. This is the bit this branch exists to set.
//   bypass clampTelemetryInterval
//       telemetry_interval_ms: 1e400 in the untracked overlay is valid JSON, and
//       setInterval(fn, Infinity) is coerced by Node to 1 ms — a /proc read, a
//       telemetry snapshot and a socket broadcast every millisecond, on the same
//       event loop as the 20 Hz override stream and the fail-safe timer.
//   readFile -> readFileSync
//       A synchronous /proc read on the control event loop (invariant 9).
//   delete io.emit('telemetry', t)
//       The operator UI silently reverts to '--' on every indicator.
//
// So the loop takes its collaborators as arguments. Nothing here reaches for a
// module-level singleton, which is what made the old version untestable.

const { clampTelemetryInterval } = require('./config-bounds');
const { batteryTrouble }         = require('./battery-warning');

const WIRELESS_PROC = '/proc/net/wireless';

// /proc/net/wireless is a two-line-header text file; parsing it costs nothing and
// needs no external tool.
function parseWirelessProc(text) {
  const line = String(text).split('\n').find((l) => /^\s*[\w-]+:/.test(l));
  if (!line) return null;
  const [iface, rest] = line.split(':');
  const cols = rest.trim().split(/\s+/);
  // status, link quality, signal level (dBm), noise level
  const quality = parseFloat(cols[1]);
  const signal  = parseFloat(cols[2]);
  return {
    iface: iface.trim(),
    // Quality is reported out of 70 by most drivers.
    qualityPct: Number.isFinite(quality) ? Math.round((quality / 70) * 100) : null,
    signalDbm:  Number.isFinite(signal) ? signal : null,
  };
}

// `readWifi` MUST return a promise. That is not a style preference — it is the
// only reason this loop cannot stall the fail-safe, and taking it as an injected
// promise-returning dependency is what makes "it is asynchronous" an assertable
// property rather than a comment.
function startTelemetryLoop({
  getFcTelemetry,
  fleetClient,
  emit,
  readWifi,
  config = {},
  batteryWarnCfg,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  const intervalMs = clampTelemetryInterval(config.telemetry_interval_ms);
  let wifi = null;

  function refreshWifi() {
    return readWifi(WIRELESS_PROC, 'utf8')
      .then((text) => { wifi = parseWirelessProc(text); })
      .catch(() => { wifi = null; });
  }

  // The single source of truth for a telemetry snapshot, so /status, a joining
  // socket, and the broadcast cannot disagree about what the vehicle is reporting.
  function current() {
    return { ...getFcTelemetry(), wifi };
  }

  function tick() {
    // Deliberately not awaited: the whole point is that the loop never blocks on
    // the /proc read. A slow read costs one stale sample, never a late fail-safe.
    refreshWifi();
    const t = current();
    // Bit 0 of the Fleet Manager status bitmask is "battery trouble". It was
    // defined and exported but never actually set by anything until now.
    fleetClient.setStatusBit(0, batteryTrouble(t.battery, batteryWarnCfg, {
      linkUp: t.linkUp,
      autopilotHeartbeat: t.autopilotHeartbeat,
    }));
    fleetClient.setTelemetry({
      batteryV:    t.battery ? t.battery.voltageV : null,
      batteryPct:  t.battery ? t.battery.remainingPct : null,
      // Forwarded so the dashboard can mark an estimate, exactly as the rover UI
      // does. Without it the Fleet Manager would present a voltage-derived
      // percentage as if the flight controller had measured it.
      batteryPctSource: t.battery ? t.battery.pctSource : null,
      batteryA:    t.battery ? t.battery.currentA : null,
      radioRssi:   t.radio ? t.radio.rssi : null,
      boardV:      t.power ? t.power.boardV : null,
      servoV:      t.power ? t.power.servoV : null,
      wifiPct:     t.wifi ? t.wifi.qualityPct : null,
      wifiDbm:     t.wifi ? t.wifi.signalDbm : null,
      linkUp:      !!t.linkUp,
      // Forwarded because linkUp only reflects the local MAVProxy TCP socket. A
      // silent Pixhawk with MAVProxy still connected looked healthy without this.
      autopilotHeartbeat: !!t.autopilotHeartbeat,
    });
    emit('telemetry', t);
    return t;
  }

  const handle = setIntervalFn(tick, intervalMs);
  if (handle && typeof handle.unref === 'function' && config._unrefForTest) handle.unref();
  refreshWifi();

  return {
    intervalMs,
    current,
    tick,
    refreshWifi,
    stop() { clearIntervalFn(handle); },
  };
}

module.exports = { startTelemetryLoop, parseWirelessProc, WIRELESS_PROC };
