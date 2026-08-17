#!/usr/bin/env bash
#
# READ-ONLY audit of one rover. Prints what it OBSERVED, never a verdict about what the
# vehicle can or cannot do.
#
# COMMANDS NO MOTION and CHANGES NOTHING. No arm, no servo, no PARAM_SET, no service
# restart, no file written outside /tmp. Safe to run on a rover with a live pack while an
# operator is driving — the only cost is a few HTTP GETs against localhost.
#
# Why this exists rather than a handful of ad-hoc ssh commands: the fleet is NOT homogeneous
# (CM4 vs CM5, ArduRover vs whatever a board was last flashed with), and comparing rovers
# from differently-typed commands is how "rover1 is worse than rover3" went four days
# without a cause. Identical evidence, same order, every rover.
#
# Usage:  test/on-target/fleet-audit.sh
#
set -uo pipefail

say()  { printf '\n\033[1m== %s\033[0m\n' "$1"; }
kv()   { printf '  %-26s %s\n' "$1" "$2"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

REPO=/opt/picar
cd "$REPO" 2>/dev/null || { echo "no $REPO on this host"; exit 2; }

say "Identity"
kv "hostname"        "$(hostname)"
kv "board"           "$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unknown)"
kv "kernel"          "$(uname -r)"
kv "os"              "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
kv "uptime"          "$(uptime -p)"
# UTC, deliberately. HANDOFF.md records that comparing rover local time to workstation local
# time made a five-hour-stale file look current — the direction that hides a frozen log.
kv "time (UTC)"      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
kv "timezone"        "$(timedatectl show -p Timezone --value 2>/dev/null || echo ?)"
kv "clock synced"    "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo ?)"

say "Code"
kv "HEAD"            "$(git rev-parse --short HEAD 2>/dev/null)"
kv "branch"          "$(git branch --show-current 2>/dev/null || echo '(detached)')"
kv "HEAD subject"    "$(git log -1 --format=%s 2>/dev/null | cut -c1-64)"
kv "HEAD date"       "$(git log -1 --format=%cI 2>/dev/null)"
DIRTY=$(git status --porcelain 2>/dev/null | grep -vc '^??' || echo 0)
UNTRACKED=$(git status --porcelain 2>/dev/null | grep -c '^??' || echo 0)
kv "tracked changes" "$DIRTY"
kv "untracked files" "$UNTRACKED"
[ "${DIRTY:-0}" -gt 0 ] && warn "the deployed tree does NOT match its commit — a validation here would not describe any reviewable SHA"
git status --porcelain 2>/dev/null | grep -v '^??' | head -5 | sed 's/^/       /'
if git remote get-url origin >/dev/null 2>&1; then
  AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo ?)
  BEHIND=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo ?)
  kv "vs origin/main"  "ahead $AHEAD, behind $BEHIND  (fetched $(git log -1 --format=%cI origin/main 2>/dev/null || echo never))"
  [ "${BEHIND:-0}" != "0" ] && [ "${BEHIND:-0}" != "?" ] && warn "behind origin/main by $BEHIND commit(s) — this rover is not running current code"
fi

say "Services"
for u in picar mavproxy mediamtx; do
  A=$(systemctl is-active "$u" 2>/dev/null)
  E=$(systemctl is-enabled "$u" 2>/dev/null)
  R=$(systemctl show "$u" -p NRestarts --value 2>/dev/null)
  kv "$u" "active=$A enabled=$E restarts=${R:-?}"
  [ "$A" != "active" ] && bad "$u is $A"
  [ "${R:-0}" != "0" ] && [ -n "${R:-}" ] && warn "$u has restarted ${R} time(s) — check why"
done
# The failure that took picar's link down on 2026-08-12: the unit hardcodes /dev/ttyACM0,
# which does not survive a flight-controller reboot.
MASTER=$(systemctl cat mavproxy 2>/dev/null | grep -oE '\-\-master=[^ ]+' | head -1)
kv "mavproxy master" "${MASTER:-?}"
case "$MASTER" in
  *by-id*) ;;
  *ttyACM*) warn "master is a bare ttyACM path — an FC reboot renumbers it and mavproxy fails permanently (see TASKS.md P0)" ;;
esac

