#!/usr/bin/env bash
# video-drop.sh — prove the frame-drop path actually sheds frames on real hardware.
#
# Run ON a rover:  sudo test/on-target/video-drop.sh [h264|mjpeg]
#
# Why this exists. It was written when stream_codec was "webrtc", where picar never
# touches a video frame — MediaMTX owns the whole path — so the drop logic could not
# execute at all in the default configuration. Since 2026-08-06 the default IS "h264",
# which means the drop path is now on the live video path for every operator, and this
# script validates the shipping configuration rather than a hypothetical one. mjpeg has
# still never been validated.
#
# This script switches the codec through the UNTRACKED per-rover overlay, drives a
# deliberately slow client, and restores the original state on every exit path
# including failure. It never touches the tracked config.
set -uo pipefail

CODEC="${1:-mjpeg}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OVERLAY="${REPO}/picar-cfg.local.json"
BACKUP="$(mktemp /tmp/picar-cfg.local.json.XXXXXX)"
FAILED=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }
note() { printf '  ---- %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then echo "must run as root (systemctl restart)"; exit 2; fi
case "$CODEC" in h264|mjpeg) ;; *) echo "codec must be h264 or mjpeg"; exit 2 ;; esac

# Sampled BEFORE anything is changed, and before the cleanup trap is armed, so cleanup
# restores what was really there. `is-active` prints inactive/failed/unknown as well as
# active, and any of those means "do not start it".
MEDIAMTX_WAS="$(systemctl is-active mediamtx 2>/dev/null || true)"
[[ -z "$MEDIAMTX_WAS" ]] && MEDIAMTX_WAS="unknown"

# ── Restore FIRST, so a failure below cannot leave the rover on a non-default
# codec with mediamtx stopped. This is the whole reason the script exists rather
# than a sequence of hand-typed commands.
cleanup() {
  say "Restoring original state"
  cp "$BACKUP" "$OVERLAY" 2>/dev/null || true
  rm -f "$BACKUP"
  # Restore mediamtx to the state it was ACTUALLY in, not to a state this script assumes.
  # It used to `systemctl start mediamtx` unconditionally, which was right only while
  # webrtc was the default. Since the default became h264 — a path where rpicam-vid opens
  # the camera directly — starting mediamtx here hands the camera back to a service that
  # is meant to be stopped, and every run of this script would silently break video until
  # the next restart.
  if [[ "$MEDIAMTX_WAS" == "active" ]]; then
    systemctl start mediamtx 2>/dev/null || true
  else
    systemctl stop mediamtx 2>/dev/null || true
    note "left mediamtx ${MEDIAMTX_WAS} — it was not running when this script started"
  fi
  systemctl restart picar
  sleep 6
  local codec_now
  codec_now="$(curl -sk --max-time 5 https://localhost:8443/status >/dev/null 2>&1 && echo up || echo down)"
  note "picar $(systemctl is-active picar), mediamtx $(systemctl is-active mediamtx), /status ${codec_now}"
  note "overlay restored to: $(tr -d '\n ' < "$OVERLAY" 2>/dev/null)"
  [[ $FAILED -eq 0 ]] && printf '\n\033[32mALL CHECKS PASSED\033[0m (%s)\n' "$CODEC" \
                      || printf '\n\033[31mCHECKS FAILED\033[0m (%s)\n' "$CODEC"
  exit $FAILED
}
trap cleanup EXIT INT TERM

cp "$OVERLAY" "$BACKUP" 2>/dev/null || echo '{}' > "$BACKUP"
say "Baseline"
note "overlay: $(tr -d '\n ' < "$BACKUP")"

# ── Switch codec and force the drop thresholds low ───────────────────────────
#
# The default thresholds are effectively unreachable on a local link: they gate on
# ws.bufferedAmount, which counts only userspace queueing, so a multi-megabyte
# kernel socket buffer sits underneath them. Stalling a client for 12 s at the
# defaults produced NO drops at all on 2026-07-31. So this forces them low —
# which tests the drop MECHANISM, not the default tuning. The tuning gap is a
# separate open task and this script does not close it.
say "Switching to ${CODEC} with low drop thresholds"
python3 - "$OVERLAY" "$CODEC" <<'PY'
import json, sys
path, codec = sys.argv[1], sys.argv[2]
try:    cfg = json.load(open(path))
except Exception: cfg = {}
cfg["stream_codec"] = codec
cfg["h264_drop_delta_bytes"] = 1024
cfg["h264_drop_all_bytes"]   = 4096
cfg["mjpeg_drop_bytes"]      = 1024
json.dump(cfg, open(path, "w"), indent=2)
PY
note "overlay now: $(tr -d '\n ' < "$OVERLAY")"

