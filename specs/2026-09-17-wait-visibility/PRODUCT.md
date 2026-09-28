# Wait visibility

## Outcome

A waiting goal is visible while it waits. Its existence, its deadline and the time left reach the user without the user asking, and a reminder costs nothing.

## Evidence

In session `01a0b0d2` the goal declared a wait until 20:00Z, then after a status question re-declared one until the next day at 12:00Z. The scheduler's waiting branch sleeps with a single timer capped only by the deadline or the next poll, so a wait with no polling is silent for its whole duration. The user was told nothing at declaration and would next have heard at the deadline, ~16 hours later.

## Behaviour

### Declaration

- Declaring a new wait notifies: reason, deadline as an absolute ISO timestamp with the time remaining, the next check and remaining checks when polling was configured, and the `/goal-resume` and `/goal-pause` options.
- Re-declaring an existing `wait_id` does not re-announce; only the first declaration does.

### While waiting

- A wait whose next event (deadline or poll) is more than 30 minutes away wakes after 30 minutes, says it is still waiting with the time left, and re-arms.
- A reminder notifies only: no checkpoint is dispatched, no model turn runs, and the autonomous allowance is untouched.
- A wait with a nearer deadline or poll sleeps to it with no reminder.

### Expiry

- A deadline reached without the expected signal pauses the goal with a reason naming what it was waiting for, plus a suggested action: check whether the condition happened, then resume or revise the plan.
- The suggested action persists on the goal, so the dashboard and the blocked/paused announcement can show it.

## Out of scope

- A configurable reminder interval. The interval is a 30-minute constant; a settings key can follow if the default proves wrong.
- Capping how far out a wait deadline may be. Reminders make a long wait visible, which was the actual problem.
