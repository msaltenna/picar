// battery-warning.js — decides whether the battery is "in trouble".
//
// Extracted from app.js purely so it can be tested. app.js binds both HTTPS ports
// and opens the MAVProxy socket at require time, so nothing in it is reachable
// from a host test — which is why a mutation that reverted this rule to its
// fail-open form left the whole suite green.
//
// The rule fails CLOSED, and that is the point. Previously "unknown" was treated
// as "fine": SYS_STATUS maps both a 0 mV and a 65535 mV voltage_battery to null,
// and a null percentage together with a null voltage returned false. So a dead
// pack or a failed power module — voltage 0 — reported no trouble at all, while
// 1 % remaining reported trouble. On a vehicle that can move, "I cannot tell you
// the battery state" is a warning, not an all-clear.
'use strict';

// `battery` is telemetry.battery (or null when there is no SYS_STATUS at all).
// A missing battery entry means the MAVLink link is down, which is a link problem
// reported elsewhere — not a claim about the pack — so it is not battery trouble.
// `link` carries { linkUp, autopilotHeartbeat } so this can tell "the pack is fine"
// apart from "nobody is telling me about the pack".
function batteryTrouble(battery, { warnLevel = 20, warnVolts = null, warnOnNoReading = true } = {},
                        link = {}) {
  if (!battery) {
    // A missing battery entry is NOT automatically fine. Two different situations
    // reach here and only one of them is benign:
    //
    //   - the MAVLink link is down: that is a link fault, surfaced separately as
    //     linkUp, and claiming battery trouble for it would make this flag
    //     meaningless every time the link blips.
    //   - the link is UP and the flight controller is even sending heartbeats, but
    //     no SYS_STATUS has arrived or it has gone stale. Something IS talking and
    //     it is not telling us about the pack. Returning false there let a silent
    //     Pixhawk read as battery-clear on both the UI and the fleet dashboard.
    return !!(warnOnNoReading && link.linkUp);
  }
  const { remainingPct, voltageV } = battery;
  if (remainingPct !== null && remainingPct !== undefined && remainingPct <= warnLevel) return true;
  if (warnVolts !== null && voltageV !== null && voltageV !== undefined && voltageV <= warnVolts) {
    return true;
  }
  // Fail closed: the monitor is reporting, but nothing it said is usable.
  if (warnOnNoReading
      && (remainingPct === null || remainingPct === undefined)
      && (voltageV === null || voltageV === undefined)) {
    return true;
  }
  return false;
}

module.exports = { batteryTrouble };
