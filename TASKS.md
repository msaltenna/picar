# TASKS

Open work only. Completed tasks are **deleted** from this file — their record lives in
`HANDOFF.md`. Priorities: `P0` safety/security · `P1` correctness · `P2` performance ·
`P3` hygiene.

## In progress

- **[P0] Root-cause the gear/throttle defect** — investigation across the shift path; see the
  P0 entry below. Blocked on rover1/rover2 access for validation.
- **[P1] Scope the four operator priorities set on 2026-07-30** — gear/throttle bug, latent
  frame dropping, radio/power telemetry, gamepad support. All four are detailed below.

## Backlog

### P0 — safety and security

- **Gear change engages throttle and it cannot be turned off** — operator-reported, 2026-07-30.
  On the two rovers fitted with a high/low gearbox, selecting **high gear** engages throttle
  and it stays engaged, whether the rover was moving or stationary. Uncommanded, unstoppable
  motor output; outranks everything else in this file. Root cause **not yet identified**, but
  the investigation has hard results in both directions:

  *Eliminated by live test on rover3 (2026-07-30, bench servo on output 2, throttle and
  steering pinned at 1500 while ch2 was swept 2000→1500→1100→1000→1500→2000):* servo2 tracked
  ch2 exactly, and **servo3 (throttle) held 1500 with 0 µs spread across the entire sweep**;
  `Vservo` held 6012–6017 mV. There is **no gear→throttle coupling in ArduPilot's mixing**, so
  `FRAME_CLASS=2` (Boat) mixing and the `RCMAP_PITCH=2`/RC2 double-duty conflict are both
  **refuted** as causes of this defect.

  *Confirmed and still live:* `RCPassThru` (`SERVO2_FUNCTION=1`) **ignores `SERVO2_MIN/MAX`* —
  commanding 1000 µs produced 1000 µs on an output whose MIN is 1100.
  **Correction:** `SERVO2_MIN/MAX = 1100/1900` are ArduPilot **factory defaults**, not
  evidence anyone measured that servo's travel — every `SERVOn_MIN/MAX` on the vehicle is
  1100/1900 including the disabled channels 6–16; only channel 3 was deliberately widened to
  1000/2000. An earlier claim that the narrow range was "the fingerprint of a servo hitting
  its stops" was wrong and is withdrawn. Servo overtravel remains a *speculative* hypothesis
  needing a loaded bench sweep on a geared rover, not a supported one.

  *Remaining hypotheses, all requiring a geared rover to discriminate:* shifting under load
  jamming the transmission or stalling the shift servo; an ESC fault latch; or the two
  verified software defects below (no interlock, unvalidated input) putting the gearbox into a
  bad state.

  **Blocker: it is unknown what code the geared rovers actually run.** rover3 was found on a
  stale divergent branch with hand-copied files and an unresolved merge conflict, so assuming
  rover1/rover2 track `main` is unsafe. Get `git rev-parse HEAD` + `git status --porcelain`
  from both before designing a fix. `rover3` has no gearbox, so the mechanical hypotheses
  cannot be tested there at all.

- **A gear change has no interlock whatsoever on `main`** — `socket.html:1411` binds
  **ShiftLeft/ShiftRight** straight to `toggleShift()`, and keyboard is the default control
  mode on every non-touch device. `toggleShift()` on `main` flips the gear and immediately
  calls `sendControlValues()` — no neutral, no stop, no disarm, no speed check
  (`interlock refs on main: 0`). So pressing the Shift key while driving at full throttle
  shifts the gearbox instantly. This is exactly the operator's "put into high gear while
  driving". The only drivetrain interlock that ever existed
  (`requireNeutralForDrivetrainChange` → stop + disarm + reset inputs) lives solely on the
  archived branch and has never been deployed. Note the binding dates to `810d2e8`
  (2026-02-24), five months old, so it does **not** by itself explain "started recently".
  Fix: require neutral-and-stopped before any drivetrain change, and stop binding a bare
  modifier key to a mechanical gear shift.

- **Unvalidated `shift` / `tlock_*` input reaches the servo channel raw** — `app.js:137-140`
  guards `throttle` and `steering` with `Number.isFinite`, but `:156-158` pass `data.shift`,
  `data.tlock_front` and `data.tlock_rear` straight into `setServoPWM` behind only an
  `!== undefined` check. Verified empirically against `main`'s own driver: `shift: []` or
  `shift: null` drives the gear servo to **1500 µs — mid-travel, a half-engaged gear**, while
  `shift: "abc"`, `{}` or `NaN` yields `channels[1] = 0`, which `buildRCOverride` converts to
  **65535 = MAVLink "ignore this field"**, so ArduPilot stops refreshing that override and it
  lapses after `RC_OVERRIDE_TIME`. Any client — and there is no authentication — can do this
  with one malformed JSON field. `main`'s `setServoPWM` also returns `undefined` in every
  case, so no caller can distinguish applied from dropped (violates safety invariant 10).
  Fix: validate every channel identically, reject non-finite input, and return an explicit
  applied/dropped result.

