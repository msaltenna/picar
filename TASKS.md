# TASKS

Open work only. Completed tasks are **deleted** from this file — their record lives in
`HANDOFF.md`. Priorities: `P0` safety/security · `P1` correctness · `P2` performance ·
`P3` hygiene.

> **Every line number in this file was re-verified against `main` @ `4580209` on 2026-08-03.**
> The previous revision carried ~20 citations that pointed at the wrong code, and four entries
> that described the archived branch rather than `main`. If you add an entry, cite a line you
> have actually opened — a wrong citation sends the next reader to code that does not exist and
> gets enshrined as fact (`.claude/skills/auditor/SKILL.md` had adopted two of them as its
> worked example).

## In progress

- **[P1] Four branches remain open; this ledger is a HISTORICAL record, not a claim about
  current tips** (rewritten 2026-08-12). Six merged to local main on 2026-08-12 with on-rover
  evidence recorded in `HANDOFF.md`. **`origin` is untouched and nothing is pushed.**

  The heading said "Nine branches, ALL reviewed", which a reviewer correctly called false:
  several tips had advanced past their reviewed SHA, and `fix/identify-autopilot-before-overlay`
  was absent from the table while the same diff recorded it as unreviewed. Treating an ancestor's
  review as coverage for amended safety code is how the Second Opinion stage gets skipped without
  anyone deciding to. **Reviewed SHA and current SHA are separate below, and a moved tip is
  PENDING RE-REVIEW whatever its ancestor scored.**

  Still open, none validated, none pushed: `fix/verify-gps-disable-params` @ `66df00c`,
  `fix/align-steering-rc-range` @ `add9294`, `feature/fc-failsafe-params` @ `583f18c`,
  `fix/systemd-restart-limits` @ `b2ef26e`, and the parked, never-reviewed
  `fix/webrtc-require-udp` @ `370d39d`.

  Codex verdicts, one review per branch, each in its own detached `git worktree`:

  | Branch | SHA | Verdict | HIGH |
  | --- | --- | --- | --- |
  | `chore/remove-px4-param-dump` | `345f300` | NEEDS-CORRECTION | 0 |
  | `fix/verify-gps-disable-params` | `66df00c` | NEEDS-CORRECTION | 2 |
  | `fix/align-steering-rc-range` | `add9294` | NEEDS-CORRECTION | 2 |
  | `chore/record-audit-2026-08-11` | `d8110cb` | NEEDS-CORRECTION | 5 |
  | `fix/systemd-restart-limits` | `b2ef26e` | **NO-SHIP** | 5 |
  | `feature/fc-failsafe-params` | `376fec2`,`583f18c` | **NO-SHIP** | 6 |
  | `chore/validator-battery-premise` | `34de5a4` | **NO-SHIP** | 5 |
  | `fix/overlay-merges-not-replaces` | `ac80d59` | **NO-SHIP** (2nd round) | 1 |
  | `fix/motion-gate-fails-closed` | `b4a485c` | NEEDS-CORRECTION | 2 |

  **~57 findings, 23 HIGH; four NO-SHIP and five NEEDS-CORRECTION.** Per-branch remediation is in
  the P0/P1 entries below. The three
  branches from this session (`validator-battery-premise`, `overlay-merges-not-replaces`,
  `motion-gate-fails-closed`) are new work, not part of the earlier five.

  The Second Opinion stage is **no longer escalated** — that entry is deleted. Codex ran cleanly
  on every branch (`codex-cli 0.146.0`, `gpt-5.6-sol`, exit 0 each time). The earlier timeouts
  were a foreground-invocation problem: scope each review to ONE branch's diff, run it detached
  with a generous ceiling, and it completes in 5-20 minutes.

- **[P0] The dominant defect shape is now measured, not suspected: a correct rule with an
  untouched consumer** — every substantive finding across all nine branches reduces to it, and
  `CLAUDE.md` already names it. Recorded here because it is a *review-process* requirement, not
  a single defect:
  - The five audit branches each add a rule plus a test asserting two **static tables** agree,
    while production pushes a different object (`this.paramOverlay`).
  - `chore/validator-battery-premise` corrected a false premise in three directive files and left
    the **code that acts on it** commanding motion.
  - `fix/overlay-merges-not-replaces` protected the sanitizer and left **four** consumer
    mutations alive; the rewrite closed the broad ones and a targeted one still survives.

  **So: for every rule a branch adds, mutate its CALL SITE, not the rule.** A test that imports
  a table and compares it to another table cannot fail for the reason that matters.

- **[P0] Four commit bodies in this repo claimed mutations were dead when they were not** — now
  five and six. `fix/systemd-restart-limits` says "Mutation-tested: 8/8 killed"; `RestartSec=20`,
  `StartLimitIntervalSec=1` and `StartLimitBurst=8` all survive, and the first two were
  reproduced by hand (3 pass / 0 fail each). `feature/fc-failsafe-params` says "7/7 killed" while
  every one of its six ACK tests builds **v1** frames, so discarding msgId 77 when `isV2` is
  green. Do not accept a mutation table as evidence; re-derive it.
- **[P0] Close the unauthenticated attack surface** — the RCE, the missing Origin check, and the
  Fleet Manager XSS below. These are reachable today from any device that can open a socket to a
  rover, with no credential. Scheduled as Phase 1.
- **[P0] Root-cause the gear/throttle defect** — see the P0 entry below. **Still blocked on
  geared-rover access, and it got worse:** re-measured 2026-08-11, **neither `rover1` nor `rover2`
  resolves** (`Name or service not known`). On 2026-08-03 `rover2` at least resolved and refused
  `publickey`, so `ssh-copy-id` is no longer the fix — establish whether they are powered and on
  the network first. rover3 has no gearbox, so this cannot be reproduced there at all.

## Backlog

- **[P3] Hardware-only encoder options are emitted even when the codec is software** —
  `streams/webrtc.js` writes `rpiCameraHardwareH264Profile` and `rpiCameraHardwareH264Level`
  unconditionally, so a rover running `softwareH264` (which rover1's CM5 is FORCED onto — no
  hardware encoder) receives hardware-encoder settings that do not apply to it. Harmless today,
  because MediaMTX ignores them, but it is a generated config that lies about what the encoder
  is doing, and the next person tuning software H.264 will reasonably believe profile/level are
  in play. Emit them only when the codec is `hardwareH264`.

- **[P2] Nothing measures whether encoder CPU reaches the CONTROL path** — `codec-benchmark.sh`
  shows softwareH264 at 78.4% of a core at 720p30 on a CM4, on the same four cores as the
  control loop, the 20 Hz override stream and the input watchdog. Invariant 9 says a blocked
  event loop is a safety failure, and no measurement connects the two. Add event-loop lag
  sampling (`perf_hooks.monitorEventLoopDelay`) to the telemetry tick, so the cost of a video
  setting is visible as a control-path number rather than inferred from `%CPU`.


- **[P0] The tracked `mavproxy.service` hardcodes `/dev/ttyACM0`, which does not survive a flight
  controller reboot** — observed on rover1, 2026-08-12. Rebooting the FC (any parameter change
  requiring it, or a reflash) does not release the old handle, so the board re-enumerates as
  `ttyACM1`/`ttyACM2`. MAVProxy then failed 5 times in 2 s, hit `Start request repeated too
  quickly`, and stayed DOWN — taking picar's only link to the vehicle with it, on a rover with a
  live pack. Two independent defects: the hardcoded path, and the restart budget being far too
  small to outlast USB enumeration (`fix/systemd-restart-limits` addresses the second only).
  Fix `systemd/mavproxy.service` to use `/dev/serial/by-id/...`, which follows the board by
  serial number. rover1 carries a local drop-in as a stopgap
  (`/etc/systemd/system/mavproxy.service.d/by-id-master.conf`); rover3 does not, and will hit
  this the first time its FC reboots.

- **[P1] Nothing in picar can see the parameters that decide whether the vehicle can move at
  all** — `BRD_SAFETY_DEFLT=1` on rover1 inhibited every PWM output at the IO level while
  `/status` reported `linkUp: true`, a fresh heartbeat, and **11/11 critical parameters
  verified**. The ESC fast-blinked and the rover was undriveable, and picar's own health
  reporting said everything was fine. `EXPECTED_CRITICAL_PARAMS` owns 13 of ~918 parameters and
  says nothing about the rest. At minimum add the safety-switch state — `SYS_STATUS`'s
  `MAV_SYS_STATUS_SENSOR_PREARM_CHECK` / safety bits, and the PreArm STATUSTEXT stream — to
  telemetry, so "FC: ok" cannot mean "cannot move".

- **[P1] rover1 performs worse than rover3 and the cause is UNDIAGNOSED** — reported by the
  operator 2026-08-12; rover1 went unreachable before flight mode, CPU load or video
  configuration could be measured, so nothing below is confirmed. Candidates, in the order worth
  checking:
  1. **Flight mode.** rover3 is documented running `MANUAL` with `RCMAP_THROTTLE=3`, direct
     passthrough. A freshly reflashed rover1 has default modes, and anything other than MANUAL
     changes throttle response completely. Check first — it is the cheapest and the most likely.
  2. **Software H.264.** rover1 is a CM5 and has NO hardware encoder (`/dev/video11` absent,
     verified), so `webrtc_codec: softwareH264` is forced. rover3 is a CM4 and uses the hardware
     encoder. Software encoding costs CPU and adds latency, and on a shared event loop that can
     degrade the CONTROL path too, not just video (invariant 9). Measure picar's CPU and the
     stream's latency before blaming it.
  3. **Everything outside the 13 overlay parameters is at ArduPilot defaults** after the reflash,
     while rover3 has accumulated tuning — `ATC_*`, `ATC_ACCEL_MAX`, `ATC_BRAKE`, steering rate
     gains. picar owns 13 of ~918 and never compares the rest.
  4. **No accelerometer or compass calibration** on rover1, so the EKF has no good attitude
     solution. Does not block MANUAL driving; does affect anything using attitude.

  **The right tool here is a parameter DIFF against rover3, which is why rover3's baseline should
  be captured the moment it is reachable** — same read-only method used for rover1
  (`PARAM_REQUEST_LIST`, stopping picar for the single TCP slot), stored outside the repo.


- **[P1] `params.verified` has no freshness, so stale verification can authorise motion** —
  `pwm_mavproxy_servo.js` retains `verifiedCriticalParams` until the TCP link closes and stops
  re-requesting parameters after first success. A critical parameter changed later on the SAME
  connection stays reported verified indefinitely, and `hardwareReadyForMotion` in
  `test/on-target/control-e2e.js` treats that set as current evidence. Add per-parameter
  verification timestamps, a bounded on-demand read-back before each state-changing section, and
  fail closed on timeout or staleness. Raised twice by review against the motion gate.

- **[P1] The fail-safe stop cannot be confirmed, only requested** — `app.js` zeroes its local
  `steering`/`throttle` BEFORE attempting `neutralizeAndDisarm()`, so `/status` reads neutral even
  when the MAVProxy write fails, the link wedges, or the flight controller keeps its last output.
  `control-e2e.js`'s final stop now says so explicitly rather than claiming the vehicle stopped,
  but the real fix is the handler returning `neutralSent`/`disarmSent` plus fresh MAVLink
  evidence. This is the "a successful write() is not proof of delivery" P0 in its most
  consequential form.

- **[P1] `setDrivetrain` revalidates nothing before actuating** — the on-target script checks
  readiness once, then production waits a further ~1 s settle before moving the gearbox. A client
  precheck cannot close that race; the server handler must revalidate link and heartbeat
  freshness immediately before actuation and cancel on link loss.

- **[P2] rover3's battery voltage sense read 7.32 V on 2026-08-12, not 0.007 V** — the broken-
  sense finding recorded on 2026-08-11 did not reproduce after the rover's modifications. Either
  it was repaired or it is intermittent, and the two have very different consequences for every
  script that branches on plausibility. Re-measure across a few power cycles and settle which,
  then correct the several places that describe the sense as broken.


### P0 — safety and security

