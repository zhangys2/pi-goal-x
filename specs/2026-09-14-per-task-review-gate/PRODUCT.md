# Per-task review gate

## Outcome

Code-changing tasks receive a review of only their own complete diff. Task creation carries an explicit `code_change` decision; legacy tasks use a conservative fallback. Review outcomes remain traceable even when rejected, failed, or skipped.

## Steered requirements

- Task review scope must include tracked, staged, and untracked files from the task-start working-tree state.
- A task baseline must be captured despite pre-existing uncommitted changes; `git stash create` is an acceptable immutable starting point.
- Add integration coverage for approved, rejected, failed, skipped, reload, and dashboard activity outcomes.
- Complete tasks 2–4 before validation task 6.
- Task 6 is validation/documentation only (`code_change: false`).
