# TASKS

Open work only. Completed tasks are **deleted** from this file — their record lives in
`HANDOFF.md`. Priorities: `P0` safety/security · `P1` correctness · `P2` performance ·
`P3` hygiene.

## In progress

- **[P3] Establish the agent directive and skill pipeline** — `CLAUDE.md`, `HANDOFF.md`,
  `TASKS.md`, `AGENTS.md`, `.claude/skills/*`, `.claude/agents/*`.
  Branch `chore/agent-directive-and-skills`. Awaiting Second Opinion review and on-rover
  validation of the deploy/validate loop itself.

## Backlog

### P0 — safety and security

- **Push, validate, and merge the safety branch `agent/fix-control-failsafe`** — commit
  `6220780` (13 files, +1226/−110) carries the entire control-safety layer: the single-owner
  lease, per-command token + sequence + timestamp integrity checking, the NTP-midpoint
  clock-skew check, the input watchdog, fail-safe stops on every disconnect/hide/timeout
  path, arm-gating on verified flight-controller params, and 24 host tests. **None of it is
  on `main`**, where
  `app.js:125` arms the vehicle from any socket that can reach `:8443`.
  **The branch has never been pushed — it exists on one workstation and nowhere else, so a
  disk failure loses it.** Push it first as a backup, then run it through the pipeline:
  Second Opinion, deploy to rover3, full Embedded Validator pass, merge. Everything else in
  this file is lower priority than getting this validated and landed.

- **rover3's Pixhawk is configured as a Boat** — `main`'s `DEFAULT_PARAM_OVERLAY`
  (`pwm_mavproxy_servo.js:37`) sets `FRAME_CLASS: 2` behind a comment that says "Rover".
  In ArduPilot Rover, `1` = Rover and `2` = Boat, so every connect re-asserts the wrong
  frame class; confirmed live in rover3's journal (`PARAM_SET FRAME_CLASS=2`). Not a
  regression — the previously-running branch `cdf4ae1` sets `2` as well, so the vehicle has
  been running this way. `agent/fix-control-failsafe` already corrects it to `1`; merging
  that branch fixes it, and the Pixhawk then needs a power-cycle to take the new frame
  class.

- **Fail-safe sends DISARM before neutral on the wire** — `control-safety.js::_failSafe`
  calls `_neutralize()`, but `setServoPWM` only mutates the driver's channel buffer and
  transmits nothing; `pwm_mavproxy_servo.js::disarm()` then sends COMMAND_LONG DISARM
  immediately, while the neutral RC_CHANNELS_OVERRIDE waits for the next 20 Hz tick
  (`pwm_mavproxy_servo.js:278`). So the actual packet order is **disarm, then neutral** —
  the reverse of what the code reads like, what `README.md` claims, and what this file
  previously claimed. Impact is bounded: ≤50 ms of stale override, with the flight
  controller's `RC_OVERRIDE_TIME=0.2` as a backstop — hence P1, not P0. But the existing
  tests assert *method-call* order against a mock and therefore cannot see it. Fix: send an
  explicit neutral RC override packet before DISARM, and cover it with a host test that
  asserts packet order plus an on-target capture. Correct the `README.md` claim too.
  *(Found by Codex adversarial review, 2026-07-30; verified against the source.)*

- **Orientation control has no throttle deadzone — uncommanded motion** — `socket.html:1409`
  maps device tilt straight to throttle via `(45 - beta) / 50` with no deadzone and no
  shaping, and it is live whenever the lease is held. Steering gets `applyCurve`; throttle
  gets nothing. After a compliant neutral arm, ordinary hand tremor produces nonzero
  throttle on an actuating vehicle. Fix: explicit neutral calibration at arm, a deadzone,
  bounded response shaping, and tests before orientation mode is enabled on a vehicle that
  can move. *(Reclassified from P3 hygiene — the original priority contradicted this repo's
  own definition of P0/P1, per Codex adversarial review.)*

- **Verify param read-back actually succeeds on rover3 before trusting arm-gating** —
  `agent/fix-control-failsafe` refuses to arm until every `EXPECTED_CRITICAL_PARAMS` entry
  is read back over MAVLink. On rover3 today, zero params verify (see the `main` parser
  defect below), so if that mechanism does not work against this Pixhawk, merging the
  safety branch leaves a rover that **can never arm**. This must be proven live before the
  merge, not after. It is the single highest-risk unknown in landing the safety work.

- **Video-param change blocks the event loop while armed** — `streams/webrtc.js:98`
  (`setParams` → `execSync('systemctl restart mediamtx')`), reachable from
  `app.js:129` (`setVideoParams`) with no arm check. A synchronous `systemctl restart`
  freezes the Node event loop for seconds, so the `control-safety.js` input watchdog
  cannot fire and no fail-safe can run while the rover is armed and moving. Violates
  safety invariant 7. Fix: make the restart asynchronous, and refuse video-param changes
  while a control lease is held.