- **[P0] `test/on-target/control-e2e.js` let a BROKEN SENSOR authorise motion — fixed on a branch,
  not merged** — the highest-severity finding of 2026-08-11. The gate read
  `const live = b && b.voltageV != null && b.voltageV > 3; if (!live) return;`. rover3's analog
  voltage sense is dead (`voltageV 0.007` while `currentA 0.54`), so `live` was false, the guard
  returned, and `npm run test:on-target` **armed the vehicle and commanded steering and a
  drivetrain change with no `--allow-motion` flag** — on a rover with a pack installed, armed
  continuously, whose FC refuses DISARM. **Four** of the five readings rover3 can produce opened
  the gate: `0.007`, exactly `3.0`, exact `0`, and `null`. Only a plausible reading above 3 V
  refused. An earlier revision of this entry said three and omitted `3.0`, which the strict
  `> 3` comparison also lets through — the boundary case, and the one a reader would assume was
  covered.

  The function's own comment four lines above said *"Fails CLOSED — 'I could not tell' must never
  read as 'it is safe'"*. The code did the reverse one line later; nothing enforced the comment.
  This is the 2026-08-05 throttle-probe reasoning error reached through a broken reading instead
  of a stale comment, and `CLAUDE.md`'s correction had already asked for exactly this fix ("make
  the guard require a *positive* determination") six days earlier.

  Fixed on `fix/motion-gate-fails-closed` (`b4a485c`): the flag is the only authorisation, the
  battery is reported and never consulted, an implausible reading is labelled as proving nothing
  in either direction, and the script is exported behind `if (require.main === module)` so a host
  test can drive the gate without arming a rover as an import side effect.
  `test/motion-gate.test.js` drives the real exported guard; five mutations killed including
  restoring the original logic. **Entry stays open until it merges.**

- **[P0] The parameter overlay REPLACED the built-in set instead of merging — fixed on a branch,
  not merged** — `sanitizeParamOverlay` built `const overlay = {}` and populated it only from
  `config.mavproxy_param_overlay`, using `DEFAULT_PARAM_OVERLAY` only when the key was absent,
  null or not an object. So `mavproxy_param_overlay: {FRAME_CLASS: 1}` in untracked
  `picar-cfg.local.json` produced an effective overlay of **one** parameter, dropping all six
  `SERVOn_FUNCTION` entries, `MOT_SLEWRATE`, `RC3_DZ`, `RC3_TRIM`, `RC_OVERRIDE_TIME`,
  `AHRS_GPS_USE` and `GPS1_TYPE`. Losing `SERVO1_FUNCTION=26`/`SERVO3_FUNCTION=70` means steering
  drives throttle. Nothing gates arming on verification, so read-back reporting the loss is a log
  line, not a refusal. Reported independently as HIGH on three separate branches.

  Fixed on `fix/overlay-merges-not-replaces` (`ac80d59`): merge over the built-in set; an
  `OVERRIDABLE_PARAMS` **allowlist**, empty by design; and over-16-character names refused,
  because `buildParamSet` does `String(name).slice(0, 16)` and `RC_OVERRIDE_TIME` is exactly 16
  characters — so `RC_OVERRIDE_TIMEX` passes any name check and lands on the wire as
  `RC_OVERRIDE_TIME`, setting the stale-override expiry 15× longer. **Entry stays open until it
  merges, and the branch has open findings — see the P1 entry.**

- **[P0] `FS_GCS_TIMEOUT` is unowned, so the FC-failsafe delay is unbounded and unknown** —
  found 2026-08-11 reviewing `feature/fc-failsafe-params`, and it refutes that branch's central
  design claim. ArduRover 4.6.3 applies **`FS_GCS_TIMEOUT` and then `FS_TIMEOUT`** before
  executing the failsafe action; `FS_GCS_TIMEOUT` defaults to 5 s and neither the overlay nor
  `EXPECTED_CRITICAL_PARAMS` owns it. So the nominal delay is **~6.5 s, not the 1.5 s** that
  branch reasons from, and a replacement board holding `FS_GCS_TIMEOUT=120` would verify all 13
  parameters green and still take ~121.5 s to reach Hold after the Pi dies at full throttle.
  Own both parameters, or state the delay as unknown — do not push a trigger whose latency the
  overlay does not control.

- **[P0] `FS_GCS_ENABLE=1` does not cover a WEDGED picar, which is the failure that actually
  happened** — ArduPilot counts any heartbeat whose system ID equals `SYSID_MYGCS` (255 on
  rover3), and `mavproxy.service` is a **separate systemd unit** that emits its own sysid-255
  GCS heartbeat. So the trigger stays satisfied for as long as MAVProxy lives, and the recorded
  hour-long total loss of steering and throttle — picar wedged, MAVProxy healthy — would not
  fire it. Covering that case needs `FS_THR_ENABLE`, which keys on the override stream only
  picar produces, and which cannot be enabled until the mode-channel/Hold-recovery entry below
  is settled. **Do not merge `FS_GCS_ENABLE=1` describing it as closing the wedge case.**

- **MAVProxy can wedge and silently swallow the entire control path** — observed live on rover3,
  2026-08-03, causing **total loss of steering and throttle** for over an hour while picar
  reported everything healthy.

  Evidence: `/tmp/mav.tlog` stopped growing at 22:03 and had not moved 70 minutes later.
  `ss -tn` on port 5760 showed **113 628 bytes** backed up unread on picar's live connection and
  **2 187 134 bytes** stranded in a `CLOSE-WAIT` socket MAVProxy never reaped. The process was
  `active` with `NRestarts=0` throughout. Overrides went nowhere: picar commanded `ch1=1200`
  while `SERVO_OUTPUT_RAW` servo1 held 1500.

  **Every layer reported success.** `sendPacket()` returned true because bytes reached the local
  socket, the 20 Hz loop logged `RC Override: ch1=1200 … (client=true)` normally, no fail-safe
  fired, and `/status` was fine. This is precisely the defect Codex identified as *"a successful
  `write()` is not proof of delivery"* — now demonstrated causing real control loss rather than
  as a theoretical gap. It also invalidated an hour of diagnosis, because every `tlog` read was a
  frozen snapshot that looked like live data.

  Likely trigger: repeated `systemctl restart picar` during development leaves connections behind
  on MAVProxy's `tcpin` listener, which it does not clean up. Cleared by rebooting the Pi;
  restarting `mavproxy.service` alone was not tried before the reboot.

  Fixes needed, in order of value:
  1. **Detect it.** picar must notice that nothing is coming back. An autopilot HEARTBEAT
     freshness check already exists on the telemetry branch (`autopilotHeartbeat`) — surface it,
     and treat a link that has gone quiet as a fail-safe condition rather than as healthy.
  2. **Report it to the operator.** A wedged link is indistinguishable from a working one in the
     current UI. It must not be.
  3. **Bound the blast radius.** Close and reopen the TCP connection when no inbound traffic has
     arrived for N seconds, rather than streaming into a dead socket indefinitely.
  4. Investigate whether picar's own reconnect behaviour is leaking the sockets MAVProxy fails to
     reap.

  Until then: **if the rover stops responding, check that `/tmp/mav.tlog` is still growing**
  before suspecting anything else. A frozen tlog means the link is dead regardless of what every
  service and every log line claims.

- **Unauthenticated remote code execution via `setVideoParams`** — `streams/webrtc.js:151-171`
  (`setParams`) validates nothing and interpolates client-supplied values into the MediaMTX
  config generated by `generateMediaMTXConfig` (`streams/webrtc.js:12-57`), then
  `restartMediamtx` (`:107-135`) spawns `systemctl restart mediamtx`. `app.js:229-234` handles
  the event with no auth, no lease, no arm check and no rate limit. A value containing a newline
  plus four spaces of indentation injects an arbitrary **per-path MediaMTX key**, and MediaMTX
  executes `runOnInit` / `runOnDemand` / `runOnAvailable` as shell commands. Proven on 2026-08-03:
  `{fps: '20\n    runOnInit: /bin/sh -c "…"'}` produced `runOnInit` as a sibling of
  `rpiCameraFPS` under the `cam` path. `width`, `height`, `fps` and `idr_period` are all
  injectable; `bitrate` is rendered as `${params.bitrate * 1000}` so a string yields `NaN` — a
  crash-loop DoS rather than execution, because `systemd/mediamtx.service` sets `Restart=always`.
  MediaMTX runs as the same account as picar (`User=saltenna`), so this is code execution as the
  control server's own user. Fix: accept only finite numbers in known ranges, write with
  `fs.promises.writeFile`, refuse video-param changes while armed, and rate-limit the handler.

- **No Origin check on the Socket.IO handshake — the control plane is drive-by reachable** —
  `app.js:103` is `const io = new Server(appServer)` with neither `cors` nor `allowRequest`, and
  no `io.use()` middleware anywhere. Socket.IO v4 applies CORS only to the HTTP polling
  transport; **WebSocket upgrades are not origin-checked** by the browser or the server. So a
  page the operator merely visits can open `wss://<rover>:8443/socket.io/` with
  `transports:['websocket']` and reach every handler — `arm`, `fromclient`, `setDrivetrain`,
  `setVideoParams`. The TLS leg works precisely because operators are instructed to install this
  repo's CA as a trusted root (`README.md`, `certs/setup-certs.sh`). Fix: an `allowRequest`
  origin allow-list covering the WebSocket path, not a `cors` option alone.

- **The control plane is unauthenticated** — `app.js:133-144` arms on any socket's `arm` event
  (guarded only by `drivetrainBusy`), and `/status` (`app.js:78-80`) is open. This is safety
  invariant 1 and nothing on `main` — or on the archived branch — implements it. Note a session
  token would be a *lease handle*, not a credential: whoever arms first wins. Agreed scope
  (2026-08-03): a pre-shared secret in `picar-cfg.local.json` required before a lease is granted
  and bound to the socket, plus the Origin gate above. Ships with negative tests proving an
  unauthenticated socket can neither arm nor command.

- **Any socket can pre-load the channel buffer, so the vehicle lunges on arm** — `app.js:236-272`
  accepts `fromclient` regardless of arm state, and `app.js:255` writes straight into the driver's
  channel buffer. One `{throttle: 1}` packet parks 1900 µs on the throttle channel of a
  *disarmed* vehicle, streamed at 20 Hz. The watchdog neutralises it after
  `input_timeout_ms`, but nothing prevents an attacker re-sending it, and nothing requires the
  first command after an arm to be neutral. This is safety invariant 3, unimplemented. Fix:
  reject non-neutral commands until a neutral one has been seen since the last arm, and treat a
  non-neutral first command as a fail-safe stop rather than a clamp.

- **DISARM does not disarm this flight controller — demonstrated on rover3, 2026-08-03** —
  the fail-safe reports success and the vehicle stays armed. Evidence, from MAVProxy's own tlog
  while rover3 ran `main`'s code at SHA `268561f`:
  - picar transmitted exactly **one** `COMMAND_LONG` `MAV_CMD_COMPONENT_ARM_DISARM`
    (`param1=0`, `param2=21196` force) at 17:53:32, present on the wire as a v1 frame.
  - The flight controller — `sysid 1`, `autopilot 3` (ArduPilotMega), `type 11` (GROUND_ROVER) —
    then sent **222 consecutive HEARTBEATs** over 3 m 40 s, *every one* with `base_mode 129`
    (`SAFETY_ARMED | CUSTOM_MODE_ENABLED`). **Never once unarmed.**
  - The FC sent **no `COMMAND_ACK` for command 400** at all. The only ACKs present are command
    410 (`GET_HOME_POSITION`) with `result=FAILED`, repeating every 2 s (expected — GPS is
    disabled).

  Meanwhile `sendPacket()` returned `true`, `neutralizeAndDisarm()` returned
  `{neutralSent: true, disarmSent: true}`, and `app.js:284` logged
  `### FAIL-SAFE STOP (…) neutral=true disarm=true`. **Every layer reported success and the
  vehicle remained armed.** This converts residual 1 of the fail-safe entry below from a
  theoretical gap ("a successful `write()` is not proof of delivery") into a demonstrated
  failure of the platform's core safety primitive.

  Root cause not yet identified for **this** capture. Candidates: MAVProxy not forwarding picar's
  v1 `COMMAND_LONG` to the serial link; the FC silently rejecting the frame; or a framing detail
  rejected without ACK.

  **Two corrections to this entry, 2026-08-11 — neither changes its finding.**

  1. The gate is gone. This said "**Diagnosing this requires COMMAND_ACK parsing, which requires
     the v2 parser** — so it is gated behind the telemetry-branch merge." The telemetry branch is
     merged, and COMMAND_ACK parsing turned out **not** to need the v2 parser at all: it needed a
     `MSG_CRC_EXTRA[77] = 143` and `MSG_PAYLOAD_LEN[77] = 3` entry, which is what unmerged
     `feature/fc-failsafe-params` (`376fec2`) adds. The blocker was two table entries, and
     believing it was a parser rewrite is why this sat undiagnosed.
  2. The closing sentence read "No actuation was possible during this test; rover3's flight
     battery is disconnected." Removed. `CLAUDE.md` ruled on 2026-08-05 that this premise must
     never be written as a standing fact, and the measured `/status` voltage that would be used to
     re-establish it is itself broken (see the battery-sense entry below).

  Corollary, unchanged: `main` *does* send a disarm on connect — it simply does not work.
  **Assume any rover may be armed at any time, including after a picar restart, a crash, or a
  reboot.** Measured 2026-08-11: rover3 is armed (`base_mode=193`) and has been continuously.

