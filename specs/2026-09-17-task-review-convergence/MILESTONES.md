# Milestones

## 2026-09-17 — Session review

Reviewed the barter-rs session `01a0aacc` against a session-review backlog. Mapped the backlog to extension causes: runtime files in review diffs (which led to `git clean` deleting the goal), overlapping started tasks, retry reviews without previous findings, and unlimited retries.

User decisions: refuse overlapping code-task starts instead of warning; cap at three consecutive rejections, then block the goal.

## 2026-09-17 — Implementation

Added the runtime-state pathspec exclusion, the overlap check on single and batch starts, previous-finding convergence, the rejection cap, and the drafting/tool prompt changes.

Setback: shell-quoted test edits turned `\n` escapes into literal newlines. Repaired them with direct edits.

Validation: the new e2e tests fail with the extension changes stashed (0/2) and pass with them. `npm run test:all` passed 1014 tests with 9 skipped. `tsc --noEmit` and `eslint .` are clean.
