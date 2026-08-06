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
// Build the loop's collaborators from the process's real objects.
//
// This exists because extracting the loop moved the untested boundary rather than
// removing it: the loop became testable and app.js was left holding five one-line
// lambdas that no test could see. A round-8 review proved two of them mutable with
// the suite fully green, one of which is a fail-open on a safety indicator:
//
//   emit: () => {}                    the operator UI never receives a frame; every
//                                     indicator sits at '--' / 'FC: --'
//   warnOnNoReading: false            an unreadable battery monitor on a live link
//                                     raises NEITHER the UI warning NOR the fleet
//                                     battery-trouble bit. battery-warning.js and
//                                     formatBattery() both implement fail-closed
//                                     correctly and neither is reached.
//   readWifi via readFileSync         a synchronous /proc read on the control event
//                                     loop (invariant 9)
//
// So the wiring itself is a unit now. What remains untestable in app.js is one call
// passing the real pwm/io/fs/config, which is as small as this boundary gets.
function buildTelemetryWiring({ pwm, io, fleetClient, fs, config = {}, onTick = null }) {
  return {
    // Forwarded, not called here. Adaptive video bitrate rides this tick rather than owning
    // a second timer and a second /proc read on the event loop that runs the input
    // watchdog. Passing it through the wiring builder keeps app.js to one call and keeps
    // the forwarding itself inside a tested function — the untested-consumer shape this
    // repo keeps rediscovering.
    onTick,
    // A driver with no telemetry support must yield an empty snapshot, not throw —
    // four of the five drivers are GPIO and have no getTelemetry at all.
    // A driver with no telemetry support yields fcSupported:false rather than {}.
    // An empty object left linkUp undefined, so the status bar rendered a permanent
    // 'FC: DOWN' on all four GPIO drivers — indistinguishable from a real MAVLink
    // link failure, on a vehicle that has no MAVLink link by design. pwm_method is
    // reachable through the untracked overlay and the fleet is not homogeneous.
    getFcTelemetry: () => (typeof pwm.getTelemetry === 'function'
      ? pwm.getTelemetry()
      : { fcSupported: false }),
    fleetClient,
    emit: (event, payload) => io.emit(event, payload),
    // fs.promises, never fs.readFileSync. Invariant 9: this runs at the telemetry
    // rate on the same event loop as the 20 Hz override stream and the fail-safe.
    readWifi: (path, enc) => fs.promises.readFile(path, enc),
    config,
    batteryWarnCfg: batteryWarnCfgFrom(config),
  };
}

// Whether anything at all can raise a battery warning on this vehicle, and if not,
// the message saying so. Extracted from app.js because the guard that lived there was
// a bare `if (...) console.error(...)` that no test could reach — and a round-8 review
// proved it deletable with the suite green, which is precisely how the defect it
// mitigates came to exist.
//
// Gated on EFFECTIVE capability rather than on a config key being present. The first
// version tested `config.battery_empty_volts == null`, which a HALF-configured range
// (empty set, full not) silently satisfied — so the one mitigation for an unwatchable
// pack was itself defeated by the likeliest typo. batteryRange is the driver's own
// verdict on whether it can estimate a percentage at all.
function batteryWarnabilityWarning(config = {}, batteryRange = null) {
  const cfg = batteryWarnCfgFrom(config);
  if (cfg.warnVolts !== null || batteryRange) return null;
  return 'picar: no batteryWarnVolts, and the driver has no usable ' +
         'battery_empty_volts/battery_full_volts range — a flight controller that reports ' +
         'voltage but no usable percentage (the default on this fleet) can NEVER raise a ' +
         'battery warning, at any state of charge. Set batteryWarnVolts for this pack.';
}

// Fail closed by default: warnOnNoReading is true unless explicitly set to false.
// `!== false` rather than `?? true` so a null or absent key still warns — an
// unreadable monitor and a healthy pack must never look alike.
function batteryWarnCfgFrom(config = {}) {
  return {
    warnLevel:       config.batteryWarnLevel ?? 20,
    warnVolts:       config.batteryWarnVolts ?? null,
    warnOnNoReading: config.batteryWarnOnNoReading !== false,
  };
}

function startTelemetryLoop({
  getFcTelemetry,
  fleetClient,
  emit,
  readWifi,
  config = {},
  batteryWarnCfg,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onTick = null,
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

    // Subscribers ride this tick. WRAPPED, because everything above it is load-bearing:
    // an exception escaping a subscriber would stop telemetry broadcasts and the Fleet
    // Manager battery-trouble bit, and under the crash fail-safe it would take the process
    // down. No subscriber's feature is worth that.
    if (onTick) {
      try { onTick(t); }
      catch (err) {
        try { console.error('telemetry: onTick subscriber threw:', err && err.message); }
        catch (_) { /* ignore */ }
      }
    }
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

module.exports = { startTelemetryLoop, buildTelemetryWiring, batteryWarnCfgFrom,
                   batteryWarnabilityWarning,
                   parseWirelessProc, WIRELESS_PROC };