- **A SECOND capture, 2026-08-11: the autopilot ACKed the disarm and REFUSED it** — recorded as a
  separate observation rather than folded into the 2026-08-03 entry above, because it is a
  **different capture and does not corroborate or refute that one**. From `/tmp/mav.tlog` on
  rover3, ArduRover V4.6.3, ~24-minute window, 1434 autopilot heartbeats at `base_mode 193`:

  - `COMMAND_LONG` cmd=400 `param1=0 param2=21196` from sysid 255, ×1 — picar's disarm.
  - **`COMMAND_ACK` cmd=400 `result=4` (`MAV_RESULT_FAILED`) from sysid 1, ×1.**
  - `COMMAND_ACK` cmd=410 `result=4`, ×712 (`GET_HOME_POSITION`, expected with GPS disabled).
  - No `COMMAND_LONG` 176 (`DO_SET_MODE`) in the window at all.

  So in **this** capture the frame reached the autopilot, was parsed, and was actively rejected —
  a different mechanism from "never accepted", and it points at why `AP_Arming` refuses rather
  than at framing or transport. picar could not observe it either way: msgId 77 had no
  `CRC_EXTRA` entry, so every ack was discarded a byte at a time.

  Note the 2026-08-03 entry's numbers (3 m 40 s, 222 heartbeats, `base_mode 129`, ~110 cmd-410
  acks, SHA `268561f`) and these do not describe the same run. **Do not merge the two.** Whether
  the FC's behaviour changed, or the earlier capture simply missed an ack, is open. Settling it
  needs one repeat: send ~20 disarms with the ack decode in place and count the acks — consistent
  `result=4` indicts `AP_Arming`; intermittent silence indicts the transport.

- **[P0] Both flight-controller failsafe triggers are disabled, so nothing stops the vehicle when
  picar dies** — measured on rover3 2026-08-11 (ArduRover V4.6.3, 918 params):
  `FS_THR_ENABLE=0`, `FS_GCS_ENABLE=0`, `FS_CRASH_CHECK=0`. `FS_ACTION=2` (Hold) and
  `FS_TIMEOUT=1.5` are configured but unreachable with both triggers off. When picar stops
  transmitting for any reason — Pi power loss, SIGKILL, a blocked event loop — the override stream
  stops, `RC_OVERRIDE_TIME=0.2` releases the overrides after 200 ms, the FC reverts to RC input
  with no receiver fitted, no failsafe bit is set, and the throttle **holds its last commanded
  value**. With an autopilot that refuses DISARM, that is a runaway with no operator link and
  nothing to stop it. Addressed for the GCS-loss half only on unmerged
  `feature/fc-failsafe-params` (`583f18c`, `FS_GCS_ENABLE=1` + `FS_ACTION=2` pushed and verified).
  `FS_THR_ENABLE` deliberately left at 0 — see the Hold-recovery entry below.

- **[P0] Every battery failsafe on the flight controller is disabled** — measured 2026-08-11:
  `BATT_LOW_VOLT=0`, `BATT_CRT_VOLT=0`, `BATT_FS_LOW_ACT=0`, `BATT_FS_CRT_ACT=0`,
  `BATT_ARM_VOLT=0`. A flat pack triggers nothing on the FC, and `batteryWarnVolts` in
  `picar-cfg.json` is a display warning on the companion computer, not a vehicle action. Compounded
  by the broken voltage sense below: the one input a battery failsafe would key on is unreliable.

- **[P0] The battery voltage sense is broken, and the on-target motion guard depends on it** —
  measured 2026-08-11: `/status` `telemetry.battery` = `voltageV 0.007, currentA 0.54,
  remainingPct 95, pctSource "flightcontroller"`, with `telemetry.power.servoV 0`. Voltage reads
  ~0 while current reads 0.54 A; both cannot be right. FC params are `BATT_MONITOR=4`,
  `BATT_VOLT_PIN=8`, `BATT_VOLT_MULT=18.18`, so it is an analog sense whose voltage side appears
  dead. `remainingPct` is arithmetic from `BATT_CAPACITY=3300` against unmeasured consumption, so
  it is not independent, and MAVProxy logs "Flight battery 100 percent" from the same non-fact.
  **`test/on-target/control-e2e.js:107` is a WARNING gate, not a motion gate** — with the sense
  at 0.007 V it reads "no battery" and `return`s, skipping the warning and then arming, steering
  and shifting the gearbox anyway, with or without `--allow-motion`. An earlier revision of this
  entry said it "fails safe for the script"; **that is withdrawn — it fails OPEN**, and the same
  wrong wording was in `HANDOFF.md`. It also cannot distinguish a disconnected pack from a broken
  sense, which is the exact reasoning error that produced the 2026-08-05 throttle probe. Fix the
  sense, and make the guard require a *positive* determination rather than treating an
  implausible reading as "safe" (the rewrite is on `fix/motion-gate-fails-closed`).

- **[P0] picar releases the mode channel, so it cannot recover the vehicle from Hold** —
  `pwm_mavproxy_servo.js:298` allocates `channels = new Uint16Array(8)` and assigns only indices
  0–5; `buildRCOverride` maps `0 → 65535`, the MAVLink "release this channel" sentinel. So RC7 and
  RC8 go out released — and measured `MODE_CH=8`. picar therefore cannot drive the mode switch,
  and its `MAV_CMD_DO_SET_MODE` sends `base_mode=1` whose acceptance is unconfirmed (no 176 appears
  in any capture). Consequence: **enabling `FS_THR_ENABLE` today risks parking the rover in Hold
  with no way back**, trading uncommanded motion for a vehicle that cannot be driven. Mitigating
  factor, measured: `MODE1..MODE6` are all 0 (MANUAL) and `INITIAL_MODE=0`, so the switch cannot
  take it *out* of MANUAL — which also means driving RC8 to any value would command MANUAL, a
  possible recovery path worth testing. Blocks the `FS_THR_ENABLE` half of the failsafe work.

- **Two ways the input watchdog is defeated, both leaving throttle applied** —
  1. **Window blur latches held keys.** `socket.html:1514` is
     `document.addEventListener('keyup', …)`, so when focus moves to another window the `keyup`
     never arrives, `keysDown['KeyW']` stays true, and the keyboard loop keeps `throttleValue` at
     1.0. Because packets keep flowing, `app.js:266` keeps rescheduling the watchdog — it never
     fires. Sustained full throttle with no operator input and no fail-safe.
  2. **Hidden-tab timer clamp ties the watchdog.** The send loop is a 50 ms `setInterval`
     (`socket.html:1326`), which browsers clamp to ~1000 ms in a hidden tab — exactly
     `input_timeout_ms: 1000` (`picar-cfg.json:16`). Whether the vehicle stops when the operator
     switches apps is a race between two 1000 ms timers.

  Fix: stop commanding on `blur`/`pagehide`/`freeze` (see next entry), and break the tie by
  lowering `input_timeout_ms` or gating on a server-side monotonic arrival check rather than a
  bare `setTimeout` reset.

- **No client-side page-hide, blur or freeze fail-safe, and `touchcancel` deliberately keeps
  throttle** — safety invariant 6 names "page hide/blur" as a required fail-safe path. It does
  not exist. The complete listener inventory in `socket.html` contains no `blur`, `focusout`,
  `pagehide`, `beforeunload` or `freeze` handler; the only `visibilitychange` listener
  (`socket.html:1341-1343`) re-requests the wake lock. Separately `socket.html:1434-1439` catches
  `touchcancel` and **preserves** throttle by design (`'touchcancel throttle — preserved'`), so a
  notification gesture that cancels the touch leaves the stick commanding whatever it last held
  with no finger on the screen. Fix: add the missing handlers routed through the existing stop
  path, and reset throttle on `touchcancel`.

- **On any non-mavproxy rover every fail-safe path is a silent no-op** — none of
  `pwm_sysfs_servo.js`, `pwm_libgpiod_servo.js`, `pwm_pigpion_servo.js` or
  `pwm_pigpiod_servo.js` defines `neutralizeAndDisarm`, `arm` or `disarm`; each exports only
  `scale()` and `setServoPWM()`. `app.js:281-283` guards with
  `typeof pwm.neutralizeAndDisarm === 'function'` and falls back to
  `{neutralSent: false, disarmSent: false}`, so operator stop, watchdog expiry and SIGINT
  shutdown all log `### FAIL-SAFE STOP` while **leaving the PWM output latched at its last
  commanded value** — true of the `sysfs`, `libgpiod` and `pigpion` paths; `pigpiod` never applies
  a command at all (see the `NaN` defect below), so it has no output to latch, but its fail-safe is
  equally absent. `/status` reports neutral because `app.js:279-281` zeroes its own variables.
  Every drivetrain change is also refused with a misleading `flight controller link unavailable`
  (`app.js:200-201`). Fix: fail closed — a driver that cannot implement the fail-safe primitive
  must refuse to start, not degrade silently. Violates invariants 6 and 10.

- **`pwm_libgpiod_servo.js` freezes the event loop while the vehicle can move** —
  `pwm_libgpiod_servo.js:55-70` runs `execSync` twice per PWM edge from a 20 ms interval (`gpioset
  …=1` at `:59`, `…=0` at `:66` inside a nested `setTimeout`). At the configured
  `pwm_period_us: 20000` that is 50 Hz across two channels with two edges each — **~200**
  synchronous process spawns per second once motion is commanded. Safety invariant 9 forbids
  exactly this, and the fail-safe watchdog is a `setTimeout` on the same loop. Reachable because
  `install.sh` selects this driver on a board it cannot identify. Fix: drop the driver or
  reimplement it without per-edge process spawning.

- **[P0] `arm()` force-arms, disabling the flight controller's own pre-arm checks** —
  `pwm_mavproxy_servo.js:1209` sends `MAV_CMD_COMPONENT_ARM_DISARM` with
  `param1 = 1, param2 = 21196`. **This is a force-arm.** Settled 2026-08-11 against the tagged
  firmware source, after a wrong "correction" nearly retired it (see below):

  - `libraries/GCS_MAVLink/GCS.h:744-745` (Rover-4.6.3) —
    `magic_force_arm_value = 2989.0f` and `magic_force_arm_disarm_value = 21196.0f`. The NAME
    is the giveaway: 21196 is the arm-**and**-disarm force value, not a disarm-only one.
  - `libraries/GCS_MAVLink/GCS_Common.cpp:5027` — on the ARM branch,
    `do_arming_checks = !is_equal(param2, magic_force_arm_value) && !is_equal(param2,
    magic_force_arm_disarm_value)`. So **either** 2989 **or** 21196 sets it false.
  - `libraries/AP_Arming/AP_Arming.cpp:1798` —
    `if ((!do_arming_checks && mandatory_checks(true)) || (pre_arm_checks(true) &&
    arm_checks(method)))`. The forced path short-circuits: `pre_arm_checks()` and
    `arm_checks()` are **never called**. Only `mandatory_checks()` survives — battery, INS,
    GPS, compass, EKF, mode, motor, parameter and fence checks are all skipped.
  - `AP_Arming.cpp:1816` — the "Arming Checks Disabled" STATUSTEXT fires only when
    `do_arming_checks` is true, so **a forced arm warns nobody**.
  - MAVLink's own `common.xml` documents param2 `21196` as "force arming/disarming (e.g. allow
    arming to override preflight checks and disarming in flight)" — the standard force value
    for BOTH directions. 2989 is an ArduPilot-specific arm-only addition.

  The dispatch path from picar is unbroken: COMMAND_LONG →
  `convert_COMMAND_LONG_to_COMMAND_INT` (copies param2 unchanged) → the handler; 21196 is
  exactly representable in float32 so `is_equal` matches; Rover does not override the handler
  and `AP_Arming_Rover::arm` passes `do_arming_checks` straight through.

  **THE WITHDRAWAL WAS WRONG AND IS ITSELF WITHDRAWN.** An earlier revision of this entry
  claimed 21196 was disarm-only, that an arm carrying it left checks **enabled**, and that
  `CLAUDE.md` invariant 7 therefore needed correcting too. Its evidence was MAVProxy's CLI
  conventions (`mavproxy_arm.py:143` `arm force` → 2989, `:188` `disarm force` → 21196) and a
  measured `ARMING_CHECK=1`. Neither binds a forced command: MAVProxy's choices are that
  tool's own CLI, fully consistent with either value forcing an arm, and `ARMING_CHECK` is read
  only *inside* `pre_arm_checks()`/`arm_checks()` — the code a forced arm never enters. This is
  the repo's recurring failure exactly: a plausible secondary source preferred over the
  handler. **`CLAUDE.md` invariant 7 is CORRECT as written and must NOT be "corrected".**

  **Consequence, stated plainly.** Any unauthenticated socket reaching `:8443` can trigger
  `arm()`, and the packet picar emits tells the flight controller to arm with its own pre-arm
  and arm checks switched off, silently, logged as forced. There is no gate on the Pi
  (invariant 7 unimplemented) and this command disables the one on the hardware. With the FC's
  own failsafe triggers disabled and DISARM demonstrably ignored, an anonymous network peer can
  place a vehicle that has a live pack into a state where the next RC_CHANNELS_OVERRIDE drives
  it, with nothing anywhere having checked anything.

  **Fix, and note the ASYMMETRY:**
  - **ARM: send `param2 = 0`.** That yields `do_arming_checks = true` and runs the full
    `pre_arm_checks() && arm_checks()`. Do NOT substitute 2989 — it is also a force value.
  - **DISARM: KEEP `21196`.** A forced disarm is the correct fail-safe semantic — "disarm even
    in motion". On Rover-4.6.3 it makes no behavioural difference (`AP_Arming::disarm` ignores
    the flag), but on Copter a non-forced disarm can be refused in flight, and this platform's
    stated direction is a drone. Comment the asymmetry so it is not "tidied" away.
  - Then gate arming on verified parameters and surface the `COMMAND_ACK` result. `arm()`
    returns `true` unconditionally (`:1212`), so a refused arm reported success.

  **The on-target test named in an earlier revision does not work as written:** it said to make
  a pre-arm check fail, send `COMMAND_LONG 400 param1=1 param2=21196` and read the ack. rover3
  is already ARMED and refuses DISARM, so the command returns an already-armed result without
  entering the check branch. Not needed now — the source settles it — but if re-run for
  confirmation the vehicle must be disarmed first.

