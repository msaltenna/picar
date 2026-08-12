# CLAUDE.md — picar engineering directive

## Role

You are an expert-level SME embedded software and electrical/computer engineer. You are
developing this repository from a teleoperated rover platform into a drone platform.

You have deep working knowledge of custom low-level software, networking and routing, and
real-time control. You write only optimized, clear code with the best achievable time and
space behavior. You approach every problem systematically. **No feature reaches `main`
until it has been validated on real hardware.**

Optimized does not mean clever. On this platform the control path is soft-real-time: a
blocked event loop is a safety failure, not a performance regret. Prefer the allocation-free,
bounded-latency implementation over the terse one, and say why in a comment when the reason
is not obvious from the code.

---

## Platform state (read this before touching anything)

> **Read this first.** The safety layer described below — `control-safety.js`,
> `client-control-safety.js`, and the arm-gating in `pwm_mavproxy_servo.js` — is **not on
> `main`**. It exists only on `origin/archive/control-failsafe-2026-07-30`, which is shelved and
> not scheduled. On `main`, `app.js:133` arms the vehicle from any socket with no lease, token,
> sequence, or staleness check. Until that is closed, the invariants below are the **required
> standard, not a description of `main`** — see the table at the end of this section for which
> ones actually hold today.
>
> `main` *does* have a `test/` suite (`npm test` → 237 tests as of 2026-08-04) — that is a separate
> thing from the archived branch's suite, and an earlier revision of this file wrongly said `main`
> had neither.
> **Do not cherry-pick the heartbeat filter out of the archive without its v2 parser**, and do
> not drop `control-safety.js` onto `main`'s driver, which has no `getSafetyStatus()` for its
> `typeof` guard to find. Both traps are written up in `TASKS.md`.

**Vehicle:** Raspberry Pi companion computer + **Pixhawk 6C mini** flight controller running
ArduPilot. Verified on rover3: **Compute Module 4 Rev 1.1**, Debian 13 (trixie), Node
v20.19.2. Do not assume Pi 5 behavior or Node 22 APIs; the fleet is not homogeneous, so check the
target. (`README.md` claimed Pi 5 / Bookworm / Node 18 until 2026-08-03; it is now correct.)
The vehicle profile is **ArduRover**, which means `FRAME_CLASS=1`. The overlay pushed `2` (Boat)
until 2026-08-04 while `EXPECTED_CRITICAL_PARAMS` expected `2` as well, so read-back confirmed the
wrong value and reported the vehicle verified — rover3 really was running as a boat. Fixed at all
three sites, and measured on target: the autopilot's HEARTBEAT `MAV_TYPE` moved `11 SURFACE_BOAT`
→ `10 GROUND_ROVER` with **no power-cycle**, so this parameter takes effect live on Rover (an
earlier revision of `TASKS.md` claimed a reboot was required; it was wrong). A test now asserts
every `EXPECTED_CRITICAL_PARAMS` entry matches what the overlay pushes, because the two tables
drifting apart is what turned read-back into a rubber stamp. The
long-term direction is a custom software stack on the same Pixhawk 6C mini hardware.
**A custom flight controller is out of scope.** Do not add speculative multirotor or
alternate-airframe plumbing until an airframe exists — abstract when needed, not before.

**Runtime topology:**

```
browser (socket.html)
  │  HTTPS + Socket.IO :8443           ┌─ /status, /manifest.json, static
  ▼                                    │
app.js ──────────────────────── pwm_servo.js ─► pwm_mavproxy_servo.js
  │   (no lease on main — see above)    (driver select)   │ TCP :5760 (MAVLink v1 out)
  │                                                        ▼
  │                                              mavproxy.service ── /dev/ttyACM0
  │                                                        ▼
  │                                                Pixhawk 6C mini
  ├── streams/ (webrtc | h264 | mjpeg) ── :8081 / MediaMTX :8889
  └── fleetmgr-client.js ──► Fleet Manager :3000 (fleet-manager/server.js)
```

**Key modules:**

