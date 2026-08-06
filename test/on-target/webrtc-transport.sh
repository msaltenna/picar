#!/usr/bin/env bash
# webrtc-transport.sh — prove WebRTC is carrying video over UDP and cannot fall back to TCP.
#
# Run ON a rover:  test/on-target/webrtc-transport.sh
#
# Read-only. Inspects the generated config, the listening sockets, and MediaMTX's own log.
# It does not restart anything, does not touch the config, needs no root, and commands no
# motion — so it is safe to run on a rover you are not willing to disturb.
#
# WHY THIS EXISTS. `webrtcLocalTCPAddress` was hardcoded in the generated mediamtx.yml, so
# every WebRTC session could silently fall back from UDP to TCP. It did, on all four
# sessions of a failed out-of-sight drive on rover3 (2026-08-06):
#
#   [session e7b1b545] peer connection established,
#     local candidate: host/tcp/192.168.10.224/8189, remote candidate: prflx/tcp/…
#
# TCP is the wrong transport for real-time video — it keeps WebRTC's assumption that media
# may be shed freely while running on a transport with head-of-line blocking. The measured
# consequence was a starved shared hardware encoder (544 `ioctl(VIDIOC_QBUF) failed` in
# 112 s at only 200 kbps offered) and, because video and commands share half-duplex
# airtime, 12 `no input for 1000 ms` control fail-safe trips in the same ~100 s.
#
# The host test (test/webrtc-ice-transport.test.js) proves the yml GENERATOR omits the TCP
# line. It cannot prove the running MediaMTX honoured it, or that a real session picked UDP.
# That is what this script is for. Nothing runs it automatically — a lesson from this same
# branch, where the one check that closed a gap was wired into no npm script at all.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
FAILED=0
WARNED=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; WARNED=1; }
note() { printf '  ---- %s\n' "$*"; }

command -v python3 >/dev/null 2>&1 || { echo "missing required tool: python3"; exit 2; }

# Whether TCP is *meant* to be enabled. Read the EFFECTIVE config — tracked file with the
# untracked overlay merged on top — because the overlay can turn this on with no branch or
# review, and checking only the tracked file would be checking git contents rather than what
# the rover is running.
ICE_TCP_EXPECTED="$(python3 - "$REPO" <<'PY'
import json, os, sys
repo = sys.argv[1]
cfg = {}
try:
    cfg = json.load(open(os.path.join(repo, 'picar-cfg.json')))
except Exception:
    pass
try:
    cfg.update(json.load(open(os.path.join(repo, 'picar-cfg.local.json'))))
except Exception:
    pass
# Mirror the code's strict check: only the literal boolean true enables it.
print('yes' if cfg.get('webrtc_ice_tcp') is True else 'no')
print(cfg.get('stream_codec', 'h264'))
print(cfg.get('webrtc_udp_port', 8189))
PY
)"
WANT_TCP="$(sed -n 1p <<<"$ICE_TCP_EXPECTED")"
CODEC="$(sed -n 2p <<<"$ICE_TCP_EXPECTED")"
ICE_PORT="$(sed -n 3p <<<"$ICE_TCP_EXPECTED")"

say "Effective configuration"
note "stream_codec=${CODEC}  webrtc_ice_tcp=${WANT_TCP}  ice port=${ICE_PORT}"
if [[ "$CODEC" != "webrtc" ]]; then
  warn "stream_codec is '${CODEC}', not 'webrtc' — the ICE checks below do not apply to the active path"
  printf '\n\033[33mSKIPPED\033[0m — not on the webrtc codec\n'
  exit 0
fi

# ── 1. The generated config ──────────────────────────────────────────────────
say "Generated mediamtx.yml"
YML="${REPO}/mediamtx.yml"
if [[ ! -f "$YML" ]]; then
  bad "no ${YML} — picar generates it at startup, so this means picar has not run"
else
  grep -qE "^webrtcLocalUDPAddress: :${ICE_PORT}\$" "$YML" \
    && ok "webrtcLocalUDPAddress: :${ICE_PORT}" \
    || bad "webrtcLocalUDPAddress missing or not on port ${ICE_PORT}: $(grep -E '^webrtcLocalUDPAddress' "$YML" || echo ABSENT)"

  if grep -qE '^webrtcLocalTCPAddress' "$YML"; then
    if [[ "$WANT_TCP" == "yes" ]]; then
      ok "webrtcLocalTCPAddress present, and webrtc_ice_tcp is true (deliberate opt-in)"
    else
      bad "webrtcLocalTCPAddress IS PRESENT while webrtc_ice_tcp is not true — silent TCP fallback is possible again"
    fi
  else
    [[ "$WANT_TCP" == "yes" ]] \
      && bad "webrtc_ice_tcp is true but no webrtcLocalTCPAddress was generated — the opt-in does not work" \
      || ok "no webrtcLocalTCPAddress — TCP fallback is impossible"
  fi
fi

# ── 2. What is actually listening ────────────────────────────────────────────
#
# The config only states intent. A stale MediaMTX still holding a TCP listener from before a
# config change would keep the fallback alive, and the yml would look correct.
say "Listening sockets on the ICE port"
if ss -lun 2>/dev/null | grep -qE "[:.]${ICE_PORT}\b"; then
  ok "UDP ${ICE_PORT} is listening"