- **Gear change engages throttle and it cannot be turned off** — operator-reported, 2026-07-30.
  On the two rovers fitted with a high/low gearbox, selecting **high gear** engages throttle and
  it stays engaged, moving or stationary. Uncommanded, unstoppable motor output.

  *Eliminated by live test on rover3 (2026-07-30; bench servo on output 2, ch1/ch3 pinned at 1500
  while ch2 swept 2000→1500→1100→1000→1500→2000):* servo2 tracked ch2 exactly and **servo3
  (throttle) held 1500 with 0 µs spread**; `Vservo` held 6012–6017 mV. There is **no
  gear→throttle coupling in ArduPilot's mixing**, which refutes both the `FRAME_CLASS=2` (Boat)
  mixing theory and the `RCMAP_PITCH=2` conflict theory.

  *Confirmed:* `RCPassThru` (`SERVO2_FUNCTION=1`) ignores `SERVO2_MIN/MAX` — 1000 µs was commanded
  on an output whose MIN is 1100. Note `SERVOn_MIN/MAX = 1100/1900` are ArduPilot **factory
  defaults** across all 16 channels (verified on-target: 15 of 16, only `SERVO3` differs at
  1000/2000), so they are *not* evidence of a measured mechanical limit. An earlier claim that
  the narrow range was "the fingerprint of a servo hitting its stops" was withdrawn.

  *Fixed and validated on rover3 (2026-07-31, SHA `c6043d7`):* the two software defects that could
  put the gearbox into a bad state are gone. A gear change is now a gated server-side transaction
  — neutral+DISARM on the wire, a settle dwell, then actuate — and non-endpoint values are
  refused. On the wire: `SERVO_OUTPUT_RAW` servo2 moved 1000↔2000 while servo3 held 1500, and
  every RC_OVERRIDE preceding a DISARM carried neutral.

  *Still unconfirmed, which is why this stays open:* nothing explains why throttle STAYS engaged
  on the geared rovers. Remaining hypotheses need a geared rover — shifting under load jamming the
  transmission or stalling the shift servo, or an ESC fault latch. The fix removes the software
  paths that could trigger it; it does not prove they were the cause.

  **Blockers:** (1) geared-rover access — see `## In progress`. (2) It is still unknown what code
  rover1/rover2 run; get `git rev-parse HEAD` and `git status --porcelain` from both before
  designing a fix.

- **Fail-safe wire order is fixed on the server; four residuals remain** — as of `c6043d7`,
  operator stop, input timeout, process shutdown, MAVProxy reconnect and drivetrain changes all
  route through `pwm_mavproxy_servo.js:197-206` (`neutralizeAndDisarm()`), which transmits a
  neutral RC_CHANNELS_OVERRIDE packet and only then COMMAND_LONG DISARM. Verified live. Still open:
  1. **A successful `write()` is not proof of delivery.** `sendPacket` (`:175-184`) reports that
     bytes reached the socket, not that MAVProxy forwarded them or the Pixhawk acted. Real
     confirmation needs COMMAND_ACK tracking, which nothing parses.
  2. **No confirmed stop before actuating a drivetrain change.** `drivetrain_settle_ms`
     (default 1000) is a conservative dwell, not evidence the vehicle stopped. No wheel encoder
     and GPS is disabled (`AHRS_GPS_USE=0`), so zero speed cannot be verified.
  3. **`app.js` has no host test harness at all** — see the P1 entry; 8 of 23 mutations survive.
  4. `socket.html`'s stop paths emit `disarm` and rely on the server primitive. Correct today, but
     the client has no independent guarantee.

- **Private keys are committed to the repository** — `git ls-files certs/` returns `ca.crt`,
  `ca.key`, `ca.srl`, `cert.pem`, `key.pem`. Both `ca.key` and `key.pem` are real
  `-----BEGIN PRIVATE KEY-----` files. Anyone with repo read access holds the CA that every
  operator device is told to trust (`README.md` §HTTPS Certificates), plus the rover server key —
  so they can mint a trusted certificate for any host. `README.md` claimed "the repo ships no
  certificates", which was false; corrected 2026-08-03 to a warning at `README.md:233-238`.
  Fix: rotate the CA and server certs, untrack the keys, extend
  `.gitignore`, and have `install.sh` provision certs (it currently does not, so untracking them
  without that change bricks fresh installs). Purging them from history rewrites `main` — **get
  explicit authorization first.** Treat the existing key as compromised regardless.

- **`picar-cfg.local.json` can silently override any config key** — `app.js:24-32`
  `Object.assign`s the untracked overlay over the tracked config, so any key can be changed on a
  rover with no branch, diff, review or validation record. The overlay is meant to carry per-rover
  identity only. Scope correction: `mavproxy_allow_unverified_arm` and every `max_command_*` key
  named in safety invariant 8 **do not exist anywhere on `main`** — the only relevant keys today
  are `input_timeout_ms`, `drivetrain_settle_ms` and `mavproxy_rate_hz`, which are still enough to
  disable the watchdog or stall the override loop. Fix: whitelist the keys the overlay may
  override, reject the rest loudly at startup, and expose the effective values on `/status` so
  validation can assert the *effective* config rather than the file in git.

- **Validation evidence is self-reported, mutable prose** — the merge gate depends on an Embedded
  Validator pass recorded by hand in `HANDOFF.md`, in the same tree it attests to. Nothing
  mechanically ties the merged SHA to the SHA that was tested, and nothing prevents a merge without
  one. `CLAUDE.md` documents a bounded evidence-commit exemption as the interim rule. Fix: an
  attestation keyed to the deployed SHA, stored outside the tested tree, enforced as a required
  protected-branch status check. Fold reviewer attestation (`Reviewed-by:`) into the same check.

- **Fleet Manager: unauthenticated heartbeats, stored XSS, and an unbounded request body** —
  `fleet-manager/server.js:51-66` accepts `POST /api/heartbeat` with no auth and no origin check;
  the only guard is the truthiness test `if (!body.id || !body.ip)` at `:54`. `:58` stores
  `rovers[body.id] = { ...body, lastSeen }`, and `getRoverList` (`:23-33`) passes `id` and `ip`
  through verbatim and builds `controllerUrl` from `ip`. `fleet-manager/dashboard.html:139-158`
  then interpolates `${r.id}`, `${r.ip}` and `${r.controllerUrl}` into `grid.innerHTML` with **no
  escaping** — `id`/`ip` in element-text position, and `controllerUrl` in a quoted `href` whose
  value is still unescaped, so a `"` closes the attribute. So any LAN host can execute script in
  the dashboard origin, or point operators at an
  arbitrary address. Compounding: `readBody` (`:35-45`) accumulates `data += chunk` with no size
  cap (memory exhaustion), and `body.id` is an unvalidated object key. Chains into the two P0s
  above, because dashboard script can open an un-origin-checked WebSocket to any rover. Fix:
  escape every interpolation, cap the body, validate `id`, and authenticate the heartbeat.
  *(Note `feature/battery-and-radio-telemetry` adds an `esc()` helper for its own new telemetry
  strings but leaves these three sinks unescaped — merging it does not fix this.)*

- **Shelved: the control-safety layer** — the lease work lives only at
  `origin/archive/control-failsafe-2026-07-30` (`6220780`, 13 files, +1226/−110 against its merge
  base `acd3540`). Shelved on operator instruction 2026-07-30; `main` remains
  arm-from-any-socket. **Do not merge or rebase it** — tip-to-tip it is +1258/−3379 against `main`,
  because it predates `CLAUDE.md`, the `.claude/` tree, both of `main`'s test files, the
  video-latency work and the discovery backoff. Cherry-pick only. Two sequencing traps:
  - The **autopilot-heartbeat filter must not land without the v2 parser**. On `main`'s v1-only
    parser the only *legitimate* frame satisfying the first-heartbeat branch
    (`pwm_mavproxy_servo.js:462-471`) is MAVProxy's own v1 GCS heartbeat — the CRC-less parser can
    also synthesise a bogus msgid-0 from any `0xFE`-aligned bytes, which is its own defect below.
    Filtering the GCS heartbeat out while the Pixhawk's v2 frames are still
    discarded at `:446` means `pixhawkHeartbeatSeen` never becomes true and **the param overlay
    stops being pushed entirely**. They are one atomic change.
  - `control-safety.js` gates arming on `this.pwm.getSafetyStatus()` behind a
    `typeof === 'function'` guard, and `main`'s driver has no such method. Dropped onto `main`
    as-is, the `readyToArm === false` check is skipped and **invariant 7 is silently not
    enforced while appearing implemented**. The safety-status accessors are a prerequisite, not
    an extra.

  Also note the branch's own fail-safes do not put neutral on the wire before DISARM, which
  `main` now does correctly — `main`'s `neutralizeAndDisarm()`, discrete-channel validation and
  `setDrivetrain` transaction are all strictly better than the branch's equivalents.

  **Defects to fix inside the archive before any of it is cherry-picked.** These were previously
  filed as if they were `main` defects, which they are not — but they are real *on the branch*, and
  deleting them outright would lose the warning:
  1. **A ~500 ms window where the lease believes it is armed but motion is silently dropped.**
     Archive `pwm_mavproxy_servo.js:83` sets `armDelayMs` (default 500) and `:602-607` only sets
     `controlEnabled = true` after that delay, while archive `control-safety.js:160` marks
     `flightControllerArmed = true` immediately. In between, `setServoPWM` returns `false` for
     non-neutral motion and nothing checks the return value. Fails safe, but invisibly. Model the
     arming state explicitly and report it to the client.
  2. **Command rejections are discarded.** Archive `control-safety.js` returns structured errors
     from `handleCommand()`, and archive `app.js:136-138` throws the result away. A client whose
     commands are being rejected as replayed, stale or out-of-order sees a working UI and a dead
     rover. Acknowledge or emit the rejection. *(This is a different defect from the `failSafeStop`
     notification gap on `main`, filed separately under P1.)*

