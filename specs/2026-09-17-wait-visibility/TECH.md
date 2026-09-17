# Technical plan

## Notice text

`extensions/goal-scheduler-state.ts` gains two pure exports:

- `formatWaitRemaining(ms)` — "now", "20s", "45m", "2h", "2h 5m".
- `buildWaitNotice(wait, kind, now?)` — the announcement for `"declared"` and `"heartbeat"`, including the polling line only when `nextCheckAt` is set. `now` is injectable so tests do not depend on the clock.

## Heartbeat

The waiting branch of `GoalScheduler.schedule` already computed `due = min(deadline, nextCheckAt)` and slept to it. It now compares `due` with `now + WAIT_HEARTBEAT_MS` (30 minutes) and, when `due` is further out, arms the existing single timer for the heartbeat instead. The callback re-reads the wait from the focused goal, notifies, and calls `schedule` again, which re-evaluates from persisted state and re-arms.

This reuses the one timer the scheduler already owns, so `cancelTimer`, `shutdown`, `pause` and `restore` need no changes and no second handle can leak. The heartbeat path never touches `armedGeneration` and never calls `queueContinuation`, which is what keeps it free of allowance and model turns.

## Declaration and expiry

- `declare` notifies with `buildWaitNotice(wait, "declared")` only when the call created a wait (`input.kind === "wait" && !input.wait_id`), so re-declaration stays quiet.
- `pause` takes an optional `suggestedAction`, persists it as `pauseSuggestedAction`, and appends `To continue: …` to its notification. The deadline-expiry call passes the wait's reason and the resume/tweak guidance; every other `pause` caller is unchanged.

## Tests

`tests/goal-scheduler.test.ts`:

- Formatter and notice-text units, including the polling line and its absence.
- A 3-hour wait: announced on declaration, silent at 29 minutes, reminding at 30 and 60, with `sent.length === 0` and `scheduler.used === 0` proving no dispatch and no allowance spend, then expiring into a pause with the reason and suggested action.
- A polling wait inside the heartbeat window: no reminder, the due check still dispatches, and re-declaring the same `wait_id` does not re-announce.
