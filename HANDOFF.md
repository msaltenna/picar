# HANDOFF

Context for the next agent or session. Open work lives in `TASKS.md` — it is not repeated
here. Read `CLAUDE.md` first for the directive and pipeline.

## Current state

picar is a working teleoperated rover platform: a Raspberry Pi companion computer (rover3 is
a **Compute Module 4**, not the Pi 5 the README claims) driving a **Pixhawk 6C mini** over
MAVLink, controlled from a browser over HTTPS. The direction of
travel is a drone platform on the same flight-controller hardware, evolving toward a custom
software stack. A custom flight controller is **not** in scope, and the vehicle profile is
**rover-only** — no speculative airframe abstraction until an airframe exists.

> ### The single most important fact right now
>
> **The safety layer is not on `main`.** `control-safety.js`, `client-control-safety.js`,
> the 24-test `test/` suite, the hardened arm-gating in `pwm_mavproxy_servo.js`, and the
> `max_command_*` config keys exist only on the local branch **`agent/fix-control-failsafe`**
> (commit `6220780`, 13 files, +1226/−110).
>
> That branch has **never been pushed** — it exists on one workstation and nowhere else.
> Losing that machine loses the work.
>
> On `main` today, `app.js:125` is `socket.on('arm', () => pwm.arm())`: any socket that
> reaches `:8443` can arm and drive the vehicle, with no lease, session token, sequence
> number, staleness check, or watchdog, and `pwm_mavproxy_servo.js` has no `isSafetyReady()`
> gate on arming. Validating and merging that branch is the platform's top priority.

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
- **Install.** `install.sh --picar|--fleet` is idempotent and installs in place, templating
  the run user and repo path into the systemd units and installing a unit-scoped polkit
  rule so the non-root service can restart MediaMTX.

What the pending branch adds: the single-owner control lease, token + sequence + timestamp
*integrity checking* of every command, the NTP-midpoint clock-skew check, the input
watchdog, fail-safe stops on every disconnect/hide/timeout path, arm-gating on verified
flight-controller parameters, and the host test suite.

Two things that branch does **not** do, contrary to earlier claims here and in `README.md`:

- It does not authenticate anyone. The session token is a lease handle, not a credential —
  whoever arms first gets it. Command integrity is not operator identity.
- Its fail-safes do not put neutral on the wire before DISARM. `setServoPWM` only mutates a
  buffer; DISARM transmits immediately, so the neutral override actually follows ≤50 ms
  later on the next 20 Hz tick. The existing tests assert method-call order against a mock
  and cannot see this.

Weakest points beyond that, in priority order: no operator authentication anywhere; the
untracked config overlay can silently disable the arm-verification gate; a video-parameter
change synchronously blocks the event loop and can freeze the fail-safe watchdog while
armed; and the CA and server private keys are committed to the repository. These are the top
`P0` entries in `TASKS.md`.

## Change log

Newest first.

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
  has `scripts: {}`. Pre-existing; the test script arrives with `agent/fix-control-failsafe`.
- *`test/on-target/` does not exist yet* — no on-target coverage was required for a
  markdown-only change, but the suite must exist before any runtime change is validated.
  Tracked in `TASKS.md`.

Rover left on branch `chore/agent-directive-and-skills` @ `3e6dd99`, clean, all services
running. **Return it to `main` after this merges.**

**Next session must know:**

- The audit that seeded `TASKS.md` read the tree, not the rover. Verify the `P0` items
  against live behavior before acting on them.
- The audit was performed against `agent/fix-control-failsafe` (the true tip of
  development), while this docs branch is based on `main`. Findings citing
  `control-safety.js` or `client-control-safety.js` refer to files that only exist on that
  branch. Line numbers cited for `app.js`, `pwm_mavproxy_servo.js`, `picar-cfg.json`, and
  `socket.html` are that branch's, not `main`'s.
- `AGENTS.md` is added by both this branch and `agent/fix-control-failsafe`, so merging the
  second one will conflict. Keep this version — the pointer at `CLAUDE.md` — and fold in
  anything from the other that `CLAUDE.md` does not already cover.

## Environment

**Rovers.** `rover1`, `rover2`, `rover3` exist. **`rover3` is the development target** and
the only rover to deploy to unless told otherwise. It is powered and running; **its flight
battery is not connected**, so motors and servos cannot physically actuate. Validate the
command path up to the flight controller and never imply mechanical motion was observed.

**The repo lives at `/opt/picar` on every rover** — standing convention, and the reason the
tracked systemd units carry `/opt/picar` paths.

**rover3 hardware (verified 2026-07-30).** Raspberry Pi **Compute Module 4 Rev 1.1**,
Debian 13 (trixie), Node **v20.19.2**. `README.md` still claims Pi 5 / Bookworm / Node
18.19.0 — it is wrong. Do not assume Pi 5 behavior or Node 22 APIs, and check the target
before assuming the fleet is homogeneous.

**Access.** `ssh saltenna@rover3` — key-based, hostname resolves over mDNS (it also
appears as `rover3.Saltenna.local`). The dev workstation and the rovers share
`192.168.31.0/24`. If SSH is refused for `publickey`, the workstation key is not in the
rover's `authorized_keys`; ask the operator to run `ssh-copy-id` in a real terminal — from a
non-TTY shell it fails on a missing `ssh-askpass`, and it needs `sudo`.

**rover3 checkout state — RECONCILED to `main` on 2026-07-30.** It now sits on branch
`main` @ `acd3540`, clean, with identity restored the modern way via untracked
`picar-cfg.local.json` = `{"rover_id": 3}` (the startup log confirms
`Applied local overrides…` / `Rover ID: 3`). Services restarted cleanly, `NRestarts=0`,
all three active, MAVProxy TCP link up, RC_CHANNELS_OVERRIDE streaming neutral at 20 Hz.
The `fleet_enabled` flag from the abandoned `d816a7d` is gone; no code on `main` reads it.

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

`agent/fix-control-failsafe` fixes all three. The consequence for sequencing: that branch
*gates arming* on the read-back that currently produces nothing, so its verification path
must be proven live on this Pixhawk **before** merging — otherwise the merge yields a rover
that can never arm. That is now the top validation risk in `TASKS.md`.

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
