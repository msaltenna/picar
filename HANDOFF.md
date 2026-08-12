# HANDOFF

Context for the next agent or session. Open work lives in `TASKS.md` — it is not repeated
here. Read `CLAUDE.md` first for the directive and pipeline.

## Current state

picar is a working teleoperated rover platform: a Raspberry Pi companion computer (rover3 is
a **Compute Module 4**) driving a **Pixhawk 6C mini** over
MAVLink, controlled from a browser over HTTPS. The direction of
travel is a drone platform on the same flight-controller hardware, evolving toward a custom
software stack. A custom flight controller is **not** in scope, and the vehicle profile is
**rover-only** — no speculative airframe abstraction until an airframe exists.

> ### The single most important fact right now
>
> **`main` has no control-safety layer, and the branch that had one has been shelved.**
>
> On `main` today the `arm` handler is `app.js:133-144`: any socket that reaches `:8443` can arm
> and drive the vehicle, with no lease, session token, sequence number, or staleness check, and
> `pwm_mavproxy_servo.js` has no `isSafetyReady()` gate. There *is* an input watchdog
> (`app.js:265`) — an earlier revision of this file said there was none. That is the live state of
> every rover.
>
> **Escalation, 2026-08-03:** three unauthenticated defects were found that are worse than
> "anyone can arm", because they need no physical proximity at all — a proven remote code
> execution via `setVideoParams`, a missing Origin check that makes the whole control plane
> reachable from any web page the operator visits, and stored XSS in the Fleet Manager dashboard.
> All three are P0s in `TASKS.md` and are Phase 1 of the agreed plan.
>
> The safety work — `control-safety.js`, `client-control-safety.js`, the 24-test `test/`
> suite, hardened arm-gating, MAVLink v2 parsing, the autopilot-heartbeat filter, and the
> `FRAME_CLASS=1` correction — was **shelved on operator instruction on 2026-07-30** and now
> exists only as the archived remote branch
> **`origin/archive/control-failsafe-2026-07-30`** (commit `6220780`, 13 files, +1226/−110).
> It is *not* local and *not* scheduled. Recover any part of it with
> `git show origin/archive/control-failsafe-2026-07-30:<file>`.
>
> **DO NOT cherry-pick the archive's MAVLink work — that instruction is withdrawn.** An earlier
> revision of this paragraph said the archive's v2 parser and heartbeat filter were prerequisites
> for current work and should be cherry-picked rather than rewritten. Both have since landed on
> `main` in better form, verified by reading the code on 2026-08-11: `parseIncoming` accepts v1
> and v2, validates `CRC_EXTRA`, rejects unknown msgids, and filters on `sysId`/`compId` at two
> separate points. **Applying the archive's version now would overwrite the newer hardened parser
> and regress live telemetry and heartbeat attribution.** `FRAME_CLASS=1` also landed. There is
> nothing in that archive currently needed; treat it as history unless a specific gap is
> identified against today's code.
>
> **Second-most-important fact, 2026-08-11: do not run `npm run test:on-target` on rover3 until
> `fix/motion-gate-fails-closed` merges.** Its motion gate reads the vehicle's broken voltage
> sense (0.007 V) as "no battery" and therefore arms the rover and commands steering and a
> drivetrain change **without** the `--allow-motion` flag. Details in the change-log entry below.
>
> **Nine branches are open, all reviewed, none cleared, none validated, none pushed.** rover3 has
> never been deployed to from any of them. See `TASKS.md` for the verdicts and the remediation.

What works today **on `main`**:

- **Control path.** Browser → Socket.IO (:8443) → RC_CHANNELS_OVERRIDE at 20 Hz → MAVProxy
  (TCP :5760) → Pixhawk. The driver applies a minimal ArduRover param overlay on connect and
  reads critical params back, but on `main` a mismatch only logs a warning — it does not
  block arming.
- **Video.** Pluggable per `stream_codec`: WebRTC through MediaMTX (default, `mediamtx.yml`
  generated at startup from `picar-cfg.json`), raw H.264 over WebSocket into WebCodecs, and
  an MJPEG fallback. Resolution/FPS/bitrate are adjustable live from the UI.
- **Fleet.** Rovers find the Fleet Manager by sweeping their own `/24` over unicast TCP for
  `GET /api/fleet-id`, then heartbeat to it — no IP, hostname, or per-rover setup, and it
  survives the Fleet Manager moving hosts. Per-rover identity lives in untracked
  `picar-cfg.local.json` so the tracked config stays git-pullable.
- **Install.** `install.sh --picar|--fleet` installs in place, templating the run user and repo
  path into the systemd units and installing a unit-scoped polkit rule so the non-root service can
  restart MediaMTX. **It is *not* idempotent** — it rewrites the tracked `picar-cfg.json`, and
  `systemctl enable --now` does not restart an already-running unit, so a re-run after `git pull`
  does not deploy the new code. Both are P1s in `TASKS.md`.
- **Bounded video latency** (merged at `4580209`). `h264` sheds delta frames while keeping
  keyframes so a client can resync, `mjpeg` skips whole frames, both parse buffers are bounded and
  resync, the mediamtx restart is async and coalesced, and failed Fleet Manager discovery sweeps
  back off 5 s → 5 min. The h264 drop path is hardware-verified; the mjpeg one is host-tested only.

What the **archived** branch adds, should it ever be revived: the single-owner control lease,
token + sequence + timestamp *integrity checking* of every command, the NTP-midpoint
clock-skew check, the input watchdog, fail-safe stops on every disconnect/hide/timeout path,
arm-gating on verified flight-controller parameters, and the host test suite.

Two things that branch does **not** do, contrary to earlier claims here and in `README.md`:

- It does not authenticate anyone. The session token is a lease handle, not a credential —
  whoever arms first gets it. Command integrity is not operator identity.
- Its fail-safes do not put neutral on the wire before DISARM. `setServoPWM` only mutates a
  buffer; DISARM transmits immediately, so the neutral override actually follows ≤50 ms
  later on the next 20 Hz tick. The existing tests assert method-call order against a mock
  and cannot see this.

Weakest points beyond that, in priority order: the three unauthenticated-network defects above
(RCE, missing Origin check, dashboard XSS); no operator authentication anywhere; the CA and server
private keys committed to the repository; the channel buffer being pre-loadable while disarmed;
two ways the input watchdog is defeated; and every fail-safe being a no-op on non-mavproxy
drivers. These are the top `P0` entries in `TASKS.md`.

Note the `setVideoParams` handler still does a synchronous `writeFileSync` on the event loop, but
the *restart* it triggers is now asynchronous — an earlier revision of this section claimed the
whole path blocked "for seconds", which was measured wrong by ~2 orders of magnitude and corrected
in the `perf/bound-video-latency` entry below (85 ms mean, 100 ms max).

## Change log

### 2026-08-12 — six branches merged to local main, validated on rover3 @ `658f5d90`

**What landed**, in merge order, all to **local `main` only — `origin` is untouched and nothing
is pushed**: `chore/remove-px4-param-dump`, `fix/motion-gate-fails-closed`,
`chore/validator-battery-premise`, `fix/overlay-allowlist`, `chore/record-audit-2026-08-11`,
`fix/identify-autopilot-before-overlay`.