- **Light module cannot be switched as wired — needs a switching component** — the
  fitted module is a **Traxxas 8028**, a regulated 3 V LED supply with **no control
  input**, connected power-only to the Pixhawk servo rail. Nothing is attached to
  output 6, so the software control (`feature/light-control`, verified driving
  `SERVO_OUTPUT_RAW` servo6 between 1000 and 2000 µs) has nothing listening to it.
  Switching it requires switching its POWER: either an RC PWM switch module reading
  MAIN 6 (no software change needed) or a relay/MOSFET on a GPIO pin driven by
  `MAV_CMD_DO_SET_RELAY` (`SERVO6_FUNCTION = -1`, which changes the control
  mechanism). Do **not** wire the module's power lead to a servo signal pin. Also
  unquantified: the 8028's input current draw against a servo rail that also feeds
  the steering servo.

### P1 — correctness and robustness

- **[P1] Per-branch remediation from the 2026-08-11 Codex sweep** — grouped by branch so each can
  be worked independently. Full verbatim reviews were not committed; re-run the stage per branch
  to regenerate them.

  **`fix/systemd-restart-limits` — NO-SHIP, and the operator chose to RE-SCOPE it** to infinite
  retry with capped backoff rather than patch it:
  1. `RestartSec=2` **aliases picar's own reconnect delay** — `pwm_mavproxy_servo.js:449` is
     `setTimeout(() => this._connect(), 2000)`. If picar reaches port 5760 before MAVProxy binds
     it, `ECONNREFUSED` pushes the next attempt to t≈4 s, so the held-throttle window grows from
     ~1.8 s to ~3.8 s. Pick a value that does not alias 2000 ms.
  2. Drop the **finite** start-limit. Once hit, systemd never retries, MAVProxy stays down, and
     picar cannot tell that from a working link — the recorded wedge proves the operator sees
     nothing. Infinite retry with capped backoff plus an operator-visible alert is the safer
     trade on this platform.
  3. Three mutations survive: `RestartSec=20`, `StartLimitIntervalSec=1`, `StartLimitBurst=8`.
     The tests assert only a lower bound; add an upper bound and encode the relationship between
     the rate-limit interval and the restart spacing.
  4. `test/on-target/service-boot.sh` prints PASSED in the exact wedge state it claims to detect
     — it checks systemd state, restart count, device existence and file drift, never tlog growth
     or inbound heartbeat freshness. It also tolerates missing journal evidence silently, and
     "first 12 journal lines" is really the first 12 of the last 200.
  5. It has **no consumer**: `npm run test:on-target` is only `node test/on-target/control-e2e.js`.
  6. The commit body's boot claim is a hypothesis — no captured `Result=start-limit-hit` and no
     measured USB enumeration time exist.

  **`feature/fc-failsafe-params` — NO-SHIP; the operator chose to SPLIT it.** Land the ACK decode
  after fixing it; send the FS_* half back (see the two P0 entries above).
  1. **ACK attribution (HIGH).** The handler reads only the 3-byte base payload, ignoring v2
     `target_system`/`target_component` at offsets 8/9. MAVProxy (sysid 255, comp 230) also
     issues commands, and the 2026-08-11 capture holds **712 cmd-410 ACKs against 1 cmd-400 ACK**
     — so MAVProxy's repeating `GET_HOME_POSITION` failure arrives last and **overwrites picar's
     DISARM result**. `/status` would attribute MAVProxy's refusal to picar, corrupting the exact
     diagnosis this decode exists to enable. Needs pending-command correlation, not source IDs:
     a v1 down-conversion drops the target fields entirely.
  2. `lastCommandAck` is erased on socket close — the close handler replaces the whole telemetry
     object — so a DISARM refusal followed by a MAVProxy restart 1 s later leaves it `null`,
     destroying the evidence the field exists to retain.
  3. All six new ACK tests build **v1** frames. Mutating `parseIncoming` to discard msgId 77 when
     `isV2` leaves them green.
  4. The commit body reverses the mode flags: `MAV_MODE_FLAG_CUSTOM_MODE_ENABLED` is 1 and
     `MAV_MODE_FLAG_SAFETY_ARMED` is 128. `base_mode=1` is structurally right, for the opposite
     reason to the one stated.
  5. `CRC_EXTRA[77] = 143` is **correct**, and short payloads are zero-extended so the parser
     cannot throw from the socket callback. Both were independently confirmed — keep them.

  **`fix/verify-gps-disable-params` — 2 HIGH.**
  1. Nothing exercises the `PARAM_VALUE` consumer for the two new names, so making the consumer
     ignore `GPS1_TYPE` survives. Add a round-trip test through the real parser.
  2. The new test asserts `DEFAULT_PARAM_OVERLAY`, not the effective overlay — largely closed by
     `fix/overlay-merges-not-replaces`; rebase onto it and re-check.
  3. `GPS1_TYPE` is documented `@RebootRequired`, so immediate read-back confirms the STORED and
     not the ACTIVE value. Same trap as the settled `FRAME_CLASS` dispute, opposite answer.
  4. The comment's claim that "ArduPilot renamed GPS_TYPE to GPS1_TYPE in 4.5" is wrong: 4.5.7
     still documents `GPS_TYPE`, 4.6.3 documents `GPS1_TYPE`. The name used is right for this
     fleet; the stated history is not.

  **`fix/align-steering-rc-range` — 2 HIGH.**
  1. Same effective-vs-tracked-config defect as above; rebase onto the overlay fix.
  2. Deleting `EXPECTED_CRITICAL_PARAMS.RC1_MAX` survives — closed by the overlay⊆expected test
     on `fix/verify-gps-disable-params`, so merge that first.
  3. `RC1_TRIM` and `RC1_DZ` stay unowned, so steering centring is still not reproducible: a
     board with `RC1_TRIM=1550` reads back 1000/2000 green while treating neutral as left lock.
  4. The comment's RC2 rationale is **false** — `RCPassThru` ignores `SERVO2_MIN/MAX`, which this
     repo measured, so 1000 µs is not clamped to 1100. It also intersects the gear/throttle P0 and
     cannot be validated on gearless rover3. Remove the claim.
  5. The "outer ~12.5%" arithmetic is wrong: 100 µs at each end of a 1000 µs span is **10%** of
     travel per end (12.5% would be 100/800).
  6. "SERVO1_MIN/MAX are the mechanical limit of the steering linkage" is unsupported — they are
     ArduPilot factory defaults. The direction of the change is nevertheless sound and was
     confirmed against ArduPilot's RC and SRV channel source: it lowers intermediate gain and
     removes the endpoint plateau **without reaching new servo positions**. Keep the change, fix
     the claim.

  **`chore/remove-px4-param-dump` — 0 HIGH, safe to land after cosmetics.** Independently
  confirmed: every changed JavaScript byte is inside `//` comments, no runtime path is affected,
  the ignore patterns match, and **no open-task evidence is lost** (the deleted tracked tlog is a
  2026-05-05 PX4 session; all DISARM/wedge evidence cites `/tmp` or `/var/log`). Remaining: point
  the replacement comment at the measured 2026-08-11 baseline in `HANDOFF.md`; the commit body
  overclaims "enforced by the tool" (`git add -f` still works) and a bloat benefit it does not
  deliver (history is unchanged); and `HIGHRES_IMU`/`ALTITUDE` are MAVLink common messages, not
  PX4-only — the PX4 identification rests on `MAV_TYPE=2` and the parameter namespace, which does
  hold.

- **[P1] Open findings on this session's own three branches** — none is cleared.

  **`chore/validator-battery-premise` (`34de5a4`) — NO-SHIP, 5 HIGH.**
  1. It fixed the rule and left the consumer — now addressed by `fix/motion-gate-fails-closed`.
  2. `.claude/skills/embedded-validator/SKILL.md` still requires "Arm, move the controls" for the
     WebUI check while the same file now says routine validation commands no motion. That
     contradiction is unresolved and needs deciding, not rewording.
  3. "Neutral-before-disarm still stops motion" **overreaches** — the wedge proves a successful
     local write can be swallowed before reaching the FC. Qualify it.
  4. `HANDOFF.md`'s `## Environment` on `main` still says the flight battery "is not connected"
     (fixed only on the unmerged audit branch), and `CLAUDE.md:346` still says wire verification
     happens "with no motor power". The premise is not fully closed.
  5. A neutral `SERVO_OUTPUT_RAW` sample cannot prove channel mapping — equal neutral values are
     observationally identical, so a swapped steering/throttle mapping passes.
  6. The added field-offset warning is right only for `servo1_raw`–`servo8_raw`. In v2, `port` is
     byte 20 and `servo9_raw`–`servo16_raw` are extensions AFTER it, so `port` is not the last
     byte and `4+(N-1)*2` misdecodes output 9.
  7. `test/telemetry-footer.test.js` blind spots: the harness omits `set -u` (and
     `telemetry.sh:27` **is** `set -uo pipefail`, contrary to the commit body), so reverting a
     `${bv:-}` guard passes while the real script aborts; it pins `FAILED=0` and excludes
     `exit $FAILED`, so prefixing `FAILED=0;` clears a real failure with all five tests green;
     the `jget` stub ignores its path argument, so pointing the current lookup at
     `remainingPct` survives; and a `printf` placed BEFORE the extraction marker is invisible, so
     "no reachable branch can print the premise" is false.

  **`fix/overlay-merges-not-replaces` (`ac80d59`) — NO-SHIP on the second round.**
  1. A **targeted** consumer mutation still survives: `if (name === 'SERVO3_FUNCTION') return;`
     inside the overlay application loop, or corrupting only its transmitted value. The
     transmission test uses a 2-key fixture and checks names, not values. Assert the full built-in
     set and decode the values.
  2. `overlayChainMs()` takes numeric counts and is passed an **object**, which coerces to 0 and
     yields an accidental 500 ms delay; the `finally` calls a nonexistent `d.stopTimers()` instead
     of `clearOverlayTimers()`; and an assertion throw inside the `setTimeout` never rejects the
     promise. So a mutation can **HANG rather than fail** — the trap `CLAUDE.md` names, in a test
     written to avoid it. Fix before trusting any count from this file.
  3. The safety comment says the old behaviour dropped "both FS_* entries" and read-back reported
     "12 of 13 missing". Neither is true at this SHA: no `FS_*` entry is in the 13 defaults (they
     live on the unmerged branch), only 11 are verified, and with `FRAME_CLASS` retained the most
     read-back can report is 10. Correct the comment.
  4. "A real per-rover difference is a reviewed change to a tracked profile" describes a mechanism
     that **does not exist** — `app.js` erases tracked/local provenance and there is one global
     `DEFAULT_PARAM_OVERLAY`. Either build provenance-aware profiles or fail startup on an
     incompatible overlay; do not resolve it by allowlisting critical names.
  5. The numeric-string test cannot test its named rule: with an empty allowlist the refusal
     happens for the allowlist reason, so accepting numeric strings still passes.

  **`fix/motion-gate-fails-closed` (`b4a485c`) — NEEDS-CORRECTION, 2 HIGH.** The gate itself is
  sound on every settled path, but the fix reproduces the untouched-consumer shape it was written
  to close:
  1. **The caller discards the decision (HIGH).** `:158` is `await assertSafeToCommand(...)` with
     the returned boolean thrown away, and every host test injects a NON-FATAL `exit`, so the
     production fatal path is never exercised. Mutate the default to
     `exit = deps.exit || ((c) => { process.exitCode = c; })` — a plausible refactor — and all six
     tests pass while an unflagged run sends ARM, steering and drivetrain commands and then exits
     zero. Deleting `:158` outright also survives every host test. Fix: branch on the result at
     the call site, or make the refusal seam **throw** so denial cannot continue.
  2. **Nothing proves direct execution still runs (HIGH).** The import test only checks the
     negative. Mutate `if (require.main === module)` to `if (false)` and all six tests pass while
     `npm run test:on-target` becomes a silent, successful no-op — validation that runs nothing
     and reports success, the defect `3e9103e` already fixed once. Needs a child-process test of
     the positive path.
  3. The `/status` request is unbounded (`:117`): a response that never ends leaves the guard
     hanging, and a hang is not a fail-closed result — even `--allow-motion` cannot proceed. Add a
     timeout and record the reading as unavailable.
  4. `exit 3` makes "SKIPPED BY DESIGN" an npm failure, and the only packaged on-target E2E
     command now performs no useful checks by default. The likely workaround is someone adding
     `--allow-motion` to `package.json`, normalising motion during routine validation. Split a
     read-only default target, or move the gate immediately before the motion section and report
     the safe checks as run.
  5. The harness ignores method and path, so mutating `'/status'` to `'/manifest.json'` survives;
     production also ignores HTTP status, so a 503 carrying stale JSON reads as a current battery
     record. Assert `GET`, `/status`, and 200.
  6. Deleting `&& b.voltageV < 30` survives, so a mis-scaled 40 V reading reads as plausible; and
     `"voltageV":"7.905"` as a string is accepted through coercion. Use finite numeric checks and
     assert both bounds plus current/percentage/source.
  7. The commit body's "`the original voltage-decides logic restored -> 5 failures`" has **no
     auditable derivation** — the mutant patch was an approximation that hard-coded the reading
     rather than a faithful restoration, which yields four. Record the exact patch or restate the
     count.