- **Private keys are committed to the repository** — `certs/ca.key`, `certs/key.pem` are
  tracked. Anyone with repo access holds the CA that every operator device is told to
  trust, plus the rover server key. Fix: rotate the CA and server certs, purge the keys
  from tracking, and extend `.gitignore`. Purging them from history rewrites `main` — get
  explicit authorization first.

- **The control plane is unauthenticated** — `app.js:113` accepts a control lease from any
  socket that can reach `:8443`, on a first-come basis; `/status` (`app.js:80`) is open
  too. On a shared or hotspot LAN, any device can arm and drive the vehicle. Acceptable
  for a bench rover, not for a drone. Note the session token is a *lease handle*, not a
  credential — an unauthenticated attacker who arms first satisfies every other invariant,
  so the safety branch does not close this. Fix: authenticate the operator before a lease is
  issued, bind the lease to that principal, and add negative tests proving an
  unauthenticated socket can neither arm nor command.

- **`picar-cfg.local.json` can silently disable safety gates** — `app.js:26`
  `Object.assign`s the untracked overlay over the tracked config, so *any* key can be
  changed on a rover with no branch, diff, review, or validation record — including
  `mavproxy_allow_unverified_arm` (which makes the driver skip critical-param verification
  entirely) and every `max_command_*` / `*_timeout_ms` bound. The overlay is meant to carry
  per-rover identity only. Fix: whitelist the keys it may override, reject the rest loudly at
  startup, expose the effective values on `/status`, and have validation assert the
  *effective* config rather than the file in git.

- **Validation evidence is self-reported, mutable prose** — the merge gate depends on an
  Embedded Validator pass recorded by hand in `HANDOFF.md`, in the same tree it attests to.
  Nothing mechanically ties the merged SHA to the SHA that was tested, and nothing prevents
  a merge without one. `CLAUDE.md` documents a bounded evidence-commit exemption as the
  interim rule. Fix: an attestation keyed to the deployed SHA, stored outside the tested
  tree, enforced as a required protected-branch status check.
  *(All three items above surfaced or sharpened by Codex adversarial review, 2026-07-30.)*

- **Fleet Manager accepts unauthenticated heartbeats** — `fleet-manager/server.js:56`
  stores whatever body arrives under `rovers[body.id]`, including `ip`, which is rendered
  into a `controllerUrl` link on the dashboard. Any LAN host can spoof or hijack a rover
  entry and point operators at an arbitrary address.

### P1 — correctness and robustness

- **`test/on-target/` does not exist** — the validation bar requires a committed, repeatable
  on-target suite, and there is none, so every validation so far has been ad hoc. Nothing
  runtime-affecting should be validated until it exists. Bootstrap it with the checks
  already performed by hand: service active with `NRestarts=0`, expected startup lines,
  autopilot heartbeat seen, RC_CHANNELS_OVERRIDE streaming neutral, `/status` shape, and
  HTTP reachability of `socket.html` / `socket.io` / WHEP. Author it via the Optimizer, not
  the validator.

- **`main`'s MAVLink receive path is dead in practice** — two defects that compound, both
  observed live on rover3 and both already fixed on `agent/fix-control-failsafe`:
  1. `pwm_mavproxy_servo.js:367` accepts only `0xFE` (MAVLink v1). MAVProxy forwards v2
     (`0xFD`) frames from a modern Pixhawk, so every `PARAM_VALUE` reply is silently
     discarded. rover3's journal shows nine `PARAM_SET` writes followed by **zero**
     `verified` or `WARNING` lines — the read-back verification has never once run.
  2. `handleMessage` treats *any* HEARTBEAT as the autopilot's — no `autopilot != 8` check
     and no `sysId` filter — so MAVProxy's own v1 GCS heartbeat satisfies it. The reassuring
     "Received first Pixhawk heartbeat" in the log is very likely MAVProxy talking to
     itself, not evidence the flight controller is alive.

  Together these mean `main` reports a healthy, verified flight controller while having
  confirmed nothing at all. Harmless only because nothing on `main` gates on it — which is
  exactly what the safety branch changes.

- **Critical-param verification never retries** — `pwm_mavproxy_servo.js:379` fires one
  `PARAM_REQUEST_READ` per critical param on a `setTimeout` chain. A single dropped
  `PARAM_VALUE` over the serial link leaves `verifiedCriticalParams` permanently short, so
  `isSafetyReady()` stays false and the rover cannot arm until MAVProxy reconnects, with
  no operator-visible reason beyond a `missingParams` list. Fix: bounded retry with
  backoff, and surface the retry state in `getSafetyStatus()`.