say "Flight controller"
FC=$(curl -sk --max-time 8 https://localhost:8443/status 2>/dev/null)
if [ -z "$FC" ]; then
  bad "no answer from https://localhost:8443/status — picar is not serving"
else
  echo "$FC" | python3 -c '
import sys, json
d = json.load(sys.stdin)
t = d.get("telemetry") or {}
f = t.get("firmware") or {}
p = t.get("params") or {}
b = t.get("battery") or {}
def kv(k, v): print("  %-26s %s" % (k, v))
ap, ty = f.get("autopilot"), f.get("type")
AP = {0:"GENERIC",3:"ARDUPILOTMEGA",8:"INVALID(GCS)",12:"PX4"}
TY = {1:"FIXED_WING",2:"QUADROTOR",6:"GCS",10:"GROUND_ROVER",11:"SURFACE_BOAT"}
kv("autopilot", "%s (%s)" % (ap, AP.get(ap, "?")) if ap is not None else "UNKNOWN - no heartbeat decoded")
kv("vehicle type", "%s (%s)" % (ty, TY.get(ty, "?")) if ty is not None else "UNKNOWN")
kv("firmware mismatch", f.get("mismatch") or "none")
kv("overlay suppressed", f.get("overlaySuppressed"))
kv("identity timed out", f.get("identityTimedOut"))
kv("link up", t.get("linkUp"))
kv("autopilot heartbeat", t.get("autopilotHeartbeat"))
kv("fcSupported", t.get("fcSupported"))
ver, mis, mm = p.get("verified") or [], p.get("missing") or [], p.get("mismatched") or {}
kv("critical params", "verified %d, missing %d, mismatched %d" % (len(ver), len(mis), len(mm)))
if mis: kv("  missing", ", ".join(sorted(mis)))
if mm:  kv("  MISMATCHED", json.dumps(mm))
# Report the reading. Do NOT conclude anything about whether the vehicle can move: a failed
# monitor and an absent pack are indistinguishable from the wire, and asserting otherwise is
# the premise that got a throttle probe run three times.
v, a = b.get("voltageV"), b.get("currentA")
kv("battery", "%s V, %s A, %s%% (%s)" % (v, a, b.get("remainingPct"), b.get("pctSource"))
   if b else "no reading in telemetry")
if isinstance(v, (int, float)):
    if not (3.0 <= v <= 30.0):
        print("  \033[33mWARN\033[0m battery voltage %s V is outside 3.0-30.0 V - implausible." % v)
        print("       A failed monitor and a disconnected pack look IDENTICAL from here.")
        print("       Check the pack physically; do not conclude the vehicle cannot move.")
    else:
        print("  ---- a plausible pack voltage is present: ASSUME THE WHEELS CAN TURN")
kv("commanded now", "steering=%s throttle=%s" % (d.get("steering"), d.get("throttle")))
vid = d.get("video") or {}
kv("video readers", "%s%s" % (vid.get("readers"),
   "" if vid.get("readersError") in (None, "") else "  (error: %s)" % vid.get("readersError")))
if vid.get("readers") is None:
    print("  \033[33mWARN\033[0m reader count UNKNOWN - null is not zero; picar cannot see MediaMTX")
' 2>/dev/null || bad "could not parse /status as JSON"
fi

say "Video pipeline"
YML=$REPO/mediamtx.yml
if [ -f "$YML" ]; then
  # The 2026-08-06 defect: an ICE-TCP candidate on offer means sessions can silently fall back
  # to a transport with head-of-line blocking, which starved the encoder AND tripped the
  # control fail-safe 12 times in 100 s.
  if grep -q '^webrtcLocalTCPAddress' "$YML"; then
    bad "webrtcLocalTCPAddress present — WebRTC can silently fall back to ICE-over-TCP"
  else
    kv "ICE transport" "UDP only (no TCP candidate offered)"
  fi
  for k in rpiCameraCodec rpiCameraWidth rpiCameraHeight rpiCameraFPS rpiCameraBitrate rpiCameraDenoise rpiCameraIDRPeriod; do
    kv "$k" "$(grep -oE "$k: *[A-Za-z0-9_]+" "$YML" | head -1 | awk '{print $2}')"
  done
  API=$(grep -oE '^apiAddress: *[0-9.:]+' "$YML" | awk '{print $2}')
  kv "mediamtx api" "${API:-disabled}"
  case "${API:-}" in
    127.0.0.1:*) ;;
    "")          warn "API disabled — the reader count cannot be read" ;;
    *)           bad "API is NOT bound to loopback ($API) — session data is reachable off-box on a server with no auth" ;;
  esac
else
  warn "no generated mediamtx.yml"
fi
# A CM5 has no hardware H.264 block. Forcing hardwareH264 there yields no video at all.
if [ -e /dev/video11 ]; then kv "hw H.264 encoder" "/dev/video11 present"
else                         kv "hw H.264 encoder" "ABSENT — this board can only do softwareH264"; fi

say "Load and thermals"
kv "cores"           "$(nproc)"
kv "loadavg"         "$(cut -d' ' -f1-3 /proc/loadavg)"
kv "temp"            "$(vcgencmd measure_temp 2>/dev/null || echo n/a)"
TH=$(vcgencmd get_throttled 2>/dev/null || echo n/a)
kv "throttled"       "$TH"
[ "$TH" != "throttled=0x0" ] && [ "$TH" != "n/a" ] && warn "throttling flags set ($TH) — undervoltage or thermal limit has occurred"
kv "top cpu"         "$(ps -eo pcpu,comm --no-headers --sort=-pcpu 2>/dev/null | head -3 | tr '\n' ' ')"
kv "mem"             "$(free -m | awk '/^Mem:/{printf "%s/%s MB used", $3, $2}')"