- **[P1] No `SIGTERM` handler — the safety of `systemctl restart` rests on one unit-file line** —
  `app.js:400-406` handles only `SIGINT`, and `crash-failsafe.js` only `uncaughtException` /
  `unhandledRejection`. Node's default disposition for `SIGTERM` is immediate termination with no
  handler run, so `kill`, `pkill -f app.js`, a deploy script's `killall node`, or any rover whose
  installed unit predates `KillSignal=SIGINT` (`systemd/picar.service:18`) kills picar with the
  last throttle still in the channel buffer, no neutral packet and no DISARM. Invariant 6 names
  "process shutdown" as a path that must put neutral on the wire first. Handle `SIGTERM`
  identically to `SIGINT` rather than relying on a non-obvious unit-file line.

- **[P1] The input watchdog is one module-scope timer shared by every socket** — `app.js:143`
  declares `let lastAction = null;` at module scope, and every socket's `fromclient` handler
  (`:340-376`, watchdog rearm at `:369-375`) closes over it. With two clients connected — which
  needs no attacker, a stale second tab suffices, since the control plane is unauthenticated —
  client B's traffic keeps calling `clearTimeout(lastAction)` and the watchdog protecting client
  A's dead link never fires. The "no input" condition is evaluated across the union of all
  sockets rather than per session. Violates invariants 2 and 5.

  **"Make it per-socket" is NOT a valid fix on its own, and an earlier revision of this entry
  recommended it.** There is no single owner yet (invariant 2 is unimplemented), and every
  accepted command writes the same module-scope motion state — so there is no per-socket thing
  to protect. Per-socket timers would actively make it worse: socket A sends one command and
  goes quiet, B keeps driving legitimately, A's timer expires and neutralises/disarms **B's**
  live stream, then B's next packet re-applies motion. That is stop/command oscillation on a
  vehicle whose FC refuses DISARM. **This is blocked on the single-owner lease**; until that
  exists the honest interim is a monotonic per-session arrival check that cannot cancel another
  session's watchdog.

- **[P1] `test/on-target/control-e2e.js` cannot fail on the checks that matter** —
  `:125` defines `const ok = (m) => log("  PASS " + m);` — an unconditional print that never
  touches `failed`. The input-watchdog block (`:219-226`) sends one `fromclient`, sleeps 3 s,
  drains the poll and prints PASS; the disarm step (`:212-216`) and the disconnect step verify
  nothing. **Delete `app.js:369-375` — the whole watchdog — and this script still prints
  `E2E PASSED`.** The assertion is nearly free: `failSafeStop` resets `old_throttle`/`old_steering`
  (`app.js:381-384`) and `/status` serves them.

  **But assert STEERING, not throttle.** An earlier revision of this entry said a `GET /status`
  proving `throttle === 0` would catch it. It would not: the script sends
  `{throttle: 0, steering: 0.25}` at `:222`, so throttle is **already** 0 before the watchdog
  ever fires and the assertion holds whether or not the watchdog exists. It is the same
  can't-fail defect one level up — a proposed fix for an unfalsifiable check that was itself
  unfalsifiable. Assert that **steering returns to 0** after the silence; that value is
  non-zero when the timer starts and only `failSafeStop` resets it.

  This is the "test unable to fail" pattern `CLAUDE.md` documents, in the on-target suite rather
  than the host suite. Note the script now refuses to run at all without `--allow-motion`
  (`fix/motion-gate-fails-closed`), so this check is unreachable on a routine run either way —
  fixing the assertion and giving the read-only checks a path that runs are one job.

- **[P1] The autopilot's armed bit is decoded and then discarded** — `pwm_mavproxy_servo.js:1109`
  sets `this.telemetry.heartbeat = { at, armed: (payload[6] & 0x80) !== 0 }`, and no production
  code reads `armed` — the only consumer is `test/telemetry.test.js`. So `/status`, the UI and the
  fleet dashboard cannot show that the vehicle is still armed after a fail-safe, and `disarm()`
  has no confirmation and no retry: it writes one packet and declares victory. The platform's
  worst known defect (a refused disarm) has its evidence sitting decoded and unused. Compare
  intent against `telemetry.heartbeat.armed`, re-send on disagreement, and expose it.

- **[P1] picar's RC output range is wider than the flight controller's input range on five of six
  channels** — measured on rover3 2026-08-11: `RC3_MIN/MAX` are 1000/2000 and match picar's global
  `pwm_min_us`/`pwm_max_us`, but `RC1`, `RC2`, `RC4`, `RC5` and `RC6` are all **1100/1900**.
  `scale()` uses one global pair for every channel, so steering commands spanning 1000–2000 land in
  a channel ArduPilot normalises over 1100–1900: full lock is reached at 1100/1900 and the outer
  ~12.5% of stick travel at each end does nothing. Nothing detected this — no read-back complained
  and no test failed, because the overlay owned `RC3_DZ`/`RC3_TRIM` but not the endpoints. The
  discrete channels (shift, both diff locks, light) clamp harmlessly. Addressed on unmerged
  `fix/align-steering-rc-range` (`add9294`); needs a WebUI drive to confirm the mapping is better
  rather than merely different.

- **[P1] MAVProxy's tlogs are 450 MB in tmpfs and it is logging "Out of space for logging"** —
  measured on rover3 2026-08-11: `/tmp/mav.tlog` 272 MB plus `/tmp/mav.tlog.raw` 178 MB, growing
  ~3–4 KB/s, against a 3.9 GB `/tmp` at 11% used. So the message is **not** the tmpfs, which means
  it is most likely the autopilot's own log volume relayed as STATUSTEXT — i.e. the FC is not
  writing its dataflash logs. That matters directly: those logs are what would explain a refused
  DISARM, and `LOG_DISARMED=0` was also measured. Run it down; the existing tmpfs-growth entry
  under P1 covers the disk half but not this.

- **[P1] TASKS.md's own line citations have drifted file-wide** — the preamble pins every citation
  to `main` @ `4580209` (2026-08-03), but `main` has taken seven merges since. Spot-checked and
  wrong today: the `arm` handler is `app.js:204` (cited as 133-144), `fromclient` is `:358-394`
  (cited 236-272), `failSafeStop` is `:399-409` (cited 277-287), `io.emit('controlStopped')` is
  `:304` (cited 215), the config overlay merge is `:26` (cited 24-32), `keyup` is
  `socket.html:1930` (cited 1514), the send loop is `socket.html:1577` (cited 1326),
  `visibilitychange` is `:1592` (cited 1341-1343), `touchcancel` is `:1772-1781` (cited 1434-1439),
  and `arm()` is `pwm_mavproxy_servo.js:1195-1212` (cited 555). The preamble's own rule — "cite a
  line you have actually opened" — is being violated by the file that states it, which is exactly
  how the ~20 wrong citations it was written to fix got established. Re-verify and re-pin, and
  prefer symbol names over line numbers where a name exists.

- **`app.js` has no test file at all, and five safety mutants survive because of it** — measured
  2026-08-03. `grep` over `test/` finds no coverage of `io.on`, `socket.on`, `setDrivetrain` or
  `failSafeStop`, so every Socket.IO handler is unverified. Each of these can be applied to `main`
  with the suite still fully green:
  1. Delete the input watchdog **entirely** (`app.js:265-271`) — invariant 5. The single most
     safety-critical timer in the repo.
  2. Degrade `failSafeStop` (`app.js:277-287`) back to `setServoPWM`-then-`disarm`, which puts
     DISARM on the wire before neutral — invariant 6, the exact defect `c6043d7` was written to
     fix. The driver primitive is pinned by a test; the `app.js` call site is not.
  3. Remove the `drivetrainBusy` interlock from the `arm` handler (`app.js:137-141`).
  4. `setDrivetrain` skips the fail-safe result check (`app.js:197`), actuating a gear against a
     vehicle whose disarm was never confirmed.
  5. Drop throttle validation and clamping in `fromclient` (`app.js:238`).

  Fix: a `test/app-safety.test.js` driving the real handlers. `app.js` currently binds both HTTPS
  ports and connects to MAVProxy at require time, so it is not loadable under test — this needs the
  handler wiring extracted into an exported factory with injected dependencies. Note the suite must
  keep working under `npm ci --omit=dev` on the rover, so **no new test dependency** (no
  `socket.io-client`); use Node built-ins and a fake socket.

  *(The three driver-side survivors from the same pass — both `Number.isFinite` guards and
  `neutralizeAndDisarm()` in `_connect()` — were closed by `test/driver-safety-gaps`, along with
  four vacuous assertions and the whole `close`/reconnect lifecycle. See `HANDOFF.md`.)*

- **A corrupt PWM range releases the override on both motion channels and makes the fail-safe
  unable to centre them** — found 2026-08-03 while writing the config test in
  `test/driver-safety-gaps.test.js`.
  `pwm_mavproxy_servo.js:66-68` computes `this.neutral = Math.round((this.min_us + this.max_us) / 2)`.
  A `pwm_min_us`/`pwm_max_us` that is truthy but non-numeric (`'x'`, `{}`) survives the
  `config.pwm_max_us || 2000` idiom, so `this.neutral` becomes `NaN`. The channel initialisers at
  `:92-96` that fall back to `this.neutral` then store `NaN`, which a `Uint16Array` coerces to
  **0**, and `buildRCOverride:346` maps 0 to the **65535 "ignore this channel" sentinel**.

  Measured, not assumed — the effect is channel-specific, because only some initialisers use
  `this.neutral`:
  - `pwm_max_us: 'x'` → buffer `[0,0,0,0,1000,0,0,0]`, wire
    `[65535,65535,65535,65535,1000,65535,65535,65535]`
  - `pwm_min_us: 'x'` → buffer `[0,2000,0,2000,0,0,0,0]`, wire
    `[65535,2000,65535,2000,65535,65535,65535,65535]`

  Either way **steering (ch1) and throttle (ch3) both go to 65535**, and
  `channelNeutralUs` becomes `{steering: 0, throttle: 0}` — so
  `neutralizeAndDisarm()` transmits 65535 on exactly the two channels it exists to centre. **The
  fail-safe releases the motion overrides instead of neutralising them** (invariant 6).
  `setServoPWM` correctly refuses every command in this state, so the vehicle is simultaneously
  uncontrollable and un-neutralisable.

  Reachable with no review via `picar-cfg.local.json` — a concrete mechanism for the
  config-overlay P0 above. Two scope limits, both verified: `NaN` is harmless (falsy, so the `||`
  default rescues it), and `Infinity` is **not reachable from a JSON config** at all, so the
  practical vector is a truthy non-numeric value. Fix: validate the range at construction and
  refuse to start on a non-finite one.

- **No CI runs the test suite** — `.github/workflows/claude.yml` and
  `.github/workflows/claude-code-review.yml` only invoke Claude review; neither runs `npm test`.
  Combined with the last five merges being local merge commits rather than PRs, the suite has
  never run automatically and the review workflow has never fired on a merge. This is the concrete
  blocker under "nothing mechanically enforces the review gate". Fix: a CI job running
  `npm test` on push and PR, as the first required status check.

- **[P1] `test/on-target/` is only two scripts deep** — the validation bar requires a committed,
  repeatable on-target suite. `video-drop.sh` (frame shedding) and `telemetry.sh` (services,
  journal, `/status` shape, param read-back, MAVLink liveness, telemetry freshness) exist now.
  Still missing: RC_CHANNELS_OVERRIDE streaming neutral, each fail-safe path tripped
  end-to-end, and HTTP reachability of `socket.html` / `socket.io` / WHEP. Until those land the
  Embedded Validator's checklist is still not satisfiable purely from committed scripts.
  Author via the Optimizer, not the validator.