- **500 ms window where the safety layer believes it is armed but motion is dropped** —
  `pwm_mavproxy_servo.js:602` sets `controlEnabled = true` only after `armDelayMs`, while
  `control-safety.js:160` sets `flightControllerArmed = true` immediately. During that
  window `setServoPWM` silently returns `false` for non-neutral motion and nobody checks
  the return value. Fails safe but is invisible. Violates safety invariant 8. Fix: model
  the arming state explicitly and report it to the client.

- **Param-overlay timers survive disconnect** — `pwm_mavproxy_servo.js:368` and `:379`
  schedule up to a dozen `setTimeout`s; the `close` handler
  (`pwm_mavproxy_servo.js:157`) clears only `armTimeout`. Reconnect churn stacks
  overlapping overlay passes. Fix: track and clear the handles on close.

- **Command rejections are never reported to the client** — `control-safety.js:94`
  `handleCommand` returns structured errors that `app.js:136` discards. A client whose
  commands are being rejected as replayed or out-of-order sees a working UI and a dead
  rover. Fix: acknowledge or emit rejections.

- **No MAVLink framing tests** — nothing validates the hand-rolled CRC and wire order in
  `pwm_mavproxy_servo.js` (`buildRCOverride`, `buildCommandLong`, `buildParamSet`,
  `buildParamRequestRead`, `parseIncoming`) against known-good vectors. This is the code
  most likely to break silently against a firmware change. Fix: byte-exact vector tests.

- **Documentation contradicts the installer** — `README.md` still documents `sudo node
  app.js`, a `/home/pi/picar` layout, and a `User=pi` systemd unit, while `install.sh`
  installs in place under the chosen run user and templates the units. Also documents
  `mediamtx.yml` as an editable file though `streams/webrtc.js:78` regenerates it at every
  startup.

### P2 — performance

- **O(n²) NAL scanning** — `streams/h264.js:38` restarts `_findSC` from offset 0 on every
  extraction, and `push` does a `Buffer.concat` per chunk. Per-frame cost on the video hot
  path. Fix: incremental scan offset and a ring or chunk list.

- **O(n²) MJPEG framing in the browser** — `socket.html:934` allocates and copies a new
  `Uint8Array` per chunk, then scans byte-by-byte in JS for `FFD8`/`FFD9`. Fix: index-based
  scanning over a retained buffer.

- **Fleet Manager re-reads `dashboard.html` from disk on every request** —
  `fleet-manager/server.js:96`, synchronously. Cache it at startup.

- **Fleet discovery sweeps the whole `/24` every 5 s, forever, when no FM is present** —
  `fleetmgr-client.js:139` re-runs `discover()` on every tick while `currentBase` is null.
  Each sweep is up to 254 TCP connects at 40 concurrent with a 500 ms timeout, so a rover on
  a subnet with no Fleet Manager — rover3's current state — spends roughly 3 s of every 5 s
  sweeping, permanently. That is continuous CPU and network churn on a CM4 sharing the box
  with the 20 Hz control loop and the camera encoder. Fix: exponential backoff on repeated
  discovery failure.

- **Pi model detection fails on the Compute Module 4** — `pwm_servo.js:6` matches `'pi 5'`,
  `'pi 4'`, `'pi 3'`, but rover3 reports `Raspberry Pi Compute Module 4 Rev 1.1`, which
  contains none of them, so `detectPiModel()` returns `null`. Harmless today because
  `pwm_method: "mavproxy"` skips the override, but any rover switched to a GPIO driver would
  silently keep a possibly-wrong `pwm_method` instead of being corrected. Match the compute
  modules too.

### P3 — hygiene

- **Three unused runtime dependencies** — `mavlink`, `sleep`, `pi-blaster.js` in
  `package.json` are required by nothing in the tree. `pigpio` is a native module that
  compiles on-target during `npm ci` yet is only used by the non-default `pigpion` driver.
  Fix: drop the unused three; make the native driver deps optional.

- **Dead and stale files** — `node-server.sh` (SysV init for a `/home/pi` layout),
  `interfaces` (stale Debian network config, with a stray backtick on the `gateway` line),
  `readme` (superseded by `README.md`), `example.js`, `test_pwm.js`, `pwm_test2.js`. Also
  two near-identical drivers, `pwm_pigpion_servo.js` and `pwm_pigpiod_servo.js`.

- **Repo bloat** — `mav.tlog` (167 KB), `mav.tlog.raw` (128 KB), `mav.parm`, and
  `picar-icon.png` (1.8 MB) are tracked even though `.gitignore` now lists `*.tlog`.
  Untrack them; history rewrite needs authorization.

- **Control-mode button shows a stale initial label** — `socket.html:361` renders
  "Control: Auto", a mode that does not exist, until `activateControlMode` runs on load.
