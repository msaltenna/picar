#!/usr/bin/env bash
# telemetry.sh — prove the battery/radio/rail telemetry path works on real hardware.
#
# Run ON a rover:  test/on-target/telemetry.sh
#
# Read-only with respect to rover state: it inspects services, the /status endpoint
# and live MAVLink traffic. It does not restart anything, does not touch the config,
# and needs no root. That is deliberate — this is the check you want to be able to
# run on a rover you are not willing to disturb.
#
# Why each check exists, because every one of them corresponds to something that has
# actually been got wrong on this platform:
#
#   - FRAME_CLASS read-back. The overlay pushed 2 (Boat) on an ArduRover while
#     EXPECTED_CRITICAL_PARAMS also expected 2, so read-back confirmed the wrong
#     value and the UI reported the vehicle verified. Checking the value picar SENT
#     is worthless; this asks the flight controller what it actually holds.
#   - params.missing empty. Invariant 7 requires read-back confirmation of every
#     critical parameter before arming. Nothing on main gates on it.
#   - A MAVProxy wedge check. On 2026-08-03 MAVProxy stopped draining its socket:
#     113 KB unread on the live connection, 2.1 MB in CLOSE-WAIT, and the tlog frozen
#     for 70 minutes. picar streamed overrides into it for over an hour and the UI
#     looked healthy. A frozen-but-plausible reading is the failure mode to hunt, so
#     this samples twice and requires the numbers to CHANGE.
#   - Telemetry freshness. A stale snapshot is the same defect one layer up: the
#     first sample proves the field exists, the second proves something is producing it.
set -uo pipefail

