#!/usr/bin/env bash
#
# Measure the cost of a WebRTC video codec on THIS rover, so hardwareH264 and softwareH264
# can be compared on identical settings rather than by impression.
#
# COMMANDS NO MOTION. It changes video configuration and restarts picar/mediamtx; it never
# arms, never touches a servo, and never writes a flight-controller parameter. It is still
# not a routine check: it restarts the video pipeline, so a viewer will lose their stream.
#
# WHY CPU IS THE HEADLINE NUMBER. The camera path runs with `sourceOnDemand: false`, so the
# encoder runs continuously whether or not anyone is watching — which makes the measurement
# possible without a browser, and also means the cost is paid all the time. On this platform
# that is not merely a power question: picar's control loop, the 20 Hz RC override stream and
# the input watchdog all share the same four cores, and CLAUDE.md's invariant 9 is that a
# blocked event loop is a safety failure. An encoder that eats a core is a control risk.
#
# Usage:  sudo test/on-target/codec-benchmark.sh <hardwareH264|softwareH264> [seconds]
#
# Optional overrides, so a tuning lever can be measured instead of argued about:
#   DENOISE=cdn_off|cdn_fast|cdn_hq   the camera ISP denoise mode. It is NOT part of the
#                                     encoder, it runs before it, and it costs CPU on every
#                                     frame whichever codec is selected.
#   WIDTH= HEIGHT= FPS= BITRATE=      resolution / frame rate / kbps
#
set -uo pipefail

CODEC="${1:-}"
SECONDS_TO_SAMPLE="${2:-60}"
CFG=/opt/picar/picar-cfg.local.json
BACKUP="/tmp/codec-benchmark-cfg-$$.json"

case "$CODEC" in
  hardwareH264|softwareH264) ;;
  *) echo "usage: $0 <hardwareH264|softwareH264> [seconds]" >&2; exit 2 ;;
esac

say()  { printf '\n\033[1m== %s\033[0m\n' "$1"; }
note() { printf '  ---- %s\n' "$1"; }

# RESTORE ON EVERY EXIT PATH, including a failure or a Ctrl-C. Leaving a rover on a codec it
# was only supposed to be measured with is how a benchmark becomes a configuration change.
restore() {
  if [ -f "$BACKUP" ]; then
    cp -a "$BACKUP" "$CFG" 2>/dev/null && rm -f "$BACKUP"
    systemctl restart picar >/dev/null 2>&1
    printf '\n  ---- restored the original video config and restarted picar\n'
  fi
}
trap restore EXIT INT TERM

[ -f "$CFG" ] || echo '{}' > "$CFG"
cp -a "$CFG" "$BACKUP"

say "Applying $CODEC"
python3 - "$CFG" "$CODEC" "${DENOISE:-}" "${WIDTH:-}" "${HEIGHT:-}" "${FPS:-}" "${BITRATE:-}" <<'PY'
import json, sys
p, codec, denoise, width, height, fps, bitrate = sys.argv[1:8]
try:
    c = json.load(open(p))
except Exception:
    c = {}
c['webrtc_codec'] = codec
for key, val, cast in (('webrtc_denoise', denoise, str), ('webrtc_width', width, int),
                       ('webrtc_height', height, int), ('webrtc_fps', fps, int),
                       ('webrtc_bitrate_kbps', bitrate, int)):
    if val:
        c[key] = cast(val)
json.dump(c, open(p, 'w'), indent=2)
PY
systemctl restart picar >/dev/null 2>&1
sleep 12

# Confirm the codec REACHED the generated file. Asserting on the value we just wrote to the
# overlay would prove only that python works — the question is what MediaMTX was told.
ACTUAL=$(grep -oE 'rpiCameraCodec: *[A-Za-z0-9]+' /opt/picar/mediamtx.yml 2>/dev/null | awk '{print $2}')
note "mediamtx.yml says rpiCameraCodec: ${ACTUAL:-<absent>}"
if [ "$ACTUAL" != "$CODEC" ]; then
  echo "  FAIL the generated config does not carry $CODEC — measuring it would be meaningless" >&2
  exit 1
