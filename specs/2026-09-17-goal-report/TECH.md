# Technical plan

## Shape

Two new modules, no behaviour in either beyond deriving text:

- `extensions/goal-report-model.ts` — pure. Takes `{ goal: GoalRecord, events: readonly GoalLedgerEvent[], now: number, pricing?: ModelPricing }` and returns a `GoalReportModel`: header fields, plan nodes/edges, status nodes, task rows, review entries, attention spans, scope entries, subagent runs, timeline lines, recommendations. No I/O, no `Date.now()`, no git.
- `extensions/goal-report.ts` — renders the model to Markdown and writes it. Holds the Mermaid emitters and the write/debounce policy.

This mirrors the dashboard split (`widgets/goal-dashboard-model.ts` pure, renderer separate), which keeps the interesting logic unit-testable without a harness.

## Data sources

Everything comes from state that already exists:

| Section | Source |
|---|---|
| Header | `GoalRecord` (status, `pauseReason`, `pauseSuggestedAction`, `verificationContract`, `usage`, timestamps) |
| Plan DAG | `goal.taskList.tasks` tree; `task_list_set` events give the confirmed-plan history |
| Current state | task `status`, `reviewBaseline` (started), `blockedAttempts`, latest `task_review` per task |
| Tasks table | `task_started` / `task_complete` / `task_skipped` / `task_reopened` timestamps; `evidence` |
| Reviews | `task_review` (verdict, report, baseline), `audit_started` / `audit_result` / `audit_skipped` |
| Attention | `goal_blocked`, `goal_paused`, `goal_resumed`, `goal_stalled`, `goal_budget_*`, plus `goal.scheduler.wait` for the live wait |
| Scope | `gitTaskChangedFiles(cwd, task.reviewBaseline)` from `goal-task-review.ts` |
| Subagent artifacts | `.pi-subagents/artifacts` listing filtered by the goal's window (decision 3) |
| Timeline | `goalActivityEvents(ctx, goalId)` with no limit |

Reuse rather than reimplement: `deriveGoalActivity` for timeline text, `statusLabel` / `formatDuration` / `formatTokenValue` from `goal-core.ts` and `storage/goal-files.ts` for consistent formatting, `buildTaskSummary` for counts.

## Mermaid

- Plan: `flowchart TD`, one node per task (`id["id: title"]`), edges parent → child. Ordered plans add a dashed edge between siblings in declared order. Labels escape `"` and `[` and are truncated to 60 characters.
- Current state: same graph plus `classDef` per status and a `class` line per node; a rejected-and-retrying task additionally carries its attempt count in the label.
- Both blocks are fenced as ```mermaid so they render in viewers and stay readable as text where they do not.

## Files and writing

- Directory `.pi/goals/reports/`, file `report_<goalFileStamp>_<goalId>.md`, matching `active_goal_<stamp>_<id>.md`. On completion, `archiveCurrentGoal` moves the report next to the archived goal.
- Written through `atomicWriteGoalFile` (temp + rename) from `storage/goal-files.ts`, so a reader never sees a half-written report. Report paths are subject to the same `isSafeArchivedPath`-style containment check; `goalReportPath` is validated to resolve inside the project directory.
- The report directory needs the same git-ignore treatment as `.pi/goals/`, so `goal-project-config.ts`'s `RUNTIME_STATE` list covers it already through `.pi/goals/`.

## Update trigger and cost

The regeneration hook is a single call in the ledger-append path (`GoalService.appendEvents` / the `ledger` callbacks already used by every transition), gated on the event type being one the report shows. That gives correctness without a timer.

Two costs to respect, both covered by existing gates:

- **I/O per turn.** B1 measures settings/pool/ledger/lock hot paths and B6 enforces no regression. A report write adds one serialize plus one atomic write per reporting event, not per turn. Debounce within a turn: mark dirty on event append and flush once at `turn_end` / when the turn stops, so a batch of task updates produces one write.
- **Context.** The report is never injected into the prompt. It is written for the user only, and `get_goal` continues to serve the model.

## Settings

Additive to `GoalSettingsLayer` / `ResolvedGoalSettings`, following existing naming:

- `disableGoalReport?: boolean`
- `goalReportPath?: string` (directory, project-relative)
- `modelPricing?: Record<string, { inputPer1M: number; outputPer1M: number }>` — only for the cost column; absent means the column is omitted.

Unknown-key rejection in `parseGoalSettings` means these must be added to the allow-list and to the settings tests.

## Per-task tokens

Today the ledger records no tokens on task events, so per-task figures cannot be derived honestly. Proposal, as a second step after the report lands: add an optional `tokensUsed` snapshot to `task_started`, `task_complete` and `task_review` events. Additive and tolerated by `reconstructGoalLedger`, and per-task cost becomes the delta between snapshots. Until then the tasks table prints tokens only where two snapshots bracket the task, and marks the column approximate.

## Tests

- `tests/goal-report-model.test.ts` — the pure model against hand-built goal/ledger fixtures: a plan with subtasks, a task rejected three times, two tasks open at once, an expired wait, a skipped review, an audit rejection, and each of the five recommendation rules firing and not firing. Fixed `now` so durations are deterministic.
- `tests/goal-report.test.ts` — Markdown rendering: Mermaid node/edge/class output, label escaping and truncation, omission of empty sections, and the cost column appearing only with pricing configured.
- `tests/e2e/goal-lifecycle-dashboard.test.ts` — through the real tool seams: completing a task writes the report, its content reflects the transition, `disableGoalReport` writes nothing, a write failure notifies without failing the task update, and one turn with a batch of updates produces a single write.
- Golden report for a fixed fixture, in the style of `goal-dashboard-golden.test.ts`, so format drift is deliberate.

## Decisions

Settled by the user on 2026-09-17:

1. **One report per goal.** No cross-goal index file.
2. **Three rejections is the only numeric threshold.** The cost-outlier rule is dropped; the remaining rules are boolean conditions, so the recommendation section needs no other tuning constants.
3. **Subagent artifacts are listed** from `.pi-subagents/artifacts` by modification time inside the goal's window, labelled as observed artifacts. `goalSubagentArtifacts(cwd, window)` does one `readdir` plus `stat` per entry, bounded to the newest 50, skipped when the directory is absent, and never reads artifact contents — so it stays a cheap listing and does not depend on pi-subagents' formats.
4. **Command results are quoted only.** The report renders what completion evidence and review reports already say. No command is executed for the report, and quoted claims are attributed to their source so an unverified claim reads as a claim.