| File | Responsibility |
| --- | --- |
| `app.js` | HTTPS servers (:8443 UI/control, :8081 stream), Socket.IO wiring, `failSafeStop`, input watchdog, `setDrivetrain` transaction, shutdown |
| `control-safety.js` | **Not on `main`** — archive branch only. Single-owner lease, replay/staleness rejection, watchdog |
| `client-control-safety.js` | **Not on `main`** — archive branch only. Browser-side lease envelope |
| `pwm_servo.js` | Driver selection; auto-overrides `pwm_method` by detected Pi model (fails to detect the CM4) |
| `pwm_mavproxy_servo.js` | MAVLink v1 framing, RC_CHANNELS_OVERRIDE @20 Hz, param overlay + read-back verification, arm/disarm |
| `streams/` | Pluggable video: `webrtc` (MediaMTX, default), `h264` (WebCodecs), `mjpeg` |
| `fleetmgr-client.js` | `/24` unicast sweep auto-discovery + heartbeat to Fleet Manager |
| `fleet-manager/server.js` | Rover registry and dashboard (:3000) |
| `install.sh` | Idempotent in-place installer; templates `systemd/*.service` |
| `socket.html` | Single-page controller UI (joystick / keyboard / device-orientation) |

**Config:** tracked `picar-cfg.json`, shallow-overridden at startup by untracked
`picar-cfg.local.json` (holds per-rover `rover_id`). Never commit machine-specific values
to the tracked config.

**Tests:** `npm test` (`node --test test/*.test.js`) runs on `main` and passes — **237 tests** as
of 2026-08-04, up from 46 before the telemetry work merged. **Verify by running it rather than
trusting this paragraph** — it has been wrong before, and a reviewer who believes there is no suite
skips mutation testing, which is the highest-value check available here. A separate, smaller
24-test suite exists on the archived branch; it is not a superset of `main`'s.

Note the explicit path in the test script. `node --test` with no argument recurses the whole tree
and executes every `.js` under `test/`, which would run the **on-target** scripts as unit tests —
on a rover that means arming the vehicle and tripping fail-safes as a side effect of `npm test`.
Use `npm run test:on-target` for those, deliberately, on a rover you intend to drive.

**Green does not mean covered.** This is the single most load-bearing paragraph in this file, and
the evidence for it keeps growing. A 23-mutation pass on 2026-08-03 found **8 survivors**: the
input watchdog could be deleted outright and `failSafeStop` reverted to the DISARM-before-neutral
pattern without turning the suite red. A second pass on 2026-08-04, against a branch with 222
passing tests, found **8 more** — including a hardwired-false fleet battery-trouble bit, a
synchronous `/proc` read on the control event loop, and a deleted telemetry broadcast.

Across eight review rounds, **nine tests were caught being unable to fail.** The variants are worth
knowing, because they recur: asserting on *source text* (satisfied by an import line, or defeated by
adding braces); asserting the behaviour of the *stub the test installed*; tampering with a MAVLink
frame *without resealing its CRC*, so the parser rejects it for the wrong reason; never reaching the
branch the test names; and one that asserted the defect outright, pinning it. Two commit messages
claimed mutations were dead when they were not.

The dominant shape has a name: **a correct rule with an untouched consumer.** Extracting a rule to
make it testable does nothing for its call site, and three times on one branch the call site was
where the defect lived. `app.js` still has **no test file**, so its remaining wiring is unverified
that way. **Mutation-test anything you touch rather than trusting a pass**, and treat a HANG as
distinct from a failure — a leaked timer makes `node --test` hang, and a hang looks like a pass.

These are host-side unit tests; necessary and not sufficient — see Validation. `test/on-target/`
now exists (`video-drop.sh`, `telemetry.sh`, `control-e2e.js`) but does not yet cover every item on
the Embedded Validator's checklist; the gap is tracked in `TASKS.md`.

**No CI runs any of this.** The two `.github/workflows/` files only invoke Claude review, and the
last five merges were local merge commits, so neither the suite nor the review has ever run
automatically.

---

## Safety invariants — never weaken these

These are the reason the platform is safe to power up. Any change that touches them
requires an explicit written justification in the commit body and Second Opinion sign-off.

1. **Only an authenticated operator may take the lease.** Arming must require proof of
   *who* is asking, established before a lease is issued and bound to it. **This is not
   implemented today** — any socket reaching `:8443` can arm (P0 in `TASKS.md`). It is
   listed first because the invariants below are worthless without it: they constrain how a
   session behaves, not who may open one.
2. **Single owner.** Exactly one socket may hold the control lease. No implicit transfer,
   no resume after reconnect. The operator must re-arm deliberately.
3. **First command after arm must be neutral.** A non-neutral first command is a fail-safe
   stop, not a clamp.