**The substantive change is the two-tier parameter overlay.** picar pushed its ArduRover overlay
at whatever answered on :5760, never reading `HEARTBEAT.type` (payload[4] was not read anywhere
in the driver) and testing `HEARTBEAT.autopilot` only for "not a GCS". Measured consequence on
rover1, 2026-08-11: all 13 ArduPilot names went to a **PX4** board; nine were rejected, but
`RC3_DZ` and `RC3_TRIM` exist in both namespaces and were written — `RC3_DZ` 10 → 30 — and the
read-back reported them **verified**. The overlay is now split: `RC_OVERRIDE_TIME` (the flight
controller's own stale-override failsafe) goes out on connect unconditionally, and everything
else waits for the autopilot to identify itself as ArduPilot with `MAV_TYPE` in
{GROUND_ROVER, SURFACE_BOAT}. If nothing identifies it within `mavproxy_identity_grace_ms`
(default 2000, clamped 500–10000) the configuration tier is **refused**, not written blind.

**VALIDATION: PASS (read-only tier), rover3, 2026-08-12 17:57–18:0x BST, at `658f5d90`** — the
exact SHA merged, deployed by `git bundle` rather than through `origin`.

| Evidence | Result |
| --- | --- |
| Services | `picar`, `mavproxy`, `mediamtx` active; `NRestarts=0` |
| Two-tier overlay | `Applying the pre-identity param overlay (1 of 13)` → `Received first Pixhawk heartbeat (sys=1 MAVLink 2)` → full overlay → `parameter overlay confirmed by read-back`, all inside ~7 s |
| Identification | `/status` `firmware: {autopilot: 3, type: 10, mismatch: null, overlaySuppressed: false, identityTimedOut: false}` — correctly identifies rover3 as an ArduRover GROUND_ROVER |
| `fcSupported` | now `true` on the wire. It was never emitted before, so the motion gate's `fcSupported === true` refused on every rover and `--allow-motion` could not pass on hardware at all |
| Critical params | 11 verified, 0 missing, 0 mismatched; `FRAME_CLASS=1` read back |
| Motion gate | `npm run test:on-target` → **exit 4 INCOMPLETE**, all five motion groups SKIPPED, nothing armed. This is the gate failing closed on real hardware |
| `telemetry.sh` | exit 0, PASSED WITH WARNINGS; footer reports `BATTERY MEASURED AT 7.31 V drawing 0.44 A. A PACK IS CONNECTED — ASSUME THE WHEELS CAN TURN` |
| Host suite on target | **385 pass, 0 fail** |

**WHAT THIS VALIDATION DOES NOT COVER, and it matters.** This is the **read-only tier** as newly
defined in `CLAUDE.md`. No motion was commanded: nothing armed, no steering, no drivetrain shift,
no watchdog expiry, no light. By this session's own new rule, `fix/motion-gate-fails-closed` and
`fix/identify-autopilot-before-overlay` are **control-path changes and therefore require the
motion tier**, so they are **read-only validated only** — which the same rule defines as
UNVALIDATED for their purpose. They were merged anyway on explicit operator instruction to merge
on review pass. That is a real, deliberate departure from the gate and it is recorded here rather
than smoothed over.

**Also unvalidated by construction:** every refusal path. rover3 is a healthy ArduRover, so the
PX4 suppression, the SURFACE_BOAT repair path and the identity timeout were exercised only by
host tests. The one rover that would exercise them is rover1, which was unreachable all day.

**Second Opinion:** every branch went through Codex adversarial review, most through two or three
rounds; **13 findings across the first round alone** (one critical, nine high). All were fixed —
see the individual commit bodies, which record what each round found and, where I disagreed, why.
**No branch carries a `Reviewed-by:` trailer except `chore/remove-px4-param-dump`**, because every
other tip moved after its last review to fix that review's findings, and an ancestor's review is
not coverage for amended safety code.

**Rover state left behind:** rover3 is on a local branch `deploy-main` @ `658f5d90`, NOT on
`main` and NOT on the branch it started the day on (`fix/webrtc-require-udp` @ `370d39da`). Its
untracked `picar-cfg.local.json` is preserved. `/tmp/main.bundle` was left in place.

**A measurement that contradicts the record:** rover3's battery sense read **7.32 V at 0.46 A**
all day. The 2026-08-11 finding of 0.007 V while current read 0.54 A did not reproduce after the
rover's modifications. Either it was repaired or it is intermittent; those have very different
consequences for every script that branches on plausibility, and it is filed in `TASKS.md`.


Newest first.

> **EVERY ACTUATION DISCLAIMER BELOW DATED BEFORE 2026-08-05 IS VOID.** Entries here say things
> like "no mechanical actuation was observed (no flight battery)", "motors and servos cannot
> move", and "no actuation is possible with the flight battery disconnected" — at roughly
> `:443`, `:478`, `:547`, `:845`, `:1129` and `:1207`. **A pack was installed the whole time**;
> battery telemetry read 7.9 V at 0.41 A from the first validation onward. The command-path
> evidence in those entries stands on its own and is not rewritten — falsifying a dated record is
> worse than annotating it — but the safety property each one asserts was never true. `CLAUDE.md`
> ruled on 2026-08-05 that this premise must never be written as a standing fact.
>
> A cross-family red team found these still reading as unqualified fact on 2026-08-11, in a
> commit that extensively edited this file while condemning exactly that failure three sections
> earlier. Hence this banner rather than another silent pass.

### 2026-08-11 (second session) — Every open branch reviewed by Codex; two P0s found, none merged

Nine branches went through the Second Opinion stage. **Not one cleared it.** ~57 findings, 23
HIGH: four NO-SHIP and five NEEDS-CORRECTION, spread across both the five branches the previous
session left open and the three this session wrote. The verdict table and all remediation are in
`TASKS.md`; this entry records what happened, what was measured, and what it cost.

**The escalated stage was not broken — the invocation was.** The previous session recorded the
Second Opinion stage as escalated because Codex "produced no verdict at all": one foreground run
timed out at 10 minutes, one `--background` run died after dumping the diff. Codex works.
`codex-cli 0.146.0`, `gpt-5.6-sol`, exit 0 on all nine runs. What makes it work: scope each review
to **one branch's diff**, run `codex exec --cd <worktree> --sandbox read-only` detached with a
~40-minute ceiling, and give it the hardware context and the branch's specific hazards in the
prompt. Reviews took 5-20 minutes each and ran nine-wide in parallel. A timeout was an
invocation problem, and `SKILL.md` is right that it is not a fallback condition.

**Every review ran in its own detached `git worktree`**, closing the tracked P3 the hard way: the
2026-08-06 session ran mutations in the same tree two reviewers were reading and had to discard
the results. `git worktree add --detach <path> <branch>` per branch, `node_modules` symlinked so
the reviewer can run the suite read-only. Authoring continued in the main checkout throughout with
no interference.

**Two P0s, both found by reviewing a DIFFERENT branch than the one that had the defect.**

The first is the worst thing found this session. `test/on-target/control-e2e.js` gated motion on
`voltageV > 3`, and rover3's analog voltage sense is dead — `0.007 V` while current reads `0.54 A`.
`0.007` is not `> 3`, so the guard concluded "no pack" and **`npm run test:on-target` armed the
vehicle and commanded steering and a drivetrain change with no `--allow-motion` flag**, on a rover
with a pack installed, armed continuously, whose FC refuses DISARM. The function's own comment four
lines above read *"Fails CLOSED — 'I could not tell' must never read as 'it is safe'"*; the code did
the reverse one line later. **Four** of the five readings rover3 can produce opened it: `0.007`,
exactly `3.0`, exact `0`, and `null` — the `3.0` boundary case included, because the rule was a
strict `> 3`. `CLAUDE.md` had asked for this exact fix on 2026-08-05 ("make the guard require a
*positive* determination"); it sat open six days.

The second: a custom `mavproxy_param_overlay` **replaced** the built-in parameter set instead of
merging. Three separate branch reviews reported it before anyone looked at the sanitizer itself,
which is the interesting part — each branch added a parameter and a test asserting two static
tables agreed, and none could see that production pushes a different object. The defect, its
consequence and its remediation are in `TASKS.md`; not restated here.

**Three branches written this session**, all committed, none cleared:
`fix/motion-gate-fails-closed` (`b4a485c`), `fix/overlay-merges-not-replaces` (`ac80d59`),
`chore/validator-battery-premise` (`34de5a4`).

**Facts established by reading the code rather than the tracking documents.** Several `TASKS.md`
entries described defects that had already been fixed, and one review's stale-entry claim was
itself too broad:

| Claim on file | Measured |
| --- | --- |
| "`main` never validates the receive CRC, and drops v2" | **False.** `parseIncoming` accepts `0xFE` and `0xFD` (`:832`), validates `CRC_EXTRA`, and rejects unknown msgids. Entry deleted. |
| "any HEARTBEAT is treated as the autopilot's, no sysId filter" | **False.** Filtered at `:949` and again at `:1108`. Deleted with the above. |
| "Param-overlay timers survive disconnect" | **Mostly false.** `close` calls `clearOverlayTimers()` (`:733`) and clears `overlayReassertTimer`. Narrowed to `armTimeout`, which genuinely is not cleared there. |
| "No MAVLink framing tests" | **Half true.** `test/mavlink-vectors.test.js` has 19 tests — but **all 19 exercise `parseIncoming`**. Not one covers `buildRCOverride`, `buildCommandLong`, `buildParamSet`, `buildParamRequestRead` or `buildHeartbeat`. Narrowed to the transmit builders. |
| `RC_OVERRIDE_TIME` is a safe 16-char name | It is **exactly** 16 characters, and `buildParamSet` does `String(name).slice(0, 16)` — so `RC_OVERRIDE_TIMEX` passes any name-based check and lands on the wire as `RC_OVERRIDE_TIME`. |
| `FS_TIMEOUT=1.5` is the failsafe delay | Rover 4.6.3 applies **`FS_GCS_TIMEOUT` then `FS_TIMEOUT`**; `FS_GCS_TIMEOUT` defaults to 5 s and nothing owns it, so the delay is ~6.5 s and unbounded on a replacement board. |
| `telemetry.sh` has no `set -u` | It does — `:27`, `set -uo pipefail`. Stated wrongly mid-session on a `head -12` grep. |

**Four process failures, mine, recorded because the pattern is the point.**

1. **I drafted five mutation counts before running the harness.** Every one was wrong, and a sixth
   mutation turned out syntax-broken, so it proved nothing while looking like a kill. `CLAUDE.md`
   records two prior commit messages doing this and the last session made three; this would have
   been four. Caught only because the harness was run afterwards. **Write the table from output.**
2. **I committed the dominant defect shape twice, in commits written to avoid it** — once fixing
   a rule in documentation while its code consumer went on acting on the old one, once protecting
   a helper while its caller stayed unguarded. Both caught by review, not by me. The specific
   defects and their fixes are tracked in `TASKS.md`; what belongs here is the pattern: when I fix
   X, X is in frame and its callers are not, and the test I write is authored from inside that
   same frame.
3. **I asserted `telemetry.sh` had no `set -u`** on the strength of grepping its first 12 lines,
   and told the operator the `${bv:-}` guards were therefore decorative. They are load-bearing.
4. **A test I wrote to avoid the hang-as-pass trap can hang.** `test/config-bounds.test.js`'s
   transmission test passes an object to `overlayChainMs()`, which expects counts and coerces to 0;
   an assertion throw inside its `setTimeout` never rejects the promise; and its cleanup calls a
   method that does not exist. Under a mutation it can report HANG instead of a failure.
5. **I miscounted the defect in the record itself, and the miss was the boundary case.** The
   motion-gate entry said three of five readings opened the old gate. It was **four**: the rule
   was a strict `voltageV > 3`, so exactly `3.0` also passed through, and that is precisely the
   value a reader would assume was handled. Stated three times — to the operator, in the commit
   body, and in both tracking documents — before the review of that branch caught it. Corrected
   above. The lesson is narrow and repeatable: **enumerate boundary values by running the old
   predicate over them, not by reasoning about it.** Four lines of `node -e` settled it.
6. **A mutation count went in with no auditable derivation.** The motion-gate commit records
   "the original voltage-decides logic restored -> 5 failures". The patch that produced it
   hard-coded the reading rather than faithfully restoring the old rule, and a faithful
   restoration yields four. The number was real output from a real run — of the wrong mutant.
   Record the patch alongside the count, or the count means nothing.

**rover3 was not touched.** No deploy, no checkout change, no service restart, no MAVLink written.
It remains on `fix/webrtc-require-udp` @ `370d39da` with the untracked `field-log.sh`, exactly as
the previous session left it. **Nothing in this entry carries an Embedded Validator pass, and
nothing may merge on the strength of it.** Host suite on the working branches: 302 on `main`, 308
with the motion-gate tests, 312 with the overlay tests.

### 2026-08-11 — Control-path and Pixhawk-config audit; five branches open, NONE reviewed or validated

Two audits (server/client control path, then flight-controller configuration), both fanned out
across parallel agents, followed by the first read-only on-target parameter survey this project
has done. Five branches came out of it. **All five are local, unmerged, unpushed, carry no
`Reviewed-by:` trailer, and have no Embedded Validator pass.** Do not merge any of them on the
strength of this entry.

| Branch | SHA | What |
| --- | --- | --- |
| `fix/systemd-restart-limits` | `b2ef26e` | mavproxy `RestartSec=2` + widened finite start-limit; `test/systemd-units.test.js`; `test/on-target/service-boot.sh` |
| `chore/remove-px4-param-dump` | `345f300` | delete `mav.parm`/`mav.tlog`/`mav.tlog.raw`, fix the comment naming them, extend `.gitignore` |
| `fix/verify-gps-disable-params` | `66df00c` | read back `AHRS_GPS_USE`/`GPS1_TYPE`; test that every pushed param is verified |
| `feature/fc-failsafe-params` | `376fec2`, `583f18c` | decode `COMMAND_ACK`; push+verify `FS_ACTION=2` and `FS_GCS_ENABLE=1` |
| `fix/align-steering-rc-range` | `add9294` | own `RC1_MIN/MAX` and `RC3_MIN/MAX`; assert against `pwm_min_us`/`pwm_max_us` |

**Review status, stated plainly because the trailers cannot say it.** Codex reviewed the first,
over-scoped version of the systemd change and returned **8 findings, all of which were accepted**;
that change was reverted whole and re-scoped from four concerns to one. Codex then produced **no
verdict at all** on anything else: one foreground run hit the 10-minute timeout, and a
`--background` re-run terminated after dumping the diff without reviewing. Per
`.claude/skills/second-opinion-validator/SKILL.md` a timeout is **not** a fallback condition, so
the Opus fallback was not used and the stage is **escalated, not satisfied**.

**On-target work was read-only.** `PARAM_REQUEST_READ` and tlog parsing only; no `PARAM_SET`, no
arm, no disarm, no motion, nothing written to the FC. rover3 was left as found: throttle 0,
steering 0, all three services active, `params.missing []`, temp files removed.

What the parameter survey established is in `## Environment` above — firmware version, the 918-param
baseline, both FC failsafe triggers disabled, all battery failsafes disabled, the v2-only autopilot,
the armed state, and the broken battery voltage sense. Open work from it is in `TASKS.md`.

**Three process failures in this session, recorded because the pattern recurs here:**

1. **A commit message asserted mutations were dead when one had survived.** The `sed` matched no
   line, so the mutation never ran; run properly it survived and exposed a real gap —
   `FS_GCS_ENABLE` could be dropped from `EXPECTED_CRITICAL_PARAMS` with no test failing. Amended,
   and a test now closes it. `CLAUDE.md` already warns that two past commit messages did this;
   make three.
2. **A commit went in with a failing test.** `not ok 47` — the new test looped over RC1 and RC3
   assuming both were pushed, and `RC3_MIN/MAX` were not in the overlay. Adding them was the right
   fix and closed a tracked P2, but the commit should not have been made first.
3. **Four proposed corrections to this file and `TASKS.md` were drafted, then all four were
   refuted** by an adversarial pass before being written. The most serious was a claim that
   `TASKS.md`'s 2026-08-03 DISARM entry was factually wrong: this session measured
   `COMMAND_ACK cmd=400 result=4` in a **different capture** (~24 min, 1434 heartbeats,
   `base_mode 193`, ArduRover 4.6.3) than the entry describes (3 m 40 s, 222 heartbeats,
   `base_mode 129`, SHA `268561f`). Different session, so it corroborates nothing about that one.
   The new measurement is recorded as its own dated observation instead. **The refute pass is the
   only reason those three wrong "corrections" did not land in a file everyone trusts — keep
   doing it.**

   **But a FIFTH correction did land, and it was wrong.** The refute pass cleared the force-arm
   correction — that `21196` is disarm-only, so an arm carrying it leaves ArduPilot's checks
   enabled — and it was written into `TASKS.md`, retiring a real P0 and queueing a matching
   "fix" to `CLAUDE.md` invariant 7. A cross-family red team read the Rover-4.6.3 source on
   2026-08-11 and overturned it: `GCS_Common.cpp:5027` disables arming checks for **either**
   2989 or 21196, and `AP_Arming.cpp:1798` then skips `pre_arm_checks()` and `arm_checks()`
   outright. The hazard is real and is restored.

   Why the refute pass missed it is the useful part: every other correction was checked against
   *this repository*, which the pass could read. This one turned on the behaviour of **external
   firmware**, and the pass accepted MAVProxy's CLI conventions as a proxy for it because they
   were on-disk, on the target, and looked authoritative. An adversarial pass over your own
   claims cannot settle a question whose answer lives outside your tree. **When a claim depends
   on third-party behaviour, go to that project's source at the tag you are running, or record
   the claim as unverified — do not promote a nearby artefact to evidence.**

### 2026-08-05 — Two P0s on the unauthenticated control port: crash-without-fail-safe, and served private keys

`fix/crash-failsafe` and `fix/no-secrets-over-http`, both merged. Found by an adversarial
review of an unrelated branch that happened to touch the same `node-static` construction;
both were pre-existing on `main` and tracked nowhere.

**P0 #1 — one request killed the control plane with no fail-safe.** node-static's
`finish()` calls `res.writeHead()` again after a 206 has streamed, so
`curl -k -H 'Range: bytes=0-99' https://rover3:8443/socket.html` threw
ERR_HTTP_HEADERS_SENT out of the request handler. `app.js` registered only
`process.on('SIGINT')`, so **no neutral RC_CHANNELS_OVERRIDE packet and no DISARM reached
the link** — invariant 6 lists "process shutdown" and only the polite half was covered.
With `Restart=always` and no `RestartSec` that was a ~100 ms crash-restart loop, each cycle
leaving the vehicle armed with the last throttle in the channel buffer, on a rover with a
flight battery and an FC that ignores DISARM.

Fixed both ways: `Range`/`If-Range` stripped before node-static sees a request
(prevention), and `uncaughtException`/`unhandledRejection` now run the real `failSafeStop`
before exiting non-zero (containment), with `RestartSec=2`.

**P0 #2 — the port served its own TLS private keys.** The static root defaulted to the
working directory, which systemd sets to `/opt/picar`. Measured on rover3:
`GET /certs/ca.key` → **200** and the CA private key that `README.md` tells every operator
device to trust — a fleet-wide MITM key from one unauthenticated GET. `/certs/key.pem`,
`/picar-cfg.local.json`, `/.git/config` and `/mediamtx.yml` likewise. Fixed with a
fail-closed **allowlist** (`/socket.html`, `/sw.js`, `/icons/*.png`), so a secret added
later is not served by default.

**Validation — read this carefully, it is not the usual shape.** Both fixes were verified
on rover3 on a combined branch `test/p0-verify`, at a tree that `git diff --quiet` confirms
is **byte-identical to `main` after both merges** (the merge commits changed no files).
Measured there:

| Check | Result |
| --- | --- |
| `/certs/ca.key`, `/certs/key.pem`, `/picar-cfg.local.json`, `/.git/config`, `/mediamtx.yml`, `/app.js` | **404** |
| `/socket.html`, `/sw.js`, `/manifest.json`, `/icons/fleet-192.png` | **200** |
| `Range: bytes=0-99` on `/socket.html` | **200**, not 206 |
| picar PID across the Range request | **unchanged — survived** |
| `RestartUSec` | 2s |
| Services / suites | active `NRestarts=0`, 302/302 on target, 26/26 on-target |

**What is NOT done:** `main`'s own SHA has not been deployed. rover3 went off the network
before the confirming run — it resolves to 192.168.31.223 but answers neither ping nor SSH.
The evidence above stands on tree equality, not on a run of this SHA. **Re-deploy `main` and
re-run the four checks when the rover is back**, and note that rover3 is currently left on
`test/p0-verify`, a throwaway branch.

**One methodological note.** The Range crash was reproduced locally against the same
node-static the rovers run, and deliberately **not** on rover3 until the fix was in —
crashing a control plane on a vehicle with a live pack is not worth the information. It was
only exercised on target afterwards, to prove the fix.

### 2026-08-05 — Tilt mode could command 0.9 throttle unbidden; two causes, both fixed

`fix/orientation-null-throttle`, validated on rover3 at
`60613ef` — **no-regression only**, see the limit below.

**The hazard.** `socket.html` computed tilt throttle as `(45 - event.beta) / 50`. Two
independent routes to 90% forward throttle with no operator input:

1. **`event.beta === null`** — `null` coerces to `0` in arithmetic, so the expression is
   45/50 = 0.9. Produced by any device that fires `deviceorientation` without a usable
   reading (Firefox on desktop, Android before its first sample, iOS with the sensor
   briefly unavailable).
2. **A phone lying flat** — `beta = 0` is a level phone, which maps to the same +0.9. Set
   the phone on a bench, press Start, and the vehicle had 90% throttle within one 50 ms
   send tick. **This one survived the first fix** and was caught by review afterwards.

rover3 has a flight battery and this flight controller ignores DISARM, so the failure mode
is a vehicle driving away. Route 1 was found incidentally while reviewing an unrelated
branch; route 2 only because the first fix was itself reviewed.

**The fix.** Non-finite beta *or* gamma yields neutral on both axes. Throttle then stays at
zero until the device has been seen at rest — one reading inside the 0.06 dead band since
the last arm — so a tilted device cannot command drive on Start. The latch clears on
leaving tilt mode and on `stopped`. Controls are assigned before anything that can throw.
`controlMode` is checked as well as `stopped`, which closes a live race: the permission
grant adds the listener from an async callback, so switching to joystick while the iOS
prompt is open otherwise attaches the tilt handler *after* the switch.

**VALIDATION LIMIT, stated plainly.** Tilt control cannot be exercised by any host test or
by anything in `test/on-target/` — it needs a physical phone. On-target work therefore
shows **no-regression only**: 271/271 on target, 26/26 on-target checks, services active
`NRestarts=0`. The diff is confined to the orientation handler, so no other control path
can regress. **The tilt behaviour itself is unvalidated on hardware.** Someone should hold
a phone, enter tilt mode flat on a table, press Start, and confirm the rover does not move.

**What the review cost, and why it was worth it.** Six mutations survived the first
version, four on lines that exist for safety: the reverse half of the tilt axis was
deletable (no test asserted a negative throttle), the `stopped` guard was deletable, the
warn-once flag's declaration was deletable *because the test supplied it* — which in a
browser throws ReferenceError and left the previous throttle live at 20 Hz — and the
neutral latch's reset was deletable because it lived in `toggleStop`, which no test can
reach. That reset now lives in the handler where a test can drive it.

**Accepted gap:** deleting the add/removeEventListener calls still survives; listener
lifecycle needs DOM wiring these tests do not have. The `controlMode` guard defangs the
consequence — a leaked listener can no longer command anything outside tilt mode.

### 2026-08-05 — Throttle response: FC deadzone escape, snap-to-neutral, MOT_SLEWRATE=250

`fix/throttle-response`, validated on rover3 at
`b17f5a66560fea77346b33db9b073e9ae7978003`. **rover3 HAS A FLIGHT BATTERY** — see the
Validation section of `CLAUDE.md`, corrected the same day.

**What prompted it and what it actually was.** The operator reported reverse was not
immediate and "required steering first". The cause turned out to be **the ESC**, not picar: on
this vehicle the reverse input while rolling forward is BRAKE, and reverse engages only after
the throttle returns to neutral and is applied again. Reverse → forward has no such gate,
which is why that direction was always instant. "Steering first" was really *time spent at
neutral* while the throttle decayed. Confirmed by the operator: reverse now engages on the
second press, consistently.

Measured, so the next person does not repeat the hunt:

| Observation point | Result |
| --- | --- |
| picar → FC, reverse step | commanded value reached in **13–93 ms**, symmetric with forward |
| FC output, `MOT_SLEWRATE` 100 → 250 | settle time ~667 ms → ~468 ms |
| Client release → neutral | up to 20 ticks (~1 s) → **one tick, 29–77 ms** |
| Flight mode / mapping | `MANUAL`, `RCMAP_THROTTLE=3` — direct passthrough |

**What shipped.** The first keyboard step from rest goes to 0.08 instead of 0.05, clearing the
FC's `RC3_DZ=30us` deadzone (0.06 normalised) that the old first step landed inside. Releasing
snaps to neutral in one tick instead of decaying for up to a second — safer in its own right,
and it is what makes the ESC's second press work *consistently* rather than intermittently.
`MOT_SLEWRATE=250`, plus `RC3_DZ` and `RC3_TRIM` now pushed and verified so the browser's
deadzone constant is derived from parameters the rover is known to hold rather than from a
one-off measurement.

**Validation at that SHA:** services active `NRestarts=0`; 257/257 on target; on-target suite
26 PASS / 0 FAIL; **11/11 critical parameters verified**, `missing: []`, `mismatched: {}`, with
`PARAM_SET`/`verified` pairs for all three new entries in the journal; the battery guard
correctly refusing (`7.905 V, 0.42 A, 77%`).

**Not validated at this SHA:** the browser behaviour itself. The deadzone escape and
snap-to-neutral are covered by host tests that drive the real `keyboardTick` and the real
`startKeyboardLoop`, but no automated on-target check exercises a browser. The operator drove
an integration build containing these changes and reported the improvement.

**Two things the reviewer made me correct, worth carrying forward.** First: `MOT_SLEWRATE` is
*not* merely a control-feel parameter, which is what my commit originally claimed. Because
`fromclient` has no armed check and no lease, the override loop streams armed or not, `arm()`
force-arms past ArduPilot's own checks, and this FC ignores DISARM, `MOT_SLEWRATE` is the
**only** rate limiter between a pre-loaded channel buffer and full throttle — so 250 raises
throttle onset 2.5× on a vehicle that can drive. Operator-approved with that understood. The
fail-safe half does hold: the override loop keeps streaming after disarm, so a higher rate
reaches neutral *sooner*.

Second: the branch's entire behaviour was initially deletable with a green suite — the rule was
tested, its only call site was not. That is the defect shape `CLAUDE.md` names as dominant here,
and it appeared in a commit whose tests were written specifically to avoid it. Fixed by
extracting `keyboardTick()` and making `startKeyboardLoop()` take its scheduler, so the tests
invoke whatever was actually scheduled.

### 2026-08-04 — Embedded Validator PASS for `f37cc0610b49801ded4c1c55575e0bcb92257683` (merged SHA)

Revalidation after reconciling `CLAUDE.md` with the skill files. That commit is
documentation-only and cannot affect runtime, but it changed the tree, and the gate is that `main`
receives a pass for the SHA that was actually deployed — so it was deployed and rerun rather than
waved through.

- Services active, `NRestarts=0` for `picar`, `mavproxy`, `mediamtx`; deployed SHA confirmed, tree
  clean.
- `npm test` on target: **237/237**.
- On-target suite: **26 PASS, 0 FAIL**. `FRAME_CLASS` read back and matched, no unverified
  critical parameters.
- Control surface e2e: **PASS**, with `telemetryConfig` carrying `batteryWarnVolts: 6.8`.
- Invariant 6 on the wire: **6 of 6** DISARM packets preceded by a neutral
  `RC_CHANNELS_OVERRIDE` packet.

This is the SHA that merged to `main`. The limits recorded against the two earlier passes still
apply unchanged: no mechanical actuation was observed (no flight battery, throttle held at 0), the
flight controller still ignores DISARM (existing P0), and the rendered UI was checked by the
operator rather than by a scripted browser drive.

**What the reconciliation fixed**, since it is the reason this SHA exists: `CLAUDE.md` and
`.claude/skills/second-opinion-validator/SKILL.md` disagreed about whether the fallback reviewer
may authorise an invariant-touching merge — and the skill file is the one the pipeline names as the
single authority for fallback conditions, so that was the worst possible disagreement to leave
behind. Three further stale claims went with it: a dangling `/red-team` skill reference I had
introduced, a 46-test count that this merge takes to 237, and `FRAME_CLASS: 2` plus "no
`test/on-target/` suite" both described as present state when this branch fixes both.

### 2026-08-04 — Embedded Validator PASS for `d741a62a9919550d0d417c2458fde4404734fefd`

Revalidation after `batteryWarnVolts` was set to 6.8 V. That commit changed the battery-warning
path, so the earlier PASS for `ca44537` no longer attested the tree. Deployed to rover3 by git
bundle over SSH, `origin` untouched, deployed SHA confirmed equal to the branch tip with a clean
tree.

- **Services** — `picar`, `mavproxy`, `mediamtx` active, `NRestarts=0` each.
- **`npm test` on target** — 237/237.
- **Parameters** — `PARAM_SET FRAME_CLASS=1` → `verified FRAME_CLASS=1`, `parameter overlay
  confirmed by read-back`, 8/8 verified, `missing: []`, `mismatched: {}`.
- **The threshold reaches the operator** — `telemetryConfig` carries
  `batteryWarnVolts: 6.8`, so the UI warns on the same rule as the Fleet Manager status bit.
- **The startup warnability guard is correctly SILENT now**, where before it fired. That is the
  positive and negative case both observed on target.
- **On-target suite** — 26 PASS, 0 FAIL, 1 WARN (the tmpfs tlog, a pre-existing finding).
- **Control surface e2e** — handshake, initial state, arm, 12 commands, `setDrivetrain` rejecting
  `'low'`/`0`/`0.5`/`null`/empty then applying `shift: 1`, operator stop, watchdog firing after
  1000 ms of silence, light on/off, telemetry still arriving with a changing `ageMs`.
- **Invariant 6 on the wire** — **35 of 35** DISARM packets preceded by a neutral
  `RC_CHANNELS_OVERRIDE` packet (steer 1500, throttle 1500), 0.9–59.6 ms earlier.

**Unchanged limits, restated because they travel with this PASS.** No mechanical actuation was
observed — rover3 has no flight battery and throttle was held at 0 throughout. The flight
controller still reports ARMED after a correctly-ordered DISARM (existing P0, untouched by this
branch). The rendered browser UI was not driven by this session; the operator reported checking it
and finding it fine, which is human confirmation rather than a scripted check.

**About the 6.8 V value.** It is 3.4 V/cell against a 2S assumption, and that assumption comes
from rover3's untracked `picar-cfg.local.json`, whose own comment says
`PLACEHOLDER 2S LiPo range ... does not describe a real pack`. The threshold is now in the tracked
config where it belongs, but it should be confirmed against the real pack before it is trusted as
a warn level.

### 2026-08-04 — Embedded Validator PASS for `ca44537fbc5fba66b5ce31271f18699e76ccae97`

`feature/battery-and-radio-telemetry`, validated live on rover3 (Compute Module 4 Rev 1.1,
Debian 13 trixie, Node v20.19.2). Deployed by git bundle over SSH — `origin` was deliberately
not touched. Deployed SHA confirmed equal to the branch tip with a clean tree before the run.

**1. Services.** `picar`, `mavproxy`, `mediamtx` all active, `NRestarts=0` for each.

**2. Journal and parameter read-back.** `Received first Pixhawk heartbeat (sys=1 MAVLink 2)`,
`PARAM_SET FRAME_CLASS=1` → `verified FRAME_CLASS=1`, `parameter overlay confirmed by
read-back`, all **8/8** `EXPECTED_CRITICAL_PARAMS` verified with `missing: []` and
`mismatched: {}`. None of the new overlay failure messages appeared (no REJECTED entry, no
EMPTY overlay, no DISABLED overlay, no unconfirmed overlay).

**3. The FRAME_CLASS reboot question is SETTLED, by measurement.** The two round-8 reviewers
disagreed on whether ArduRover's `FRAME_CLASS` is `@RebootRequired`; an earlier revision of
`TASKS.md` asserted it was, with no source. Decoded from MAVProxy's live tlog, the autopilot's
own HEARTBEAT `MAV_TYPE`:

| Time | MAV_TYPE |
| --- | --- |
| 15:29:43 – 17:15:02 (continuous) | **11 SURFACE_BOAT** |
| 17:15:20 onward | **10 GROUND_ROVER** |

The transition is exactly when the overlay pushed `FRAME_CLASS=1`. **No power-cycle occurred** —
`mavproxy.service` has been up since Aug 03 23:27:53 and only `picar.service` restarted. So it
takes effect live, the reviewer who checked ArduPilot's source was right, and this repo's earlier
claim was wrong. It also proves the defect was real and live: rover3 had been running as a
**boat**.

**4. MAVLink wire verification.** Bidirectional traffic decoded from the tlog:
`RC_CHANNELS_OVERRIDE` outbound from picar (sysId 255, 1434 frames in a 300 KB window), and
inbound from the autopilot (sysId 1) `SYS_STATUS`, `POWER_STATUS`, `SERVO_OUTPUT_RAW`,
`ATTITUDE`, `VFR_HUD`, `RC_CHANNELS` at 288 frames each.

**5. Invariant 6 verified on the wire, not in call order.** Every one of **12** DISARM packets
in the window was preceded by a *neutral* `RC_CHANNELS_OVERRIDE` packet (steer 1500, throttle
1500) 1.0–2.3 ms earlier. This is the check a mock cannot perform: `setServoPWM` only mutates the
channel buffer, so a setter followed by `disarm()` would put DISARM on the link first and neutral
on the next 20 Hz tick.

**6. Control surface end-to-end** (`npm run test:on-target`). Socket.IO handlers driven on
target: a joining socket receives `streamConfig`, `telemetryConfig` (carrying
`telemetryIntervalMs: 1000`) and a first `telemetry` frame; `arm`; 12 `fromclient` commands;
`setDrivetrain` rejecting `'low'`, `0`, `0.5`, `null` and an empty request, then applying
`shift: 1` through the interlock; `disarm`; the input watchdog firing on its own after 1000 ms of
silence; `setLight` on/off. Journal confirms `### FAIL-SAFE STOP (operator stop) neutral=true
disarm=true` and `### FAIL-SAFE STOP (no input for 1000 ms) neutral=true disarm=true`.

**7. Telemetry readings.** Battery 7.95–7.97 V, 82 % marked as voltage-derived (`pctSource:
"voltage"`), board rail 5.163 V, servo rail 6.017 V, Wi-Fi 61–63 %, `radio: null` (correct — no
SiK radio fitted). Battery `ageMs` differs between consecutive frames, so the reading is live
rather than a repeated snapshot.

**8. No regressions.** `npm test` 236/236 on the rover and on the dev host.

#### What this PASS does NOT cover — read before merging

- **No mechanical actuation was observed or implied.** rover3 has no flight battery connected;
  motors and servos cannot move. Throttle was held at 0 for the entire run. Everything above
  validates the command path up to and including the flight controller's response.
- **The rendered browser UI was not driven.** No Chrome browser was connected to the session, so
  the WebUI requirement was met at the Socket.IO protocol level instead. The UI's own formatting
  logic is covered by host tests that execute the real functions out of `socket.html`, but nothing
  clicked a real button in a real browser.
- **The flight controller remains ARMED after a DISARM.** `base_mode=0xc1` with the armed bit
  set, immediately after DISARM packets went out in the correct order. This is the existing P0
  "DISARM does not disarm this flight controller", unchanged and unaffected by this branch — the
  packets are correct and the FC ignores them. It is why nothing here should be read as "the
  vehicle can be stopped".
- **`npm test` on a rover WITH a battery would have driven the vehicle** until `ca44537`. The
  on-target e2e script landed under `test/`, where `node --test` executed it as a unit test. Fixed
  in `ca44537`; worth knowing because it was live for two commits on this branch.

#### Rover3 state at the end of this session

Left on `feature/battery-and-radio-telemetry` @ `ca44537`, clean tree, all three services active
and enabled — **not** on `main`, because the branch cannot merge until Codex reviews it. The
Pixhawk now holds `FRAME_CLASS=1`. Note that deploying `main` to rover3 would push `FRAME_CLASS=2`
back and return it to reporting as a boat. `picar-cfg.local.json` was preserved untouched
throughout.

### 2026-08-04 — Battery/radio telemetry hardened through review rounds 4-8 (branch, unmerged)

Branch `feature/battery-and-radio-telemetry`. **Not merged, and it cannot be merged on the
reviews it has** — see the P0 merge entry in `TASKS.md`. 236 host tests pass (was 173 when the
round-4 work began, 46 on `main`).

**What shipped in these rounds.** `main` was merged into the branch first (`f526f42`): it had
fallen 13 commits behind, so `git diff main..HEAD` reported `main`'s light-control feature as
*deletions* and `main`'s test files produced 9 false failures against the branch's driver. The
driver auto-merged with no conflict, which is the dangerous case — two independent sets of edits
to the MAVLink framing path, and nobody forced to look at them.

Then, in order: the overlay-reassert bound was pinned to the timer schedule the driver actually
schedules rather than to a grep of its source; `sanitizeParamOverlay()` was added because `[]`
in the untracked overlay silently disabled the whole critical-parameter mechanism and a string
crashed the process from inside a `setTimeout`; **`FRAME_CLASS` was corrected from 2 (Boat) to 1
(Rover)** at all three sites; the telemetry publish loop was extracted to `telemetry-loop.js`
and then its `app.js` wiring extracted again to `buildTelemetryWiring()`; the UI status bar
gained an FC indicator that reports unverified/mismatched critical parameters, telemetry
expiry, and `FC: n/a` for the GPIO drivers.

**What the reviews cost, and why that is the useful part of this entry.** Eight rounds ran, and
*every* round found real defects in the previous round's fixes. Cumulatively they found **nine
tests that could not fail** — asserting on source text, asserting the stub the test installed,
tampering with a MAVLink frame without resealing its CRC so the parser rejected it for the wrong
reason, never reaching the branch they named, and one that asserted the defect outright — plus
**two commit messages that claimed mutations were dead when they were not**. The recurring shape
has a name now and it is worth carrying forward: **a correct rule with an untouched consumer.**
Extracting a rule to make it testable does nothing for its call site, and three times on this
branch the call site was where the defect lived.

**Reviewer record.** Rounds 1-6 and 8: `opus-fallback` (Codex reports `ERROR: Your workspace is
out of credits.`). Round 8 additionally: a **Fable 5 red team** — the only different-model-family
review this branch has had, and it found a survivor the fallback missed (the loop could schedule
a no-op instead of its tick). No commit on this branch carries a `Reviewed-by:` trailer, which is
honest: no review has cleared it.

**Known limitation, stated rather than claimed closed.** `app.js` has no test file, so its three
remaining one-line call sites survive their mutations. Every rule they invoke is tested; the
invocation is not.

**Open question to settle by measurement, not argument.** The two round-8 reviewers disagree on
whether ArduRover's `FRAME_CLASS` is `@RebootRequired`. If it is, read-back confirms the *stored*
and not the *active* value, and a validation pass on this branch would be unearned. The test is
in `TASKS.md`: set it, read it back, and watch whether the HEARTBEAT's `MAV_TYPE` changes from
`SURFACE_BOAT` to `GROUND_ROVER` without a power-cycle.

**Two findings unrelated to this branch, found while validating it.** MAVProxy's tlog grows
without bound in **tmpfs** — 412 MB of RAM after 17 h on rover3, filling in roughly a week. And
`/var/log/mavproxy/mav.tlog` is a *stale* file from an earlier configuration; an on-target check
that read it reported a healthy MAVProxy as wedged, which is the same misdiagnosis, in the same
direction, as the 2026-08-03 incident below. Both are in `TASKS.md`.

**New on-target script.** `test/on-target/telemetry.sh` — services and restart counts, journal
evidence including the overlay's new failure messages, `/status` shape, critical-param read-back,
MAVLink liveness (derived from the unit's real `--logfile`, not a guessed path), wedge signatures,
and a two-sample freshness check that a frozen snapshot cannot pass. Read-only: no restarts, no
config changes, no root.

### 2026-08-03 — MAVProxy wedged and took the control path with it

Not a code change — an incident worth recording, because it cost an hour of misdirected
diagnosis and it will look like a software regression when it recurs.

Steering and throttle stopped responding. They were **not** broken by any picar change: the
identical failure reproduced on `main`, which contains none of the light work — picar commanded
`ch1=1200` and the flight controller held `servo1` at 1500 in both cases.

The cause was **MAVProxy wedging**. It was `active` with `NRestarts=0` and had simply stopped
reading its socket: 113 KB backed up on picar's live connection, 2.1 MB stranded in a
`CLOSE-WAIT` socket it never reaped, and `/tmp/mav.tlog` frozen for 70 minutes. Overrides were
being written into a dead socket. A reboot of the Pi cleared it.

**Two lessons worth more than the fix.**

*Every layer claimed success.* `sendPacket()` returned true, the 20 Hz loop logged normal
override values with `client=true`, no fail-safe fired, `/status` was healthy. picar cannot
currently tell "the vehicle is following my commands" from "I am writing to a socket nobody
reads". Filed as a P0.

*A frozen tlog reads exactly like live data.* Every `SERVO_OUTPUT_RAW` value examined during the
first hour was a stale snapshot from 22:03, which is why successive tests contradicted each other
and why one apparently showed the light not responding. Any tlog analysis must first confirm the
file is still growing — check `stat -c %s` twice, or mark the offset before the test and parse
only bytes written after it. That marking technique is what finally exposed the problem: a test
that wrote **zero** new bytes.

The operator also suspected a short after wiring a relay, which was a reasonable read given the
timing. It was not — but the safe order (power down, unplug the new hardware, meter the rail
before re-powering) is the right response to that suspicion regardless.

### 2026-08-03 — `feature/light-control` — BLOCKED ON HARDWARE, software complete

> **The fitted light module cannot be switched by any signal, so this feature cannot
> work as wired.** The module is a **Traxxas 8028 "Regulated 3-Volt LED Light Power
> Supply"** — a pure voltage regulator with **no control input**. Traxxas: it "plugs
> directly into the accessory tap on the XL-5 HV speed control to provide a regulated
> 3-Volt output for LED lights." Energise it and the LEDs are on; there is no channel
> to listen to. It is connected power-only to the Pixhawk servo rail, so nothing is
> attached to output 6 at all.
>
> **To switch it, its POWER must be switched**, which needs a component between the
> rail and its power lead. The Pixhawk cannot do this directly — a servo output's
> signal pin sources a few mA at 3.3 V, and wiring the module's power lead to a
> signal pin risks the flight controller. Two options:
>
> - **An RC PWM switch module** reading MAIN 6 and switching the rail feed. **No
>   software change** — the existing 1000/2000 µs swing is what such a module expects,
>   and `light_on_us` / `light_off_us` are configurable if it wants a different pair.
> - **A relay/MOSFET board on a GPIO**: `SERVO6_FUNCTION = -1`, a relay defined on
>   that pin, driven by `MAV_CMD_DO_SET_RELAY` rather than an RC override. The
>   supported ArduPilot path for on/off loads, but it changes the control mechanism,
>   so both the driver and the handler change.
>
> Also worth checking: Traxxas publish no input current figure for the 8028, and it
> now draws from the servo rail that also feeds the steering servo.

### 2026-08-03 — `feature/light-control` — command path verified to the flight controller

Web control for a light module on **Pixhawk output 6**, driven by RC channel 6
passthrough (`SERVO6_FUNCTION: 1`) from a Light button in the controller UI.

**Verified on rover3 at SHA `45a9e0b`, on the MAVLink wire — to the flight controller
output only.** An earlier version of this entry, and the session summary, said "it
works". That overstated it: what was verified is the command path up to output 6.
The lamp itself was never observed and could not be, which is exactly the distinction
`CLAUDE.md`'s validation rules exist to keep straight. The light did **not** in fact
turn on — see the blocker above.


| | `RC_OVERRIDE` ch6 (commanded) | `SERVO_OUTPUT_RAW` servo6 (flight controller) |
| --- | --- | --- |
| Light ON | 2000 | **2000** |
| Light OFF | 1000 | **1000** |

Throughout both toggles `servo1` (steering) held 1500 and `servo3` (throttle) held
1500 — switching the light never perturbed a motion output. The full Socket.IO path
was exercised as the browser uses it (EIO=4 over WebSocket): the server pushed the
initial `lightState` on connect, broadcast it on each change, logged `Light: ON` /
`Light: OFF`, and **rejected a non-boolean** with no state change and no broadcast.

**Not reviewed by Codex**, on explicit operator instruction — this was a
does-it-work check on new hardware. Recorded plainly rather than with a
`Reviewed-by` trailer, since the trailer is the only durable record of whether the
gate ran.

Design notes for whoever touches this next: the light is its own socket event rather
than a `fromclient` field (so it cannot be combined with motion in one packet, or
replayed at 20 Hz); it does **not** go through the drivetrain neutral+disarm
transaction, because a light is not a mechanical actuator working against the
driveline; and a fail-safe deliberately **leaves it on**, because an operator who has
just lost control wants the vehicle to stay visible. That last one is pinned by test.

**A diagnostic trap worth knowing.** `SERVO_OUTPUT_RAW` orders its fields by
DESCENDING SIZE, so `port` is the **last** byte, not the second field — `servo6_raw`
is at offset 14, and `servoN_raw` at `4 + (N-1)*2`. Reading it as though `port`
followed `time_usec` put every servo one byte out and reported servo6 as `3`/`7`.
That looked exactly like "the light does not work". Same rule the telemetry branch's
field-offset comments exist for.

### 2026-08-03 — `test/driver-safety-gaps`

Closes the driver half of the coverage gap the 2026-08-03 mutation pass exposed. Tests only —
no runtime file is touched. Suite goes **46 → 58**.

Adds `test/driver-safety-gaps.test.js` and strengthens three tests in
`test/drivetrain-safety.test.js` that were passing vacuously:

- **`setServoPWM`'s `Number.isFinite` guards were only ever exercised through `shift`.** The raw
  guard at `pwm_mavproxy_servo.js:243` runs *first*, but the `DISCRETE_CHANNELS` endpoint check at
  `:251` is a **fallback** that also rejects every non-endpoint value — so deleting the guard left
  the shift tests green. A continuous channel has no such fallback: it stores `NaN`, which a
  `Uint16Array` coerces to 0 and `buildRCOverride:346` encodes as the 65535 *release-override*
  sentinel. Now covered on `throttle` and `steering` directly.
- **Nothing invoked `_connect()`, and nothing drove the `close` handler.** The old reconnect test
  hand-wrote the sequence it claimed to verify — *including* the `this.client = null` that
  production does — so both could be deleted with the suite green. Now the real `_connect()` runs
  against fake sockets and the real `close` handler is driven by emitting `'close'`, covering all
  four things that handler owns and the automatic 2 s retry.
- **Four vacuous assertions replaced:** `typeof … === 'boolean'` on `setServoPWM` and `disarm` (a
  stub returning a constant satisfied both); `notEqual(shift, 1500)` where the constructor default
  is already 2000, so it held *before* the refused call ran; and `sendPacket`'s destroyed-socket
  guard, which was only reachable through a fake whose `write()` threw, letting the `try/catch`
  stand in for the guard.

**Verified by mutation — 13 mutants, each applied individually with the tree restored after every
run, all now caught.** Counts are the observed `not ok` totals from *these* patches; a differently
shaped patch for the same intent yields different counts, so treat the kill as the result and the
number as provenance:

| Mutant | Failures |
| --- | --: |
| remove raw `isFinite` guard (`:243`) | 2 |
| remove post-scale `isFinite` guard (`:259`) | 1 |
| remove **both** guards | 2 |
| disable `DISCRETE_CHANNELS` endpoint check (`:251`) | 2 |
| delete `sendPacket`'s destroyed/missing-client guard (`:176`) | 2 |
| `_connect`: no `neutralizeAndDisarm()` (`:149`) | 2 |
| `_connect`: no `startLoop()` (`:150`) | 2 |
| `_connect` callback throws (must fail, not hang) | 4 |
| `close`: client not released (`:166`) | 2 |
| `close`: override loop not stopped (`:167`) | 1 |
| `close`: heartbeat not stopped (`:168`) | 1 |
| `close`: retry not scheduled (`:169`) | 1 |
| `setServoPWM` constant-`false` stub | 4 |

**Three process notes, each a real trap:**

1. The first `net.createConnection` stub invoked the connect callback **synchronously**, hitting the
   temporal dead zone on `_connect()`'s `const socket = …` and throwing `ReferenceError`. Real
   sockets fire `connect` on a later tick, so the stub defers via `setImmediate`.
2. That deferred callback must settle its promise **even when it throws**. With a bare
   `onConnect(); resolve();` a throwing callback left the promise pending, `await settle()` never
   returned, and the suite **hung instead of failing** — indistinguishable from a pass unless you
   check the exit code. It now rejects.
3. The `close` handler's retry is a bare `setTimeout(…, 2000)` that **nothing tracks**, so a test
   driving `close` cannot cancel it. If it fires after the helper restores the real `net` module it
   opens a genuine socket to `127.0.0.1:5760`, and the resulting `ECONNREFUSED` → close → retry
   loop hangs the runner forever. Cleanup now parks a truthy `d.client` so `_connect()`'s
   existing-client guard swallows any escaped retry. This was found the hard way: mutating away the
   close handler's interval-clearing made the run hang rather than report its failure.

Every mutation run is wrapped in a hard `timeout` that reports `HANG` distinctly from a failure
count, because the two are otherwise indistinguishable and a hang reads as success.

**Reviewer: `codex`, two rounds.**

*Round 1 returned NEEDS-CORRECTION with 6 findings, 2 HIGH, all accepted and fixed.* The important
one is finding 1: it applied a mutant this session had not thought to try — deleting
`this.client = null` from the close handler — and **all 55 tests stayed green**, because the
then-current "reconnect" test performed that assignment *itself* instead of letting the close
handler run. The test was verifying its own scaffolding. It also found that a throwing connect
callback hung the suite rather than failing it, that the corrupt-range prose overstated the channel
state, that `TASKS.md` still listed the survivors this branch fixes as open work, that three
recorded mutation counts were wrong, and that the guard-order explanation was backwards.

*Round 2 verified every substantive fix independently* — reproduced 2/1/1/1 on the close-handler
lines with no hangs, 4 failures on the throwing callback with no hang, both corrupt-range buffer and
wire arrays exactly, `channelNeutralUs = {steering: 0, throttle: 0}`, that JSON rejects non-finite
literals, that all five remaining `app.js` mutants still pass 58/58, that the new `sendPacket` tests
are behavioural rather than tautological, and that the parked-sentinel cleanup masks nothing and no
test asserts against it. It reproduced 12 of the 13 recorded counts exactly; the thirteenth
(removing both finite guards) gave 5 rather than 2 under its own patch shape, which the recorded
caveat covers — the mutant is killed either way.

*Round 2's two remaining findings were documentation accuracy only* — `HANDOFF.md` abbreviated the
measurement arrays that `TASKS.md` quoted in full, and this entry contradicted itself on the suite
total (46 → 55 versus 46 → 58; it is 58). Both fixed above and re-verified mechanically. No third
round: neither touched code or a substantive claim, and both are checkable by reading the file.

Two honest process notes. Twice during this work a mutation was reported as "0 failures" when the
substitution had silently **not applied** — a `grep -F` pattern matched the constructor's
`this.client = null` rather than the close handler's, and another had wrong indentation. A no-op
patch and a surviving mutant produce identical output. Mutations are now applied by line number and
the mutated line is echoed back for confirmation.

**Validation: PASS** — rover3, 2026-08-03 18:2x BST.
**Validated SHA: `d59b32ba` (`test/driver-safety-gaps`).**

Validated **without changing rover3's checkout**, on operator instruction that the rover stay on
`feature/battery-and-radio-telemetry`. Because the branch touches zero runtime files, the entire
substance of it is whether the suite passes under the rover's Node, so the tests were copied to
`~/picar-testrun` on rover3 and run there against a symlinked `node_modules`. No service was
restarted, no branch was checked out, and the directory was removed afterwards.

- *On-target result:* **27/27** driver tests under the rover's Node **v20.19.2**, run twice — once
  against rover3's live `feature/battery-and-radio-telemetry` driver and once against `main`'s
  driver (sha256 `3bbb52a41c58d6a7…`). Identical.
- *Host suite:* 58/58 on the workstation (Node v22.22.1).
- *rover3 after:* branch `feature/battery-and-radio-telemetry` @ `a979b59`, clean tree, `picar` /
  `mavproxy` / `mediamtx` all active with `NRestarts=0`, `/status` reporting battery 7.934 V and 7
  params verified. Unchanged throughout.
- *Not done, deliberately:* no MAVLink wire capture, no WebUI drive, no fail-safe trip. There is no
  new runtime behaviour to exercise — `git diff --name-only main..d59b32b` is two test files and the
  two tracking documents. No arming attempted; no actuation is possible with the flight battery
  disconnected.

**The same run answered a merge question.** All 27 tests pass unchanged against the telemetry
branch's driver — verified first in a throwaway local worktree, then on the rover itself. So these
tests survive the eventual `feature/battery-and-radio-telemetry` merge and do not depend on `main`'s
driver shape.

**New defect found while writing the config test**, filed as P1 in `TASKS.md`: a truthy-but-invalid
`pwm_min_us`/`pwm_max_us` makes `this.neutral` `NaN`, so the channels that fall back to it
initialise to 0 and the wire carries the 65535 release sentinel. The effect is channel-specific,
because only some initialisers fall back to `this.neutral`. Measured in full:

```
pwm_max_us: 'x'   buffer [0,0,0,0,1000,0,0,0]
                  wire   [65535,65535,65535,65535,1000,65535,65535,65535]
pwm_min_us: 'x'   buffer [0,2000,0,2000,0,0,0,0]
                  wire   [65535,2000,65535,2000,65535,65535,65535,65535]
both cases        channelNeutralUs = {steering: 0, throttle: 0}
```

**Both motion channels go to 65535 either way**, and because `channelNeutralUs` is
`{steering: 0, throttle: 0}`, `neutralizeAndDisarm()` transmits the release sentinel on exactly the
two channels it exists to centre. `NaN` is harmless because the `|| default` idiom rescues it, and
`Infinity` is not expressible in a JSON config, so the practical vector is a truthy non-numeric.

### 2026-08-03 — `chore/reconcile-tracking-docs`

Documentation only — zero runtime files. Reconciles the tracking documents against a full
verified read of `main` @ `4580209`. No behaviour changes.

The tracking documents had drifted far enough to actively mislead, which matters because the
pipeline uses them as its map. What was wrong:

- **~20 line-number citations in `TASKS.md` pointed at the wrong code.** `pwm_mavproxy_servo.js:602`
  is past EOF (the file is 577 lines); `control-safety.js:94` and `:160` name a file that does not
  exist on `main`; `app.js:113`/`:136`, `fleetmgr-client.js:139`, `fleet-manager/server.js:96`,
  `socket.html:1409` and others were simply off. Every citation in the rewritten file was
  re-verified by opening the line.
- **Four entries described the archived branch, not `main`**, and two were refuted outright — the
  "500 ms window where the safety layer believes it is armed" (no `controlEnabled` exists on
  `main`) and "command rejections are never reported" (no `handleCommand` exists). Deleted.
- **Three entries were already done** — the `/24` discovery sweep (fixed by `SweepBackoff`), the
  h264 frame-drop hardware validation, and "prove MAVLink read-back works on this Pixhawk"
  (answered by the telemetry branch). Deleted per `TASKS.md`'s own contract; their record is here.
- **`CLAUDE.md` contradicted itself and the code**: it said `main` had no `test/` suite (it has
  46 tests), stated `FRAME_CLASS=1` while the code pushes `2` in three places, listed
  `control-safety.js` in the topology diagram and module table as if it were on `main`, described
  `isSafetyReady()` as existing, and named config keys (`mavproxy_allow_unverified_arm`,
  `max_command_*`) that exist nowhere on `main`.
- **`HANDOFF.md` headed a merged branch "NOT MERGED"** and carried two contradictory validation
  records in one section, the superseded one left below its own "Superseded" line.
- **`README.md`** was wrong about board, OS, Node version, install command, run command, and
  systemd unit, and described a generated file as editable.

Added, because they were missing entirely: a table in `CLAUDE.md` recording **which of the ten
safety invariants actually hold on `main`** — **five not implemented** (1, 2, 4, 7, 8), **one
violated** (3), **four partial** (5, 6, 9, 10), and **none fully holding** — and the fact that
**no CI runs `npm test`**.

`.claude/skills/auditor/SKILL.md` had adopted two of the bad citations as its worked example of a
well-formed finding, so the audit tooling was propagating them — corrected.

**New defects found while verifying, now filed in `TASKS.md`:** a proven unauthenticated RCE via
`setVideoParams` YAML injection, a missing Socket.IO Origin check that makes the control plane
drive-by reachable, stored XSS in the Fleet Manager dashboard, a pre-loadable channel buffer that
lunges on arm, two ways the input watchdog is defeated (window blur latching held keys, and the
hidden-tab timer clamp tying `input_timeout_ms`), every fail-safe being a silent no-op on
non-mavproxy drivers, `arm()` force-arming with `21196`, and `install.sh` being destructive on
re-run. Also recorded: **8 of 23 mutations survive the test suite**, because `app.js` has no test
file at all.

**Reviewer: `codex`** (codex-cli 0.146.0, `model_reasoning_effort=high`, read-only sandbox).
Returned "must go back for correction" with **6 blocking findings, all real, all fixed before
commit**:

1. `TASKS.md` cited `README.md:188` for the "ships no certificates" claim — but this very diff
   rewrote that section, so the citation was stale on arrival. **The change invalidated its own
   citation**, which is precisely the defect the branch exists to fix.
2. `pwm_sysfs_servo.js:54` supported only half its sentence; the ignored channel configuration is
   established at `:20`/`:30`/`:49`.
3. The Codex re-review entry claimed none of the three fallback-reviewed branches touches an
   invariant. **False and dangerous** — `6675341`'s own commit body says its `RC_OVERRIDE_TIME`
   overlay write *is* fail-safe timing, touches invariant 6, and "must not merge until Codex
   reviews it". As written, the entry could have authorised exactly the merge that commit forbids.
4. Two archive defects were deleted as "refuted" when they are **real on the archive branch** and
   only mis-scoped to `main` — the ~500 ms armed-but-dropping window (archive
   `pwm_mavproxy_servo.js:83`/`:602-607` vs `control-safety.js:160`) and the discarded
   `handleCommand()` result (archive `app.js:136-138`). Since these documents now advise
   cherry-picking from that branch, deleting the warnings lost real information. Restored as
   cherry-pick prerequisites.
5. Fixing `README.md` left three other documents asserting that `README.md` is wrong about the
   board — a **new** cross-document contradiction created by the fix itself.
6. The summary count of the new invariant table was wrong (it is five not-implemented, one
   violated, four partial, none holding — not "4/5/1").

Accepted non-blocking corrections: the telemetry branch needs **no rebase** (`6675341`'s parent
*is* `4580209`, and `git rev-list 6675341..main` is empty — my "four merges have landed since" was
wrong); `pwm_libgpiod` spawns **~200** `execSync`/s, not 400 (50 Hz × 2 channels × 2 edges);
`pigpiod` has no latched output to leave behind because it never applies a command at all; the
dashboard `href` *is* quoted (still exploitable, since the value is unescaped); Ctrl-C on a manual
`node app.js` does deliver `SIGINT`, so the shutdown claim was overstated; and "the only thing
satisfying the heartbeat branch" was too absolute, since the CRC-less parser can synthesise a bogus
msgid-0 frame from any `0xFE`-aligned bytes.

Codex could not run `npm test` itself (two video tests write YAML under `/tmp`, which fails
`EROFS` in its read-only sandbox — an environment restriction, not a regression). Verified here
instead: **46/46**.

**Validation: PASS** — rover3, 2026-08-03 17:53–17:57 BST.
**Validated SHA: `268561f0dd73dcc39b3737460103372d51b7b58c`** (deployed by git bundle).

Markdown-only (`git diff --name-only main..268561f` → five `.md` files, zero runtime files), so
this proves the rover is healthy on the deployed SHA rather than exercising new behaviour.

- *Services:* `picar`, `mavproxy`, `mediamtx` all active, `NRestarts=0` after restart.
- *Startup:* clean — `Applied local overrides…`, `Rover ID: 3`, MAVProxy driver at 20 Hz,
  `Stream codec: webrtc`, web server up. No error or refusal lines.
- *Host suite on-target:* **46/46** under the rover's Node **v20.19.2**.
- *Endpoints:* `/status` → `{"status":"OK","throttle":0,"steering":0}`; `socket.html` 200;
  `socket.io` polling 200; WHEP `:8889` 204.
- *Wire:* `RC Override: ch1=1500 ch2=2000 ch3=1500` streaming — steering and throttle neutral,
  ch2 at the configured `shift_default_us` (2000 = low gear, wiring reversed).
- *No arming attempted. No actuation is possible — the flight battery is disconnected.*

**Three findings came out of the wire capture, and they matter more than the doc change.** Because
this branch runs `main`'s code, the capture is direct evidence about `main`:

1. **Zero of nine `PARAM_SET` writes were ever verified** — confirming live that `main`'s v1-only
   parser discards every reply. Nine `PARAM_SET` lines, zero `verified`, zero `WARNING`.
2. **`main`'s "Received first Pixhawk heartbeat" is picar seeing its OWN heartbeat echoed back.**
   Parsing MAVProxy's tlog by protocol version: **8391 v2 (`0xFD`) frames vs 2003 v1 (`0xFE`)**, and
   1907 of the v1 are picar's own outbound `RC_CHANNELS_OVERRIDE`. Heartbeats break down as
   `v1 sysid 255 comp 0 type 6 autopilot 8` (exactly what `buildHeartbeat()` emits — picar's own),
   `v2 sysid 255 comp 230 autopilot 8` (MAVProxy's GCS heartbeat) and
   `v2 sysid 1 comp 1 type 11 autopilot 3` (the real Pixhawk). Since `main` accepts only v1, the
   *only* v1 heartbeat it can see is its own. This is sharper than the previous note in this file,
   which guessed it was MAVProxy's.
3. 🔴 **DISARM does not disarm this vehicle.** One `COMMAND_LONG ARM_DISARM` (`param1=0`,
   `param2=21196`) went out at 17:53:32 and reached the wire; the flight controller then sent
   **222 consecutive HEARTBEATs, all `base_mode 129` (`SAFETY_ARMED`), never once unarmed**, and
   never ACKed command 400. Every software layer reported success. Filed as a new P0 in `TASKS.md`;
   diagnosing it needs COMMAND_ACK parsing, so it is gated behind the telemetry-branch merge.
   **Assume any rover may be armed at any time.**

Finally, restoring rover3 to `a979b59` produced a clean A/B on the same hardware minutes apart:
`main` verifies **0** critical params and exposes no telemetry, while the telemetry branch returns
all **7** verified with `missing: []` plus live battery, board/servo rail and WiFi figures. That is
the strongest argument yet for landing that branch — subject to the Codex review its own commit
body requires.

**Rover left on `feature/battery-and-radio-telemetry` @ `a979b59`** — the state it was found in —
clean tree, all three services active, `NRestarts=0`, `/status` responding.

### 2026-07-31 — `perf/bound-video-latency` — **MERGED** at `4580209`

Bounds video latency and stops the video path from starving the control path. Merged to `main` as
merge commit `4580209`, which is `main`'s current tip. (This header read "NOT MERGED" until
2026-08-03; the branch had already landed. `git branch --merged main -a` lists it.)

- `fleetmgr-client.js`: failed Fleet Manager discovery sweeps now back off exponentially from
  the tick interval to a 5-minute ceiling.
- `streams/webrtc.js`: mediamtx restart moved from `execSync` to `spawn`, with coalescing of
  restarts requested while one is in flight and child cleanup on `stop()`.
- `streams/h264.js` / `streams/mjpeg.js`: frames are dropped when a client's socket backlog
  exceeds a configured budget rather than queued without bound. h264 keeps keyframes through a
  moderate backlog so a client can still resync; only a hard backlog drops everything. Drops
  are logged at most every 5 s.
- Both parse buffers are bounded and resync rather than growing until the process dies.
- The drop rules, the fan-out loops, `NalParser`, the JPEG framing, and the backoff schedule are
  all exported so tests exercise the real logic rather than a reimplementation of it. This change
  adds **31 tests** (the suite total is 46, including the 15 pre-existing drivetrain tests) —
  among them a 300-case fuzz over random streams with random multi-chunk splits, and
  split-at-every-boundary tests for both the NAL and JPEG framing.

**A pre-existing framing bug was found and fixed.** `NalParser._extractOne` discarded the
ENTIRE buffer when no start code was found, so a 4-byte start code straddling a chunk boundary
was thrown away, corrupting the framing of the next access unit. Found by the byte-exact
split-at-every-boundary test, confirmed by mutation. This affected `main`, not just this branch.

**CORRECTION — an earlier claim in this repo was wrong by ~2 orders of magnitude.** `TASKS.md`
carried, as a P0, that `execSync('systemctl restart mediamtx')` "freezes the Node event loop for
seconds", so the input watchdog could not fire. Measured directly on rover3, five trials:
**85 ms mean, 100 ms max.** The 1000 ms watchdog was never actually at risk. The async change is
still correct — unbounded synchronous work reachable from a socket handler is a defect, and
`systemctl` blocks until the unit's job completes, so a unit slow to terminate could block for
its full stop timeout — but it is a robustness fix worth ~85 ms, not the emergency it was
recorded as. The P0 has been removed rather than reworded, because it was wrong.

**Validation: PASS** — rover3, 2026-07-31 18:27 BST.
**Validated SHA: `ba796d6b1f71d3eec22a662678b27d04c5bff901`**

- *Reviewer:* `opus-fallback`. Codex did not run; verbatim: *"Your workspace is out of credits."*
  The review returned NEEDS-ATTENTION and ran 9 mutations against the previous tip, of which
  **5 survived** — including inversion of the drop gate at BOTH call sites, and replacing `spawn`
  with a fully synchronous `execFileSync` while the test literally named "does not restart
  mediamtx synchronously" still reported `ok`. Every finding on its minimum-to-ship list was
  fixed, and **all nine mutations are now caught** (re-verified individually).
- *Host suite:* 46/46 on-target under the rover's Node v20.19.2 (31 added by this change).
- *Services:* all active, `NRestarts=0`, `/status` OK, WHEP 204.
- *Fleet backoff:* progression 5→10→20→40→80→160→300 s observed live, capping and resetting
  correctly. Idle CPU **6.90% → 3.47% of one core (2.0x)**.
- *THE DROP PATH IS NOW VERIFIED ON HARDWARE.* rover3 was temporarily switched to
  `stream_codec: "h264"` through the untracked per-rover overlay (mediamtx stopped to free the
  camera; both reverted afterwards, overlay back to identity-only). A WebSocket client received
  **165 frames / 11 keyframes / 403 kB**, confirming the path runs. With the threshold forced low,
  the server logged `dropped 149` and `dropped 150 stale frame(s)` while the client received
  **29 frames, all 29 keyframes** — proving the keyframe-priority rule works on real hardware:
  deltas shed, keyframes still delivered, picture recoverable.
- *A NEGATIVE RESULT THAT MATTERS.* With the **default** thresholds, stalling a client's socket
  for 12 s produced **no drops at all**. This confirms finding F3 empirically: `ws.bufferedAmount`
  counts only userspace queueing, so a multi-megabyte kernel socket buffer sits underneath the
  threshold invisibly. On a local link the defaults are effectively unreachable. Latency is
  bounded rather than unbounded — the mechanism is real and works when it engages — but **not by
  the configured amount**, and on loopback it does not engage. Filed in `TASKS.md`; the fix is a
  small `SO_SNDBUF`/`writableHighWaterMark` on the accepted socket, or gating on an enqueue
  timestamp instead of a byte count.
- *Not tested:* the mjpeg path on hardware (host tests only, including split-at-every-boundary).

The earlier partial validation of `781d56a` that used to sit here has been **deleted** — it was
left in place below its own "Superseded" line, so this entry carried two contradictory validation
records at once, one of them for a SHA that is not an ancestor of `main`. Two facts from it are
worth preserving:

- *A withdrawn figure.* Commit `bc1cd71`'s body quotes `/status`-gap numbers (121 ms vs 61 ms) as
  its central measurement. **Those are withdrawn** — the probe could not distinguish the two
  builds and is dominated by ordinary event-loop jitter. The real figure is the direct `execSync`
  timing: 85 ms mean, 100 ms max over five trials. Anyone reading `git log` without this file
  would otherwise take the discredited number as fact.
- *Parser benchmark* (workstation, not rover): large access units 2.1x faster at 64 kB, 4.7x at
  256 kB, 8.9x at 1 MB. Real access units are a few kB, so the practical win is on large
  keyframes, not typical frames.
### 2026-07-31 — `chore/adversarial-review-fallback`

Adds the operator-requested rule: when Codex cannot run, adversarial review falls back to
Opus 5 rather than the pipeline stalling or the stage being silently skipped.

- `CLAUDE.md` pipeline stage 3 documents the fallback, defers the permitted-condition list to
  the skill (single authority), and sets two hard limits.
- `.claude/skills/second-opinion-validator/SKILL.md` holds the conditions: default-deny, only
  `out of credits` / auth failure / CLI-or-plugin missing, and **a timeout is explicitly not
  one** — foreground Codex times out on multi-file diffs, so a timeout trigger would let an
  author reach the friendlier reviewer with no dishonesty at all.
- **The bright line is information, not exit status:** once any Codex finding for a diff has
  been seen, the fallback is unavailable for that diff however Codex terminated. Keying it to
  "returned cleanly" would route crash-after-findings to a second reviewer after the author had
  already seen the first one's objections.
- **The fallback does not clear a change touching the ten safety invariants.** It runs and its
  findings must be addressed, but that merge waits for Codex. `CLAUDE.md` accepts the
  evidence-commit exemption because its alternative is *unachievable*; the alternative here is
  *wait for credits*, which is achievable, so it does not meet the same bar. Hygiene,
  performance and documentation work — where stalling actually hurts — is cleared normally.
- New `.claude/agents/adversarial-reviewer.md`: Opus, isolated context, no rover access. It
  derives the diff itself rather than trusting the dispatch prompt, must establish a green
  `npm test` baseline before mutating anything, and follows an explicit
  mutate / restore / verify-clean protocol.
- Git workflow now requires a **`Reviewed-by: codex`** or **`Reviewed-by: opus-fallback`**
  commit trailer. Prose in this file is rewritten by every later change; a commit object is not,
  so the trailer is the only durable record of whether the gate was honoured and by whom.

**Also corrected a false statement `CLAUDE.md` carried twice:** that `main` has no `test` script
and no `test/` directory. It has both, and `npm test` passes 15/15 on `main`. That error would
have disabled the new reviewer's highest-value check — a reviewer who believes there is no suite
does not mutation-test.

**Reviewer: `opus-fallback`.** Codex did not run; verbatim: *"Your workspace is out of credits.
Ask your workspace owner to refill in order to continue."* This is the first exercise of the new
rule, on the change that creates it.

The fallback returned **NEEDS-ATTENTION with 10 findings, 2 HIGH**, and the whole
minimum-to-ship set was accepted and fixed before commit: the timeout defeat path, the
permissive enumeration, the two documents disagreeing on the trigger set, the non-binding
safety-invariant mitigation, the read-only-versus-mutation contradiction in the agent file, the
missing green-baseline instruction, and an invariant count reading "eight" in two files where
`CLAUDE.md` defines ten. It also ran a real mutation test — inverting the fail-safe wire order in
`pwm_mavproxy_servo.js` — which the suite **caught** (3 of 15 failing, by name), then restored
the tree clean. That is evidence the fallback path does useful work, not merely that it runs.

**Validation: PASS** — rover3, 2026-07-31 17:49 BST.
**Validated SHA: `69ffc1bc2df529a408e4242070f6e074462a4fb8`** (deployed by git bundle).
Markdown-only (`git diff --name-only main..69ffc1b` → zero runtime files), so this proves the
rover is healthy on the deployed SHA rather than exercising new behaviour. All services active,
`NRestarts=0`, 15/15 host tests under the rover's Node v20.19.2, zero error lines in the startup
window, `Rover ID: 3`, `MAVProxy: Sending DISARM` on connect, `/status` OK, `socket.html` 200.
No arming attempted; no actuation is possible with the flight battery disconnected.

### 2026-07-31 — `fix/drivetrain-change-safety`

Made a drivetrain change a gated server-side transaction. Addresses the operator-reported P0
where selecting high gear engaged throttle unstoppably.

- Moved gear/diff changes out of the `fromclient` control stream into a `setDrivetrain` event
  handled server-side. A browser-side interlock was decorative: this control plane is
  unauthenticated, so any client or a second tab could send `{throttle: 1, shift: -1}` in one
  packet and shift at full throttle.
- Added `neutralizeAndDisarm()` to the driver, which transmits a neutral RC_CHANNELS_OVERRIDE
  packet and only then COMMAND_LONG DISARM, and routed operator stop, input timeout, process
  shutdown and MAVProxy reconnect through it. Fail-safe order is a wire property; `setServoPWM`
  only mutates a buffer.
- Drivetrain channels now accept only their endpoints. `shift: 0` — and `[]`/`null`, which
  coerce to 0 — previously parked the shift fork at 1500 us, half-engaged.
- Fixed `arm()` scheduling its ARM packet on an untracked `setTimeout`: a fail-safe sent DISARM
  and the vehicle re-armed itself 500 ms later with no operator action.
- Moved the keyboard gear shortcut off the bare Shift modifier to KeyG, ignoring auto-repeat,
  modifiers, and keystrokes while a modal or form control has focus.
- Added `drivetrain_settle_ms` (default 1000) between the disarm and the actuation.
- `setServoPWM`, `disarm()` and `sendPacket()` now report applied/dropped instead of returning
  `undefined`.

Two rounds of Codex adversarial review. The first found the interlock was client-side only and
bypassable, that `shift: 0` was accepted, that DISARM still preceded neutral, and that the
tests asserted source text vacuously — all accepted and reworked. The second confirmed those
fixes hold (it mutation-tested the packet-order assertion) and found four more, of which the
pending-ARM leak and the `disarm() !== false` false-success were real bugs and are fixed here.

**Validation: PASS** — rover3, 2026-07-31 16:0x BST.
**Validated SHA: `c6043d7e8cbdc292cb8b861800770354df3c3952`** (deployed by git bundle).

- *Host suite on-target:* 15/15 under the rover's Node v20.19.2 (not just the workstation's
  Node 22). Services active, `NRestarts=0`.
- *Reconnect disarm:* `MAVProxy: Sending DISARM...` now appears on connect.
- *Integration, over the real Socket.IO protocol:* 8/9 checks passed —
  `shift` in the `fromclient` stream is ignored (ch2 unchanged); `setDrivetrain` refuses `0`,
  `0.5`, `'abc'` and an empty request; the ack returns after 1013 ms, confirming the settle
  dwell; throttle stayed neutral throughout. The one FAIL was a defect in the throwaway test
  script, not the code: it read the driver's `RC Override` log line, which prints only once
  every 5 s, so a 1.5 s read saw a stale line. Re-verified on the wire instead.
- *MAVLink wire verification:* `RC_OVERRIDE` ch2 took values [1000, 2000] and
  `SERVO_OUTPUT_RAW` servo2 followed to [1000, 2000] — the flight controller really drove the
  output, and the bench test servo on output 2 physically moved. `SERVO_OUTPUT_RAW` servo3
  (throttle) held **1500 throughout**. The RC_OVERRIDE packets immediately preceding each
  DISARM all carried neutral throttle, confirming neutral-before-disarm on the wire.
- *Not proven here:* rover3 has **no gearbox**, so nothing about a loaded transmission,
  shifting under load, or an ESC latch was tested. **The operator must confirm on a geared
  rover before this is trusted to have fixed the reported symptom.** No flight battery, so no
  actuation of the drivetrain itself was possible.

### 2026-07-30 — `chore/priorities-and-branch-archive`

Shelved the control-safety branch and recorded four new operator priorities.

- Archived `agent/fix-control-failsafe` (`6220780`) to
  **`origin/archive/control-failsafe-2026-07-30`** on operator instruction, verified the
  content is retrievable from the remote ref, then deleted the local branch. It had never
  been pushed, so this was the only way to shelve it without destroying it. Three fixes
  inside it were flagged as cherry-pick prerequisites. **That is withdrawn — see `## Current
  state`. All three landed on `main` in better form, and applying the archive's versions now
  would OVERWRITE the newer hardened parser.**
- Recorded the four priorities set by the operator: the gear/throttle safety defect, latent
  frame dropping for video + C2, radio and power status in the UI and Fleet Manager, and
  Xbox/PlayStation controller support.
- Recorded that **the fleet is not homogeneous**: two rovers have a high/low gearbox and
  rover3 does not, so gear work has no validation path on the only reachable rover.
- Confirmed with the operator: telemetry sources are the Pixhawk power module, a SiK
  telemetry radio, and WiFi link quality; the gamepad connects to the operator's browser
  device, not the Pi.
- Purged now-false statements about the safety branch being local and unpushed, and removed
  the completed directive/pipeline task from `TASKS.md` per its own contract.

**Validation: PASS** — rover3, 2026-07-31 15:21 BST.
**Validated SHA: `a8f041ccb359f2de8a6728eb937478eb00791d6b`** (deployed by git bundle).
Markdown-only (`git diff --name-only main..a8f041c` → zero runtime files), so this proves the
rover is healthy on the deployed SHA rather than exercising new behavior. Services all active,
`NRestarts=0`, zero error/refusal lines in the startup window, `Rover ID: 3`, Pixhawk heartbeat
received, `/status` OK, `socket.html` 200. No arming attempted; **no actuation is possible with
the flight battery disconnected.** The `SERVO*_MIN/MAX` factory-default correction recorded
above was itself verified on-target: 15 of 16 outputs at 1100/1900, including the disabled
`SERVO6–10` (`FUNCTION=0`); only `SERVO3` differs at 1000/2000.

### 2026-07-30 — `chore/agent-directive-and-skills`

Established the engineering directive and the six-skill pipeline for this repo.

- Added `CLAUDE.md`: role, platform topology, ten named safety invariants, the mandatory
  pipeline, the `HANDOFF.md`/`TASKS.md` contracts, git rules, the validation bar, and
  hardware access facts.
- Added `TASKS.md` and this file, seeded from a full read of the tree at `acd3540`.
- Added `.claude/skills/{auditor,optimizer,second-opinion-validator,devops-engineer,embedded-validator,fleet}/SKILL.md`
  and subagent definitions in `.claude/agents/`.
- Reduced `AGENTS.md` to a pointer at `CLAUDE.md`, so Codex reviews under the same directive
  instead of a second, narrower rule set.

Also reconciled rover3's `/opt/picar` from the stale divergent branch `fleet-manager` to
`main` @ `acd3540`, restoring per-rover identity through the untracked
`picar-cfg.local.json` overlay. Backups kept on the rover. Details under `## Environment`.

**Validation: PASS** — Embedded Validator, rover3, 2026-07-30 19:55 BST.
**Validated SHA: `3e6dd994711551cd7e64aa70503b5194b39bb142`** (deployed by git bundle, not
via `origin`; `git status` clean at that SHA on the rover).

- *Scope.* `git diff --name-only main..3e6dd99` is **markdown only** — 13 `.md` files, zero
  `.js`/`.json`/`.service`/`.sh`/`.html`. The change cannot alter runtime behavior; the
  validation therefore proves the rover is healthy on the deployed SHA rather than
  exercising new behavior.
- *Services.* `picar`/`mavproxy`/`mediamtx` all active, `NRestarts=0` after restart. Startup
  clean: `Applied local overrides…`, `Rover ID: 3`, MAVProxy driver at 20 Hz, `Stream codec:
  webrtc`, web server up. No errors.
- *MAVLink wire.* Post-restart PID 1981: `Received first Pixhawk heartbeat`, then
  `RC Override: ch1=1500 ch2=2000 ch3=1500 (client=true)` repeating — override stream live
  and neutral.
- *Endpoints.* `/status` → `{"status":"OK","throttle":0,"steering":0}`; `socket.html` → 200
  (56 875 B); `socket.io` polling → 200; WHEP `:8889` → 204.
- *Not done, deliberately.* No browser drive of the UI and no fail-safe trip: with no
  runtime file changed there is nothing new to exercise, and `main` has no safety layer to
  trip. No arming attempted. **No actuation is possible — the flight battery is
  disconnected.**
- *Known non-regression.* `npm test` fails on this branch because `package.json` on `main`
  has `scripts: {}`. Pre-existing; a test script exists only on the archived branch.
- *`test/on-target/` does not exist yet* — no on-target coverage was required for a
  markdown-only change, but the suite must exist before any runtime change is validated.
  Tracked in `TASKS.md`.

Rover returned to `main` @ `8271d14` after this merge. *(No longer the current baseline — see
`## Environment` for rover3's verified state as of 2026-08-03.)*

**Next session must know:**

- The audit that seeded `TASKS.md` read the tree, not the rover. Verify the `P0` items
  against live behavior before acting on them.
- Part of the original audit was performed against the now-archived safety branch rather
  than `main`. Findings citing `control-safety.js` or `client-control-safety.js` refer to
  files that exist **only** on `origin/archive/control-failsafe-2026-07-30` and on no rover.
  Line numbers cited for `app.js`, `pwm_mavproxy_servo.js`, `picar-cfg.json`, and
  `socket.html` may be that branch's rather than `main`'s — re-check before acting.
- The archive branch also carries its own `AGENTS.md`. If it is ever revived or
  cherry-picked, keep `main`'s version (the pointer at `CLAUDE.md`) and fold in anything the
  directive does not already cover.

## Environment

**Rovers.** `rover1`, `rover2`, `rover3` exist. **`rover3` is the development target** and
the only rover to deploy to unless told otherwise.

> **ASSUME rover3 CAN MOVE. Measure the battery for your own run; do not inherit a premise.**
>
> This paragraph said "its flight battery is not connected, so motors and servos cannot
> physically actuate" until 2026-08-11. `CLAUDE.md` reversed that standing premise on
> 2026-08-05 after an on-target probe commanded throttle −0.6 for 1.5 s and +0.6, three
> separate runs, on the strength of it — but this section, which reads as live standing
> guidance rather than a dated record, was never updated. That is the more dangerous half of
> the mistake: a frozen historical entry misleads whoever reads that entry, while
> `## Environment` misleads everybody.
>
> **And the reading you would measure it with is not currently trustworthy.** Measured on
> rover3 2026-08-11 16:5x BST: `/status` `telemetry.battery` is
> `voltageV: 0.007, currentA: 0.54, remainingPct: 95, pctSource: "flightcontroller"`, with
> `telemetry.power.servoV: 0`. Voltage reads essentially zero *while current reads 0.54 A* —
> those cannot both be right, so **"0.007 V" is not evidence of a disconnected pack.** The FC
> is on an analog sense (`BATT_MONITOR=4`, `BATT_VOLT_PIN=8`, `BATT_VOLT_MULT=18.18`) and the
> voltage side of it appears dead. `remainingPct` is arithmetic from `BATT_CAPACITY=3300`
> against unmeasured consumption, so it is not an independent reading either, and MAVProxy
> logs "Flight battery 100 percent" from the same non-fact.
>
> Consequence for the on-target scripts, and read this before running anything:
> `test/on-target/control-e2e.js:107` is a WARNING gate, not a motion gate. With the sense
> reading 0.007 V it concludes "no battery" and `return`s — **skipping the warning and then
> arming, steering and shifting the gearbox anyway, with or without `--allow-motion`.**
>
> An earlier revision of this paragraph called that "fails safe for the script". **That is
> withdrawn: it fails OPEN.** The broken reading removes the one thing that would have told
> the operator to stop, on a rover with a pack installed and a flight controller that
> refuses DISARM. The same wrong wording was in `TASKS.md` and is corrected there too.
>
> It also **cannot distinguish a disconnected pack from a broken sense**, which is the
> reasoning error that produced the 2026-08-05 throttle probe. Do not reason from it, and do
> not reason from `/status` voltage, until the sense is fixed. The fail-closed rewrite is on
> `fix/motion-gate-fails-closed`; until it merges, treat `npm run test:on-target` as a
> motion-tier action. Both are open in `TASKS.md`.
>
> What to do instead: look at the pack and the connector, physically. If a change cannot be
> proven without actuation, report it unvalidated and stop.

**The fleet is NOT homogeneous — this constrains what can be validated where.**

- **Two rovers have a high/low gearbox; `rover3` does not** (operator, 2026-07-30). Any
  gear/shift work therefore **cannot be validated on rover3 at all** — not partially, not
  by proxy. It needs access to rover1 or rover2. Treat "validated on rover3" as meaningless
  for the shift channel.
- Hardware also differs by SBC generation: rover3 is a Compute Module 4. Do not assume a
  fix verified on one rover holds on another; check the target's model and config.
- Practical consequence: a change touching `channelMap.shift`, `shift_default_us`, or the
  gear UI has no valid validation path today. That is a scheduling blocker, not a detail.

**The repo lives at `/opt/picar` on every rover** — standing convention, and the reason the
tracked systemd units carry `/opt/picar` paths.

**rover3 hardware (verified 2026-07-30, re-verified 2026-08-03).** Raspberry Pi **Compute Module 4
Rev 1.1**, Debian 13 (trixie), Node **v20.19.2**. Do not assume Pi 5 behavior or Node 22 APIs, and
check the target before assuming the fleet is homogeneous. (`README.md` claimed Pi 5 / Bookworm /
Node 18.19.0 until 2026-08-03; it is now correct.)

**Access.** `ssh saltenna@rover3` — key-based, hostname resolves over mDNS (it also
appears as `rover3.Saltenna.local`). The dev workstation and the rovers share
`192.168.31.0/24`. If SSH is refused for `publickey`, the workstation key is not in the
rover's `authorized_keys`; ask the operator to run `ssh-copy-id` in a real terminal — from a
non-TTY shell it fails on a missing `ssh-askpass`, and it needs `sudo`.

**rover3 checkout state — measured 2026-08-11 16:5x BST. It is NOT on `main`.**

```
branch  fix/webrtc-require-udp
HEAD    370d39da
dirty   untracked field-log.sh only
units   picar active · mavproxy active · mediamtx active
model   Raspberry Pi Compute Module 4 Rev 1.1 · Linux 6.12.62+rpt-rpi-v8
uptime  18 h (mavproxy up since Mon 2026-08-10 21:32:06 BST, NRestarts=0)
clock   Europe/London (BST, +0100) — agrees with the workstation in UTC
params  11/11 critical verified · missing [] · mismatched {}
```

Before this, the block above claimed `feature/battery-and-radio-telemetry` @ `a979b59`
(2026-08-03), and the change log separately asserted `fix/webrtc-require-udp` @ `8dbdb52` and
`test/p0-verify` — **three different checkouts asserted at once in one file.** The dev rover has
never been left on `main`. Any validation must state the SHA the rover actually ran, and
deploying a branch moves it, so record what it came from first. Identity is untracked
`picar-cfg.local.json` and survives checkouts.

**The rover's clock is Europe/London (BST, +0100); the dev workstation is EDT (−0400).** Both
agree in UTC. Local timestamps in journals and `ls` output are therefore **five hours ahead of
workstation local time** — a log line reading "Aug 10 23:09" is 18:09 EDT the same day.

**The failure direction was stated backwards here until 2026-08-12, and the correct one is the
dangerous one.** Misreading a rover timestamp as workstation-local does NOT make a fresh file look
stale. It makes a fresh file look ~5 h **in the future** — obvious, and self-correcting. What it
actually does is make a file that is genuinely **five hours stale look current**, which is not
obvious at all. That is the direction that hides a frozen tlog or a wedged MAVProxy: the exact
observability failure this fleet has already had.

So do not compare local timestamps. **Compare in UTC** (`date -u`, `ls --time-style=full-iso`,
`journalctl --utc`), or establish freshness by sampling a file's SIZE twice a few seconds apart —
which `test/on-target/telemetry.sh` does, and which no clock error can fake.

**MAVProxy's tlogs are 450 MB in tmpfs and growing (measured 2026-08-11).**
`/tmp/mav.tlog` 272 MB + `/tmp/mav.tlog.raw` 178 MB, growing ~3–4 KB/s (measured by sampling the
size 6 s apart), against a 3.9 GB `/tmp` at 11% used. MAVProxy is simultaneously emitting
**"Out of space for logging" ~118 times per 10 minutes** — which cannot be the tmpfs, so it is
most likely the autopilot's own log volume relayed as STATUSTEXT, meaning the FC is not writing
its own dataflash logs. That matters because those logs are what would explain a refused DISARM.
Not yet run down; open in `TASKS.md`.

`/var/log/mavproxy/` still holds a genuinely stale set from **May 21** (`mav.tlog` 3.3 MB,
`mav.tlog.raw` 2.2 MB, `mav.parm` 19.7 kB). Do not parse those believing they are current — the
live logs are the two in `/tmp`.

**rover1 and rover2 are not reachable from this workstation (re-measured 2026-08-11).** Neither
hostname **resolves** any more: both fail with `Name or service not known`. That is a change from
2026-08-03, when `rover1` did not resolve but `rover2` resolved and refused SSH `publickey` —
`rover2`'s failure has moved one layer down the stack, so `ssh-copy-id` is no longer the fix for
it. Both hold the high/low gearbox, so the gear/throttle P0 still has no validation path, and
neither can be diffed against rover3's parameter baseline. Establishing whether they are powered,
on the network, or advertising over mDNS at all is the first step, ahead of any key exchange.

**Flight controller firmware, measured 2026-08-11 — recorded here because it was written down
nowhere before.**

```
ArduRover V4.6.3 (3fc7011a) · ChibiOS 88b84600
Pixhawk6C 002E002F 30345119 31303434
918 distinct parameters
```

Read out of MAVProxy's own startup parameter fetch in `/tmp/mav.tlog`, which needs no extra
MAVLink client — useful because **MAVProxy's `--out=tcpin:127.0.0.1:5760` is single-client and
picar owns it**: a second client gets a connection but no traffic and `wait_heartbeat` times out.
Parse the tlog instead of attaching. The version matters because parameter *names* move between
releases: `GPS1_TYPE` exists and `GPS_TYPE` does not, and `SYSID_MYGCS` exists while
`MAV_GCS_SYSID` does not, so 4.6.3 is the naming era this fleet is in.

**The autopilot speaks MAVLink v2 on the link that was captured.** In a 200 kB live tail: 48
autopilot HEARTBEATs as v2 (`0xFD`), **zero** as v1. picar's own OUTBOUND traffic is v1 (`0xFE`,
msgid 70 `RC_CHANNELS_OVERRIDE` ×955).

**Do not read a translation dependency into that.** An earlier revision of this paragraph said
MAVProxy "is therefore translating v2→v1 for picar's link, which is the only reason picar — whose
parser drops v2 — sees heartbeats at all." Both halves are wrong. `parseIncoming` on `main`
accepts `0xFE` **and** `0xFD`, validates CRCs on both, zero-extends v2 payloads and filters source
IDs — this document says so itself under Current state. And the capture is of the FC-side link,
which establishes nothing about what MAVProxy delivers on picar's TCP socket. The false version
invited someone to "fix" a dependency that does not exist, or to regress the hardened parser to
match it.

**rover3's measured parameter baseline (2026-08-11).** Keep this: it is the first real baseline
this project has had, and it replaces `mav.parm`, which was a **PX4 quadcopter dump** (1101
params, `MAV_TYPE 2`, zero ArduPilot-only names) that a code comment used to invite operators to
load by hand.

```
FS_ACTION 2      FS_TIMEOUT 1.5   FS_THR_ENABLE 0   FS_GCS_ENABLE 0
FS_OPTIONS 0     FS_CRASH_CHECK 0 FENCE_ENABLE 0
SYSID_MYGCS 255  SYSID_ENFORCE 0  ARMING_CHECK 1    ARMING_REQUIRE 0
MODE_CH 8        INITIAL_MODE 0   MODE1..MODE6 all 0 (all MANUAL)
RCMAP_ROLL 1  PITCH 2  THROTTLE 3  YAW 4            RC_PROTOCOLS 1
RC3_MIN/MAX 1000/2000   RC1/RC2/RC4/RC5/RC6_MIN/MAX 1100/1900
SERVO3_MIN/MAX 1000/2000  SERVO1/2/4/5/6_MIN/MAX 1100/1900
MOT_THR_MAX 100  MOT_THR_MIN 0    MOT_SLEWRATE 250  CRUISE_THROTTLE 50
ATC_BRAKE 1      ATC_ACCEL_MAX 1  WP_SPEED 2        SPEED_MAX 0
BATT_MONITOR 4   BATT_CAPACITY 3300  BATT_VOLT_PIN 8  BATT_VOLT_MULT 18.18
BATT_LOW_VOLT 0  BATT_CRT_VOLT 0  BATT_FS_LOW_ACT 0  BATT_FS_CRT_ACT 0  BATT_ARM_VOLT 0
```

Two readings from it are load-bearing and are open in `TASKS.md`: **both FC failsafe triggers are
disabled** (`FS_THR_ENABLE`/`FS_GCS_ENABLE` = 0, so `FS_ACTION=2` Hold is configured but
unreachable), and **every battery failsafe is disabled**. One is reassuring and worth not
re-litigating: `INITIAL_MODE=0` with `MODE1..MODE6` all 0 means the mode switch cannot take the
vehicle out of MANUAL, and `RCMAP_*` is at defaults so picar's channel map is correct.

**The vehicle is ARMED as of 2026-08-11 16:5x** — autopilot `base_mode=193` (`SAFETY_ARMED` set)
across all 48 heartbeats in the live tail, `custom_mode=0` (MANUAL). It has been armed
continuously, and picar's `neutralizeAndDisarm()` on connect has not changed that.

**`mavproxy_arm.py` is NOT evidence of what ArduPilot does — a worked example of the mistake this
file keeps recording.** MAVProxy's arm module on rover3
(`/opt/venvs/mavproxy/lib/python3.13/site-packages/MAVProxy/modules/mavproxy_arm.py`) uses
`p2 = 2989` for `arm force` (:143) and `p2 = 21196` for `disarm force` (:188). On 2026-08-11 that
was read as proof that "2989 is the force-ARM magic and 21196 is the force-DISARM magic", and a
real P0 was withdrawn on it.

**It proved no such thing, and the withdrawal was wrong.** Rover-4.6.3's own handler
(`GCS_Common.cpp:5027`) disables arming checks when `param2` equals **either** value, and
`AP_Arming.cpp:1798` then skips `pre_arm_checks()` and `arm_checks()` outright. MAVProxy's choices
are one tool's CLI conventions, entirely consistent with both values forcing an arm. The measured
`ARMING_CHECK=1` proved nothing either: that parameter is read only *inside* the checks a forced
arm never reaches.

The lesson is the one this repo has now recorded several times in different clothes: a plausible
secondary source was preferred over the primary one, and it retired a live hazard. The P0 is
restored in `TASKS.md` with the source citations, and `CLAUDE.md` invariant 7 — which had been
queued for "correction" — turns out to have been right all along.

Rollback point, if ever needed: branch `fleet-manager` @
`cdf4ae16dc9e105acf4cd711b33c416f52ae7739`, with the pre-change working-tree diff and the
old config preserved **on the rover** at `/home/saltenna/picar-backup-20260730/`
(`local-changes.patch`, `picar-cfg.json.pre-reconcile`, and the three `*.bak` files).

The state it was found in, for the record:
`/opt/picar` is on the stale branch **`fleet-manager` @ `cdf4ae1`**, which is *divergent*
from `main`, not behind it: it carries two commits `main` never took
(`d816a7d` "Fix rover sort crash…; add fleet_enabled flag", and the PR #3 merge), while
missing 12 files' worth of newer work. On top of that the working tree is dirty:

- `socket.html` and `fleetmgr-client.js` are modified — but both are **byte-identical to
  `main`'s versions** (md5 `0a1c1f6b…` and `d6ea11ac…`). Someone hand-copied newer files
  onto the old branch instead of checking it out. Nothing unique is at risk in them.
- `picar-cfg.json` is **`UU` (unmerged) in the index** — a conflict that was hand-resolved
  in the file but never `git add`ed. The resolution left `"fleetManagerUrl": "auto"`
  duplicated (harmless: last key wins in `JSON.parse`, but it is evidence of a sloppy merge).
- `picar-cfg.local.json` is **absent**, and `rover_id: 3` sits in the *tracked* config —
  this rover predates the untracked-overlay mechanism, so the next `git pull` re-conflicts
  on exactly the file the overlay was designed to protect.
- Stray `*.bak` files: `fleetmgr-client.js.bak` (**owned by root**), `picar-cfg.json.bak`,
  `socket.html.bak`.

**What the reconciliation restart revealed.** Restarting on `main` produced a clean startup
and also exposed a defect chain worth understanding before trusting any log on `main`:

- The overlay pushed `PARAM_SET FRAME_CLASS=2` — **Boat**, not Rover. Pre-existing, not
  caused by the reconciliation; the previous branch sets `2` as well.
- Nine `PARAM_SET` writes were followed by **zero** `verified` or `WARNING` lines. `main`'s
  parser accepts only MAVLink v1 (`0xFE`) while MAVProxy forwards v2 (`0xFD`), so every
  `PARAM_VALUE` reply is discarded and read-back verification has never actually run.
- `main` accepts *any* HEARTBEAT as the autopilot's, so the reassuring "Received first
  Pixhawk heartbeat" is most likely MAVProxy's own GCS heartbeat, not the flight controller.

The archived branch fixes all three, and its v2 parser plus heartbeat filter should be
cherry-picked on their own merits — the radio/power telemetry work cannot read a single
MAVLink field until they are. Note the corollary: because read-back currently verifies
*nothing* on this Pixhawk, it is unproven that a v2 parser will actually receive
`PARAM_VALUE` here. Prove that first; it is the cheapest experiment with the highest
information value, and it gates both the telemetry feature and any future arm-gating.

**Gear/throttle investigation, 2026-07-30 (live test on rover3).** With a bench test servo on
output 2 and the servo rail powered (`Vservo` 6014 mV), ch2 was swept
2000→1500→1100→1000→1500→2000 while ch1 and ch3 were pinned at 1500. Result: servo2 tracked
the command exactly; **servo3 (throttle) held 1500 with 0 µs spread**; `Vservo` held
6012–6017 mV. Conclusion: **no gear→throttle coupling exists in ArduPilot's mixing**, which
refutes both the `FRAME_CLASS=2` (Boat) mixing theory and the `RCMAP_PITCH=2` conflict theory.
`RCPassThru` was confirmed to ignore `SERVO2_MIN/MAX` (commanded 1000 on an output whose MIN
is 1100). Note `SERVOn_MIN/MAX = 1100/1900` are ArduPilot factory defaults across all 16
channels, so they are *not* evidence of a measured mechanical limit — an earlier claim to that
effect was withdrawn. The test script was throwaway diagnostic tooling and was removed from
the rover; picar was stopped for the run and restored afterwards.

**The flight controller was found ARMED, and `main` never disarms it.** `base_mode=193` has
`SAFETY_ARMED` set, before and throughout that test. `main`'s `_connect()` calls only
`startHeartbeat()` and `startLoop()` — there is no `disarm()` on connect, so arm state
survives picar restarts, crashes, and companion-computer reboots. The archived branch added
that disarm. Assume any rover may be armed with no operator connected.

**Telemetry already streaming (relevant to the radio/power task).** From the live tlog:
`SYS_STATUS` voltage 7861 mV / current 46 cA / remaining 0 % (`BATT_MONITOR=4` is configured,
but capacity params are not, hence 0 %); `POWER_STATUS` Vcc 5164 mV / Vservo 6014 mV;
`SERVO_OUTPUT_RAW` and `RC_CHANNELS` at ~4 Hz. `RC_CHANNELS.rssi = 255` (no RC receiver link)
and **zero `RADIO_STATUS` messages in 656 375 logged frames** — so a SiK radio is either not
fitted or not on a MAVLink serial port. Confirm before building the Radio indicator.

**Runtime baseline (healthy, post-reconcile).** `picar`, `mavproxy`, `mediamtx` all active;
`NRestarts=0`; up since 2026-07-30 19:36 BST. Listeners: `:8443` and `:8081` (node),
`:8889` (mediamtx), `127.0.0.1:5760` (mavproxy). `/status` returns
`{"status":"OK","throttle":0,"steering":0}` — note it has no `armed`/`controllerConnected`
fields on `main`; those arrive with the safety branch. The journal still shows "Fleet
Manager not found on LAN; will retry" every ~5 s — no Fleet Manager runs on this subnet.
The pre-reconcile process had consumed 1 min 53 s of CPU in ~1 h 47 m, most of it that
never-backing-off discovery sweep.

**Services on the rover.** `picar.service`, `mavproxy.service`, `mediamtx.service`.
Logs: `journalctl -u picar -f`. `picar.service` uses `KillSignal=SIGINT` so `app.js` can
flush a final neutral + DISARM before exit — do not change that without re-validating
shutdown behavior.

**Endpoints.** Controller UI `https://rover3:8443/socket.html` · status JSON
`https://rover3:8443/status` · WHEP `https://rover3:8889/cam/whep` · Fleet Manager
dashboard `http://<fm-host>:3000`.

**Never commit.** `picar-cfg.local.json` (per-rover identity), `mediamtx.yml` (generated at
startup), `*.tlog`, or any new key material.

**Repo.** `git@github.com:Saltenna/picar.git`. Do not delete, rewrite, or force-push remote
branches. Several stale remote branches exist (`dev`, `dev-h264`, `pix_dev`,
`fleet-manager`, `claude/nice-bell-AupRX`) — leave them alone; cleanup is explicitly not
authorized.

**Running the Second Opinion stage so it actually completes** — known-good as of 2026-08-11,
recorded because getting this wrong cost a previous session a false "the stage is escalated"
and nearly cost it the weaker fallback reviewer.

```
git worktree add --detach <path>/<branch> <branch>      # never review in the authoring tree
ln -sfn /home/bimansantoso/picar/node_modules <path>/<branch>/node_modules
timeout 2400 codex exec --cd <path>/<branch> --sandbox read-only "$(cat preamble.md focus.md)"
```

- **One branch per review.** The runs that timed out were multi-branch. Scoped to a single
  `git diff main..HEAD`, nine reviews completed in 5-20 minutes each, run in parallel.
- **Detached background invocation with a ~40 min ceiling.** A foreground 10-minute timeout is an
  invocation problem, not a fallback condition — `SKILL.md` is right to refuse it as one.
- **`--sandbox read-only`** keeps the stage review-only as `SKILL.md` requires. The consequence is
  that Codex reasons about mutations rather than running them; it has been accurate doing so, but
  re-derive any mutation claim yourself before trusting it.
- **A worktree per review is mandatory, not hygiene.** The 2026-08-06 session ran mutations in the
  tree two reviewers were reading; one saw HEAD move and correctly discarded its own results.
- **Give the reviewer the hardware context in the prompt.** It cannot know the pack is installed,
  that DISARM is refused, that the voltage sense is broken, or that `SYSID_MYGCS=255`, and every
  one of those changed a verdict. Also tell it the repo's known can't-fail test shapes and ask it
  to name a concrete mutation per test — that is where the highest-value findings came from.