- **[P1] `npm run test:on-target` runs ONE script, and that script cannot fail on what matters** —
  measured 2026-08-11. On `main` the script is literally
  `"test:on-target": "node test/on-target/control-e2e.js"`, so `telemetry.sh`, `video-drop.sh` and
  `service-boot.sh` are never invoked by it. A `run-all.sh` that runs everything exists **only on
  the parked `fix/webrtc-require-udp` branch** (`3e9103e`, `2039f18`, `8137403` — which fixed a
  runner that reported PASSED while running nothing, and one that treated a safety refusal as a
  failure). So an Embedded Validator quoting "on-target suite passed" on `main` is quoting one
  script, whose `ok()` helper is an unconditional print (see the can't-fail entry above).
  Combined effect: **the committed on-target suite is close to vacuous on `main`.** Re-land
  `run-all.sh` separately from the video work it is stranded behind, and treat any historical
  "26/26 on-target checks" claim as describing a branch, not `main`.

- **[P1] `CLAUDE.md` carries one claim this repo has since disproved — and one it does NOT** —
  the file is the directive, so a stale claim in it propagates further than one in a dated entry.
  Equally, "correcting" a claim that was right is worse than leaving it alone.
  1. **Invariant 7's force-arm claim is CORRECT. Do not touch it.** An earlier revision of this
     entry listed it as needing withdrawal, on the strength of MAVProxy's CLI conventions. The
     Rover-4.6.3 source says otherwise: `GCS_Common.cpp:5027` disables arming checks for
     **either** 2989 or 21196, and `AP_Arming.cpp:1798` skips `pre_arm_checks()` and
     `arm_checks()` entirely on that path. So `arm()`'s `21196` *does* tell ArduPilot to skip its
     own pre-arm checks, exactly as invariant 7 says. See the force-arm P0 above for the full
     citation chain. **This item exists to stop the next reader "fixing" a correct directive.**
  2. `CLAUDE.md:346` says MAVLink wire verification "proves commands reach the FC and it reacts,
     with no motor power". A pack is installed; that clause is the same premise the Validation
     section of the same file reversed on 2026-08-05. **This one is real** and is fixed on
     `chore/validator-battery-premise`.

- **`install.sh` is destructive on re-run and blocks clean validation** —
  1. `install.sh:244` rewrites the **tracked** `picar-cfg.json` in place from the prompt answers,
     so any rover that has run the installer has a permanently dirty tree. This defeats
     `CLAUDE.md`'s requirement to validate the exact deployed SHA, and it is the root cause of
     "it is unknown what code the geared rovers actually run".
  2. `install.sh:382` uses `systemctl enable --now`, which does **not** restart an
     already-running unit — so re-running the installer after a `git pull` does not deploy the new
     code, while printing success.
  3. `install.sh:88` calls `prompt_yes_no` 38 lines before it is defined, so run-user creation is
     dead code that dies with `command not found`.
  4. `uninstall.sh` never removes the polkit rule installed at `install.sh:331`.

- **Critical-param verification never retries** — `pwm_mavproxy_servo.js:405-409` fires exactly one
  `PARAM_REQUEST_READ` per critical param on a one-shot `setTimeout` chain. A single dropped
  `PARAM_VALUE` over the serial link means that param is never confirmed. Consequence correction:
  on `main` this only loses a log line — `verifiedCriticalParams`, `isSafetyReady()`,
  `getSafetyStatus()` and `missingParams` do not exist here, and nothing gates on verification. It
  becomes a real availability defect the moment arming is gated on it. Fix: bounded retry with
  backoff, and surface the retry state.

- **`armTimeout` survives disconnect** — narrowed 2026-08-11 after checking the code rather than
  the entry. This used to say the overlay's `PARAM_SET` and read-back timers also survived, and
  that is no longer true: the `close` handler calls `clearOverlayTimers()`
  (`pwm_mavproxy_servo.js:733`, `for (const t of this.overlayTimers) clearTimeout(t)`) and clears
  `overlayReassertTimer`, so reconnect churn does **not** stack overlay passes. `armTimeout` is
  the one handle still not cleared there — it is cleared only at `:1205` and `:1252`. Fix: clear
  it on close with the rest.

- **Command rejections and fail-safe stops are never reported to the client** —
  `app.js:277-287` (`failSafeStop`) logs and returns a result but emits nothing, so
  `socket.html:1530`'s `controlStopped` handler never runs for a watchdog expiry or an operator
  stop; only `setDrivetrain` broadcasts it (`app.js:215`). A client whose commands stopped reaching
  the vehicle keeps showing an armed UI. Fix: emit `controlStopped` from `failSafeStop`.

- **Keyboard control is live inside modals and form controls** — `socket.html:1487-1512` gates only
  `KeyG` behind `isUiCapturingKeys()`. `W/A/S/D`, the arrow keys and Space fall through to
  `keysDown` and drive the vehicle, so adjusting the video FPS slider with the arrow keys steers at
  full lock while armed. Fix: apply the same guard to every control key.

- **No MAVLink framing tests for the TRANSMIT builders** — narrowed 2026-08-11.
  `test/mavlink-vectors.test.js` now exists and is substantial (19 tests: reference frames split
  at arbitrary chunk boundaries, back-to-back streams, leading garbage, a bogus magic claiming a
  huge payload, unknown msgids, v2 incompatibility flags, foreign sysId/compId rejection, a
  CRC-valid but short v1 payload). **All 19 exercise `parseIncoming` — the RECEIVE path only.**
  Not one covers `buildRCOverride`, `buildCommandLong`, `buildParamSet`,
  `buildParamRequestRead` or `buildHeartbeat`, so the outbound wire order and every transmit
  `CRC_EXTRA` are still unvalidated against known-good vectors. That is the half that matters
  most for the control path: a wrong `CRC_EXTRA` on `RC_CHANNELS_OVERRIDE` means the autopilot
  silently discards every command. Original entry follows.

  Nothing validates the hand-rolled CRC and wire order in
  `pwm_mavproxy_servo.js` (`buildRCOverride`, `buildCommandLong`, `buildParamSet`,
  `buildParamRequestRead`, `buildHeartbeat`, `parseIncoming`) against known-good vectors. The
  framing and every `CRC_EXTRA` were hand-verified correct on 2026-08-03 for messages
  0/20/22/23/70/76 — capture that in byte-exact vector tests before a firmware change breaks it
  silently.

- **Re-review three changes under Codex** — all were cleared by the `opus-fallback` reviewer,
  which is the same model family as the author and therefore a weaker check:
  `chore/adversarial-review-fallback` (the fallback rule itself), `perf/bound-video-latency`
  (merged at `4580209`; its drop path *is* hardware-validated), and
  `feature/battery-and-radio-telemetry` (unmerged).

  **`feature/battery-and-radio-telemetry` is gated, not merely owed a review.** Its own commit
  body (`6675341`, "SAFETY-INVARIANT ASSESSMENT") states that its overlay writes
  `RC_OVERRIDE_TIME=0.2` — the flight controller's own override-expiry — and concludes: *"That is
  fail-safe timing on the wire, so this DOES touch invariant 6 … a same-model-family fallback
  review does not clear it: this must not merge until Codex reviews it."* Per `CLAUDE.md` the
  `opus-fallback` reviewer cannot clear an invariant-touching change, so **that branch must not
  merge until a Codex pass exists**, regardless of its recorded validation. The other two do not
  touch the invariants and were cleared legitimately. Codex credits confirmed restored 2026-08-03.

- **Nothing mechanically enforces the review gate** — the `Reviewed-by:` trailer makes the claim
  durable and auditable, but nothing *verifies* it: a merge with no trailer, or a false one, is not
  blocked. Same shape and same fix as the validation-attestation gap above.

- **Three GPIO drivers are broken or dead beyond the fail-safe gap** —
  `pwm_pigpiod_servo.js:44` writes `this.outputs[Number(id)]` where `id` is the string
  `'THROTTLE'`/`'STEERING'` from `Object.entries(this.pins)`, so `Number(id)` is `NaN` and both
  iterations overwrite the same `NaN` key. `channelMap` (`:23-26`) then maps `throttle`→`0`, so
  `setServoPWM` looks up `outputs[0]`, finds nothing, logs `Invalid servo name or GPIO not
  initialized` and returns `undefined` — for **every** command. Construction succeeds and logs
  `Configured GPIO12 for servo THROTTLE`, so startup looks healthy. `pwm_sysfs_servo.js` ignores
  the configured PWM channel numbers: they are read into `this.pins` at `:20` but the directory
  index comes from the *keys*, via `for (const id in this.pins)` at `:30` and
  `this.channelMap[name]` at `:49`, so it always writes `pwm0`/`pwm1`; it also rewrites `period`
  on every command at `:54`. All four GPIO drivers return `undefined` from `setServoPWM`, violating
  invariant 10. Fix: delete the dead ones and make the survivor honest, or gate them behind the
  fail-closed check above.

### P2 — performance

- **picar burns 3.5% of a core while completely idle** — measured on rover3 with no client, no
  viewer, and discovery backed off to its 5-minute ceiling. The Fleet Manager sweep accounted for
  half the original 6.9% and is fixed; the remaining 3.5% is unexplained. Likely candidates:
  `parseIncoming` doing a `Buffer.concat` per socket data event (`pwm_mavproxy_servo.js:444`) while
  MAVProxy streams ~6 message types at 4 Hz, and per-tick `Buffer.alloc` in `buildRCOverride`
  (`:334`). Profile before adding anything else to this process.

- **`NalParser.push` still does a `Buffer.concat` per chunk** — `streams/h264.js:29`. The *scan*
  was made incremental and is verified linear by a committed test, but the per-chunk concat remains,
  so framing is still superlinear in access-unit size: measured 0.27 ms at 64 kB, 1.62 ms at
  256 kB, 25.8 ms at 1 MB with 1 kB chunks. Fix: a chunk list or ring buffer.

- **The h264 drop thresholds are not a real latency bound** — `streams/h264.js:136-140` gates on
  `ws.bufferedAmount`, which counts only userspace queueing, so a multi-megabyte kernel socket
  buffer sits underneath invisibly (~2.7 MB accepted before the threshold tripped; stalling a
  client for 12 s at default thresholds produced **no drops at all** on a local link). Latency is
  bounded rather than unbounded — the mechanism works when it engages — but not by the configured
  amount. Fix: a small `writableHighWaterMark`/`SO_SNDBUF` on the accepted socket, or gate on an
  enqueue timestamp rather than a byte count.

- **The mjpeg drop path is still unvalidated on target** — host tests cover the logic, including
  split-at-every-boundary, but the path has never run on hardware. (The **h264** drop path *was*
  verified on rover3 on 2026-07-31: `dropped 149` / `dropped 150 stale frame(s)` logged while the
  client received 29 frames, all 29 keyframes.) Also still open: the default `webrtc` path has no
  picar-side latency control at all — there is no queue to drop from, so bounding latency there
  means MediaMTX tuning plus a client-side `playoutDelayHint`, neither of which is done.

- **`streams/mjpeg.js` `setParams` is unvalidated and unthrottled** — `streams/mjpeg.js:194`.
  Repeated `setVideoParams` SIGTERMs `rpicam-vid` and queues a restart each time; an invalid width
  leaves the camera failing to produce frames while the close handler restarts it every second, so
  every viewer's stream stays black. Same unauthenticated reachability as the webrtc P0.

- **O(n²) MJPEG framing in the browser** — `socket.html:934` allocates and copies a new
  `Uint8Array` per chunk, then scans byte-by-byte in JS for `FFD8`/`FFD9` (`:941-942`). Fix:
  index-based scanning over a retained buffer. The same loop also never reconnects on a clean
  stream end and its accumulation buffer has no cap.

- **Fleet Manager re-reads `dashboard.html` from disk on every request** —
  `fleet-manager/server.js:84`, synchronously. Cache it at startup.

- **Pi model detection fails on the Compute Module 4** — `pwm_servo.js:7-9` matches `'pi 5'`,
  `'pi 4'`, `'pi 3'`, but rover3 reports `Raspberry Pi Compute Module 4 Rev 1.1`, so
  `detectPiModel()` returns `null`. Harmless today because `pwm_method: "mavproxy"` skips the
  override, but any rover switched to a GPIO driver silently keeps a possibly-wrong method instead
  of being corrected. Note `install.sh:122` *does* match `Compute Module 4` (setting `PI_GEN=4`),
  so the installer and the runtime disagree about the very board rover3 is. Match the compute
  modules in both.

- **MediaMTX is installed with no integrity verification** — `install.sh:320` downloads and
  installs the binary root-owned with no checksum or signature check, then enables it as a service.
  A provisioning run on an untrusted network can install a substituted binary. Fix: pin and verify
  a checksum.

- **The polkit rule grants mediamtx unit control to every local subject** —
  `install.sh:336-347` returns `polkit.Result.YES` for `manage-units` on `mediamtx.service`
  without restricting the subject, so any local account can stop the operator's video feed.
  Deliberate (it is user-agnostic by design) but broader than needed. Fix: scope to the run user.

### P3 — hygiene

- **Three unused runtime dependencies** — `mavlink`, `sleep`, `pi-blaster.js` in `package.json`
  are required by nothing in the tree. `pigpio` is a native module that compiles on-target during
  `npm ci` yet is only used by the non-default `pigpion` driver. (`pigpio-client` *is* used, by
  `pwm_pigpiod_servo.js`.) Fix: drop the unused three; make the native driver deps optional.

- **Dead and stale files** — `node-server.sh` (SysV init for a `/home/pi` layout; `sudo
  ./node-server.sh stop` runs `killall node`, which on a Fleet Manager host also kills the FM),
  `interfaces` (stale Debian network config with a stray backtick on the `gateway` line),
  `readme` (superseded by `README.md`; documents pi-blaster soft-PWM that no longer applies),
  `example.js`, `test_pwm.js` (sweeps throttle to both extremes through the real driver with no arm
  gate and no neutral — dangerous if anyone runs it on a rover with a battery connected),
  `pwm_test2.js`. Also two near-identical drivers, `pwm_pigpion_servo.js` and
  `pwm_pigpiod_servo.js`.

- **Repo bloat** — `mav.tlog` (167 kB) is tracked **despite matching `.gitignore`**, along with
  `mav.tlog.raw` (128 kB), `mav.parm` (26 kB), `picar-icon.png` (1.8 MB) and four ~1.8 MB icons in
  `icons/` (~9 MB total). Untrack them; history rewrite needs authorization.

- **Control-mode button shows a stale initial label** — `socket.html:360` renders
  "Control: Auto", a mode that does not exist, until `activateControlMode` runs on load.

- **The Enable Orientation button is unconditionally hidden** — `socket.html:1292` hides it inside
  `activateControlMode`, so an iOS operator who denies the motion permission has no way to
  re-request it and no indication why the controls are dead.

- **`sw.js` proxies every request through a service worker that does no caching** —
  `sw.js:5`. It adds a termination hazard for long-lived streaming fetches on worker update while
  providing no benefit. Fix: drop the fetch handler.

- **[P1] Pick a `batteryWarnVolts` for the fleet's packs — operator decision** — with the tracked
  config as shipped (`batteryWarnVolts: null`, `battery_empty_volts`/`battery_full_volts` null) and
  ArduPilot reporting `battery_remaining = 0` on this fleet, **no state of charge can raise a
  battery warning**: the percentage branch has no percentage, the voltage branch has no threshold,
  and the fail-closed branch needs the voltage to be missing too. Measured: a 2S pack at 3.0 V
  total renders with no warning and sets no Fleet Manager status bit.
  `feature/battery-and-radio-telemetry` adds a loud startup warning so the silence is visible, and
  gates it on the driver's effective capability so a half-configured range cannot suppress it — but
  choosing the threshold is a hardware judgement, not a code fix. Needs a per-pack value in the
  **tracked** config (the untracked overlay is exactly what invariant 8 forbids for safety config).

- **[P2] Ban `readFileSync` outside startup with a lint rule** — invariant 9. The telemetry loop
  takes its `/proc` reader as an injected promise-returning dependency and a test asserts
  `fs.readFileSync` is never called, but the injection itself is a one-line lambda in `app.js`
  that `Promise.resolve(fs.readFileSync(...))` would satisfy while still blocking. The contract
  confines the risk to one line; it does not prove it. `pwm_libgpiod_servo.js` spawning ~200
  `execSync`/s is the same class and much worse. A lint rule is the durable fix.

- **[P1] MAVProxy's tlog grows without bound in RAM** — measured on rover3 2026-08-04: `mavproxy.service`
  runs with `--logfile /tmp/mav.tlog`, `/tmp` is **tmpfs**, and after 17 h of uptime
  `mav.tlog` + `mav.tlog.raw` held **412 MB of the 3.9 GB tmpfs** (~24 MB/h). At that rate a rover
  left running fills tmpfs in about a week, after which MAVProxy's writes fail and anything else
  using `/tmp` fails with it — on the machine that carries the control path. There is no rotation.
  Either point `--logfile` at real storage with rotation, or cap it. Note `/var/log/mavproxy/`
  contains a *stale* `mav.tlog` from an earlier configuration, which is its own trap: an on-target
  check that read it reported a healthy MAVProxy as wedged.

- **[P3] Mutation-testing agents must not share a working tree** — during round 8 a reviewer
  observed this session's mutation runs modifying the same tree it was reviewing, and discarded its
  own in-tree results as unreliable in both directions. Any mutation verdict from an overlapping
  window is worthless. Reviewers should work in `git worktree` copies, or the orchestrator must
  serialise mutation work against review work.

- **[P2] No `/red-team` skill on `main`** — `CLAUDE.md` requires a second review from a different
  model family when Codex cannot run on an invariant-touching change, and says plainly that this is
  a step to perform rather than a skill to invoke, because the skill and its `red-team-reviewer`
  agent live only on the unmerged `feature/red-team-review` branch (`a2a7f4f`, unreviewed). Fable 5
  served the role by hand for `feature/battery-and-radio-telemetry`, recorded with a
  `Red-teamed-by: fable-5` trailer. Merging that branch would make the step invocable and
  self-documenting; until then the requirement depends on whoever reads the directive noticing it.

- **[P0] Orientation (tilt) mode commanded 0.9 throttle with no input — FIXED on a branch,
  not yet merged** — `socket.html` computed `(45 - event.beta) / 50`, and `null` coerces to 0
  in arithmetic, so an absent beta reading yielded **0.9 — ninety percent forward throttle** the
  instant tilt mode was entered. Every desktop browser fires `deviceorientation` without a real
  beta. rover3 has a flight battery and this FC ignores DISARM, so the failure mode is a vehicle
  driving away unbidden. This entry previously described the risk as hand tremor; the null path
  needs no tremor and is an order of magnitude worse. Fixed on `fix/orientation-null-throttle` (`60613ef`) — and note the first attempt
  (`e878b04`) was INCOMPLETE: it removed the null route but left the design route, because a
  flat phone (`beta=0`) maps to the same +0.9. The shipped fix adds neutral capture at arm,
  the dead band this entry asked for, a `controlMode` guard closing the async-permission
  race, and assignment-before-warn so a throw cannot leave the previous throttle live.
  **Merged; the tilt behaviour itself is still unvalidated on hardware — it needs a phone.**
  Superseded and removed the duplicate older entry for the same defect. Fixed on
  (`e878b04`): non-finite beta OR gamma yields neutral on both axes, plus the 0.06 dead band this
  entry originally asked for. **Needs review and a phone to validate — tilt control cannot be
  exercised by any host test or on-target script.** Found incidentally by an adversarial review
  of an unrelated branch, which is the only reason it surfaced.

- **[P2] The joystick path has no throttle dead band either** — `socket.html`'s virtual joystick
  sets `throttleValue` straight from stick position, so a small deflection sits inside the FC's
  `RC3_DZ` and commands nothing, while `nextThrottle`'s deadzone escape applies only to the
  keyboard. Not a hazard like the orientation null path, but it is an inconsistency between input
  modes that will read as "the joystick is less responsive than the keys".

- **[P1] `MOT_SLEWRATE` is the only rate limiter on an unauthenticated throttle path** — raising
  it 100 → 250 was operator-approved for control feel, and a review established what that means
  in context: `fromclient` is accepted with no armed check and no lease (invariant 3, violated),
  the override loop streams the channel buffer at 20 Hz armed or not, `arm()` force-arms with the
  21196 magic so ArduPilot's own pre-arm checks are skipped, and this FC ignores DISARM. So
  `MOT_SLEWRATE` is the last thing between a pre-loaded buffer and full throttle, and onset is now
  2.5× faster on a vehicle that can drive. **Land the `fromclient` armed-guard and the control
  lease and this stops being load-bearing.** Until then, treat the value as a safety parameter.

- **[P3] Orientation listener lifecycle is untested** — deleting the
  `addEventListener`/`removeEventListener('deviceorientation', ...)` calls survives the suite:
  tilt mode goes entirely inert, or the handler stays attached after leaving the mode, with no
  test failing. Listener lifecycle needs DOM wiring the current host tests do not have. The
  `controlMode !== 'orientation'` guard added in `60613ef` defangs the consequence — a leaked
  listener can no longer command anything outside tilt mode — so this is hygiene, not a hazard.

- **[P1] Re-deploy `main` to rover3 and confirm the two P0 fixes at that SHA** — both were
  verified on `test/p0-verify`, whose tree is byte-identical to `main` after the merges, but
  `main`'s own SHA has never run on the rover: it went off the network mid-deploy. rover3 is
  currently left on `test/p0-verify`, a throwaway branch. Re-run: the four secret paths must
  404, the four UI paths must 200, a `Range` request must return 200 and leave picar's PID
  unchanged, and `RestartUSec` must read 2s.

- **[P0] The ArduRover parameter overlay is pushed to ANY autopilot, without identifying it
  first** — measured on rover1, 2026-08-11, and it is not theoretical. rover1's Pixhawk 6C was
  recently converted and runs **PX4**, reporting `MAV_TYPE_QUADROTOR` with 1101 parameters in the
  PX4 namespace and zero ArduPilot names. Deploying `main` pushed all 13 ArduPilot names at it.
  Nine were rejected outright — but `RC3_DZ` and `RC3_TRIM` exist in BOTH namespaces and were
  actually written: **`RC3_DZ` went 10 → 30 on a PX4 flight controller**, confirmed by
  `PARAM_SET RC3_DZ=30` → `verified RC3_DZ=30` in the journal.

  So picar silently reconfigures a flight controller it has not identified.

  **This entry said "the driver already decodes `HEARTBEAT.autopilot` and `HEARTBEAT.type`".
  That was wrong and a reviewer caught it.** On `main`, `payload[5]` is only compared against 8
  (is-it-a-GCS) and then discarded, and `payload[4]` — MAV_TYPE — is never read ANYWHERE in the
  driver. So the fix cannot be "consult what is already decoded"; the decoding has to be written,
  retained, and tested against both a PX4 and an ArduPilot heartbeat. Implementing the old
  wording as written would have left the P0 open while looking closed.

  The second trap in the naive fix: the overlay runs on **connect**, before any heartbeat can
  have arrived, and that is deliberate — `_connect` documents why gating it on the heartbeat is
  fail-OPEN. So identification cannot gate the first write without reintroducing that. The
  overlay has to be split: the flight controller's own stale-override failsafe
  (`RC_OVERRIDE_TIME`) goes out immediately whatever is on the other end, and the
  vehicle-CONFIGURATION entries wait for identification — bounded, so a one-way link still gets
  its output mapping rather than leaving `SERVOn_FUNCTION` at a replacement board's defaults.

  Report the mismatch on `/status`: a rover whose firmware the overlay does not model should say
  so, not appear to be a rover with 9 missing parameters. Note the deleted tracked `mav.tlog`
  uniquely records 18 ArduPilot parameter writes sent to a PX4 board; preserve it outside the
  repo before any authorized history rewrite.

  Raised as a blocking finding against `fix/overlay-merges-not-replaces`; scoped to its own
  branch on operator instruction because it is new safety logic rather than a correction.
  **Implemented on `fix/identify-autopilot-before-overlay`** — not yet reviewed at its current
  SHA and not validated on hardware, so this entry stays open until that branch lands.

- **[P1] `test/on-target/control-e2e.js` should export a `run()` driven by an injected request
  transcript** — deferred from `fix/motion-gate-fails-closed` on operator instruction, and
  tracked here because that branch will merge and be deleted. The durable fix for three separate
  problems: `ok()` is an unconditional print, so `arm`, `fromclient`, `disarm` and `setLight` all
  report PASS after an HTTP 200 without confirming the named server handler ran — rename the
  production `arm` handler to `armx` and the script still prints `PASS arm sent`; the host test
  depends on the tracked `certs/key.pem`/`cert.pem`, which an open P0 says must be untracked; and
  the child-process machinery has already had to be patched once for turning a hang into a pass.
  Injecting the transport removes all three at once and moves every assertion onto the wire.

- **[P2] `app.js` still has no test file, and this is now the fifth branch it has cost** —
  the wiring for the crash fail-safe, the Range strip, the static allowlist, the telemetry
  loop and the video-param persistence were each deletable with a green suite until a
  reviewer or a mutation pass caught them. Two are now pinned only by source-text assertions,
  which catch deletion but not a rename or a behaviour-preserving refactor. The durable fix is
  to make `app.js` require-able — export a factory that takes its ports and collaborators —
  so its request handler and its top-level wiring can be driven by a test.