4. **Every command is integrity-checked and fresh.** Session token, strictly increasing
   sequence, and a timestamp checked against `max_command_age_ms` /
   `max_command_future_skew_ms` using the NTP-midpoint clock offset established at arm.
   Replayed, out-of-order, or stale commands never reach the servos.
   **The session token is a lease handle, not a credential** — it proves continuity of a
   session, never the identity of the operator. Do not describe this as authentication;
   that is invariant 1, and it is a separate, missing control.
5. **The watchdog always rearms.** Any accepted command reschedules the input watchdog.
   Its expiry commands neutral and disarms.
6. **Fail-safe means neutral *then* disarm — on the wire, not just in call order.**
   Every path (operator stop, disconnect, page hide/blur, drivetrain change, watchdog,
   process shutdown, MAVProxy reconnect) must put a neutral RC_CHANNELS_OVERRIDE *packet*
   on the link before the DISARM packet. Note that `setServoPWM` only mutates the channel
   buffer; it transmits nothing. Calling a setter and then `disarm()` sends DISARM first and
   neutral on the next 20 Hz tick — the opposite of the intended order. Assert packet order,
   not method-call order: a mock that records calls cannot see this defect.
7. **No arming without verified hardware.** Arming must require a live TCP link, an autopilot
   HEARTBEAT (autopilot != 8, correct sysId), and read-back confirmation of every entry in
   `EXPECTED_CRITICAL_PARAMS`. The `isSafetyReady()` / `getSafetyStatus()` accessors this needs
   **do not exist on `main`** — only `EXPECTED_CRITICAL_PARAMS` does, and nothing gates on it.
   Worse, `arm()` sends the `21196` force magic, which tells ArduPilot to skip *its own* pre-arm
   checks — so `main` has no gate and disables the hardware's. Both are P0s in `TASKS.md`.
8. **Safety-relevant configuration cannot be overridden off-branch.** `app.js:24-32` shallow-
   merges untracked `picar-cfg.local.json` over the tracked config, so *any* key can be
   changed on a rover with no branch, diff, review, or validation record. Only per-rover
   identity belongs there. The overlay must whitelist what it may override, and validation must
   check the **effective** config, not the file in git. Note the keys an earlier revision named
   here — `mavproxy_allow_unverified_arm`, `max_command_age_ms`,
   `max_command_future_skew_ms` — **do not exist anywhere on `main`**; they belong to the
   archived branch. The keys that exist and matter today are `input_timeout_ms`,
   `drivetrain_settle_ms` and `mavproxy_rate_hz`, which are enough to disable the watchdog or
   stall the override loop.
9. **Never block the event loop while the vehicle can move.** The watchdog is a
   `setTimeout`. Synchronous work — `execSync`, `readFileSync` on a hot path, an unbounded
   loop — freezes the fail-safe. Treat any new synchronous call in a request/socket handler
   as a defect.
10. **A driver that cannot honour a command reports it.** Silent `return false` from a
    setter is not acceptable on the motion path; the caller must be able to distinguish
    "applied" from "dropped".

### Which of these actually hold on `main` today

Verified against `main` @ `4580209` on 2026-08-03. **This table is the honest state; the ten
items above are the target.** Do not cite an invariant as implemented without checking here first
— that mistake has been made repeatedly in this repo.

| # | State on `main` | Note |
| --- | --- | --- |
| 1 | ❌ not implemented | No auth anywhere. Any socket reaching `:8443` can arm |
| 2 | ❌ not implemented | No lease exists |
| 3 | ❌ violated | `fromclient` is accepted while disarmed, so the channel buffer can be pre-loaded and the vehicle lunges on arm |
| 4 | ❌ not implemented | No token, sequence, or timestamp check |
| 5 | ⚠️ present, untested | `app.js:265`. Deletable without failing a test; also defeated by window blur and by the hidden-tab timer clamp |
| 6 | ⚠️ partial | Correct in `pwm_mavproxy_servo.js:197`. But no blur/pagehide handler, `touchcancel` keeps throttle, and on any non-mavproxy driver every path is a silent no-op |
| 7 | ❌ not implemented | No `isSafetyReady()`; and `arm()` force-arms, disabling ArduPilot's own checks |
| 8 | ❌ not implemented | The overlay can still change any key |
| 9 | ⚠️ violated on a reachable path | `writeFileSync` in the `setVideoParams` handler; `pwm_libgpiod` spawns ~200 `execSync`/s |
| 10 | ⚠️ mavproxy only | All four GPIO drivers return `undefined` from `setServoPWM` |

---

## The pipeline — every change goes through it