# MediaMTX holds the camera; h264/mjpeg need it themselves.
systemctl stop mediamtx || true
systemctl restart picar
sleep 8

if ! systemctl is-active --quiet picar; then bad "picar did not stay active"; exit 1; fi
ok "picar active after codec switch"

say "Confirming the stream module actually loaded ${CODEC}"
if journalctl -u picar --since "-30 seconds" -o cat | grep -qi "Stream codec: ${CODEC}"; then
  ok "journal reports 'Stream codec: ${CODEC}'"
else
  bad "journal does not report the expected codec"
  journalctl -u picar --since "-30 seconds" -o cat | grep -i "stream codec" | tail -2
fi

# ── Drive a deliberately slow client ─────────────────────────────────────────
say "Connecting a slow client and watching for drops"
node - "$CODEC" <<'PY'
// A client that receives, then stops reading, so the server's backlog grows and
// the drop rule has to engage. Counts frames and keyframes so the keyframe-priority
// rule can be checked: deltas must shed while keyframes still arrive, or the
// picture can never recover.
const codec = process.argv[2];
const https = require('https');
let frames = 0, keyframes = 0, bytes = 0;

function done(extra = '') {
  console.log(`CLIENT frames=${frames} keyframes=${keyframes} bytes=${bytes} ${extra}`);
  process.exit(0);
}
setTimeout(() => done('(timeout)'), 25000);

if (codec === 'h264') {
  const { WebSocket } = require('/opt/picar/node_modules/ws');
  const ws = new WebSocket('wss://localhost:8081/stream', { rejectUnauthorized: false });
  ws.on('message', (d) => {
    frames++; bytes += d.length;
    // Annex-B: NAL type 5 = IDR, and a keyframe packet leads with SPS (7).
    const t = d.length > 4 ? (d[4] & 0x1f) : 0;
    if (t === 7 || t === 5) keyframes++;
    if (frames === 20) ws.pause();       // stop reading -> backlog grows
  });
  ws.on('error', (e) => done(`(ws error ${e.message})`));
  ws.on('close', () => done('(closed)'));
} else {
  const req = https.get({ host: 'localhost', port: 8081, path: '/stream.mjpg',
                          rejectUnauthorized: false }, (res) => {
    res.on('data', (d) => {
      bytes += d.length;
      // count SOI markers rather than chunks
      for (let i = 0; i < d.length - 1; i++) if (d[i] === 0xFF && d[i + 1] === 0xD8) frames++;
      if (frames === 20) res.pause();    // stop reading -> backlog grows
    });
    res.on('end', () => done('(ended)'));
  });
  req.on('error', (e) => done(`(http error ${e.message})`));
}
PY

sleep 2
say "Server-side drop accounting"
DROPS="$(journalctl -u picar --since "-40 seconds" -o cat | grep -ciE 'dropped .*(frame|stale)' || true)"
if [[ "${DROPS}" -gt 0 ]]; then
  ok "server logged ${DROPS} drop line(s)"
  journalctl -u picar --since "-40 seconds" -o cat | grep -iE 'dropped .*(frame|stale)' | tail -3 | sed 's/^/       /'
else
  bad "server logged NO drops — the drop path did not engage"
  note "this is the failure mode that hid for weeks: host tests green, path never run"
fi

say "Parse buffer stayed bounded"
if journalctl -u picar --since "-40 seconds" -o cat | grep -qiE 'buffer exceeded|resync'; then
  note "buffer bound engaged (this is the guard working, not a failure)"
fi
if journalctl -u picar --since "-40 seconds" -o cat | grep -qiE 'heap out of memory|FATAL ERROR'; then
  bad "process hit an allocation failure"
else
  ok "no allocation failure"
fi

say "Not covered by this script"
note "the DEFAULT thresholds — they gate on ws.bufferedAmount and are effectively"
note "unreachable on a local link, so this forces them low and tests the mechanism"
note "the webrtc path has no picar-side queue at all, so it has no drop path to test"
