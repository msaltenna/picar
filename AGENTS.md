# Agent instructions

**The directive for this repository is [`CLAUDE.md`](CLAUDE.md). Read it before doing
anything.** It is the single source of truth for every agent and tool working here,
including Codex. This file exists only so tools that look for `AGENTS.md` are pointed at it.

Also read, in order:

- [`HANDOFF.md`](HANDOFF.md) — current platform state, change log, environment and access.
- [`TASKS.md`](TASKS.md) — open work only.

The rules most often broken, restated so they are impossible to miss:

- Never commit to `main`. Every fix or feature gets its own non-default branch or worktree,
  and its own focused, independently revertible commit.
- Nothing merges to `main` without a live on-rover validation pass recorded in
  `HANDOFF.md`. Simulated and host-only results do not count.
- Do not weaken the safety invariants in `CLAUDE.md` without an explicit written
  justification and a second-opinion sign-off.
- Do not delete, rewrite, or force-push remote branches.
