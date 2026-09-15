# Per-task review gate

## Outcome

Code-changing tasks receive a review of only their own complete diff. Task creation carries an explicit `code_change` decision; tasks without it fall back to their observed changed files, and are reviewed when those cannot be determined. Every review decision stays traceable: approved, rejected, failed, and skipped.

## Behaviour

### Which tasks are reviewed

- `code_change: true` tasks are reviewed; `code_change: false` tasks are not.
- Tasks without the label are reviewed when their changed files include source code, and not reviewed when only non-source files changed.
- Tasks without the label whose changes cannot be determined (no git repository, no baseline, or git fails) are reviewed. The gate fails closed; it never guesses from task wording.

### Settings

- `disableTaskReviews: true` turns the gate off without turning off the completion auditor.
- `taskReviewExcludedTypes` lists `review_type` values (case-insensitive) whose tasks skip review.
- Task reviews are also skipped when the completion auditor is disabled in settings or for the focused goal.
- A skipped review never runs git diff work or a reviewer session.

### Review scope

- Setting a task list records a list-level baseline of the working tree.
- A task's first start records its own baseline. Restarting a task, including after a rejection, keeps the original baseline, so the retry review still covers the rejected work.
- A task completed without being started is reviewed against the list-level baseline.
- The diff covers tracked, staged, and untracked files changed since the baseline, including untracked files that existed at the baseline and were edited afterwards.
- When the diff is too large to include in full, the reviewer is told it is truncated and which files changed, so it never approves changes it was not shown as if it saw them all.

### Completion order

- Completion checks (already complete or skipped, missing evidence for a completion requirement, unfinished subtasks) run before any review. An invalid completion starts no review and records no review outcome.
- A batch is checked in order, so completing subtasks and then their parent in one batch stays valid.

### Traceability

- Rejected and failed reviews are recorded immediately.
- An approval is recorded together with the task completion, so a completion that does not commit (for example a batch rejected by a later task's review) leaves no approval behind.
- A task that is not reviewed records a skipped outcome with the reason: not code-changing, excluded type, reviews disabled, or auditor disabled.

## Steered requirements

- Task review scope must include tracked, staged, and untracked files from the task-start working-tree state.
- A task baseline must be captured despite pre-existing uncommitted changes; `git stash create` is an acceptable immutable starting point.
- Add integration coverage for approved, rejected, failed, skipped, reload, and dashboard activity outcomes.
- Complete tasks 2–4 before validation task 6.
- Task 6 is validation/documentation only (`code_change: false`).
