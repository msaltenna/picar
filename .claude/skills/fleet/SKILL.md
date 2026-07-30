---
name: fleet
description: Summon a right-sized fleet of agents to run picar pipeline work in parallel, matching model tier to task complexity. Use when work is wide — a full-tree audit, several independent findings, or many files to sweep. Not for single-file changes.
---

# Fleet

You orchestrate. You are not a pipeline stage — you *run* stages, or many instances of one,
in parallel when the work is wide enough to justify it. The goal is maximum throughput for
the minimum tokens that still does the job properly.

## When to summon a fleet

Fan out when the work decomposes into genuinely independent units:

- A full-tree audit — one agent per subsystem (control safety, MAVLink driver, streams,
  fleet manager, install/systemd, UI).
- Several unrelated findings the Optimizer can implement in parallel.
- A sweep across many files: a config-key inventory, a dead-code pass, a dependency audit.
- Independent review lenses on one change: correctness, real-time behavior, security.

**Do not fan out** for a single-file change, a task where step two needs step one's answer,
or anything touching `control-safety.js` — safety-path work goes through the serial pipeline
where each stage sees the whole picture.

## Sizing

Match the model tier to the task, and be honest about which is which:

- **Haiku** — mechanical and verifiable: file inventories, grep sweeps, dependency usage
  checks, log collection, formatting.
- **Sonnet** — bounded reasoning: implementing a well-specified finding, writing a test,
  auditing one non-safety subsystem, collecting on-target evidence.
- **Opus** — safety-critical reasoning: anything touching the ten invariants in
  `CLAUDE.md`, MAVLink protocol work, arming logic, adjudicating conflicting reviews.

Size the fleet to the work, not to the budget. Three agents that each own a real subsystem
beat ten that overlap — overlapping agents duplicate tokens and produce contradictory
findings someone then has to reconcile.

## Rules

- **Isolation.** Agents editing files in parallel need `isolation: "worktree"`, or they
  will fight over the tree. Read-only agents do not.
- **Disjoint scopes.** Give every agent an explicit, non-overlapping scope in its prompt.
- **Structured returns.** Ask for findings in a fixed shape — `file:line`, severity, the
  concrete failure — so you can merge them without re-reading everything.
- **The pipeline still applies.** Parallelism changes how work is produced, never whether it
  is reviewed, deployed, and validated. Fleet output converges back into the serial pipeline
  at the Second Opinion stage.
- **One writer for the shared documents.** Many agents may find things; exactly one merges
  the results into `TASKS.md` and `HANDOFF.md`, after deduplicating.

## Method

1. Decompose the work and name each unit's scope and success criterion.
2. Pick the tier per unit. Say which tier you chose and why — the operator is paying for it.
3. Dispatch all independent agents in one batch so they run concurrently.
4. Merge: deduplicate, resolve contradictions between agents, and rank by severity.
5. Hand the merged result to the next pipeline stage.

## Output

The decomposition, the tier chosen per unit and the reasoning, the merged findings ranked by
severity, any contradictions you had to resolve and how, and what the next stage should do.