No exceptions. This applies to `.js`, config, systemd units, CI, and documentation
including this file. A change that cannot affect the rover at runtime still gets a branch,
a focused commit, review, deploy, and a validator confirming the rover is healthy
afterwards.

```
  Auditor ─► Optimizer ─► Second Opinion ─► DevOps (branch + commit + deploy)
                 ▲                                        │
                 └──────── findings ◄── Embedded Validator ┘
                                                          │ pass
                                                          ▼
                                              DevOps: push, PR, merge to main
```

1. **Auditor** — establishes ground truth. Reads the current state, finds defects,
   inconsistencies, and improvement opportunities. Updates `TASKS.md` and `HANDOFF.md`.
   Read-only with respect to source code.
2. **Optimizer** — implements the Auditor's findings and any flags raised in the main
   session, plus optimizations the Auditor missed. Owns all source edits.
3. **Second Opinion Validator** — independent adversarial review through Codex, using this
   file as its directive. Review-only; it never edits or commits.
   **If Codex produces no findings at all because it cannot run, the review falls back to
   Opus 5** via the `adversarial-reviewer` subagent, in isolated context with no access to the
   authoring conversation. The stage is never skipped and no deploy proceeds without a review.
   The permitted fallback conditions are enumerated in
   `.claude/skills/second-opinion-validator/SKILL.md`, which is the single authority for them —
   default-deny, and a timeout is not one of them.
   One hard limit. **The bright line is information, not exit status:** once you have seen any
   Codex finding for a diff, the fallback is unavailable for that diff however Codex terminated.
   **Operator decision, 2026-08-04: the fallback CAN authorise a merge, including for a change
   touching the ten safety invariants.** This file previously held the merge for Codex in that
   case. It no longer does. The reasoning behind the old rule still stands on its own terms —
   Opus reviewing Opus is the same model family checking its own work — so the mitigation is
   disclosure rather than delay: record which reviewer ran in the commit trailer, and when Codex
   cannot run on an invariant-touching change, **obtain a second review from a reviewer of a
   different model family** — spawn one directly (Fable 5 served this role for
   `feature/battery-and-radio-telemetry`) and record it with a `Red-teamed-by:` trailer.
   Convergence between two families is evidence; agreement inside one is not. There is no
   `/red-team` skill on `main`; a branch adding one exists and is tracked in `TASKS.md`, so until
   it merges this is a step you perform, not a skill you invoke.
4. **DevOps Engineer** — owns all git operations. One focused branch and one focused commit
   per feature or fix. Deploys the branch to the rover over SSH.
5. **Embedded Validator** — proves the change works **on the rover**. Only this stage can
   declare a change validated.
6. **DevOps Engineer** — on a validator pass, pushes the branch and opens/merges the PR.
   On a fail, hands the evidence back to the Optimizer and the loop repeats.

**Fleet** is not a pipeline stage. It is the orchestrator that runs stages — or many
instances of a stage — in parallel when the work is wide enough to justify it.

**Gate:** `main` only ever receives work carrying an Embedded Validator pass for **the exact
SHA that was deployed**.

**The evidence-commit exemption.** Writing the validation result into tracked `HANDOFF.md`
changes the tree, so the merged SHA would no longer be the SHA that was tested — and if that
write itself required the full pipeline, the recursion never terminates. So exactly one
bounded exemption exists:

- Validate the **code SHA**. Record the pass in `HANDOFF.md` as a separate, final commit on
  the same branch that touches **nothing but** `HANDOFF.md` / `TASKS.md`, and quote the
  validated SHA verbatim in it.
- That evidence commit does not re-enter the pipeline. It is the only change that may skip
  it, and it may not modify anything else — if it does, it is not an evidence commit and the
  branch must be revalidated.
- A reviewer must be able to confirm the merge by reading the quoted SHA and diffing it
  against what actually landed.

This is a real weakening of "no exceptions", accepted because the alternative is
unachievable rather than because it is convenient. It leaves the attestation as
self-reported prose in a mutable file. The durable fix is an attestation keyed to the
deployed SHA, enforced as a required protected-branch status check — tracked in `TASKS.md`.

---

## Skills

Invoke with `/<name>`. Each is defined in `.claude/skills/<name>/SKILL.md`; the ones that
run in isolated context also have a subagent in `.claude/agents/`.

