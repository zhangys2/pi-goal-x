# Blocked goal notification

## Outcome

A goal that needs the user says so, in the user's terminal, with the fix attached. Nothing about a block depends on the user happening to read the dashboard.

## Evidence

In session `01a0b0d2` the goal stopped on a toolchain problem and the user learned nothing until they typed "what is the status". Inspection of the extension found why: `paused`, stalled, budget-limited and wait-deadline transitions all call `ctx.ui.notify`, while `runGoalBlockedFlow` wrote state, ledger and dashboard and returned text to the model only. `suggested_action` was accepted for `paused` but never passed on the blocked path, even though `pauseSuggestedAction` exists on the record and the dashboard already rendered it. `attempted_actions` was accepted and forwarded only to the Oracle, so the user never saw what had been tried.

## Behaviour

### Blocking notifies

- Marking a goal blocked notifies the user (warning level) with: the objective title, the reason, the actions already attempted, the suggested fix, and the `/goal-resume`, `/goal-tweak`, `/goal-clear` line.
- The system block from three consecutive task-review rejections notifies the same way, and supplies its own suggestion: narrow the task, fix the verification environment, revise the contract, or accept the findings.
- A failed notification never fails the transition.
- The tool result tells the model the user has been notified, so it does not repeat the request into the void.

### Blocking requires a fix suggestion

- `update_goal({status: "blocked"})` requires `suggested_action` as well as `reason`. Without it the call is refused, nothing is persisted and nothing is notified; the goal stays active.
- `suggested_action` is addressed to the user: the exact command, install, credential or decision. It persists as `pauseSuggestedAction`.
- `attempted_actions` (up to 8) persists as `blockedAttempts`.

### Where the user sees it

- The compact dashboard shows `Blocker`, `Tried` and `Action` rows for a blocked goal.
- A session start restates a focused blocked goal, so restarting pi does not hide it.

## Out of scope

- Desktop or OS-level notifications: pi's extension surface offers only in-TUI `ctx.ui.notify`. A settings-configured hook command would be a separate feature.
- Wait visibility (announcing a wait at declaration, heartbeats before the deadline, capping silent waits) is a planned follow-up.