fi
note "denoise: $(grep -oE 'rpiCameraDenoise: *[A-Za-z_]+' /opt/picar/mediamtx.yml | awk '{print $2}')"
note "$(grep -oE 'rpiCameraWidth: *[0-9]+' /opt/picar/mediamtx.yml | awk '{print "width " $2}') \
$(grep -oE 'rpiCameraHeight: *[0-9]+' /opt/picar/mediamtx.yml | awk '{print "height " $2}') \
$(grep -oE 'rpiCameraFPS: *[0-9]+' /opt/picar/mediamtx.yml | awk '{print "fps " $2}') \
$(grep -oE 'rpiCameraBitrate: *[0-9]+' /opt/picar/mediamtx.yml | awk '{print "bitrate " $2}')"

say "Sampling ${SECONDS_TO_SAMPLE}s"
SINCE=$(date '+%Y-%m-%d %H:%M:%S')
CAM_SAMPLES=""; MTX_SAMPLES=""; N=0
while [ "$N" -lt "$SECONDS_TO_SAMPLE" ]; do
  # Sum across matching processes: the encoder may be split across helpers, and taking only
  # the first PID would silently under-report.
  c=$(ps -eo pcpu,comm --no-headers 2>/dev/null | awk '$2 ~ /mtxrpicam/ {s+=$1} END {printf "%.1f", s+0}')
  m=$(ps -eo pcpu,comm --no-headers 2>/dev/null | awk '$2 ~ /mediamtx/  {s+=$1} END {printf "%.1f", s+0}')
  CAM_SAMPLES="$CAM_SAMPLES $c"; MTX_SAMPLES="$MTX_SAMPLES $m"
  N=$((N+1)); sleep 1
done

stat_of() {  # mean / max over a whitespace list
  echo "$1" | tr ' ' '\n' | grep -E '^[0-9.]+$' | awk '
    {s+=$1; n++; if ($1>mx) mx=$1}
    END {if (n) printf "mean %.1f%%  max %.1f%%  (n=%d)", s/n, mx, n; else print "no samples"}'
}

say "Results — $CODEC"
printf '  %-22s %s\n' "camera/encoder:" "$(stat_of "$CAM_SAMPLES")"
printf '  %-22s %s\n' "mediamtx:"       "$(stat_of "$MTX_SAMPLES")"
printf '  %-22s %s\n' "cores:"          "$(nproc)"
printf '  %-22s %s\n' "load (1/5/15):"  "$(cut -d' ' -f1-3 /proc/loadavg)"
printf '  %-22s %s\n' "temp:"           "$(vcgencmd measure_temp 2>/dev/null || echo n/a)"
printf '  %-22s %s\n' "throttled:"      "$(vcgencmd get_throttled 2>/dev/null || echo n/a)"

say "Encoder / reader complaints during the run"
# These are the failure modes that matter and they do NOT show up as CPU: a starved encoder
# reports QBUF failures, and a link that cannot keep up makes MediaMTX discard frames.
for pat in 'QBUF' 'reader is too slow' 'error' 'failed'; do
  c=$(journalctl -u mediamtx --since "$SINCE" --no-pager 2>/dev/null | grep -aci "$pat")
  printf '  %-22s %s\n' "$pat:" "${c:-0}"
done

say "Summary"
echo "  Compare the camera/encoder mean against the other codec at the SAME width, height,"
echo "  fps and bitrate — the numbers above are meaningless across different settings."
echo "  NOTE: this measures ENCODER COST, not delivered video quality or latency. A codec can"
echo "  be cheap and still look worse, or keep up here and stutter at a real viewer. Those"
echo "  need a browser and getStats(); this does not replace them."
