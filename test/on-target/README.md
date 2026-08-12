# On-target tests

Scripts that run **on a rover**, over SSH or locally, and prove behaviour the host
suite cannot. `CLAUDE.md`'s validation bar requires these to exist and be
repeatable rather than ad hoc — every validation before 2026-08-03 was hand-typed,
which is why results were hard to reproduce and easy to overstate.

Each script:

- exits non-zero on failure so it can gate a deploy,
- prints what it observed, not just pass/fail, because a validator has to quote
  evidence,
- states plainly what it did **not** cover.

## Exit codes — non-zero does NOT always mean failure

`control-e2e.js` has **three** outcomes, because two were not enough. Anything that
gates on "non-zero = broken" will misread the middle one:

| Code | Meaning | What a validator should do |
| --- | --- | --- |
| `0` | PASSED — every check ran, including the control path | Quote it as evidence |
| `1` | FAILED — a check ran and did not pass | Treat as a validator failure |
| `4` | **INCOMPLETE** — the motion checks were SKIPPED because `--allow-motion` was not given. Nothing failed. | **Not** a pass and **not** a defect. It may not be recorded as an on-target validation pass |
| `2` | the script threw | Read the trace |

**Unverified hardware exits `1`, not `4`.** If `--allow-motion` IS given but the flight
controller is not ready — link down, no fresh autopilot heartbeat, or a critical parameter
missing or mismatched — that is a **failure**, not a deliberate skip: you asked for motion and
the vehicle was not in a state to receive it. An earlier revision of this table said `4`.

Exit 4 is the **default** outcome of `npm run test:on-target`, deliberately: a routine
validation run is not supposed to command motion. `CLAUDE.md` requires committed
on-target scripts to refuse motion by default behind an explicit opt-in.

**Do not "fix" a non-zero default by putting `--allow-motion` into `package.json`.**
That converts every routine validation into one that arms the vehicle and shifts the
gearbox, which is the exact habit the gate exists to prevent. If you want a
zero-exit routine check, run the read-only scripts (`telemetry.sh`) instead.

## Running

```bash
# from a workstation
ssh saltenna@rover3 'cd /opt/picar && sudo test/on-target/video-drop.sh'
```

## Scripts

| Script | Proves |
| --- | --- |
| `video-drop.sh` | The frame-drop path actually sheds frames on real hardware, keyframes survive a delta-level backlog, and the parse buffers stay bounded |

## Why video-drop.sh needs care

rover3 runs `stream_codec: "webrtc"`, where **picar never touches a video frame** —
MediaMTX owns the whole path. So the drop logic cannot execute at all in the default
configuration, which is exactly why it went unvalidated for so long. This script
switches the codec through the untracked per-rover overlay, runs the test, and
**restores the original state including on failure**.

The h264 drop path was hardware-verified on 2026-07-31 (server logged
`dropped 149` / `dropped 150 stale frame(s)` while a stalled client received 29
frames, all 29 of them keyframes). **The mjpeg path has never run on hardware** —
that is the gap this closes.
