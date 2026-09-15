# Technical plan

## Baselines

`gitBaseline` captures `git stash create` (falling back to `HEAD`) plus an `UNTRACKED` inventory of `<blob hash>\t<path>` lines, hashed through `git hash-object --stdin-paths` so large inventories do not hit the Windows command-line limit.

- `GoalTaskList.reviewBaseline` is written by `set_goal_tasks` and guided drafting when the list is set.
- `GoalTask.reviewBaseline` is written on the first `start` only (`task.reviewBaseline ?? baseline`). `mergeTasksWithExisting` preserves an existing task baseline.
- Reviews use `task.reviewBaseline ?? taskList.reviewBaseline`.
- Baselines are computed before calling `GoalService`, never inside `validate`/`update` closures: `updateTaskAttempt` retries once on a conflicting write, and batch validation dry-runs `update`, so git work inside closures would repeat.

## Changed files and diff

- `gitTaskChangedFiles` returns tracked names from `git diff --name-only <revision>` plus untracked paths that are new or whose blob hash differs from the inventory. It returns `undefined` when there is no baseline or git fails, which classification treats as unknown.
- `gitTaskDiff` returns the tracked `git diff --binary` plus the content of changed untracked files, excluding exact tracked names. Output over the 120,000-character limit is cut and followed by a notice giving shown and total sizes and the full changed-file list.

## Gate order in `reviewTaskBeforeCompletion`

1. Settings skip (`disableTaskReviews`, auditor disabled or `skipAuditor`, excluded `review_type`): record `skipped` and return. No git work.
2. Classification: the label, else `gitTaskChangedFiles`. Not code-changing: record `skipped` with the reason and return.
3. Compute the task diff and run the reviewer.
4. Rejected or failed: append the `task_review` event and return the failure. Approved: return the event to the caller.

Callers validate before step 1. The single-task path runs its `validate` function first; the batch path runs `batchValidationFailure`, which dry-runs the ordered specs on a cloned tree. Approvals are written through the update spec's `ledger` callback, so they commit with `task_complete`.

## Tests

Tool-seam tests in `tests/e2e/goal-lifecycle-dashboard.test.ts` drive `update_goal_task` and `set_goal_tasks` with an injected `runTaskReview` in temporary git repositories. Git helper tests in `tests/goal-task-review.test.ts` cover baseline and diff behaviour. Harnesses that complete tasks inject a reviewer so no test calls the real auditor.
