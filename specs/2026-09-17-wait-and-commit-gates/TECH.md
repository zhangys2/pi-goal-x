# Technical plan

## Wait dependency

`GoalContinuation`'s wait variant gains `depends_on?: "producer" | "user"` (`goal-scheduler-state.ts`), mirrored in the `update_goal` schema. `GoalScheduler.declare` validates it inside the existing `update` closure, only when `s.wait` is absent, so re-declaration is untouched. Both rejections throw, which `declare` already reports as "Scheduling decision NOT saved" with `terminate: false` and no state change.

The field is optional in the type so existing persisted states and re-declarations stay valid, while `declare` requires it for new waits.

## Commit guard

`extensions/goal-commit-guard.ts`:

- `commandCommitsEverything(command)` looks for a `git commit` in the command plus either an all-flag on the commit or a sweeping `git add` in the same command. It is deliberately textual: the guard only needs to catch the sweep-everything shape.
- `preexistingDirtyPaths(cwd, baseline)` unions `git diff --name-only HEAD <baseline.revision>` (the stash-create baseline commit carries the dirty state, so this diff is what was dirty then) with the baseline's untracked inventory, and intersects that with the current `git status --porcelain`. Both git calls reuse `RUNTIME_STATE_PATHSPECS`, now exported from `goal-task-review.ts`.
- `commitGuardBlockReason(core, ctx, command)` returns the block text and records the goal id in a module-level asked set, so a goal is blocked once until the user speaks.
- `clearCommitGuardAsk(goalId)` is called from the user-driven branch of `before_agent_start`, the same branch that clears continuation state.

The `tool_call` handler in `goal-events.ts` blocks `bash` calls with `{ block: true, reason }`. It reads `event.input?.command` defensively because test harnesses call the hook without an input.

## Tests

- `tests/goal-commit-guard.test.ts`: command classification, pre-existing path detection against a real baseline, the once-per-goal block and its reset, scoped commits, inactive/absent goal, and a clean start.
- `tests/goal-scheduler.test.ts`: missing and `user` dependencies rejected with no state change, `producer` accepted, and re-declaration without `depends_on`. Existing wait fixtures and `tests/scheduler-sdk-worker.mjs` now declare `producer`.