| Skill | Role |
| --- | --- |
| `/auditor` | Audit current state; update `TASKS.md` + `HANDOFF.md`; flag bugs, inconsistencies, improvement opportunities |
| `/optimizer` | Implement audit findings and main-session flags; propose what the audit missed |
| `/second-opinion-validator` | Adversarial review of decisions and diffs under this directive — Codex, falling back to Opus 5 when Codex cannot run |
| `/devops-engineer` | Branches, focused commits, branch hygiene, SSH deploy, push and merge |
| `/embedded-validator` | On-rover validation: test scripts, WebUI drive, MAVLink wire capture, service inspection |
| `/fleet` | Summon a right-sized fleet of agents; match model tier to task complexity |

---

## `HANDOFF.md` and `TASKS.md`

Both are tracked. They have **disjoint** content — never duplicate between them.

**`TASKS.md`** — only work that is *not done*.
- Two sections: `## In progress` and `## Backlog`.
- Each entry: a one-line title, the affected files, why it matters, and its priority
  (`P0` safety/security · `P1` correctness · `P2` performance · `P3` hygiene).
- **A completed task is deleted from this file, not marked done.** Its record lives in
  `HANDOFF.md`.

**`HANDOFF.md`** — enough context for the next agent or session to pick up cold.
- Opens with **`## Current state`**: a short summary of where the platform is right now and
  what shipped. This section is *supplementary*, not a restatement of the rest of the
  document — it says what is true now, while the log below says how it got there.
- Then **`## Change log`**: newest first. Per entry — date, branch, what changed and why,
  the Embedded Validator result, and anything the next session must know (a manual step, a
  known limitation, a rover left in a non-default state).
- Then **`## Environment`**: access details, rover inventory, known-good procedures.
- **Update it after every change**, as part of that change's commit.

---

## Git workflow

- Never commit to `main`. Branch first: `fix/…`, `feature/…`, `chore/…`, `perf/…`.
- One concern per branch, one concern per commit — every change must be independently
  revertible.
- Commit subject in the imperative, under 72 characters. The body explains *why*, plus any
  safety-invariant justification.
- Every commit that passed the Second Opinion stage carries a
  **`Reviewed-by: codex`** or **`Reviewed-by: opus-fallback`** trailer. Prose in `HANDOFF.md`
  gets rewritten by every later change; a commit trailer does not, so this is the only durable
  record of whether the gate was honoured and by which reviewer.
- Delete local branches once merged. **Do not delete, rewrite, or force-push remote
  branches** — leave `origin` alone unless explicitly asked.
- Merge to `main` only after an Embedded Validator pass.
- Never commit secrets, `picar-cfg.local.json`, `mediamtx.yml`, or `*.tlog`.

---

## Validation

Simulated or host-only results never count as validation. Every change is validated live on
rover3 by the Embedded Validator, which must gather **all** of:

1. **Service and log evidence** — unit active, no restart loop, expected startup lines in
   `journalctl` (autopilot heartbeat seen, critical params verified, stream config written).
2. **MAVLink wire verification** — observe real traffic and the Pixhawk's response
   (RC_CHANNELS_OVERRIDE out; HEARTBEAT / PARAM_VALUE / COMMAND_ACK / SERVO_OUTPUT_RAW back).
   This proves commands reach the FC and it reacts, **without commanding motion** — it does not
   prove the output MAPPING, because every motion channel reads 1500 µs at neutral and a swapped
   steering/throttle assignment looks identical to a correct one. The clause "with no motor
   power" stood here until 2026-08-11 and is removed: a pack is installed, and this section's own
   rule is to state what you measured rather than assert what the vehicle cannot do.
3. **WebUI end-to-end, in two tiers.** This said "arm, move the controls, and trip each
   fail-safe path" for *every* change, which contradicted this document's own rule two
   sections down that a routine validation commands no motion. A validator following the
   sentence armed a packed vehicle on every merge; a validator following the rule silently
   weakened the gate. Both readings were available, which is the defect.
   - **Read-only tier — always required.** The page is served over HTTPS, the Socket.IO
     connection establishes, telemetry updates in the UI, `/status` agrees with what the
     UI shows, and the browser console is clean. Commands nothing.
   - **Motion tier — required for any change to the control path, the fail-safe paths,
     the driver, or the arming logic; never routine.** Arm, move the controls, and trip
     each fail-safe path. Requires the operator physically present, the vehicle safe to
     drive, and the battery reading quoted in the record per the rule below.
   A validator must state **which tier it performed**, because "WebUI end-to-end"
   unqualified reads as the second. A motion-tier change validated only read-only is
   **unvalidated**, not partially validated.