say "Storage"
kv "/ usage"         "$(df -h / | awk 'NR==2{print $5" of "$2}')"
kv "/tmp usage"      "$(df -h /tmp | awk 'NR==2{print $5" of "$2" ("$1")"}')"
# tlogs in tmpfs grow unbounded and are RAM. Recorded as an open task; report the size.
for f in /tmp/mav.tlog /tmp/mav.tlog.raw; do
  [ -f "$f" ] && kv "$(basename "$f")" "$(du -h "$f" | cut -f1)"
done
TMPPCT=$(df /tmp | awk 'NR==2{gsub("%","",$5); print $5}')
[ "${TMPPCT:-0}" -gt 70 ] && warn "/tmp is ${TMPPCT}% full and holds the tlogs — MAVProxy logging is unrotated"

say "Network"
IF=$(ip route show default 2>/dev/null | awk '{print $5; exit}')
kv "default iface"   "${IF:-none}"
kv "address"         "$(ip -br addr show "${IF:-lo}" 2>/dev/null | awk '{print $3}')"
kv "gateway"         "$(ip route show default 2>/dev/null | awk '{print $3; exit}')"
if [ -r /proc/net/wireless ] && grep -q "${IF:-nomatch}" /proc/net/wireless 2>/dev/null; then
  kv "wifi signal"   "$(awk -v i="${IF}:" '$1==i{print "link "$3"  level "$4" dBm"}' /proc/net/wireless)"
  kv "ssid/rate"     "$(nmcli -t -f ACTIVE,SSID,CHAN,FREQ,RATE dev wifi list 2>/dev/null | awk -F: '$1=="yes"{print $2" ch"$3" "$4" "$5; exit}')"
  PS=$(iw dev "$IF" get power_save 2>/dev/null | awk '{print $3}')
  kv "wifi power save" "${PS:-unknown}"
  [ "$PS" = "on" ] && warn "power save is ON — the radio parks itself, which shows up as latency spikes mid-drive"
fi
kv "iface errors"    "$(ip -s link show "${IF:-lo}" 2>/dev/null | awk '/RX:/{getline; rx=$3" drop "$4} /TX:/{getline; print "rx err "rx", tx err "$3" drop "$4}')"
# INTERNET, as asked. Reported per-hop so a DNS failure is not read as "no internet".
kv "gateway reachable" "$(ping -c2 -W2 "$(ip route show default | awk '{print $3; exit}')" >/dev/null 2>&1 && echo yes || echo NO)"
kv "internet (1.1.1.1)" "$(ping -c2 -W3 1.1.1.1 >/dev/null 2>&1 && echo yes || echo NO)"
kv "dns"             "$(getent hosts github.com >/dev/null 2>&1 && echo resolves || echo FAILS)"
kv "https egress"    "$(curl -sI --max-time 10 -o /dev/null -w '%{http_code}' https://github.com 2>/dev/null || echo fail)"
say "Peers"
for p in rover1 rover2 rover3; do
  [ "$p" = "$(hostname)" ] && continue
  kv "$p" "$(ping -c1 -W2 "$p" >/dev/null 2>&1 && echo reachable || echo unreachable)"
done

say "Safety-relevant config"
# The untracked overlay can set any key with no review (invariant 8 is open), so what it
# actually contains is audit evidence rather than a detail.
if [ -f "$REPO/picar-cfg.local.json" ]; then
  kv "local overlay" "$(stat -c '%s bytes, mode %a' "$REPO/picar-cfg.local.json")"
  python3 -c '
import json
try:
    c = json.load(open("'"$REPO"'/picar-cfg.local.json"))
except Exception as e:
    print("  \033[31mFAIL\033[0m local overlay is not valid JSON: %s" % e); raise SystemExit
for k in sorted(c):
    print("       %-28s %r" % (k, c[k]))
' 2>/dev/null
else
  kv "local overlay" "absent"
fi
kv "certs"           "$(ls "$REPO"/certs/*.pem 2>/dev/null | wc -l) pem file(s)"
# A world-readable private key on a box serving HTTPS is a finding, not a nit.
for k in "$REPO"/certs/key.pem; do
  [ -f "$k" ] || continue
  M=$(stat -c '%a' "$k")
  kv "key.pem mode" "$M"
  case "$M" in 600|400) ;; *) bad "key.pem is mode $M — the private key is readable beyond its owner" ;; esac
done

say "Done"
echo "  READ-ONLY: nothing was armed, written, restarted or reconfigured."
echo "  This reports observations only. It is NOT a validation pass and must not be recorded"
echo "  as one — no on-target regression script was run and no motion was commanded."
