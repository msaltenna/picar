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
#
# THE FIRST VERSION OF THIS FUNCTION REPORTED "ON-TARGET CHECKS PASSED" WHILE RUNNING NOTHING.
# Caught on rover3, 2026-08-06, first run. Two independent bugs, and both are worth naming
# because they are the same class of defect this whole suite exists to catch:
#
#   1. It tested `[[ ! -e "$1" ]]` AFTER `shift`, so `$1` was the interpreter (`bash`, `node`)
#      rather than the script path. Neither is a file in the working directory, so every
#      check took the not-present branch.
#   2. A missing check was a SKIP, and skips did not set FAILED — so the summary printed a
#      green PASS having executed not one assertion.
#
# So: the script path is validated explicitly, a missing script is a FAILURE rather than a
# skip (a named check that is absent means absent coverage, not a clean run), and a run in
# which nothing executed cannot report success.
run_check() {
  local name="$1"; shift
  local interpreter="$1"
  local script="$2"
  hdr "$name"
  if ! command -v "$interpreter" >/dev/null 2>&1; then
    printf '  \033[31mFAIL\033[0m interpreter %s is not available\n' "$interpreter"
    FAILED_LIST+=("$name (no $interpreter)")
    FAILED=1
    return 0
  fi
  if [[ ! -f "$script" ]]; then
    printf '  \033[31mFAIL\033[0m %s is missing — a named check that is absent is absent coverage\n' "$script"
    FAILED_LIST+=("$name (missing $script)")
    FAILED=1
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

# A run in which nothing executed must never report success. This is the backstop for the
# bug above: even if some future edit reintroduces a silent skip, an empty pass list fails.
if [[ ${#PASSED_LIST[@]} -eq 0 ]]; then
  printf '\n\033[31mON-TARGET CHECKS FAILED\033[0m — no check actually ran\n'
  exit 1
fi

if [[ $FAILED -eq 0 ]]; then
  printf '\n\033[32mON-TARGET CHECKS PASSED\033[0m (%d checks)\n' "${#PASSED_LIST[@]}"
else
  printf '\n\033[31mON-TARGET CHECKS FAILED\033[0m\n'
fi
exit $FAILED
