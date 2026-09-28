# Milestones

## 2026-09-17 — Session review

Reviewed the barter-rs session `01a0aacc` against a session-review backlog. Mapped the backlog to extension causes: runtime files in review diffs (which led to `git clean` deleting the goal), overlapping started tasks, retry reviews without previous findings, and unlimited retries.

User decisions: refuse overlapping code-task starts instead of warning; cap at three consecutive rejections, then block the goal.

## 2026-09-17 — Implementation

Added the runtime-state pathspec exclusion, the overlap check on single and batch starts, previous-finding convergence, the rejection cap, and the drafting/tool prompt changes.

Setback: shell-quoted test edits turned `\n` escapes into literal newlines. Repaired them with direct edits.

## 2026-09-17 — The cap did not fire in production

A live barter-rs session rejected `task-1` three times (20:57, 21:02, 21:26) and the goal stayed active; the agent blocked it by hand instead. Two bugs, one on top of the other:

1. `GoalService.appendEvents` buffers into the per-turn transaction, so counting rejections from the ledger *after* appending never saw the current one. The count is now taken before the append and incremented.
2. `flushTurn` returned early when the turn held no goal mutation, discarding the buffered ledger batch with it. A rejected completion mutates nothing, so those `task_review` events never reached disk at all — which also meant the earlier count had nothing to read. The no-mutation path now appends the buffered events.

The second bug predates this spec and explains why the first was invisible in tests: the e2e cap test wrote outside a turn transaction, where both paths happen to work. The new tests drive real turn boundaries.

Validation: the new e2e tests fail with the extension changes stashed (0/2) and pass with them. `npm run test:all` passed 1014 tests with 9 skipped. `tsc --noEmit` and `eslint .` are clean.