4. **Scripted regression suite on-target** — the checks are committed scripts under
   `test/on-target/`, runnable on the rover, so validation is repeatable rather than ad hoc.
5. **No regressions** — `npm test` clean, and previously validated behavior still works.

### Assume rover3 CAN MOVE. Check the battery before commanding anything.

**This section said "Rover3 has no flight battery connected. Motors and servos cannot
physically actuate" until 2026-08-05. That was false, and it was acted on.** A flight
battery is installed. Believing otherwise, an on-target probe commanded throttle
**−0.6 for 1.5 s and +0.6**, three separate runs, on a vehicle that could drive — and each
run was reported as safe on the strength of this paragraph.

The evidence was available the whole time and went unquestioned: battery telemetry read
**7.9 V at 0.41 A** from the first validation onward, and reports `pctSource:
"flightcontroller"`, meaning the autopilot is coulomb-counting a real pack. A config
comment asserting "no flight battery" was written on the same rover, on the same day, that
was reporting a live pack voltage.

So the standing rule is now the opposite of what it was:

- **Assume the vehicle can move.** Before any script or manual step commands a non-neutral
  throttle, check `/status` → `telemetry.battery`. A voltage and a current reading mean a
  pack is connected and the wheels can turn.
- **Committed on-target scripts must refuse to command motion by default** and require an
  explicit opt-in flag, with the operator physically present and the vehicle safe to drive.
  Throttle-commanding checks are not part of a routine validation run.
- **Never write "cannot actuate" as a premise.** State what you measured. If a claim
  depends on the vehicle being unable to move, verify that for the run in question and
  quote the reading.
- If a change genuinely cannot be proven without actuation, report it as **unvalidated**
  and stop — do not merge and do not soften the claim. That part was always right.

Note what this does to the record: every validation entry in `HANDOFF.md` written before
2026-08-05 that says "no mechanical actuation was observed or implied, because rover3 has
no flight battery" asserts a safety property that was not true. The command-path evidence
in those entries stands on its own; the actuation disclaimer does not, and is corrected
there.

**Compounding factor, and the reason this matters more than a documentation slip:** this
flight controller ignores DISARM (P0 in `TASKS.md`, demonstrated on rover3 — 222
consecutive ARMED heartbeats with no `COMMAND_ACK`). The vehicle does not actually disarm, and
it will act on the next command it receives. Under the old false premise that was a paperwork
problem. With a pack installed it is not.

An earlier revision of this paragraph added "Neutral-before-disarm still stops motion, so the
fail-safe's *stopping* function works." **That is withdrawn — it is one claim too far.** Neutral
stops motion only if the neutral *packet reaches the flight controller*, and the recorded
MAVProxy wedge proves it need not: `sendPacket()` returned true, the 20 Hz loop logged normal
values, no fail-safe fired, and 113 KB sat unread on the socket while the FC held its last output
for over an hour. Invariant 6 gets the ORDER right on the wire; whether the packet arrives is the
separate, still-open "a successful `write()` is not proof of delivery" P0. Do not describe a
fail-safe as having stopped the vehicle unless the flight controller's own output was observed
to change.

---

## Hardware access

- Rovers: `rover1`, `rover2`, `rover3`. **`rover3` is the development target and the only
  rover to deploy to** unless told otherwise.
- SSH: `ssh saltenna@rover3` (key-based; hostname resolves over mDNS).
- **The repo lives at `/opt/picar` on every rover.** That is the standing convention, and
  it is why the tracked systemd units carry `/opt/picar` paths.
- Services: `picar.service`, `mavproxy.service`, `mediamtx.service`.
- UI: `https://rover3:8443/socket.html` · status JSON: `https://rover3:8443/status`
- Leave the rover in a known-good state at the end of every session: services enabled and
  running the merged code, or an explicit note in `HANDOFF.md` saying otherwise.

---

## Code standards

- Match the surrounding style: 2-space indent, `'use strict'` in modules that have it,
  aligned `const` blocks, section banner comments (`// ── Name ───…`).
- Comment the *why*, never the *what*. Existing comments explaining a hardware quirk or a
  safety decision are load-bearing — do not delete them while refactoring.
- No new runtime dependencies without justification. The Pi installs with
  `npm ci --omit=dev`; a native module that must compile on-target is a real cost.
- Bound every buffer and every loop. Streaming and parsing code runs on every frame — no
  accidental O(n²) over an accumulating buffer.
- New behavior ships with a test. Safety-path behavior ships with a host test *and* an
  on-target script.
