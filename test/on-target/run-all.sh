#!/usr/bin/env bash
# run-all.sh — the on-target checks that are safe to run on any rover, in one command.
#
# Run ON a rover:  npm run test:on-target
#
# WHY THIS EXISTS. `test:on-target` used to be `node test/on-target/control-e2e.js` — one
# script out of five. Two independent adversarial reviews on 2026-08-06 made the same point:
# a check that no pipeline stage invokes is diligence, not mechanism. `video-keyframes.js`
# was written specifically to close a gap the host suite provably cannot see, and it was
# reachable only by someone remembering a path that appeared nowhere but a code comment.
#
# EVERYTHING RUN HERE IS READ-ONLY AND COMMANDS NO MOTION.
#
# Deliberately EXCLUDED, and each exclusion is listed at the end so it cannot be mistaken
# for coverage:
#   * control-e2e.js needs an explicit --allow-motion opt-in to command any throttle, and a
#     throttle-commanding check is not part of a routine validation run. It IS run here in
#     its default, motion-refusing mode.
#   * video-drop.sh restarts services and rewrites the untracked overlay, so it must be a
#     deliberate act, not part of a routine sweep. It also needs root.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
FAILED=0
declare -a PASSED_LIST=() FAILED_LIST=() SKIPPED_LIST=()

hdr() { printf '\n\033[1m######## %s\033[0m\n' "$*"; }

# Runs one check and records its outcome. Exit status is what decides — never the presence of
# the word PASS in the output, which is how a summary comes to disagree with its own detail.
run_check() {
  local name="$1"; shift
  hdr "$name"
  if [[ ! -e "$1" && ! -e "${DIR}/$(basename "$1")" ]]; then
    printf '  \033[33mSKIP\033[0m %s not present\n' "$1"
    SKIPPED_LIST+=("$name (missing)")
    return 0
  fi
  if "$@"; then
    PASSED_LIST+=("$name")
  else
    local rc=$?
    printf '  \033[31m>>> %s exited %d\033[0m\n' "$name" "$rc"
    FAILED_LIST+=("$name (exit $rc)")
    FAILED=1
  fi
}

run_check "telemetry"        bash "${DIR}/telemetry.sh"
run_check "webrtc-transport" bash "${DIR}/webrtc-transport.sh"
run_check "video-keyframes"  node "${DIR}/video-keyframes.js" 15
run_check "control-e2e"      node "${DIR}/control-e2e.js"

hdr "On-target summary"
for n in "${PASSED_LIST[@]:-}";  do [[ -n "$n" ]] && printf '  \033[32mPASS\033[0m %s\n' "$n"; done
for n in "${SKIPPED_LIST[@]:-}"; do [[ -n "$n" ]] && printf '  \033[33mSKIP\033[0m %s\n' "$n"; done
for n in "${FAILED_LIST[@]:-}";  do [[ -n "$n" ]] && printf '  \033[31mFAIL\033[0m %s\n' "$n"; done

printf '\n  not run here: video-drop.sh (needs root, restarts services, rewrites the overlay)\n'
printf '  not run here: any check that commands motion — control-e2e.js ran in its refusing mode\n'

if [[ $FAILED -eq 0 ]]; then
  printf '\n\033[32mON-TARGET CHECKS PASSED\033[0m\n'
else
  printf '\n\033[31mON-TARGET CHECKS FAILED\033[0m\n'
fi
exit $FAILED
