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

`TECH.md` records these as decisions with the listing bounds for the artifact scan.

## 2026-09-17 — Implemented

`goal-report-model.ts` (pure), `goal-report.ts` (Markdown + Mermaid + atomic write), `goal-report-runtime.ts` (when to write), the `disableGoalReport` setting, and `/goal-report`.

Decisions made during implementation:

- **Trigger**: keyed on the goal's persisted `revision` counter, compared at `turn_end`. No call-site plumbing, one write per turn that changed state, and nothing written on turns that changed none. External edits are picked up too.
- **Git cost**: changed files are fetched only for tasks whose contract forbids something, since the scope-drift rule is the only consumer and only such a contract can produce a finding.
- **Rendering**: Mermaid node ids are sanitised to `t_<slug>`, labels strip quotes and brackets and truncate at 60 characters, table cells escape pipes and flatten newlines.

Setbacks:

- `atomicWriteGoalFile` resolves its file against `cwd` and uses the root only for containment, so the report needed the full project-relative path; the first attempt threw "Goal path escapes".
- A rendered demo showed a completed task with evidence but no review producing no verification entry at all; the section now renders for evidence alone.
- Two test expectations of mine were wrong rather than the code: the review count, and the overlap rule, which correctly flags every start that lands on an open task.
- Adding `/goal-report` broke two pinned command-inventory tests, updated deliberately.

Validation: `npm run test:all` 1053 pass, 9 skipped; `check`, `lint`, `test:selfcheck` pass. A rendered demo confirmed all five recommendation rules fire on realistic data.
