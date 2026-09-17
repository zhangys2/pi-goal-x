# Milestones

## 2026-09-17 — Spec drafted

Requested after the barter-rs session reviews: a goal report holding the initial task DAG, a running-status flowchart, a task table with cost and tokens, reviews and tests, and improvement recommendations. Added four sections the session evidence argued for — attention/lost time, scope drift, subagent runs, and a timeline — because those were the facts that took a transcript parser to recover.

Checked against the code before writing `TECH.md`:

- Every section but subagents and real command results is derivable from the existing ledger and goal record. No new event types are needed for the first version.
- Per-task tokens are **not** derivable: accounting is goal-level (`usage.tokensUsed`, `usage.activeSeconds`) and no token figure is recorded on task events. Deferred to an additive `tokensUsed` snapshot on task events rather than faked.
- Currency cost needs a price table; the column is omitted without one.
- Writes must respect the B1/B6 I/O gates, hence one debounced write per turn rather than per event.
- `atomicWriteGoalFile` already provides temp + rename, and `.pi/goals/` is covered by the runtime-state ignore rules from `2026-09-17-project-orchestration-check`.

## 2026-09-17 — Open questions settled

User decisions: one report per goal with no cross-goal index; three rejections as the only numeric threshold, dropping the cost-outlier rule; list `.pi-subagents/artifacts` by modification time as observed artifacts; quote command results from evidence and reviews without running anything.

`TECH.md` records these as decisions with the listing bounds for the artifact scan. Implementation has not started.