STATUS_URL="https://localhost:8443/status"
FAILED=0
WARNED=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; WARNED=1; }
note() { printf '  ---- %s\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1"; exit 2; }; }
need curl
need python3

status_json() { curl -sk --max-time 8 "$STATUS_URL"; }

# jq is not installed on the rovers; python3 is. Reads a dotted path and prints the
# value, or the literal string ABSENT — never an empty string, so a missing field
# cannot be mistaken for a present-but-empty one.
jget() {
  python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception as e: print("PARSE-ERROR:"+str(e)); sys.exit(0)
cur=d
for k in sys.argv[1].split("."):
  if isinstance(cur,dict) and k in cur: cur=cur[k]
  elif isinstance(cur,list) and k.isdigit() and int(k)<len(cur): cur=cur[int(k)]
  else: print("ABSENT"); sys.exit(0)
print(json.dumps(cur) if isinstance(cur,(dict,list)) else cur)
' "$1"
}

# ── 1. Services ──────────────────────────────────────────────────────────────
say "Services"
for unit in picar mavproxy; do
  state="$(systemctl is-active "$unit" 2>/dev/null || true)"
  [[ "$state" == "active" ]] && ok "$unit is active" || bad "$unit is $state"
done
# A unit that is active but restarting in a loop reports active at the moment you
# look. NRestarts is the only way to see it from one sample.
for unit in picar mavproxy; do
  n="$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || echo 0)"
  [[ "${n:-0}" -le 2 ]] && ok "$unit NRestarts=$n" || bad "$unit has restarted $n times — restart loop"
done

# ── 2. Startup evidence in the journal ───────────────────────────────────────
say "Journal evidence"
J="$(journalctl -u picar --since '-10min' --no-pager 2>/dev/null || true)"
if [[ -z "$J" ]]; then
  warn "no picar journal in the last 10 minutes — restart the service to re-check startup lines"
else
  grep -q 'autopilot' <<<"$J" && ok "autopilot identified in the log" \
    || warn "no autopilot line in the last 10 min (normal if the service has been up longer)"
  # These must NOT appear. Each is a real config-failure mode the driver now reports.
  for pattern in 'REJECTED mavproxy_param_overlay' \
                 'param overlay is EMPTY' \
                 'overlay is DISABLED' \
                 'overlay unconfirmed'; do
    if grep -q "$pattern" <<<"$J"; then
      bad "journal contains: $(grep -m1 "$pattern" <<<"$J" | tail -c 160)"
    else
      ok "no '$pattern' in the journal"
    fi
  done
  if grep -q 'no batteryWarnVolts and no battery_empty_volts' <<<"$J"; then
    warn "no battery threshold configured — a low pack can never raise a warning on this rover"
  fi
  if grep -qE 'WARNING [A-Z0-9_]+=.* but expected' <<<"$J"; then
    bad "a critical parameter failed read-back: $(grep -m1 -E 'WARNING [A-Z0-9_]+=' <<<"$J" | tail -c 200)"
  else
    ok "no critical-parameter read-back mismatch reported"
  fi
fi

# ── 3. /status telemetry ─────────────────────────────────────────────────────
say "/status telemetry"
S1="$(status_json)"
if [[ -z "$S1" ]]; then
  bad "$STATUS_URL returned nothing — cannot check telemetry"
else
  ok "/status responded"
  linkup="$(jget telemetry.linkUp <<<"$S1")"
  [[ "$linkup" == "true" ]] && ok "MAVLink link up" || bad "telemetry.linkUp=$linkup"

  hb="$(jget telemetry.autopilotHeartbeat <<<"$S1")"
  [[ "$hb" == "true" ]] && ok "autopilot HEARTBEAT fresh" || bad "telemetry.autopilotHeartbeat=$hb"

  # Battery. A voltage is the one reading this fleet always has; remainingPct is
  # null unless BATT_CAPACITY is set, which is why it is not required here.
  bv="$(jget telemetry.battery.voltageV <<<"$S1")"
  if [[ "$bv" == "ABSENT" || "$bv" == "null" ]]; then
    bad "no battery voltage in telemetry (battery=$(jget telemetry.battery <<<"$S1"))"
  else
    ok "battery voltage ${bv} V"
    python3 -c "import sys; v=float('$bv'); sys.exit(0 if 3.0 < v < 30.0 else 1)" \
      && ok "battery voltage is in a plausible range" \
      || bad "battery voltage ${bv} V is implausible — check the monitor scaling"
  fi
  pct="$(jget telemetry.battery.remainingPct <<<"$S1")"
  src="$(jget telemetry.battery.pctSource <<<"$S1")"
  note "remainingPct=${pct} pctSource=${src}"
  if [[ "$pct" != "ABSENT" && "$pct" != "null" && "$src" == "ABSENT" ]]; then
    bad "a percentage is reported with no pctSource — the UI cannot mark it as an estimate"
  fi

  # Board and servo rails.
  for rail in boardV servoV; do
    v="$(jget "telemetry.power.$rail" <<<"$S1")"
    if [[ "$v" == "ABSENT" || "$v" == "null" ]]; then
      warn "power.$rail unavailable (POWER_STATUS not seen)"
    else
      ok "power.$rail = ${v} V"
    fi
  done

  # Wi-Fi, the link that actually carries teleoperation.
  wq="$(jget telemetry.wifi.qualityPct <<<"$S1")"
  [[ "$wq" == "ABSENT" || "$wq" == "null" ]] && warn "no wifi reading" || ok "wifi quality ${wq}%"

  # Radio. Absent is CORRECT unless a SiK radio is fitted; asserting its presence
  # would fail on every rover in the fleet as currently built.
  radio="$(jget telemetry.radio <<<"$S1")"
  [[ "$radio" == "null" || "$radio" == "ABSENT" ]] \
    && note "radio=null (expected: no SiK radio fitted)" \
    || ok "radio telemetry present: $radio"

  # ── Invariant 7: every critical parameter read back ────────────────────────
  missing="$(jget telemetry.params.missing <<<"$S1")"
  mismatched="$(jget telemetry.params.mismatched <<<"$S1")"
  verified="$(jget telemetry.params.verified <<<"$S1")"
  note "verified=$verified"
  [[ "$missing" == "[]" ]] && ok "no unverified critical parameters" \
    || bad "critical parameters NOT read back: $missing"
  [[ "$mismatched" == "{}" ]] && ok "no critical-parameter mismatches" \
    || bad "critical parameters mismatched: $mismatched"
fi

# ── 4. FRAME_CLASS as the flight controller actually holds it ────────────────
#
# Asking picar what it pushed proves nothing — the whole FRAME_CLASS defect was that
# picar pushed 2 and verified 2. This reads the value back off the FC.
say "FRAME_CLASS on the flight controller"
FC_EXPECT=1
if [[ "$(jget telemetry.params.verified <<<"${S1:-}")" == *FRAME_CLASS* ]]; then
  ok "FRAME_CLASS was read back and matched picar's expectation"
  note "picar expects FRAME_CLASS=$FC_EXPECT (1=Rover; 2=Boat was the defect)"
else
  bad "FRAME_CLASS is not in telemetry.params.verified — it was never confirmed by the FC"
fi

# ── 5. MAVLink traffic is MOVING, not frozen ─────────────────────────────────
say "MAVLink wire activity"
# Derive the tlog path from the unit's own --logfile argument. Hardcoding
# /var/log/mavproxy/*.tlog found a STALE file left there from an earlier
# configuration — last written 44 minutes earlier — and reported a healthy MAVProxy
# as wedged. That is the same mistake, in the same direction, as the 2026-08-03
# incident where a frozen tlog was read as live data for an hour: never trust a
# log path you did not get from the running process.
tlog="$(systemctl show -p ExecStart --value mavproxy 2>/dev/null \
        | grep -oP '(?<=--logfile )\S+' | head -1 || true)"
if [[ -z "$tlog" ]]; then
  tlog="$(ls -t /var/log/mavproxy/*.tlog 2>/dev/null | head -1 || true)"
  [[ -n "$tlog" ]] && note "no --logfile in the unit; falling back to $tlog"
fi
[[ -n "$tlog" ]] && note "tlog: $tlog"
if [[ -n "$tlog" ]]; then
  s1="$(stat -c %s "$tlog")"; sleep 4; s2="$(stat -c %s "$tlog")"
  if [[ "$s2" -gt "$s1" ]]; then
    ok "tlog growing ($s1 -> $s2 bytes) — MAVProxy is logging live traffic"
  else
    bad "tlog FROZEN at $s2 bytes over 4 s — MAVProxy may be wedged (this exact state was read as live data for an hour on 2026-08-03)"
  fi
else
  warn "could not determine the tlog path — cannot check wire activity that way"
fi

# Unbounded growth, and on this fleet the tlog lives in RAM. Measured on rover3
# 2026-08-04: 412 MB of a 3.9 GB tmpfs after 17 h of uptime (~24 MB/h), which fills
# it in about a week of continuous running. When /tmp fills, MAVProxy's writes fail
# and so does anything else using it.
if [[ -n "$tlog" ]] && df -P "$(dirname "$tlog")" 2>/dev/null | tail -1 | grep -q tmpfs; then
  used_pct="$(df -P "$(dirname "$tlog")" | tail -1 | awk '{print $5}' | tr -d '%')"
  sz="$(du -shc "$tlog"* 2>/dev/null | tail -1 | awk '{print $1}')"
  if [[ "${used_pct:-0}" -ge 60 ]]; then
    bad "tlog is on tmpfs (RAM) at ${used_pct}% full, ${sz} of logs — it will fill and take MAVProxy with it"
  else
    warn "tlog is on tmpfs (RAM): ${sz} of logs, ${used_pct}% full. No rotation — see TASKS.md"
  fi
fi

# The wedge signature: unread bytes piling up on the MAVProxy socket.
if command -v ss >/dev/null 2>&1; then
  rq="$(ss -tnH state established '( sport = :5760 or dport = :5760 )' 2>/dev/null | awk '{print $2}' | sort -rn | head -1)"
  rq="${rq:-0}"
  [[ "$rq" -lt 8192 ]] && ok "MAVProxy socket recv-queue ${rq} B" \
    || bad "MAVProxy socket has ${rq} B unread — it is not draining (wedge signature)"
  # Calibrated deliberately. A single CLOSE-WAIT socket is NORMAL and transient: any
  # client that connects and disconnects leaves one briefly, and this script's own
  # earlier probe produced exactly that false positive. What distinguished the
  # 2026-08-03 wedge was 2.1 MB QUEUED in CLOSE-WAIT — data MAVProxy would never
  # read because it had stopped reading at all. So gate on the queued bytes and on
  # accumulation, not on existence.
  cw_lines="$(ss -tnH state close-wait '( sport = :5760 or dport = :5760 )' 2>/dev/null || true)"
  cw="$(grep -c . <<<"${cw_lines:-}" 2>/dev/null || echo 0)"
  [[ -z "${cw_lines:-}" ]] && cw=0
  cw_max="$(awk '{print $2}' <<<"${cw_lines:-}" | sort -rn | head -1)"
  cw_max="${cw_max:-0}"
  if [[ "$cw_max" -gt 65536 ]]; then
    bad "a CLOSE-WAIT socket on :5760 holds ${cw_max} B unread — MAVProxy has stopped reading (wedge signature)"
  elif [[ "$cw" -ge 3 ]]; then
    bad "$cw CLOSE-WAIT sockets on :5760 — abandoned connections accumulating"
  elif [[ "$cw" -gt 0 ]]; then
    note "$cw CLOSE-WAIT socket on :5760, ${cw_max} B queued — transient, expected after any client disconnect"
  else
    ok "no CLOSE-WAIT sockets on :5760"
  fi
fi

# ── 6. Telemetry is being refreshed, not served from one frozen snapshot ─────
say "Telemetry freshness"
sleep 3
S2="$(status_json)"
if [[ -n "$S1" && -n "$S2" ]]; then
  a1="$(jget telemetry.battery.ageMs <<<"$S1")"
  a2="$(jget telemetry.battery.ageMs <<<"$S2")"
  if [[ "$a1" == "ABSENT" || "$a2" == "ABSENT" ]]; then
    warn "no battery ageMs to compare — cannot prove the reading is being refreshed"
  elif [[ "$a1" == "$a2" ]]; then
    bad "battery ageMs identical across 3 s ($a1) — the reading is a frozen snapshot"
  else
    ok "battery reading is being refreshed (ageMs $a1 -> $a2)"
  fi
  # ageMs must also stay small; a growing age means frames stopped arriving.
  if [[ "$a2" != "ABSENT" ]] && [[ "$a2" -gt 5000 ]]; then
    bad "battery reading is ${a2} ms old — SYS_STATUS has stopped arriving"
  fi
else
  warn "could not sample /status twice"
fi

say "Summary"
if [[ $FAILED -eq 0 && $WARNED -eq 0 ]]; then
  printf '\n\033[32mALL CHECKS PASSED\033[0m\n'
elif [[ $FAILED -eq 0 ]]; then
  printf '\n\033[33mPASSED WITH WARNINGS\033[0m — read them; a warning here usually means a subsystem is absent rather than broken\n'
else
  printf '\n\033[31mCHECKS FAILED\033[0m\n'
fi
printf 'NOTE: this validates the command and telemetry path only. rover3 has no flight battery\n'
printf 'connected, so no mechanical actuation is observed or implied by any check above.\n'
exit $FAILED
