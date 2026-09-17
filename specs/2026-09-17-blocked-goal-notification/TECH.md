# Technical plan

## Message building

`extensions/widgets/goal-notifications.ts` gains two exports beside `buildGoalRunningNotification`:

- `buildGoalAttentionNotification({ objective, status, reason, suggestedAction, attempts })` — pure, bounded by `truncateText`, and omits any field it was not given.
- `notifyGoalNeedsUser(ctx, goal)` — notifies only for `blocked` (warning) and `paused` (info), and swallows notify failures so a transition cannot fail on UI trouble. It takes a structurally typed `ctx` so tests need no full `ExtensionContext`.

## Record

`GoalRecord.blockedAttempts?: string[]`. `normalizeBlockedAttempts` filters non-strings and blanks, caps at 8 and **omits the key entirely** when empty, so records without attempts keep their historical shape — an always-present `blockedAttempts: undefined` broke the pinned v3 golden record.

## Blocked flow

`runGoalBlockedFlow` takes `suggestedActionInput` and validates it like `reason`: empty means refuse before any state change, with the goal left active. `commitBlocked` writes `pauseSuggestedAction` and `blockedAttempts` alongside `pauseReason`, and calls `notifyGoalNeedsUser` after `updateUI`. The Oracle paths are untouched; they all funnel through `commitBlocked`.

`update_goal` passes `params.suggested_action` on the blocked branch, and its schema and the lifecycle prompt now describe the requirement.

`blockGoalForRejectedTask` in `goal-task-review.ts` sets its own `pauseSuggestedAction` and notifies through the same helper.

## Session start

`goal-events.ts` calls `notifyGoalNeedsUser` at the end of `session_start` when the focused goal is blocked, after the existing paused-resume prompt.

## Dashboard

`DashboardGoalStatus.attempts` carries `blockedAttempts`; the compact renderer prints a `Tried` row between `Blocker` and `Action`. Blocked details exist only in the compact renderer, which is where the existing `Blocker`/`Action` rows live.

## Tests

- `tests/goal-notifications.test.ts`: message content for blocked and paused, field omission, notify severity per status, no-op for active/complete/null, and a throwing notify.
- `tests/e2e/goal-lifecycle-dashboard.test.ts`: `update_goal` refusing a block with no `suggested_action` (no state change, no notification), a successful block's persisted fields, notification text, compact dashboard rows, and the session-start restatement.
- Existing blocked-path tests in `goal-core-tools`, `goal-drafting` and `goal-tool-visibility` now pass `suggested_action`.
