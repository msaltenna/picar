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