- **Drop latent frames so the video stream and C2 stop stalling** — operator-reported.
  Bound latency in the video path and stop it propagating into the control link. Related
  known causes already filed here: the `execSync` event-loop block in `streams/webrtc.js`,
  the O(n²) NAL scanning in `streams/h264.js`, the O(n²) browser MJPEG parser, and the
  never-backing-off fleet discovery sweep burning ~3 s of every 5 s on a CM4. Needs a
  bounded, drop-oldest queue discipline rather than more buffering.

- **Shelved: the control-safety layer** — the work described in `HANDOFF.md` now lives only
  at `origin/archive/control-failsafe-2026-07-30` (`6220780`). Shelved on operator
  instruction 2026-07-30; `main` remains arm-from-any-socket. Three fixes inside it are
  prerequisites for other priority work and should be cherry-picked independently of any
  decision to revive the lease itself: MAVLink v2 (`0xFD`) frame parsing, the
  autopilot-heartbeat filter (`autopilot != 8` + sysId), and `FRAME_CLASS: 1` (Rover, not
  Boat).

- **rover3's Pixhawk is configured as a Boat** — `main`'s `DEFAULT_PARAM_OVERLAY`
  (`pwm_mavproxy_servo.js:37`) sets `FRAME_CLASS: 2` behind a comment that says "Rover".
  In ArduPilot Rover, `1` = Rover and `2` = Boat, so every connect re-asserts the wrong
  frame class; confirmed live in rover3's journal (`PARAM_SET FRAME_CLASS=2`). Not a
  regression — the previously-running branch `cdf4ae1` sets `2` as well, so the vehicle has
  been running this way. The archived branch already corrects it to `1` — **cherry-pick that
  one-line fix**, do not revive the whole branch. The Pixhawk then needs a power-cycle to
  take the new frame class. This is also a live suspect in the gear/throttle defect above,
  since Boat mixing may route a channel differently than Rover mixing.

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

- **Prove MAVLink read-back works on this Pixhawk at all** — on rover3 today **zero**
  parameters verify, because `main`'s parser is v1-only (see the P1 parser entry below). Until
  a v2-capable parser is shown to actually receive `PARAM_VALUE` from this flight controller,
  two things are unsafe to assume: that the radio/power telemetry work can read anything, and
  that any future arm-gating would ever open. This is the cheapest high-value experiment
  available — cherry-pick the archived v2 parser, deploy to rover3, and confirm
  `verified SERVO1_FUNCTION=26` and friends appear in the journal. Do it before building on
  MAVLink receive.

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

### P1 — new features (operator priorities, 2026-07-30)

- **Radio status and Power status on the UI and the Fleet Manager** — three data sources
  confirmed by the operator: the **Pixhawk power module** (battery V/A via MAVLink
  `SYS_STATUS` / `BATTERY_STATUS`), a **SiK telemetry radio** (`RADIO_STATUS` RSSI/noise),
  and **WiFi link quality** (read from the Pi's wireless interface, not MAVLink).
  Existing plumbing to reuse rather than reinvent: `fleetmgr-client.js` already defines a
  status bitmask with `bit 0 = battery trouble` and exports `setStatusBit()`, which nothing
  calls; `fleet-manager/server.js` `decodeStatus()` already decodes it; `picar-cfg.json`
  already carries `batteryWarnLevel: 20`; and `socket.html`'s status bar has an established
  `uiCfg` checkbox pattern to extend.
  **Hard dependency:** `main`'s MAVLink parser accepts only v1 (`0xFE`) and drops the v2
  (`0xFD`) frames MAVProxy actually forwards, so *no* MAVLink telemetry can be read until the
  v2 parser is cherry-picked from the archive branch. Also confirm `BATT_MONITOR` is
  configured on the flight controller — if it is `0`, the Pixhawk reports no voltage at all
  and this is a parameter task before it is a code task.

- **Xbox / PlayStation controller support** — a fourth control mode in `socket.html`
  alongside joystick / keyboard / orientation, via the browser **Gamepad API**; the pad pairs
  to the operator's device, not the Pi (operator-confirmed). Must follow the existing
  `activateControlMode` / `deactivateAllControls` structure and the `uiCfg` checkbox pattern.
  Safety requirements are the hard part: gamepad disconnect mid-drive must fail safe exactly
  as `touchcancel` / blur / page-hide do; arming must stay a deliberate UI action rather than
  a pad button; and a trigger held at arm time must not become throttle — apply deadzone and
  shaping, which orientation mode currently gets wrong.

### P1 — correctness and robustness

- **`test/on-target/` does not exist** — the validation bar requires a committed, repeatable
  on-target suite, and there is none, so every validation so far has been ad hoc. Nothing
  runtime-affecting should be validated until it exists. Bootstrap it with the checks
  already performed by hand: service active with `NRestarts=0`, expected startup lines,
  autopilot heartbeat seen, RC_CHANNELS_OVERRIDE streaming neutral, `/status` shape, and
  HTTP reachability of `socket.html` / `socket.io` / WHEP. Author it via the Optimizer, not
  the validator.

- **`main`'s MAVLink receive path is dead in practice** — two defects that compound, both
  observed live on rover3 and both already fixed on the archived branch:
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