else
  bad "nothing is listening on UDP ${ICE_PORT} — WebRTC cannot work at all"
fi
if ss -ltn 2>/dev/null | grep -qE "[:.]${ICE_PORT}\b"; then
  [[ "$WANT_TCP" == "yes" ]] \
    && ok "TCP ${ICE_PORT} is listening, as opted into" \
    || bad "TCP ${ICE_PORT} IS LISTENING — restart mediamtx; the running process predates the config"
else
  [[ "$WANT_TCP" == "yes" ]] \
    && bad "TCP ${ICE_PORT} is not listening despite the opt-in" \
    || ok "TCP ${ICE_PORT} is not listening"
fi

say "MediaMTX listener line"
LSN="$(journalctl -u mediamtx --no-pager 2>/dev/null | grep -F 'listener opened' | tail -1 || true)"
if [[ -z "$LSN" ]]; then
  warn "no 'listener opened' line in the mediamtx journal"
else
  note "${LSN##*INF }"
  if grep -qi 'ICE/TCP' <<<"$LSN" && [[ "$WANT_TCP" != "yes" ]]; then
    bad "MediaMTX opened an ICE/TCP listener — restart it to pick up the current config"
  else
    ok "listener line agrees with the intended transport policy"
  fi
fi

# ── 3. Real sessions ─────────────────────────────────────────────────────────
#
# The decisive check: what transport did an actual peer connection use? This is exactly the
# line that revealed the defect, so it is the line worth asserting on. Absent is not a pass
# and not a failure — nobody may have connected since boot — so it warns and says so.
say "Most recent peer connections"
PCS="$(journalctl -u mediamtx --no-pager 2>/dev/null | grep -F 'peer connection established' | tail -5 || true)"
if [[ -z "$PCS" ]]; then
  warn "no WebRTC session since boot — open the UI and re-run; this check is the whole point of the script"
else
  n_tcp=0; n_udp=0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    # Only inspect the candidate portion, so the word tcp elsewhere cannot mislead.
    cands="${line#*local candidate: }"
    if grep -qi '/tcp/' <<<"$cands"; then
      n_tcp=$((n_tcp + 1)); note "TCP: ${cands}"
    elif grep -qi '/udp/' <<<"$cands"; then
      n_udp=$((n_udp + 1)); note "UDP: ${cands}"
    else
      warn "could not classify candidates: ${cands}"
    fi
  done <<<"$PCS"
  if [[ "$n_tcp" -gt 0 && "$WANT_TCP" != "yes" ]]; then
    bad "${n_tcp} of the last $((n_tcp + n_udp)) session(s) used ICE/TCP — this is the failure mode"
  elif [[ "$n_udp" -gt 0 ]]; then
    ok "all ${n_udp} classified session(s) used ICE/UDP"
  fi
fi

# ── 4. Adaptive bitrate is actually wired in ─────────────────────────────────
#
# THIS IS THE ONLY CHECK THAT CAN SEE IT. The host suite proves buildAdaptiveBitrate() and
# the onTick forwarding, but the single line in app.js that connects them is unverifiable —
# replacing `onTick: adaptiveVideo ? adaptiveVideo.onTelemetry : null` with `onTick: null`
# leaves all 367 host tests green, measured. app.js has no test file, so the wiring is
# observable only from the running process. That is exactly the "correct rule, untouched
# consumer" shape CLAUDE.md names as this repo's dominant defect.
say "Adaptive bitrate wiring"
AB="$(journalctl -u picar -b --no-pager 2>/dev/null | grep -F 'video-adaptive:' | head -3 || true)"
if [[ -z "$AB" ]]; then
  bad "picar logged NOTHING from video-adaptive at startup — the module is not being built, so adaptation is silently absent"
else
  while IFS= read -r l; do [[ -n "$l" ]] && note "${l##*node?[0-9]*]: }"; done <<<"$AB"
  if grep -q 'video-adaptive: active' <<<"$AB"; then
    ok "adaptive bitrate is active, with its ladder logged"
  elif grep -qE 'video-adaptive: (disabled|inactive|NOT running)' <<<"$AB"; then
    warn "adaptive bitrate is NOT running — the reason is logged above; this is a deliberate refusal, not a crash"
  else
    bad "unrecognised video-adaptive startup line — cannot tell whether adaptation is running"
  fi
fi
# A step actually taken is the proof it works end to end, but it only happens on a degrading
# link, so absence here is expected indoors and must not read as a failure.
STEPS="$(journalctl -u picar -b --no-pager 2>/dev/null | grep -cF 'video-adaptive: stepped' || true)"
note "rung changes since boot: ${STEPS:-0} (0 is expected on a strong link — it starts at the ceiling)"

say "Not covered by this script"
note "whether UDP survives the TACTICAL RADIO path — that needs a drive, and it is the"
note "open question: UDP works on lab WiFi and lost its connectivity checks over the radio"
note "the client side: run getStats() in the browser to confirm the nominated pair is udp"

say "Summary"
if [[ $FAILED -eq 0 && $WARNED -eq 0 ]]; then
  printf '\n\033[32mALL CHECKS PASSED\033[0m\n'
elif [[ $FAILED -eq 0 ]]; then
  printf '\n\033[33mPASSED WITH WARNINGS\033[0m — read them\n'
else
  printf '\n\033[31mCHECKS FAILED\033[0m\n'
fi
exit $FAILED
