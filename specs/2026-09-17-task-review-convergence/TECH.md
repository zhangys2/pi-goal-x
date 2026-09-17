# Technical plan

All gate logic stays in `extensions/goal-task-review.ts`.

## Runtime state exclusion

`RUNTIME_STATE_PATHSPECS` (`.` plus `:(exclude)` pathspecs) is passed to `git ls-files --others`, `git diff --name-only`, and `git diff --binary`. Baseline inventories and task changes use the same list, so both sides agree.

## Overlap check

`openCodeTaskConflict(tasks, taskId)` returns a pending task with a `reviewBaseline` and `codeChange !== false` that is neither the target nor related to it by ancestry. `reviewBaseline` marks a started task because it is written on first start and kept across restarts.

- Single `start`: checked before `gitBaseline`, so a refused start does no git work.
- Batch: checked inside `batchValidationFailure` against the cloned tree for specs with `setCurrentTaskId`, so earlier completions in the same batch count.

## Convergence and cap

`taskRejectionsSinceResume` scans the ledger for the goal and resets on `goal_resumed`, collecting `task_review` events with verdict `disapproved` for the task.

- Before the review, the latest one is passed as `previousAuditReport`, which enables the auditor prompt's existing re-check step (3b).
- After a rejection is appended, reaching `MAX_TASK_REVIEW_REJECTIONS` (3) calls `blockGoalForRejectedTask`. It mirrors `update_goal` blocked: `goalService.apply` sets `status: "blocked"`, records `goal_blocked` with `source: "system"`, and clears continuation and accounting. `reviewTaskBeforeCompletion` returns `blocked: true`, and both tool paths return `terminate: true`.

## Prompts

- Confirmation protocol (`goal-draft.ts`): two bullets on task sizing, contract content, and toolchain checks.
- `verification_contract` descriptions in drafting and `set_goal_tasks`: an acceptance checklist.
- `update_goal_task` guideline: the overlap rule, and evidence that names the commands.
- The task review completion summary adds contract-as-checklist and environment-blocker instructions.

## Tests

- `tests/goal-task-review.test.ts`: runtime-state exclusion in a temporary repository; `openCodeTaskConflict` cases.
- `tests/e2e/goal-lifecycle-dashboard.test.ts`: single and batch start refusal through `update_goal_task`; previous findings passed to the retry review, blocking on the third rejection, refusal while blocked, and reset after `/goal-resume`.
